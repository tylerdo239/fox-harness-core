# Core agent: các cấu phần, luồng chạy, và vì sao làm vậy

Tài liệu này dành cho người mới đọc `api/`. Đọc theo thứ tự: mục 1 (khái niệm dsh) → mục 2 (bản đồ cấu phần) → mục 3
(luồng chạy) → mục 4 (vì sao). Mục 5 là bảng tra "muốn làm X thì sửa ở đâu".

## 0. Một đoạn tóm tắt

Backend gồm hai thứ chạy trong **một container**:
- **Gateway** (`api/services/gateway`): chương trình Node bình thường, không dính gì tới dsh. Lo đăng nhập, phân
  quyền, REST, quota, và khởi động/giám sát các process agent.
- **Runtime** (từ 1 tới N process `dsh`, `FOX_RUNTIME_COUNT`): mỗi process là một chương trình **dsh**
  (`@deepseek-ai/dsh`, DeepSeek Harness) phục vụ **nhiều session cùng lúc**.

dsh được xây trên hệ plugin **Cordis**: mọi tính năng (vòng lặp agent, gọi LLM, tool, prompt, lưu log…) đều là
plugin. Phần lớn plugin là của dsh và chạy nguyên bản. Các package trong `api/packages/` là **plugin của mình**,
cắm vào đúng những chỗ dsh chưa có hoặc chưa hợp cho nhiều người dùng.

```
api/
├── services/gateway/          chương trình gateway (KHÔNG phải plugin dsh)
└── packages/                  plugin dsh của mình + dữ liệu cấu hình
    ├── transport/             cổng vào runtime: nhận kết nối, tạo/khôi phục agent, gắn flow, chặn đường dẫn
    ├── agent-driver/          vòng lặp agent (thay vòng lặp gốc của dsh)
    ├── core/                  chọn model theo session, quota token, prompt chung
    ├── llm/openai-compat/     gọi LLM chuẩn OpenAI (/chat/completions)
    ├── tool/                  các tool: python-repl, data-studio-agent, create-skill, serper-web-search
    ├── flow/data-analysis/    luật làm việc riêng của flow phân tích dữ liệu
    ├── profile-template/      cấu hình: profile dsh duy nhất + preset cho từng flow
    ├── skills/                skill dựng sẵn (markdown) cho mọi user
    └── contracts/             kiểu dữ liệu dùng chung giữa gateway và transport
```

## 1. Năm khái niệm dsh cần biết trước

| Khái niệm | Là gì | Ở repo này |
|---|---|---|
| **Plugin Cordis** | Một module export `name`, `inject` (cần những service nào) và `apply(ctx)`. Trong `apply`, plugin đăng ký thứ nó cung cấp: tool, LLM adapter, đoạn prompt, hook sự kiện. | Mỗi folder trong `api/packages/` (trừ `profile-template`, `skills`, `contracts`) là một plugin. |
| **Row và profile** | Profile là danh sách plugin được nạp. Mỗi plugin là một **row** (`id`, `name`, `config`) trong file `cordis.patch.yml`. Một package có thể kèm `cordis.patch.yml` riêng để tự thêm, sửa hoặc tắt row. | `profile-template/runtime/template/` là **profile duy nhất** mọi runtime dùng. |
| **Service trên `ctx`** | Plugin dùng chức năng của nhau qua `ctx.llm`, `ctx.tools`, `ctx.systemPrompt`, `ctx.agents`… | Ví dụ tool đăng ký bằng `ctx.tools.register(...)`. |
| **Sự kiện, hook** | Vòng lặp agent phát sự kiện, và plugin chen vào được: `agent/request` (chọn model trước mỗi lần gọi LLM), `agent/pre-step` (trước mỗi bước), `agent/turn-stopping`… | `core` dùng `agent/request`; `flow/data-analysis` dùng `agent/pre-step` để giới hạn số bước. |
| **Session log** | Mọi thứ của một hội thoại (tin nhắn, chunk LLM, gọi tool, kết quả) được **ghi vào log trên đĩa trước** rồi mới gửi đi. Log là nguồn sự thật: process chết thì đọc log để khôi phục. | `<data>/dsh-home/sessions/…`. Runtime không giữ trạng thái nào khác. |

Thêm hai khái niệm dsh dùng cho nhiều người:
- **Agent preset:** một bộ plugin (persona, tool riêng…) mà **một agent** gia nhập. Plugin trong preset chỉ có tác
  dụng với agent đó, không ảnh hưởng agent khác cùng process.
- **Scope:** vùng `ctx` riêng của mỗi agent. Hook và tool đăng ký trong scope chỉ áp dụng cho agent ấy.

dsh tự ghi chú rằng scope và preset **không phải ranh giới bảo mật**: chúng tách cấu hình, không tách dữ liệu
người dùng. Phần cô lập người dùng là của mình (mục 3.3).

## 2. Bản đồ cấu phần

### 2.1 Phần của dsh (chạy nguyên bản, không sửa)

Do bundle `@deepseek-ai/dsh-base` nạp: lưu và khôi phục session, đăng ký tool, các tool cơ bản (`read`, `edit`,
`grep`, `glob`, `bash`, `subagent`, `todo_write`, goal…), sandbox `bash`, ghép system prompt, nén hội thoại dài
(`compaction-basic`), skill đọc từ thư mục, agent preset, đặt tiêu đề session, retry khi gọi LLM lỗi, `web_search`.

Một số row của dsh-base **bị tắt có chủ ý** trong profile: vòng lặp gốc `agent-loop` (thay bằng `agent-driver`),
telemetry gửi về DeepSeek, các adapter gọi DeepSeek, và adapter đa nhà cung cấp `llm-pi-ai`.

### 2.2 Phần của mình

| Package | Làm gì | Cắm vào dsh thế nào | Vì sao cần |
|---|---|---|---|
| **`services/gateway`** | Đăng nhập (MariaDB + Redis), phân quyền admin/user, REST (session, project, file, skill, user, Data Studio admin), quota, proxy WebSocket chat. Khởi động N runtime, kiểm tra sẵn sàng, restart khi chết, chọn runtime cho session theo `hash(sessionId) % N`. | Không phải plugin. Chạy `dsh` như một chương trình con và nói chuyện qua WebSocket nội bộ có secret. | dsh là runtime **một người dùng**, không có tài khoản hay phân quyền. Tách gateway riêng để mọi thông tin người dùng nằm ở một chỗ, và runtime không bao giờ có `DATABASE_URL`, `REDIS_URL` hay `S3_*`. |
| **`packages/transport`** | WebSocket server **trong** runtime (chỉ loopback, bắt buộc secret). Nhận kết nối gateway chuyển vào, đọc `flow/model/cwd/user/role`, **tạo mới hoặc khôi phục** agent, gắn agent vào preset của flow, gửi snapshot log rồi đẩy event trực tiếp, giải phóng session lâu không dùng. Đăng ký **workspace guard** cho mọi agent (gồm subagent). | Plugin, row `fox-harness-transport`. Dùng `ctx.agents.create/resume` với hook `setup`. | dsh không có cổng nhận "nhiều session của nhiều người" vào một process. Flow là preset (`flows.ts`), và guard chặn tool đọc/ghi ra ngoài workspace của chính session. |
| **`packages/agent-driver`** | Vòng lặp agent: lượt → bước → gọi LLM → chạy tool → lặp. Hành vi giống vòng lặp gốc của dsh (kiểm bằng `api/scripts/agent-loop-parity.mjs`). | Tắt row `agent-loop` gốc, thêm row `fox-harness-agent-loop` (`cordis.patch.yml`). Đăng ký làm agent factory. | Vòng lặp gốc chưa cho mỗi agent **một scope riêng** và **hook `setup`** để gắn preset lúc tạo agent, nên không thể chạy nhiều flow, nhiều người trong một process. Ngoài hai điểm đó, driver chép theo bản gốc. Khác biệt duy nhất còn lại: tool chạy lần lượt thay vì song song. |
| **`packages/core`** | (1) Chọn model cho từng agent: model của session, hoặc mặc định `OPENAI_MODEL_ID`, luôn qua `openai-compat`; không có model thì báo lỗi. (2) Quota token mỗi session (`SESSION_TOKEN_BUDGET`), tính từ log. (3) Đoạn prompt chung: luật nền, chính sách làm việc, cách kết thúc, môi trường (ngày hiện tại). | Plugin, row `fox-harness-core`. Hook `agent/request`, `agent/pre-step`, `ctx.systemPrompt.section/variable`. | Chỗ đặt "chính sách sản phẩm" chung cho mọi flow, không nhét vào vòng lặp. |
| **`packages/llm/openai-compat`** | Adapter LLM cho mọi endpoint chuẩn OpenAI (`POST {OPENAI_BASE_URL}/chat/completions`, stream SSE). Đổi định dạng qua lại, phát hiện LLM treo (`LLM_IDLE_TIMEOUT_MS`), map lỗi. | Plugin, `ctx.llm.registerAdapter`, provider tên `openai-compat`. | dsh chỉ có adapter DeepSeek. Hệ thống dùng proxy LLM nội bộ (vLLM, Qwen…). |
| **`packages/tool/python-repl`** | Tool `python`: mỗi hội thoại một kernel Python giữ biến giữa các lần gọi, chạy trong sandbox (không mạng, chỉ thấy workspace). Có thông báo danh sách biến cho model. | Plugin, nằm trong preset `data-analysis`. | Flow phân tích dữ liệu cần trạng thái liên tục (DataFrame), điều `bash` không có. |
| **`packages/tool/data-studio-agent`** | Tool `analyze_data`: chuyển câu hỏi cho **pipeline Python** (`python/`) chạy trong pool worker. Pipeline tìm bảng (Meilisearch), dựng SQL (LLM qua Agno), kiểm SQL theo role, chạy trên Dremio, trả bảng, chart, giải thích. Truyền **role của chủ session** xuống (đi ngược tới agent gốc nếu là subagent). | Plugin, nằm trong preset `default` và `data-studio`. | Pipeline có sẵn bằng Python, nên chạy nó như process con thay vì viết lại. Phân quyền dữ liệu (`python/src/security/role.py`) nằm ở đây vì Dremio OSS không có policy. |
| **`packages/tool/create-skill`** | Tool `create_skill`: kiểm tra một skill mới mà model đề xuất. Việc lưu do FE gọi gateway. | Plugin global. | Cho user tạo skill riêng ngay trong lúc chat. |
| **`packages/tool/serper-web-search`** | **Không phải tool riêng.** Là "nguồn tìm kiếm" `serper` cho tool `web_search` có sẵn của dsh. | `ctx.web.registerSearchProvider`. | Nguồn mặc định của dsh là DeepSeek. |
| **`packages/flow/data-analysis`** | Luật riêng của flow phân tích dữ liệu: đoạn prompt nghiệp vụ, giới hạn số bước và thời gian mỗi lượt, cách nén hội thoại kiểu riêng, gom ghi chú của plugin theo bước. | Plugin trong preset `data-analysis`. | Flow này cần kỷ luật chặt hơn chat thường. |
| **`packages/profile-template`** | `runtime/template/`: **profile duy nhất** (`profile.package.json` liệt kê bundle, `cordis.patch.yml` chỉnh row). `presets/<flow>/`: preset của từng flow (persona + tool riêng). | Gateway chép profile vào `<data>/dsh-home` mỗi lần khởi động, và link thư mục preset. | Một process phục vụ mọi flow. Khác biệt giữa flow nằm ở preset, không phải ở profile. |
| **`packages/skills`**, `flow/data-analysis/skills` | Skill dựng sẵn (markdown): `report-writing`, `web-research`… và skill cho phân tích dữ liệu. | Plugin `skill-filesystem` của dsh đọc các thư mục này. Cả hai thư mục khai ở **profile chung**, nên mọi flow đều thấy cả hai bộ skill. | Skill là hướng dẫn cho model, không phải code. |
| **`packages/contracts`** | Kiểu TypeScript dùng chung giữa gateway và transport. | Chỉ là type. | Gateway không import plugin dsh nào, nhưng cần cùng định nghĩa dữ liệu. FE tự chép lại kiểu, không import. |

Folder `packages/tool/duckduckgo-web-search` trên máy chỉ còn `lib/` và `node_modules/` cũ, **không có trong git và
không được dùng**: nguồn tìm kiếm cũ trước khi đổi sang Serper. Xoá được.

### 2.3 Ba flow khác nhau ở đâu

| Flow | Preset (`profile-template/presets/<flow>/agent.cordis.yml`) | Tool global bị ẩn (`transport/src/flows.ts`) |
|---|---|---|
| `default` | persona chung + `analyze_data` | không ẩn gì (thấy mọi tool của dsh) |
| `data-analysis` | persona phân tích + `python` + luật `flow-data-analysis` | ẩn `bash`, subagent, goal, `todo_write`… |
| `data-studio` | persona Data Studio + `analyze_data` | ẩn **toàn bộ** tool global, chỉ còn `analyze_data` |

## 3. Luồng chạy

### 3.1 Khởi động backend

```
gateway khởi động
 ├─ kiểm sandbox (bubblewrap chạy được, không có mạng) và thư mục dữ liệu nằm ngoài git      [production: không đạt → dừng]
 ├─ materialize: chép profile-template/runtime/template → <data>/dsh-home/profiles/fox-harness
 │               link node_modules/@fox-harness và thư mục presets
 ├─ chạy runtime 0 (dsh --profile fox-harness), chờ nó nhận được kết nối thật, rồi mới chạy runtime 1..N-1
 │      mỗi runtime: Cordis nạp các row → plugin dsh + plugin của mình apply()
 │                   transport mở WebSocket ở 127.0.0.1:4201+i, chỉ nhận kết nối có secret
 └─ mở cổng 4000 cho web/nginx
```

Runtime chỉ nhận các biến môi trường trong allow-list (`runtimeEnvPassthrough` trong `config.ts`): khoá LLM, Serper,
cấu hình Data Studio. Không có DB của gateway, Redis hay S3.

### 3.2 Một lượt chat

```
FE ──WS /sessions/<id>?token──► nginx ──► gateway
  gateway: token → user, role (Redis) · quyền sở hữu session (MariaDB) · quota · ghi skill của user vào workspace
           chọn runtime = hash(sessionId) % N · mở WS nội bộ kèm secret và flow/model/cwd/user/role/output
  ──► transport (trong runtime)
        Hub.ensure: session đang sống? dùng tiếp : ctx.agents.resume (đọc log) hoặc ctx.agents.create
        setup(agent): gia nhập preset của flow + ẩn tool global theo flow
        gửi snapshot (toàn bộ event của log) cho FE
FE gửi {"type":"followup","text":"..."}
  ──► agent-driver: mở lượt (turn/start)
        lặp từng bước:
          ① ghép system prompt (persona, prompt của core/flow, mô tả tool, skill…) + runtime context
          ② hook agent/pre-step (core: quota; flow: giới hạn bước)
          ③ hook agent/request → core chọn provider=openai-compat, model của session
          ④ openai-compat gọi LLM (stream) → mỗi chunk ghi log (assistant/chunk) → FE thấy chữ hiện dần
          ⑤ model gọi tool? → guard kiểm đường dẫn → chạy tool → ghi tool/result → quay lại ①
             không gọi tool → câu trả lời cuối (assistant/message) → turn/end
  mọi event: ghi log TRƯỚC, rồi transport đẩy cho FE qua gateway (gateway không đọc nội dung)
```

### 3.3 Khi model gọi tool: bốn lớp chặn

| Lớp | Ở đâu | Chặn gì |
|---|---|---|
| Phân quyền | gateway | Mở hoặc xem session, file, project của người khác (trừ admin) |
| Workspace guard | `transport/src/workspace-guard.ts` | Tool có tham số đường dẫn trỏ ra ngoài workspace của session (kể cả qua symlink, kể cả subagent) |
| Sandbox | `api/docker/fox-confine.sh` (bubblewrap) | `bash`/`python` chỉ thấy workspace của mình; không mạng; không capability; env sạch |
| Quyền dữ liệu | `data-studio-agent/python/src/security/role.py` | Bảng/cột không được phép cho role, cột PII; kiểm SQL trước khi gửi Dremio |

### 3.4 Câu hỏi Data Studio (`analyze_data`)

```
agent gọi analyze_data(question)
  └─ data-studio-agent (Node): lấy role của chủ session → đưa vào hàng đợi pool (FOX_DS_WORKERS / runtime)
       └─ worker Python (bridge/runner.py, process con, KHÔNG trong sandbox vì cần Mongo/Dremio/Meili)
            catalog (Mongo, lọc theo role) → tìm bảng (Meilisearch) → các bước LLM qua Agno (cùng LLM của harness)
            → dựng SQL → sql_validator (theo role) → chạy Dremio → bảng, chart, giải thích
  ◄─ kết quả có cấu trúc → tool/result → FE vẽ bảng và chart
```

Thao tác quản trị Data Studio (sync Dremio, reindex, profiling) **không** đi qua agent: gateway chạy thẳng
`bridge/admin_runner.py` khi admin bấm.

### 3.5 Khôi phục và giải phóng

- **Session lâu không ai kết nối** (`FOX_IDLE_DISPOSE_MS`): bị bỏ khỏi RAM. Lần mở sau đọc lại log để khôi phục.
- **Runtime chết hoặc restart:** gateway tự chạy lại. Session của nó khôi phục từ log ở lần kết nối sau. Lượt đang
  dở được đóng là `interrupted`, phần chữ đã sinh vẫn được giữ.
- **Restart cả container:** như trên, vì toàn bộ trạng thái nằm trong volume `/data`.

## 4. Vì sao làm như vậy

1. **"Fork mỏng", không viết lại dsh.** dsh đã có rất nhiều thứ tốt: tool, sandbox, log bền, nén hội thoại, skill,
   subagent. Mình dùng nó như một package npm thật (ghim bản `0.1.1-rc.2`) và chỉ thay **đúng một phần**: vòng lặp
   agent. Nâng cấp dsh sau này vẫn khả thi, kiểm bằng `agent-loop-parity.mjs`.
2. **Một runtime phục vụ nhiều session** (không phải một container mỗi session). Phương án orchestrator mỗi session
   một container đã không được duyệt vì không scale và cần quyền Docker. Một process phục vụ nhiều agent cần đúng
   hai thứ mà vòng lặp gốc thiếu (scope riêng, hook `setup`), đó là lý do có `agent-driver`.
3. **Flow là preset, không phải profile.** Trước đây mỗi flow là một profile, tức một process riêng. Gộp về một
   profile và để mỗi agent gia nhập preset của flow mình, thì một process chạy được mọi flow.
4. **Gateway tách khỏi runtime và không import dsh.** Mọi thông tin người dùng (tài khoản, quyền, quota, khoá DB)
   nằm ở gateway. Runtime chỉ nhận những gì gateway cho phép. Code do model sinh ra chạy trong runtime, nên runtime
   càng ít bí mật càng tốt.
5. **Cô lập người dùng là việc của mình.** dsh thiết kế cho một người; scope và preset không phải ranh giới bảo mật.
   Vì vậy có workspace guard, sandbox bubblewrap cắt mạng và bỏ capability, secret giữa gateway và runtime, và lọc
   dữ liệu theo role.
6. **Log là nguồn sự thật.** Ghi trước rồi mới gửi, nên F5, mất mạng, runtime chết hay restart container đều không
   mất gì, và runtime không cần giữ trạng thái riêng.
7. **Data Studio chạy Python như process con.** Pipeline có sẵn bằng Python (Agno, SQLGlot), nên chạy nó qua một
   pool worker thay vì viết lại sang TypeScript. Worker cần Mongo, Dremio, Meilisearch nên không nằm trong sandbox;
   bù lại, nó không chạy code do model sinh.

## 5. Muốn làm X thì sửa ở đâu

| Việc | Sửa ở |
|---|---|
| Thêm tool cho một flow | Package mới `api/packages/tool/<tên>` (mẫu: `create-skill`) → `api/package.json` → `api/tsconfig.json` → một dòng trong `profile-template/presets/<flow>/agent.cordis.yml`. Rebuild image. (Đã thử thật: `docs/core-readiness-review-2026-10-05.md` mục 5.) |
| Thêm tool cho mọi flow | Như trên, nhưng khai bundle trong `profile-template/runtime/template/profile.package.json`. Ẩn ở `data-analysis` thì thêm tên vào `FLOW_TOOL_MASK` (`transport/src/flows.ts`). |
| Thêm skill dựng sẵn | `api/packages/skills/<tên>/SKILL.md` |
| Đổi persona hay prompt của một flow | `profile-template/presets/<flow>/agent.cordis.yml` (persona); `core/src/prompt.ts` (chung); `flow/data-analysis/src/index.ts` (riêng flow phân tích) |
| Thêm flow mới | Folder `profile-template/presets/<flow>/`; thêm tên vào object `flows` trong `services/gateway/src/config.ts` (kèm `workspace: true/false`); (tuỳ chọn) mask tool trong `transport/src/flows.ts` |
| Đổi cách chọn model | `core/src/index.ts` (hook `agent/request`) |
| Đổi LLM endpoint | Chỉ đổi env `OPENAI_BASE_URL` / `OPENAI_MODEL_ID`. Endpoint không chuẩn OpenAI thì viết adapter mới cạnh `llm/openai-compat` |
| Đổi luật phân quyền dữ liệu | `data-studio-agent/python/src/security/role.py`, `crud_mongo/*`, `services/sql_validator.py` |
| Đổi phân quyền API | `services/gateway/src/index.ts` (`adminGate`, `needsAdmin`) |
| Nâng cấp dsh | `docs/upstream-upgrade-policy.md`: chạy `agent-loop-parity.mjs` và e2e trước và sau |

**Lưu ý khi viết tool:** tool chạy **trong process runtime dùng chung, không nằm trong sandbox**. Guard chỉ kiểm tra
các tham số trông như đường dẫn. Tool tự đọc file, gọi mạng hay DB thì phải tự giới hạn theo workspace
(`exec.agent.session.header.cwd`) và theo role; không bao giờ lấy user, role hay đường dẫn từ tham số do model truyền.
