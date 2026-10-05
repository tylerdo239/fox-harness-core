# Một core agent duy nhất: phân tích các flow và plan gộp `agent-core`

Hai câu hỏi:
1. Vì sao có các flow riêng (`default`, `data-analysis`, `data-studio`)? Có trái với "một core agent cho nhiều user"
   không?
2. Gộp `agent-driver`, `core`, `transport`, `contracts` thành **một package `agent-core`** thế nào?

## Phần A. Flow là gì và vì sao cần

### A.1 Flow không phải agent riêng

Chỉ có **một** core agent: một chương trình, một vòng lặp, một profile, chạy trong mọi runtime. Flow là **chế độ làm
việc của một hội thoại**, chọn lúc tạo hội thoại và gồm ba thứ:
- **persona:** đoạn giới thiệu "bạn là ai";
- **bộ tool được phép dùng:** tool riêng của flow, và tool global nào bị ẩn;
- **luật làm việc thêm:** đoạn prompt, giới hạn số bước…

Về kỹ thuật, flow là một **agent preset** của dsh (`profile-template/presets/<flow>/`): một bộ plugin mà agent của
hội thoại đó gia nhập, cộng một mặt nạ tool (`transport/src/flows.ts`). Hai hội thoại khác flow vẫn chạy **cùng
process, cùng vòng lặp**.

Phép so sánh gần nhất: một ứng dụng chat có các chế độ "Chat thường", "Phân tích file", "Hỏi dữ liệu công ty".
Vẫn là một hệ thống, chỉ khác cấu hình cho từng cuộc trò chuyện.

### A.2 Ba flow hiện có

| | `default` | `data-analysis` | `data-studio` |
|---|---|---|---|
| **Khu vực trên UI** | Chat | Dữ liệu / Project (upload file, phân tích) | Data Studio |
| **Dùng cho** | Trợ lý chung: hỏi đáp, tìm web, viết, code | Phân tích **file của người dùng** (CSV, Excel…) | Hỏi **dữ liệu kinh doanh của công ty** (Dremio) |
| **Thư mục làm việc** | Có (riêng mỗi hội thoại) | Có, gắn với **project**; file upload, file sinh ra | Không |
| **Số tool model thấy** (đo bằng e2e) | 27 | 10 | **1** (`analyze_data`) |
| **Tool riêng** | `analyze_data` | `python` (kernel giữ biến giữa các lần gọi) | `analyze_data` |
| **Tool global bị ẩn** | không | `bash`, subagent, goal, `todo_write`, plan mode, job… | **tất cả** |
| **Luật thêm** | không | prompt nghiệp vụ dữ liệu; **tối đa 8 bước / 10 phút** mỗi lượt rồi buộc trả lời; thu gọn bước cũ; sắp xếp file theo hội thoại | persona "chỉ trả lời về dữ liệu công ty" |

### A.3 Vì sao `data-analysis` cần là flow riêng

Mỗi điểm dưới đây có trong code (`flow/data-analysis/src/`, `tool/python-repl/`):

1. **Tool `python` có trạng thái.** Mỗi hội thoại một kernel Python giữ DataFrame giữa các lần gọi. Phân tích nhiều
   bước ("lọc tiếp", "vẽ lại theo tháng") cần dùng lại biến thay vì đọc lại file. `bash` không làm được việc này.
2. **Prompt nghiệp vụ dữ liệu (khoảng 20 luật).** "Mọi phép tính dùng `python`, không tự nhẩm"; "`profile_dataset`
   trước khi phân tích"; "kết quả 0%, bảng rỗng thường là lỗi đọc/lọc, phải kiểm lại rồi mới kết luận"; "dùng lại số
   đã nêu, chép đúng chữ số"… Đây là kinh nghiệm chuyển từ agent RLM (`docs/rlm-transfer-plan.md`). Đặt các luật
   này vào mọi hội thoại sẽ làm nhiễu chat thường.
3. **Ít tool hơn thì model chọn đúng hơn.** Model đang dùng là Qwen 35B (A3B), context 32k. Danh sách 27 tool vừa tốn
   chỗ trong prompt vừa dễ chọn nhầm (`bash` thay vì `python`, gọi subagent không cần thiết). Flow này chỉ giữ 10
   tool cần cho phân tích.
4. **Giới hạn bước và thời gian.** Phân tích dữ liệu dễ rơi vào vòng thử đi thử lại. Quá 8 bước hoặc 10 phút, model
   phải trả lời bằng kết quả đang có và nói rõ phần chưa kiểm (`agent/pre-step`, `agent/turn-stopping`).
5. **Giữ context 32k.** Các bước tool của lượt cũ được thu gọn thành ghi chú, xem lại được bằng `history(n)`, để hội
   thoại dài vẫn vừa context.
6. **Project và file.** Hội thoại phân tích nằm trong project. Cuối mỗi lượt, file được sắp đúng chỗ (file upload,
   file chia sẻ, file của từng hội thoại) để UI biết file nào của ai.

### A.4 Vì sao `data-studio` cần là flow riêng

1. **Người dùng là nhân viên nghiệp vụ, không phải dev:** chỉ hỏi dữ liệu công ty, không cần `bash`, file hay web.
2. **An toàn và phân quyền:** chỉ còn đúng `analyze_data`, đường đi đã lọc theo role. Không có tool nào khác để đi
   đường vòng.
3. **Model không bị phân tâm:** một tool, một nhiệm vụ.

### A.5 Các phương án đã cân nhắc

| Phương án | Vì sao không chọn / chọn |
|---|---|
| **Một chế độ duy nhất, đủ mọi tool cho mọi hội thoại** | Model nhỏ, context 32k, phải chọn giữa khoảng 30 tool và hai bộ luật mâu thuẫn (chat tự do và phân tích chặt chẽ), nên chất lượng giảm. Người dùng Data Studio có thêm `bash`, file, web: rộng hơn mức cần. |
| **Mỗi flow là một chương trình hoặc container riêng** (kiến trúc cũ) | Bị loại vì không scale: nhiều process, nhiều cấu hình phải giữ đồng bộ. |
| **Một core + flow là preset** (hiện tại) | Một chương trình phục vụ mọi flow và mọi user; flow chỉ là vài dòng cấu hình. Thêm flow mới không cần code core. |

**Kết luận phần A:** flow **không trái** với "một core agent". Nên giữ ba flow như ba chế độ của cùng một core.
Phần cần làm cho gọn là **cấu trúc code của core** (phần B).

## Phần B. Plan gộp thành `api/packages/agent-core`

### B.1 Hiện trạng: lõi bị chia 4 package

| Package | Nội dung | Kích thước |
|---|---|---|
| `agent-driver` | Vòng lặp agent (thay `dsh-agent-loop`), runtime context | `agent.ts`, `factory.ts`, `runtime-context.ts` |
| `core` | Chọn model theo hội thoại, quota token, prompt chung | `index.ts`, `quota.ts`, `prompt.ts` |
| `transport` | Cổng vào runtime (WebSocket nội bộ), Hub, gắn flow, workspace guard | `server.ts`, `flows.ts`, `workspace-guard.ts` |
| `contracts` | 4 kiểu TypeScript | 38 dòng |

Bốn phần này luôn đi cùng nhau, không cái nào dùng riêng được. Tool `python` còn dựa vào hook riêng
`fox/resolve-tool-call` của vòng lặp. Tách làm 4 package chỉ là di sản của các giai đoạn trước.

### B.2 Cấu trúc đích

```
api/packages/
├── agent-core/                      @fox-harness/dsh-agent-core — MỘT core agent
│   ├── cordis.patch.yml             gộp 3 file patch: tắt dsh agent-loop + 3 row của mình
│   └── src/
│       ├── loop/                    (= agent-driver)  agent.ts, factory.ts, runtime-context.ts
│       ├── policy/                  (= core)          model routing, quota, prompt chung
│       └── transport/               (= transport)     server.ts (Hub), flows.ts, workspace-guard.ts
│                                    package export 3 plugin: ./loop, ./policy, ./transport
├── llm/openai-compat/               plugin: cách gọi LLM
├── tool/*                           plugin: tool
├── flow/data-analysis/              plugin: luật riêng flow phân tích
├── profile-template/                cấu hình: profile chung + preset từng flow
└── skills/                          skill (markdown)
```

- **Một package, ba plugin bên trong.** dsh cho phép một package khai nhiều row qua subpath export; repo đã làm vậy
  với `flow/data-analysis/compaction`.
- **Giữ nguyên id các row** (`fox-harness-agent-loop`, `fox-harness-core`, `fox-harness-transport`), để cấu hình,
  preset và log session cũ không bị ảnh hưởng. Chỉ đổi tên npm của plugin.
- **`contracts` bỏ hẳn.** Gateway chỉ dùng hai kiểu (`SkillFile`, `WorkspaceFile`), chép vào gateway như FE đang làm.
  Gateway vẫn giữ nguyên tắc **không import gì từ plugin dsh**.

### B.3 Các bước

1. **Mốc trước khi gộp:** `agent-loop-parity.mjs`, `dsh --dump-config` (lưu lại), 19 e2e, LLM thật trên 8080 (3 flow).
2. **Tạo `agent-core`:** `git mv` code ba package vào `src/loop`, `src/policy`, `src/transport`; viết
   `package.json` (exports, gộp dependencies), `tsconfig.json`, gộp ba `cordis.patch.yml`.
3. **Cập nhật nơi tham chiếu:**
   - `profile.package.json`: bundle `dsh-core`, `dsh-agent-driver`, `dsh-transport` thay bằng `dsh-agent-core`;
   - `api/package.json`, `api/tsconfig.json`;
   - `agent-loop-parity.mjs` (profile B dùng `dsh-agent-core`);
   - comment trong `python-repl` và `flow/data-analysis`.
4. **Bỏ `contracts`:** chép hai kiểu vào gateway, bỏ dependency.
5. **Kiểm chứng sau khi gộp:**
   - `tsc` sạch;
   - `dsh --dump-config` **cùng tập row** như mốc (chỉ khác tên package);
   - `agent-loop-parity.mjs` khớp;
   - 19/19 e2e;
   - LLM thật trên 8080: chat + web search, `python`, Data Studio = 77;
   - kiểm thêm một tool mới vẫn gắn đúng flow.
6. **Tài liệu:** `docs/core-architecture.md`, README, gateway README, `docs/README.md` (bảng đường dẫn cũ → mới).

### B.4 Rủi ro

| Rủi ro | Cách kiểm soát |
|---|---|
| Thứ tự nạp plugin đổi, ví dụ `transport` cần `agents` đã sẵn sàng | Giữ nguyên các row và `inject` như cũ; boot thật + `dump-config` + e2e `restartResumes`, `idleDisposeAndResume` |
| Row trỏ sai subpath nên runtime không boot | Self-test lúc boot đã có, gateway sẽ từ chối khởi động; chạy e2e `health` |
| Tham chiếu tên package cũ còn sót | grep sau khi gộp; build image từ `./api` sạch |
| Phiên bản dependency lệch khi gộp `package.json` | Cả ba package cũ đều ghim `0.1.1-rc.2`; lockfile không được có phiên bản mới (kiểm như lúc tách repo) |

### B.5 Không thay đổi
Hành vi chạy, giao thức với gateway và FE, cấu hình flow, preset, log session, phân quyền. Đây là tổ chức lại code,
không phải sửa logic.

## Kết quả (2026-10-05, commit 75cf974)

Đã làm theo plan; thư mục thứ ba giữ tên `transport` (không đổi thành `gateway-link`) cho khớp tài liệu và comment.
`dsh --dump-config` trước và sau giống hệt (85 row, cùng id, thứ tự và cấu hình; chỉ khác tên package),
`agent-loop-parity.mjs` khớp, e2e 19/19, LLM thật trên 8080 chạy python và web search. Lockfile không có phiên bản
mới.
