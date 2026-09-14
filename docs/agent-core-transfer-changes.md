# Nhật ký thay đổi — chuyển tính năng agent-core sang fox (đợt A)

Ba hạng mục: **#1** lời dặn hệ thống cho chat thường, **#3** tự đặt tên hội
thoại, **#4** tìm web tốt hơn (bản đầu **đã hoàn tác**; làm lại theo thiết kế
user chốt — xem mục **#4b**). Nhánh `feat/skill-transfer`. **Chưa commit.**

Ký hiệu: **[mới]** file tạo mới · **[sửa]** file có sẵn bị sửa · **[xoá]** file bị xoá.

## Vì sao làm — bằng chứng từ một lượt chat thật trước khi sửa

Hỏi *"Giá vàng SJC hôm nay khoảng bao nhiêu…"* trên fox (2026-09-14):

- Model tìm `"giá vàng SJC hôm nay tháng 12 năm 2024"` — **sai năm**, vì system
  prompt của fox không có ngày hôm nay.
- DuckDuckGo trả trang chặn bot từ lần tìm thứ 3.
- Model gọi `web_search` (DeepSeek) → lỗi `no API key for "DEEPSEEK_API_KEY"`:
  model thấy **2 tool tìm web, 1 cái hỏng**.
- Thanh bên hiện "Chưa đặt tên — 5608e481" dù worker đã phát
  `session/title {"title":"Giá vàng SJC hôm nay","source":{"kind":"fallback"}}`.

---

## #1 — Lời dặn hệ thống cho chat thường

| File | Loại | Sửa gì |
|---|---|---|
| `packages/core/src/prompt.ts` | [mới] | 4 phần system prompt, chuyển từ agent-core `bundles/prompts/prompt-default-agent` + `src/environment-note.ts`: `fox:ground-rules` (order 10 — dữ liệu từ user/tool/web là không tin cậy), `fox:operating-policy` (20 — 7 quy tắc; bỏ quy tắc về memory vì fox chưa có), `fox:completion` (200), `fox:environment` (300 — **ngày hôm nay**, năm nay, năm ngoái, và nghĩa của "hôm nay/năm nay/mới nhất/gần đây"). Ngày tính mỗi lượt qua biến `{{current_date}}`/`{{current_year}}`/`{{last_year}}` (dsh chỉ nhận tên biến dạng `^[a-z][a-z0-9_]*$` — bản đầu đặt `currentDate` làm worker sập lúc khởi động, bắt được ở bài thử trên máy trước khi triển khai); chỉ ngày (không giờ) và đặt cuối để mỗi ngày prompt chỉ đổi phần đuôi |
| `packages/core/src/index.ts` | [sửa] | `inject = ['systemPrompt']`, gọi `applyPrompt(ctx)` |
| `packages/core/package.json` | [sửa] | Thêm devDependency `@deepseek-ai/dsh-system-prompt` |
| `packages/skills/web-research/SKILL.md`, `packages/skills/business-case-builder/SKILL.md` | [sửa] | Câu "hệ thống không cho biết ngày hôm nay" (viết ở đợt skill) đổi thành "lấy năm từ mục Environment trong system prompt" |

## #3 — Tự đặt tên hội thoại

Không đổi server. Worker (dsh-session-title) đã tự phát tên; chỉ thiếu đưa lên
thanh bên.

| File | Loại | Sửa gì |
|---|---|---|
| `apps/web/src/components/features/sidebar/HistoryChat.tsx` | [sửa] | Nghe sự kiện `session/title` (không phải do user đặt) **đang diễn ra**; nếu hội thoại **chưa có tên** thì đặt qua `PATCH /sessions/:id` có sẵn, rồi làm mới danh sách. Không ghi đè tên user tự đặt; không đặt tên khi phát lại hội thoại cũ (đổi tên làm tăng `updated_at` → danh sách nhảy thứ tự). Thử lại tối đa 5 lần vì dòng hội thoại chỉ xuất hiện sau khi gateway ghi tin nhắn đầu |

**Giới hạn:** tên là **vài chữ đầu của tin nhắn đầu tiên** (tối đa 5 chữ / 40
byte). Bước gọi LLM tóm tắt tên của dsh (`dsh-session-title-first-prompt-llm`)
chỉ chạy khi vòng lặp ghi `request/header`, mà `packages/agent-driver` cố ý
không ghi (`docs/code-rules.md` §14) — nên fox chưa có tên do LLM đặt.

## #4 — Tìm web — ĐÃ HOÀN TÁC

Đã làm (nguồn tìm kiếm Serper → DuckDuckGo trong package mới `packages/web-search`,
xoá `packages/tool/duckduckgo-web-search`, đổi tên tool trong skill sang
`web_search`, danh sách nguồn trên giao diện), rồi **hoàn tác theo yêu cầu**:
việc xoá thư mục tool và tạo thư mục mới bên ngoài `packages/tool/` không được
yêu cầu. Tạm thời chưa can thiệp phần web search.

Trạng thái sau hoàn tác — giống hệt trước #4:

| File | Trạng thái |
|---|---|
| `packages/tool/duckduckgo-web-search/` | khôi phục từ git, giống bản gốc |
| `packages/web-search/` | đã xoá (thư mục do tôi tạo) |
| `README.md`, `docs/core-overview.md` | trả về bản gốc trong git |
| `packages/profile-template/template/profile.package.json`, `package.json`, `tsconfig.json`, `pnpm-lock.yaml` | trỏ lại `@fox-harness/dsh-tool-duckduckgo-web-search` |
| `services/orchestrator/src/config.ts`, `.env.example` | bỏ `SERPER_API_KEY` |
| `infra/docker/worker/Dockerfile` | chú thích `curl` trỏ lại `packages/tool/duckduckgo-web-search/src/search.ts` |
| `packages/skills/**` | tool trở lại `duckduckgo_web_search` (21 chỗ) |
| `apps/web/.../Conversation.tsx`, `translations.ts`, `style.css` | bỏ danh sách nguồn |

**Vấn đề vẫn còn nguyên như trước #4:**

- Model thấy 2 tool tìm web: `duckduckgo_web_search` và `web_search` của DeepSeek
  (hỏng — thiếu `DEEPSEEK_API_KEY`).
- DuckDuckGo đang chặn theo IP máy chủ này (CAPTCHA "Unfortunately, bots use
  DuckDuckGo too", kể cả với cookie mới) — tìm web trên máy này đang lỗi.

(Cả 2 vấn đề trên đã xử lý ở #4b.)

## #4b — Tìm web qua Serper, gỡ DuckDuckGo (2026-09-14)

Thiết kế user chốt: thư mục mới **trong `packages/tool/`**, dùng tool
`web_search` + tổng đài `ctx.web` có sẵn của dsh, fox chỉ viết **nguồn tìm**
`serper`. User đồng ý xoá luôn DuckDuckGo.

Luồng chạy: model gọi `web_search` (dsh-tool-web) → `ctx.web.search()` →
đọc `searchProvider: serper` → `packages/tool/serper-web-search` gọi
`https://google.serper.dev/search` → trả `{ sources, truncated }`.

| File | Loại | Sửa gì |
|---|---|---|
| `packages/tool/serper-web-search/` (`package.json`, `tsconfig.json`, `cordis.patch.yml`, `README.md`, `src/index.ts`, `src/search.ts`) | [mới] | Đăng ký nguồn tìm id `serper` vào `ctx.web`. Lấy key `SERPER_API_KEY` (credentials → biến môi trường); thiếu key → lỗi `Serper search has no API key: set SERPER_API_KEY in .env`; Serper trả lỗi → `Serper search failed: HTTP <mã> <nội dung>`. Chỉ lấy kết quả `organic` (title, link, snippet, date). Không tự đăng ký tool |
| `packages/tool/duckduckgo-web-search/` | [xoá] | Theo yêu cầu user |
| `packages/profile-template/template/cordis.patch.yml` | [sửa] | Thêm dòng `- id: web … searchProvider: serper` (thay `deepseek-official` của dsh-base) |
| `packages/profile-template/template/profile.package.json`, `package.json`, `tsconfig.json`, `pnpm-lock.yaml` | [sửa] | Thay `@fox-harness/dsh-tool-duckduckgo-web-search` bằng `@fox-harness/dsh-tool-serper-web-search` |
| `services/orchestrator/src/config.ts` | [sửa] | Thêm `SERPER_API_KEY` vào `workerEnvPassthrough` (biến chưa đặt thì bỏ qua — `docker.ts:71`) |
| `.env.example` | [sửa] | Thêm `SERPER_API_KEY=` |
| `packages/skills/**` | [sửa] | `duckduckgo_web_search` → `web_search` (20 chỗ, 11 file); `web-research-guide.md` mục 5 ghi "kết quả Google qua Serper"; `packages/skills/README.md` ghi tool mới |
| `README.md`, `docs/core-overview.md` | [sửa] | Mô tả package mới thay DuckDuckGo |
| `infra/docker/worker/Dockerfile` | [sửa] | Thêm ghi chú: tool DuckDuckGo đã gỡ, `curl` vẫn giữ cho lệnh bash |
| `services/orchestrator/src/materialize.ts`, `services/orchestrator/src/archive.ts`, `services/gateway/src/index.ts` | [sửa] | Chú thích ví dụ trỏ sang package mới / bỏ ví dụ DuckDuckGo |

Không sửa: tài liệu nhật ký cũ có ngày (`docs/code-rules.md`,
`docs/agent-core-architecture-roadmap.md`, `docs/security-performance-review-2026-09-09.md`, …)
— giữ nguyên như lịch sử.

### Dữ liệu hội thoại cũ

Orchestrator chỉ chép profile **1 lần** khi tạo hội thoại / dựng container sẵn
(`materialize.ts`), mở lại hội thoại cũ không chép lại (`ensure.ts`). Profile
cũ còn ghi package DuckDuckGo đã xoá → mở lại sẽ lỗi. Đã sửa tay **16 profile**
trong `data/dsh-home/*/profiles/fox-harness` và `data/dsh-home/_pool/*/profiles/fox-harness`
(5 hội thoại + 11 thư mục pool; 2 trong số đó còn tên `@fox-harness/dsh-web-search`
từ bản #4 đầu): đổi tên package + thêm dòng `web`. Bản gốc chép ở scratchpad
`profile-backup-2026-09-14/`.

### Kiểm tra #4b

Worker chạy trên máy + LLM giả (gọi `web_search`) + Serper giả trong tiến trình:

| Trường hợp | Kết quả |
|---|---|
| Không có `SERPER_API_KEY` | ✅ `tool/result` lỗi: `Serper search has no API key: set SERPER_API_KEY in .env`, không gọi mạng |
| Key sai (Serper giả trả 403) | ✅ lỗi: `Serper search failed: HTTP 403 {"message":"Unauthorized."}` |
| Key đúng | ✅ `meta.sources` = 2 (bỏ mục không có link), có `publishedAt`; model nhận khối `Sources:` có link markdown; Serper nhận `{"q":"…","num":8}` |
| Danh sách tool | ✅ có `web_search`, không còn `duckduckgo_web_search` |

Bộ fox đầy đủ + Qwen thật (tài khoản `smoke-test@fox.local`), sau khi build lại
image, thay container dựng sẵn, khởi động lại orchestrator:

| Kiểm tra | Kết quả |
|---|---|
| Mở lại hội thoại cũ `9cd89a65` (profile đã sửa) | ✅ container mới chạy được; model gọi `web_search` (3 truy vấn, đúng năm 2026) → lỗi thiếu key → nói thẳng không tra được |
| Hội thoại mới (container dựng sẵn) | ✅ như trên |
| **Serper thật** (sau khi user thêm `SERPER_API_KEY`, khởi động lại orchestrator, thay container dựng sẵn) | ✅ hỏi "giá vàng SJC hôm nay, ghi rõ nguồn" → `web_search` trả nguồn thật (vietnamnet.vn, ngày 14/9/2026) trong ~1,5 giây → model trả lời có số liệu và link nguồn |

## Kiểm tra

### Worker chạy trên máy + LLM giả (ghi lại nguyên văn request)

LLM giả được dựng để gọi `web_search` ở request đầu.

| Kiểm tra | Kết quả |
|---|---|
| System prompt có đủ 4 phần mới, đúng thứ tự (persona → ground-rules → operating-policy → completion → Environment) | ✅ |
| Dòng ngày | ✅ `Current date: 2026-09-14 (UTC). This IS "today" — current year is 2026, last year is 2025.` |
| Danh sách tool: có `web_search`, **không còn** `duckduckgo_web_search`, vẫn có `create_skill` | ✅ |
| `web_search` đi vào nguồn `fox-web-search` (không còn lỗi thiếu `DEEPSEEK_API_KEY`) | ✅ |
| Dùng `curl` giả trả trang kết quả mẫu: `tool/result` có `meta.sources` (2 nguồn, đủ url/title/snippet), model nhận khối "Sources:" có link | ✅ |
| Sự kiện `session/title` vẫn phát (`source.kind: fallback`) | ✅ |
| **DuckDuckGo thật từ máy chủ này** | ❌ bị chặn theo IP ("bot-challenge page") — không có `SERPER_API_KEY` thì `web_search` trên máy này lỗi |

### Bộ fox đầy đủ + model Qwen thật + Chrome thật (tài khoản thử `smoke-test@fox.local`)

Hỏi *"Giá vàng SJC mới nhất hôm nay bao nhiêu?"* sau khi build lại image worker
và thay container dựng sẵn:

| Kiểm tra | Kết quả |
|---|---|
| #1 — câu tìm có đúng năm | ✅ `"giá vàng SJC hôm nay 2026"`, `"tỷ giá vàng SJC mới nhất ngày 14/09/2026"` (trước khi sửa: `"tháng 12 năm 2024"`) |
| #1 — tool lỗi thì nói thẳng, không bịa số | ✅ model trả lời "hiện tại tôi không thể tra cứu được giá vàng SJC mới nhất vì công cụ tìm kiếm web đang gặp vấn đề" |
| #3 — tên tự hiện ở thanh bên | ✅ "Giá vàng SJC mới nhất" hiện chưa tới 1 giây sau khi gửi; API `GET /sessions/mine` có title |
| #3 — hội thoại cũ chưa có tên không bị đổi tên / nhảy thứ tự | ✅ 5/5 giữ nguyên `title` và `updated_at` |
| #4 — model chỉ thấy và gọi `web_search`, lỗi hiện gọn trong ô tool | ✅ |
| #4 — danh sách nguồn trên giao diện thật | ⚠️ **chưa thấy**: DuckDuckGo chặn IP máy chủ này nên không có kết quả. Đường dữ liệu (`meta.sources`) đã kiểm ở bài thử trên máy; phần hiển thị cần chạy lại khi có `SERPER_API_KEY` |

