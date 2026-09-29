# Kế hoạch chuyển skill từ agent-core sang fox-harness-core

Lập ngày 2026-09-13. Gồm 3 giai đoạn: skill có sẵn → skill riêng của user → tạo
skill ngay trong chat.

---

## 1. Bối cảnh

**agent-core đang có:**

- 15 skill đặt trên đĩa (`bundles/skills/*/SKILL.md`), trong đó 9 skill khai
  `drivers: rlm` (chỉ chạy được trong chế độ phân tích dữ liệu).
- Skill riêng của từng user lưu trong Postgres (`custom_skills`), quản lý ở tab
  Kỹ năng.
- Tool `create_skill` cho model lưu skill ngay trong lúc chat, theo quy trình
  "đề xuất ở lượt đầu, lưu khi user đồng ý ở lượt sau".
- Menu "/" để user tự chọn skill.

**fox đã có sẵn phần lõi skill** từ `@deepseek-ai/dsh-base`
(`node_modules/@deepseek-ai/dsh-base/cordis.patch.yml:237-248`, xem thêm
`docs/agent-core-architecture-roadmap.md` Phase 18):

| Module DeepSeek | Vai trò | Thay cho module agent-core |
|---|---|---|
| `dsh-skill` | sổ danh sách skill | `skill-registry` |
| `dsh-skill-filesystem` | đọc `SKILL.md` từ các thư mục, tự theo dõi thay đổi | `skill-filesystem` |
| `dsh-tool-skill` | đưa danh sách skill cho model, tool `skill`, hiểu cú pháp `/tên-skill` | `tool-skill`, `skill-selection-llm` |

Vì vậy **không chuyển code** của 4 module trên. Việc cần làm là chuyển nội dung
skill và xây phần skill riêng theo user.

**Ngoài phạm vi kế hoạch này:** loop RLM và 9 skill dữ liệu.

---

## 2. Những điều đã kiểm định bằng chạy thật

Chạy với Node 22.23.2, pnpm 11.7.0, `@deepseek-ai/dsh@0.1.1-rc.2`. Dùng thư mục
tạm và một LLM giả chạy trên máy, ghi lại nguyên văn yêu cầu gửi tới model.

| # | Câu hỏi | Kết quả |
|---|---|---|
| 1 | Ghi skill vào `$DSH_HOME/skills` **sau khi** worker đã khởi động, lúc thư mục `skills` còn chưa tồn tại (giống container dựng sẵn) | ✅ DeepSeek thấy sau ~30ms |
| 2 | Sửa hoặc xoá skill | ✅ sửa: ~200ms (chờ file ghi xong hẳn). Xoá: ~6ms |
| 3 | Chạy trong Docker, file do máy chủ ghi vào thư mục gắn `/data` (đúng cách orchestrator làm) | ✅ giống hệt khi chạy trực tiếp |
| 4 | `DSH_BUNDLED_SKILL_DIR` làm chỗ đặt skill có sẵn | ✅ skill hiện với `source=bundled` |
| 5 | Skill riêng trùng tên skill có sẵn | ⚠️ skill riêng **lặng lẽ đè** skill có sẵn, không có cảnh báo |
| 6 | Skill của agent-core có trường lạ (`drivers`, `triggers`, `argument-hint`) và thư mục con | ✅ vẫn nhận. `user-invocable: false` hiểu đúng |
| 7 | Chạy nguyên worker fox: `/tên-skill` có nạp skill không, skill thêm giữa hội thoại có tới model không | ✅ cả hai. Skill có `user-invocable: false` không nạp được bằng `/`, đúng thiết kế |

Bằng chứng cho mục 7: yêu cầu gửi LLM ở lượt 2, sau khi ghi thêm skill
`bao-cao-tuan` giữa 2 lượt:

```
[5] user  /sql-to-insights /bao-cao-tuan thử lần 2
[6] user  <available_skills> bao-cao-tuan, business-case-builder, data-profiling, report-writing, sql-to-insights
          "The available skill catalog changed. This complete catalog replaces..."
[7] user  <skill_content name="bao-cao-tuan">
```

Các script thử nằm trong thư mục tạm của phiên làm việc, **chưa lưu vào repo**.

---

## 3. Phát hiện ảnh hưởng tới cách làm

| Phát hiện | Hệ quả |
|---|---|
| Viết tên trường kiểu chữ hoa (`userInvocable`) thì DeepSeek **bỏ nguyên skill**, chỉ ghi cảnh báo vào log | Luôn viết `user-invocable`, `disable-model-invocation` |
| Skill riêng đè skill có sẵn khi trùng tên (mục 5) | Gateway phải cấm đặt tên trùng skill có sẵn |
| Tool `web_search` của fox là tìm kiếm của DeepSeek, cần `DEEPSEEK_API_KEY` (`dsh-web-search-deepseek/README.md`), mà `.env.example` chỉ có `OPENAI_*` | Skill phải dùng `duckduckgo_web_search` |
| Repo không dùng thư viện YAML, file cấu hình ghép bằng chuỗi | Khi ghi `SKILL.md`, `description` phải đặt trong ngoặc kép kiểu JSON, nếu không dấu `:` hay `#` làm hỏng file và skill bị bỏ |
| Luật `docs/code-rules.md` §7: worker không bao giờ biết `userId` | Skill riêng được lưu ở gateway (biết user), orchestrator chép file vào thư mục của hội thoại (không biết user) |
| agent-core dùng `users.id` UUID + `username`, fox dùng số + `email` | Không chuyển tự động được skill riêng cũ |

---

## 4. Quyết định đã chốt: tạo skill trong chat bằng cách "trình duyệt lưu hộ"

Tool chạy trong container không biết user và không có database. Đã cân nhắc 3
cách để đưa yêu cầu "lưu skill" ra ngoài:

| Cách | Kết luận |
|---|---|
| Model tự ghi file skill bằng tool `write` | **Loại.** Sandbox chỉ cho ghi trong `/repo`, file mất khi container ngủ đông, không vào database |
| **Trình duyệt lưu hộ:** tool chỉ kiểm tra, giao diện thấy tool chạy thành công thì gọi API lưu của tab Kỹ năng | **Chọn.** Không thêm đường nói chuyện mới, giữ nguyên §7, dùng lại toàn bộ giai đoạn 2 |
| Tool cầm "vé" của hội thoại, tự gọi về gateway | Để dành. Model biết chắc kết quả lưu, nhưng phải mở đường mạng container → gateway và thiết kế vé |

Đánh đổi đã chấp nhận: nếu trình duyệt đóng đúng lúc lưu thì skill không được
lưu. Lỗi hay gặp nhất (trùng tên, quá 50 skill) vẫn được tool bắt ngay trong
container. Có thể nâng lên cách "cầm vé" sau này mà không bỏ phần đã làm.

---

## 5. Giai đoạn 1 — Skill có sẵn

**Mục tiêu:** 5 skill không cần RLM chạy được trong fox, dùng chung cho mọi user.

| Việc | File |
|---|---|
| Tạo package chứa skill | `packages/skills/package.json` (`@fox-harness/skills`, không có tiền tố `dsh-` vì không phải plugin, theo §1), `packages/skills/README.md` |
| Chép và sửa 5 skill | `packages/skills/report-writing/`, `web-research/`, `sql-to-insights/`, `support-tone/`, `business-case-builder/` |
| Báo worker chỗ đặt skill | `infra/docker/worker/Dockerfile`: `ENV DSH_BUNDLED_SKILL_DIR=/repo/packages/skills` |

**Sửa nội dung khi chép:**

- Bỏ `drivers`, `triggers`, `argument-hint`. Ý của trigger đưa vào `description`.
- Đổi `web_search` → `duckduckgo_web_search`.
- `support-tone`: bản agent-core là code (`index.ts`), viết lại thành `SKILL.md`.
- `business-case-builder`: bỏ câu "script cần Python REPL (chỉ RLM có)" và chỗ
  `{skill-dir}`. DeepSeek đã tự đưa đường dẫn thư mục skill cho model.

**Xong khi:** bài thử worker + LLM giả thấy đủ 5 skill trong danh sách, và
`/report-writing` nạp đúng nội dung.

---

## 6. Giai đoạn 2 — Skill riêng: tab Kỹ năng và menu "/"

**Mục tiêu:** user tự thêm, sửa, xoá skill riêng. Skill dùng được trong mọi hội
thoại của user đó và hiện trong menu "/".

**Luồng dữ liệu:**

```
trình duyệt ─► gateway ─► MariaDB (custom_skills)
                  │
                  └─► orchestrator ─► <dshHomeDir>/skills/<tên>/SKILL.md ─► DeepSeek tự thấy
```

| Bước | File | Việc |
|---|---|---|
| 2.1 | (máy phát triển) | Dựng đủ bộ fox: MariaDB, Redis, gateway, orchestrator, image worker. Kiểm cổng (4000, 4100, 3306, 6379) không trùng dịch vụ khác |
| 2.2 | `infra/migrations/002_custom_skills.sql` | Bảng `custom_skills`: `owner_id` (khoá tới `users.id`), `name` (≤ 64), `description` (≤ 280), `content` (≤ 64 KB), `created_at`, `updated_at`. Mỗi user không có 2 skill trùng tên |
| 2.3 | `services/gateway/src/db.ts` | Hàm đọc, thêm, sửa, xoá skill. Hàm lấy **mọi** hội thoại của một user (`listSessionsForOwner` hiện bỏ qua hội thoại chưa có tin nhắn) |
| 2.4 | `services/gateway/src/index.ts` | API `GET/POST/PUT/DELETE /custom-skills` và `GET /skills` (skill có sẵn không có `user-invocable: false` + skill riêng của user). Kiểm tra: tên `^[a-z0-9][a-z0-9-]{1,63}$`, độ dài, 64 KB, tối đa 50 skill/user, **không trùng tên skill có sẵn**. Lúc khởi động, đọc phần khai báo đầu `packages/skills/*/SKILL.md` để biết skill có sẵn |
| 2.5 | `services/orchestrator/src/skills-sync.ts`, `index.ts`, `packages/contracts` | Route nội bộ `PUT /skills-sync`, xác thực bằng `x-fox-harness-internal-secret` như các route hiện có. Nhận `{ sessionIds, skills }`. Với hội thoại `running` hoặc `hibernated`: ghi lại toàn bộ `<dshHomeDir>/skills/` (ghi file mới, xoá thư mục thừa). Hội thoại `archived` bỏ qua, lúc thức dậy sẽ được đồng bộ lại |
| 2.6 | `services/gateway/src/index.ts` | Đồng bộ ở 2 thời điểm (xem dưới) |
| 2.7 | `apps/web/src/components/features/skills/` (mới), `sidebar/`, `conversation/` | Tab Kỹ năng: danh sách, form thêm và sửa, nút mở rộng xem nội dung. Menu "/": gõ "/" hiện danh sách từ `GET /skills`, chọn thì chèn `/tên-skill ` vào ô chat |

**2 thời điểm đồng bộ:**

| Lúc | Làm gì |
|---|---|
| Mở hội thoại (mới, lấy container dựng sẵn, hay thức dậy) | Ngay sau `ensureSession()` thành công, **trước** `wss.handleUpgrade()`: đồng bộ skill của user vào hội thoại đó, để tin nhắn đầu tiên đã có đủ skill |
| Thêm, sửa, xoá ở tab Kỹ năng | Gọi `PUT /skills-sync` **một lần** kèm mọi hội thoại của user |

**Xong khi:**

- 2 tài khoản không thấy skill riêng của nhau.
- Sửa skill ở tab lúc đang mở hội thoại: lượt chat kế tiếp dùng bản mới.
- Đặt tên trùng skill có sẵn bị từ chối.
- Hội thoại ngủ đông rồi thức dậy vẫn có đủ skill.

---

## 7. Giai đoạn 3 — Tạo skill ngay trong chat

**Mục tiêu:** giữ đúng trải nghiệm agent-core, không có nút bấm:

```
User:  tạo giúp tôi skill viết báo cáo tuần
Model: (lượt 1) trình bày bản nháp, chưa lưu
User:  oke tạo đi
Model: (lượt 2) gọi create_skill → "Đã lưu skill bao-cao-tuan"
```

| Bước | File | Việc |
|---|---|---|
| 3.1 | `packages/tool/create-skill/` (`@fox-harness/dsh-tool-create-skill`): `package.json`, `cordis.patch.yml`, `README.md`, `src/index.ts` | Tool **chỉ kiểm tra, không lưu**: tên đúng dạng, độ dài, 64 KB, không trùng skill đang có (đọc danh sách skill của hội thoại qua `agent` mà tool nhận lúc chạy), chưa quá 50 skill riêng (đếm skill có `source = user-dsh`). Sai thì báo lỗi cho model. Mô tả tool mang sang quy tắc "lượt đầu chỉ đề xuất, lượt sau user đồng ý mới gọi" |
| 3.2 | `packages/profile-template/template/profile.package.json`, `package.json` gốc | Thêm package vào `bundles` **và** vào `dependencies` gốc (thiếu chỗ thứ hai thì DeepSeek không tìm thấy package, xem `docs/code-rules.md` §10 mục 4) |
| 3.3 | `apps/web/src/components/features/conversation/Conversation.tsx` | Thấy sự kiện `tool/call` có `name: "create_skill"` → giữ `arguments` theo `callId`. Thấy `tool/result` cùng `callId`, không lỗi → gọi `POST /custom-skills` bằng đăng nhập của user → hiện thông báo "Đã lưu skill" |
| 3.4 | `packages/skills/skill-creator/SKILL.md` | Viết lại từ bản agent-core: 3 trường (bỏ `triggers`), dùng `duckduckgo_web_search`, không nhắc `query_database`, nội dung skill tự đủ, giữ mẫu trình bày bản nháp (thân skill luôn đặt trong khối ` ```markdown `) |

**Hai chỗ phải cẩn thận ở bước 3.3:**

- **Chỉ xử lý sự kiện đang diễn ra**, bỏ qua sự kiện phát lại trong frame
  `snapshot` khi mở lại hội thoại cũ. Nếu không, mỗi lần mở lại chat sẽ lưu skill
  thêm lần nữa.
- **Mở cùng hội thoại ở 2 tab trình duyệt:** cả 2 tab đều gọi lưu, tab thứ hai
  nhận lỗi 409. Lỗi 409 trong trường hợp này thì bỏ qua, không báo.

**Xong khi:**

- Chat 2 lượt → skill có trong MariaDB, hiện ở tab Kỹ năng và menu "/", dùng được
  ở lượt sau và ở hội thoại khác.
- Tên trùng → model báo và hỏi tên khác, không lưu.
- Mở lại hội thoại cũ không lưu thêm lần nữa.

---

## 8. Mặc định đang áp dụng (đổi được)

| Điểm | Mặc định |
|---|---|
| Gateway biết danh sách skill có sẵn | Đọc thẳng `packages/skills` (đọc file, không import package, nên không phạm §1) |
| Cách đồng bộ skill xuống container | Mỗi lần gửi nguyên danh sách skill của user, không gửi từng thay đổi |

## 9. Chưa nằm trong kế hoạch

- Chuyển skill riêng cũ từ agent-core: phải khớp user bằng tay (UUID + username
  ↔ số + email), và mất trường `triggers`.
- Loop RLM và 9 skill dữ liệu: `data-profiling`, `data-scientist`,
  `data-visualization`, `deliverable-export`, `ml-modeling`, `pandas-expert`,
  `product-analytics`, `statistical-analysis`, `time-series-analysis`.

## 10. Lưu ý chung

- **Fox chưa có bộ test tự động.** Mỗi giai đoạn được kiểm bằng script (như bài
  thử worker + LLM giả) và thử tay trên bộ fox đầy đủ.
- **Node 22 cài riêng**, không thay Node của hệ thống. Trước khi chạy lệnh cho
  fox trong một terminal mới:
  ```bash
  export PATH=$HOME/.local/share/node-v22.23.2-linux-x64/bin:$PATH
  ```

## 11. Việc chờ làm (chưa code)

- **Model mò file không có trong thư mục skill.** Chat `42f94073` (2026-09-15): sau
  `/web-search-analyzer`, model gọi `read /data/skills/web-search-analyzer/template.md`
  (`FS_NOT_FOUND`), `read` chính thư mục (`FS_NOT_REGULAR_FILE`), rồi `glob` với đường dẫn
  tuyệt đối trong `pattern` mà không truyền `path` nên chỉ tìm trong `/repo` ("No files
  found"). Skill tạo từ chat chỉ có một file `SKILL.md` và nội dung không nhắc tới template
  nào; sandbox không chặn gì. Kết quả không sai, nhưng tốn 3 bước và hiện nhãn đỏ "Lỗi khi
  dùng read".
  - Đề xuất: khi nạp skill riêng, thêm một câu vào nội dung skill (hoặc mô tả tool `skill`):
    *"Skill này chỉ có một file SKILL.md; đừng tìm file khác trong thư mục skill."*
  - Cùng nhóm với V6 trong `docs/qa-report-2026-09-15.md` (model lặp lỗi dùng công cụ).
