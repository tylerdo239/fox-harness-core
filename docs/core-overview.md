# Tổng quan bộ core — hiện trạng thật (tính đến 2026-09-11)

Tài liệu này khác `docs/agent-core-architecture-roadmap.md` (kế hoạch +
research theo từng phase, có phần chưa làm) và `docs/code-rules.md` (nhật ký
lỗi/sửa theo thứ tự thời gian). Đây là **ảnh chụp hiện trạng**: bộ core hiện
có những cấu phần nào, logic nào dựa trên `dsh` thật, và làm được gì THẬT SỰ
tính đến hôm nay — không phải kế hoạch, không phải lịch sử. Mọi con
số/route/table liệt kê dưới đây đọc trực tiếp từ source thật lúc viết tài
liệu này, không suy đoán từ trí nhớ.

## 1. Chiến lược nền: "nấc 2"

`fox-harness-core` KHÔNG fork `@deepseek-ai/dsh` (deepseek harness). Nó dùng
`dsh` như 1 dependency thật (cài qua npm, chạy qua Cordis plugin runtime của
chính `dsh`), chỉ thay đúng 1 thứ: **`core/agent-loop`** (vòng lặp
turn/step/tool-call gốc) → `packages/agent-driver` (viết riêng, đọc source
thật của `dsh-agent-loop` để bắt chước đúng hành vi). Mọi thứ khác của `dsh`
— LLM adapter registry, tool registry, session/event log (nguồn sự thật
durable), Cordis plugin runtime, profile/bundle system — **giữ nguyên, dùng
thật**, không viết lại.

Toàn bộ lớp **multi-tenant** (nhiều user, nhiều session cùng lúc, cô lập
từng session) **hoàn toàn KHÔNG có sẵn trong `dsh`** — `dsh` gốc là 1 harness
single-process, single-user. Đây là phần tự xây 100%: `services/gateway`,
`services/orchestrator`, `apps/web`.

## 2. Sơ đồ luồng thật

```
Browser (apps/web — 1 React SPA tĩnh, build 1 lần, dùng chung mọi user)
   │  HTTP (auth, REST) + WebSocket (chat stream)
   ▼
services/gateway  ── auth thật (MariaDB users + Redis token trượt TTL), CORS,
   │                  proxy — KHÔNG chạy agent logic gì cả
   ▼
services/orchestrator ── vòng đời container (spawn/hibernate/rehydrate/
   │                      warm-pool), 1 session = 1 container Docker riêng
   ▼
Container worker thật (1 cái/session) — chạy `dsh` thật với:
   packages/agent-driver   (thay agent-loop)
   packages/core           (agent/request routing + quota)
   packages/llm/openai-compat  (LlmAdapter thật)
   packages/tool/serper-web-search
   packages/transport      (WS server bên trong worker)
   -- mọi năng lực đều là bundle CỐ ĐỊNH, giống nhau cho mọi user/session

Redis   — session affinity (fh:session:*), warm pool, login token store
MariaDB — users, sessions
```

`packages/contracts` là type-only, dùng chung giữa `services/*` và
`apps/web` — quy tắc cứng (`docs/code-rules.md` §1): `services/*` không bao
giờ import trực tiếp từ package `dsh-*` nào, chỉ từ `contracts`. `services/*`
cũng không bao giờ import lẫn nhau — chỉ nói chuyện qua HTTP thật. Chỉ 4
type export thật hiện có: `EnsureSessionRequest`/`EnsureSessionResponse`
(gateway↔orchestrator), `TouchSessionReason`, `ModelsResponse`.

## 3. Từng cấu phần thật

### 3.1 `packages/agent-driver` (`@fox-harness/dsh-agent-driver`) — logic lõi nhất dựa trên `dsh`

Thay `core/agent-loop` thật — `src/agent.ts`/`src/factory.ts`, viết bằng
cách đọc thẳng TypeScript source thật của `@deepseek-ai/dsh-agent-loop`
(không đoán), verify lại bằng `.d.ts` đã cài + boot thật. Có `resume()`/
`wake()` thật — flush session lúc idle để không mất turn cuối khi container
bị kill giữa chừng. Tự đăng ký lại 3 system-prompt template variable
(`provider`/`model`/`cwd`) mà `dsh-agent-loop` gốc có, vì thay driver cũng
làm mất side-effect setup-time đó nếu không tự thêm lại. Tool-call loop
(`runStep()`) chỉ đưa field `error` vào event `tool/result` khi
`result.error.info` THẬT SỰ có giá trị (không chỉ khi `result.isError`) —
`dsh-session`'s `Session.append()` từ chối `undefined` tường minh như
non-JSON-serializable, và không phải mọi tool error đều là `HarnessError`
có `.info` (2026-09-11, `docs/code-rules.md` §83).

### 3.2 `packages/core` (`@fox-harness/dsh-core`) — bundle sản phẩm

Đúng 2 file thật (`src/index.ts`, `src/quota.ts`):
- `index.ts`: lắng nghe waterfall `agent/request` (driver ở trên phát ra),
  route `provider`/`model` theo biến môi trường `OPENAI_MODEL_ID` — đây là
  cơ chế làm "chỉ cần set biến môi trường, không cần sửa patch file" hoạt
  động.
- `quota.ts`: giới hạn token/session qua `agent/pre-step` — cùng cơ chế
  `reject | enter(messages)` chuẩn, không phát minh mới. Biết trước: counter
  chỉ ở RAM, reset khi hibernate/rehydrate (chưa replay lại từ log).

### 3.3 `packages/llm/openai-compat` — `LlmAdapter` thật

Đăng ký qua `ctx.llm.registerAdapter()`, cùng seam `dsh-llm-deepseek` dùng.
Chạy được với OpenAI thật, Azure OpenAI, hoặc bất kỳ server tự host nào nói
cùng giao thức `/chat/completions` SSE (Ollama, vLLM, LM Studio,
OpenRouter...). Không thay thế `dsh-llm-deepseek` mặc định — cộng thêm.

### 3.4 `packages/tool/serper-web-search` — nguồn tìm kiếm web (Serper)

Cần `SERPER_API_KEY`. Không tự đăng ký tool: model dùng tool `web_search`
có sẵn của dsh (`dsh-tool-web`), package này chỉ cắm nguồn tìm `serper` vào
`ctx.web`. Nguồn được chọn bằng dòng `searchProvider: serper` trong
`packages/profile-template/{default,data-analysis}/template/cordis.patch.yml`. Thay cho
`packages/tool/duckduckgo-web-search` (gỡ 2026-09-14 — DuckDuckGo chặn IP
máy chủ).

### 3.5 `packages/transport` (`@fox-harness/dsh-transport`) — WS bên trong worker

1 kết nối WebSocket = 1 session. `ws://.../sessions/new` mint session mới,
`ws://.../sessions/<id>` reconnect. Giao thức snapshot-rồi-live (không phải
resume-from-cursor) — mỗi lần connect nhận `{type:'snapshot', events}` đầy
đủ rồi mới tiếp tục nhận `{type:'event'}` từng cái mới. Client gửi
`{type:'followup'|'steer', text}`. Bind mặc định `127.0.0.1` — chỉ nghe
loopback trong container.

### 3.6 `packages/contracts` — type-only, ranh giới cứng

Package DUY NHẤT `services/*` được phép import. Không có prefix `dsh-` (vì
không phải Cordis plugin).

### 3.7 `packages/profile-template` — KHÔNG phải bundle `dsh`

Chỉ là file mẫu (`template/profile.package.json` +
`template/cordis.patch.yml`) — `services/orchestrator` copy nó ra thành
`$DSH_HOME/profiles/fox-harness/` thật cho từng session lúc materialize,
không phải thứ `dsh` tự phát hiện qua `node_modules`. `bundles` liệt kê
đúng 6 package: `dsh-base` + 5 package tự viết ở mục 3.1-3.5.

### 3.8 `services/gateway` — auth + proxy, chặn giữa mọi thứ

Container-built, không import package `dsh-*` nào (chỉ `contracts`), KHÔNG
chạy agent logic gì. Route thật hiện có (đọc trực tiếp từ `src/index.ts`):

- `POST /auth/register` / `POST /auth/login` / `POST /auth/logout` — tài
  khoản thật (MariaDB `users`), token random 32-byte hex lưu Redis có TTL
  **trượt** (sliding expiration — `GETEX` gia hạn mỗi lần có hoạt động
  thật, REST hoặc frame WS, không phải đếm ngược cứng từ lúc login), thu
  hồi thật lúc logout. `role` chỉ có `user`/`admin`, không bao giờ tạo
  `admin` qua `register()` (chỉ qua `scripts/create-admin.mjs`, ngoài
  HTTP).
- `GET /sessions` (admin), `GET /sessions/mine`, `PATCH /sessions/:id`
  (rename), `DELETE /sessions/:id` (purge).
- `ws://.../sessions/new?token=` / `ws://.../sessions/:id?token=` — proxy
  trong suốt tới `packages/transport` của đúng worker.
- `GET /sessions/:id/plugin-inventory` — đọc live Cordis Loader state thật
  của worker đó (chẩn đoán).
- `GET /models` — không cần auth (đọc trước khi có token).
- `GET /users` — admin-only.

### 3.9 `services/orchestrator` — vòng đời container

Spawn/hibernate/rehydrate/TTL/warm-pool thật qua `dockerode` + Redis affinity
(`ioredis`). KHÔNG BAO GIỜ biết nội dung session — chỉ affinity/lifecycle.
Mọi route yêu cầu header shared-secret thật từ gateway
(`x-fox-harness-internal-secret`, `timingSafeEqual`) — không phải per-user
auth, chỉ xác thực đúng caller là gateway. Container spawn có giới hạn
resource thật (`Memory`/`NanoCpus`/`PidsLimit`).
Materialize `$DSH_HOME/profiles/fox-harness/` từ `profile-template` mỗi
session (không phải việc `dsh` tự làm): copy thẳng `profile.package.json`
từ template, ghi override host/port cho `packages/transport`. Cũng giữ
quota "số session chạy đồng thời" + "tuổi tối đa 1 session" (2 trong 3
quota thật — quota thứ 3, token/session, nằm ở `packages/core` như mục
3.2). Rehydrate luôn spawn container MỚI, không bao giờ restart container
cũ — buộc state phải sống lại từ log.

**MariaDB schema thật (2 bảng, `infra/migrations/001_init.sql`):**
`users`, `sessions` (có `first_message_at` — chỉ session THẬT SỰ đã chat
mới hiện trong `GET /sessions/mine`).

### 3.10 `apps/web` (`@fox-harness/web`) — 1 React SPA tĩnh

Build 1 lần bằng esbuild thành 1 file `main.js` IIFE, mọi user dùng chung 1
bundle. Có URL routing thật (`/` hoặc `/chat/<id>`, `history.pushState`/
`replaceState` tay, không router library — 2026-09-09), ẩn hoàn toàn tới
khi có tin nhắn thật đầu tiên, đúng quy tắc `first_message_at` phía
backend. i18n thật 2 ngôn ngữ (Việt mặc định, Anh — 2026-09-10).

`components/` chia `primitives/` (Button/IconButton/Input/MenuItem/
SelectableCard — generic, không biết gì về domain) + `features/` (nhóm
theo layout/page thật: `auth/`, `sidebar/`, `conversation/`, `settings/`,
cộng 1 file phẳng `LanguageSelect.tsx` dùng chung 2 nơi). Component thật
hiện có (2026-09-10, đọc trực tiếp từ source, không phải danh sách cũ):
`App.tsx` (auth/kết nối/layout/routing, `Runtime` context —
`authedFetch()` tự đưa về màn login khi token hết hạn thật; màn spinner
loading thật lúc đang tự động reconnect bằng token đã lưu, tránh flash
form login), `features/auth/ConnectForm.tsx` (màn login/register riêng, có
validate rõ 3 loại lỗi khác nhau trước khi gọi server),
`features/sidebar/Sidebar.tsx` (brand row + search + collapse toggle
thật, nút "New chat" — no-op nếu đang ở 1 chat rỗng chưa nhắn gì, account
row mở popup Settings/Logout), `features/sidebar/HistoryChat.tsx` (đổi
tên từ `SessionList.tsx` — danh sách lịch sử chat nhóm theo ngày, mỗi row
hover hiện nút "..." mở popup Đổi tên (input inline, check tối đa 255 ký
tự)/Xoá thật), `features/conversation/Conversation.tsx` (log + composer —
KHÔNG còn `/`-command palette, KHÔNG còn hiện reasoning của model (đã bỏ
hẳn), tool call/result hiện thành 1 pill thu gọn/bấm để xem chi tiết,
assistant reply không còn bọc trong bubble container — chỉ tin nhắn user
mới có bubble), `features/settings/SettingsDialog.tsx` (2 tab General/
Profile thật — KHÔNG còn `PluginInventory.tsx`, đã xoá hẳn khỏi app),
`features/auth/ThemeToggle.tsx`/`features/LanguageSelect.tsx` (light/dark
+ vi/en thật, màu chủ đạo cam `#F37021`), toast thật qua thư viện
`sonner`. Icon dùng `lucide-react`.

## 4. Bộ core làm được gì — checklist năng lực thật

- **Multi-user thật**: đăng ký/đăng nhập/đăng xuất thật, 2 role, token thu
  hồi được ngay (Redis), TTL trượt theo hoạt động thật (không đăng xuất oan
  user đang dùng), gateway là điểm enforce authorization DUY NHẤT — sai
  password/nonexistent email không còn phân biệt được qua timing, có
  rate-limit thật. Orchestrator vẫn không tự biết user là ai (đúng ranh
  giới kiến trúc gốc), chỉ xác thực caller là gateway qua shared-secret.
- **Multi-session/multi-tenant thật**: mỗi session 1 container Docker
  riêng, không bao giờ chung process giữa 2 user. Hibernate theo TTL rảnh,
  rehydrate lại đúng dữ liệu khi có request mới, warm pool giảm độ trễ cold
  start.
- **Chat turn thật**: streaming reasoning + text qua model OpenAI-compatible
  thật, resume được giữa chừng dù reload trang hoặc container bị kill (log
  event durable là nguồn sự thật, không phải WS connection).
- **Tool-call thật**: `web_search` (nguồn Serper) — model gọi thật, có kết
  quả thật.
- **Sandbox thật cho bash/fs tool** (2026-09-11, `docs/
  agent-core-architecture-roadmap.md` Phase 18): `dsh-sandbox`/
  `dsh-sandbox-local` (bwrap trên Linux) đã hoạt động thật trong container
  worker — `bubblewrap` cài trong image + `CAP_SYS_ADMIN` cấp cho tiến
  trình `dsh` (không phải lệnh model chạy) để `bwrap` tự dựng PID
  namespace cô lập. Xác nhận qua WS thật: lệnh bash chạy CONFINED
  (`workspace-write`), trả stdout thật, không còn `SANDBOX_UNAVAILABLE`.
  Đây là lớp phòng thủ THỨ 2 bên trong mỗi container — không thay thế cô
  lập multi-tenant hiện có (1 container Docker/session).
- **Quota thật**: giới hạn session đồng thời (global), tuổi tối đa 1
  session, token budget/session — cả 3 đều thật, không phải placeholder.
- **Năng lực cố định, giống nhau cho mọi user thật**: search
  (`web_search`) và mọi capability khác đều là bundle CỐ ĐỊNH
  trong profile — không có khái niệm "user tự chọn/bật-tắt". Thêm năng lực
  mới = viết 1 package thật + `insert:` vào cây plugin + redeploy.
- **1 UI thật, dùng chung mọi user**: theme light/dark thật (đổi được, lưu
  lại), sidebar đúng cấu trúc thật đối chiếu qua ảnh chụp `chat.deepseek.com`
  thật, toast thật có animation, empty-state composer thật khi chưa có tin
  nhắn.
- **Log retention thật**: archive/restore (`tar` thật) + xoá theo yêu cầu
  (`DELETE /sessions/:id`), verify bằng session archive-rồi-restore vẫn
  replay đúng.
- **Telemetry cross-layer thật**: log JSON có gắn `sessionId` xuyên suốt mọi
  service, verify bằng grep 1 sessionId thật qua từng log.

## 5. Giới hạn/gap thật hiện tại (ghi rõ, không giả vờ đã xong)

- **MicroVM isolation thật** — chỉ có chiến lược viết ra
  (`docs/microvm-isolation-strategy.md`, khuyến nghị gVisor `runsc`), CHƯA
  triển khai. Ranh giới cô lập thật hiện tại vẫn là Docker container
  thường (có giới hạn resource CPU/RAM/PID mỗi container từ 2026-09-09,
  nhưng chưa phải cô lập kernel-level).
- **`services/orchestrator` yêu cầu shared-secret từ gateway** (2026-09-09,
  không phải per-user auth — orchestrator vẫn không biết user là ai, chỉ
  xác thực đúng caller là gateway). `OPENAI_API_KEY` vẫn dùng chung, forward
  vào mọi container — chưa có LLM-call proxy riêng để tách biệt theo
  session. Xem `docs/security-performance-review-2026-09-09.md`.
- **Chat log + ảnh đính kèm lưu đĩa cục bộ 1 host** — chưa lên object
  storage, chưa có backup. Chiến lược đã viết sẵn, chưa làm:
  `docs/object-storage-strategy.md`.
- **Multi-provider credential admin UI** — chỉ 1 provider cố định qua biến
  môi trường, không có màn quản lý nhiều API key/provider.
- **Reasoning-effort picker, chọn model giữa chừng session** — model chỉ
  chọn được lúc TẠO session (tự động chọn model đầu tiên `GET /models` trả
  về), không đổi được giữa chừng.
- **Workspace/folder cho session** — chỉ có danh sách phẳng + nhóm theo
  ngày (Today/Yesterday/...), không có khái niệm thư mục/dự án.
- **Không có kho plugin cho user tự chọn năng lực khác nhau** — quyết định
  có chủ đích: mọi user thật ra cần giống nhau, không cần khác nhau. Cần
  bộ năng lực khác nhau theo nhóm user thật sự thì đây là việc xây LẠI,
  không phải bật lại thứ có sẵn.
- **Chưa từng chạy qua browser thật** — mọi verify FE là Node WS client
  thật hoặc jsdom + React thật, chưa có công cụ mở browser trong session
  này.
- **Escalation `danger-full-access` luôn bị chặn, có chủ đích** — không
  có approval channel nào được wire (hệ thống multi-tenant không có
  human-in-the-loop). Model thử escalate khi sandbox backend không dùng
  được sẽ luôn nhận lỗi `"no approval channel is available"`, không có UI
  duyệt nào để bật lên.
- **`warmpool.ts` không dọn thư mục pool member cũ** (2026-09-11,
  `docs/code-rules.md` §83) — `data/dsh-home/_pool/<uuid>` của pool
  member bị thay thế (hibernate/thay bằng replenish) không bao giờ tự
  xoá, tích luỹ vô thời hạn trên đĩa host. Quan sát thật: 76 thư mục mồ
  côi sau vài ngày test. Chưa sửa.

## 6. Đọc thêm

- `docs/agent-core-architecture-roadmap.md` — kế hoạch gốc + research chi
  tiết từng phase.
- `docs/code-rules.md` — nhật ký đầy đủ mọi lỗi thật tìm được + cách sửa,
  theo thứ tự thời gian — đọc khi cần hiểu TẠI SAO 1 quyết định cụ thể
  được chọn.
- `docs/security-performance-review-2026-09-09.md` — review bảo mật/
  performance/bug toàn bộ source, có file:line cụ thể.
- `docs/microvm-isolation-strategy.md`, `docs/object-storage-strategy.md` —
  2 chiến lược đã viết kỹ, chưa triển khai.
- `docs/schema/` — schema MariaDB + hướng dẫn setup, bản để gửi bên
  system/infra.
- `README.md`'s Status section — log tăng dần từng phase, có ngày tháng.
- README riêng của từng package/service liệt kê ở mục 3 — chi tiết nhất,
  luôn cập nhật cùng lúc code đổi.
