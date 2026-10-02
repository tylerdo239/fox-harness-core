# Tổng quan bộ core — hiện trạng thật (cập nhật 2026-10-02: đã bỏ orchestrator, còn FE + BE)

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
single-process, single-user. Đây là phần tự xây 100%: `services/gateway` (gồm
supervisor của runtime), `apps/web`.

## 2. Sơ đồ luồng thật

```
Browser (apps/web — 1 React SPA tĩnh, build 1 lần, dùng chung mọi user)
   │  HTTP (auth, REST) + WebSocket (chat stream)
   ▼
web (nginx) ── phục vụ static; chuyển /auth, /sessions, /projects, ... và WebSocket tới backend cùng origin
   ▼
backend (1 container)
   ├─ services/gateway ── auth thật (MariaDB users + Redis token trượt TTL), REST, phân quyền theo user id,
   │                      proxy WS byte-blind, skills/file/project theo user, quota, và SUPERVISOR của runtime
   └─ N tiến trình `dsh` (FOX_RUNTIME_COUNT) do gateway khởi động — mỗi tiến trình chạy NHIỀU session
        packages/agent-driver   (thay agent-loop; scope riêng cho từng agent)
        packages/core           (model theo agent + quota token dựng lại từ log)
        packages/llm/openai-compat, packages/tool/*, packages/transport (WS server + tool guard)
        flow = agent preset (packages/profile-template/presets/<flow>), join theo từng session

Redis   — token đăng nhập + rate-limit (không còn affinity/warm pool)
MariaDB — discovery_users, discovery_sessions, discovery_projects, discovery_custom_skills
Đĩa     — <GATEWAY_DATA_DIR>: dsh-home (log session = nguồn sự thật), users/<userId>/<sessionId>, projects/<id>
```

Trạng thái của một session chỉ là **log trên đĩa**: runtime không giữ trạng thái điều khiển, gateway truyền
flow/model/cwd/owner (đọc từ hàng `discovery_sessions`) ở MỌI lần kết nối. Runtime chết → session tự resume từ log
ở lần kết nối sau; session idle bị gỡ khỏi RAM và cũng resume như vậy.

`packages/contracts` là type-only, dùng chung giữa `services/gateway` và `apps/web` — quy tắc cứng
(`docs/code-rules.md` §1): `services/*` không bao giờ import trực tiếp từ package `dsh-*` nào, chỉ từ `contracts`.

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

### 3.5 `packages/transport` (`@fox-harness/dsh-transport`) — WS bên trong mỗi runtime

1 kết nối WebSocket = 1 session: `ws://.../sessions/new?id=` mint session mới, `ws://.../sessions/<id>` reconnect;
query `flow`, `model`, `cwd`, `user`, `output` do gateway truyền. Giao thức snapshot-rồi-live. Một listener
`session/event` duy nhất cho cả process (`Hub`, fan-out theo `Map<sessionId, Set<ws>>`), frame đến trước khi session
sẵn sàng được xếp hàng, session idle bị dispose khỏi RAM (`FOX_IDLE_DISPOSE_MS`), tạo/resume single-flight theo id.
`setup` của agent join preset của flow (`flows.ts`) và gắn `workspace-guard.ts` (từ chối tool có đường dẫn ra ngoài
cwd của session). Bind loopback, mọi kết nối/HTTP phải mang secret của gateway.

### 3.6 `packages/contracts` — type-only, ranh giới cứng

Package DUY NHẤT `services/*` được phép import. Không có prefix `dsh-` (vì
không phải Cordis plugin).

### 3.7 `packages/profile-template` — profile hợp nhất + preset theo flow

Không phải bundle `dsh`. `runtime/template/` là profile DUY NHẤT mọi runtime khởi động (gateway copy ra
`<dsh-home>/profiles/fox-harness/` mỗi lần start); `presets/{default,data-analysis,data-studio}/` là 3 flow dưới dạng
agent preset (persona + tool riêng của flow). Khác biệt từng flow trước đây là `disabled: true` cấp process nay nằm ở
`packages/transport/src/flows.ts` (mask tool theo agent) và trong preset. `profile-boot` của dsh ép `roots` của
`agent-presets` về thư mục preset đóng gói, nên preset của ta nạp qua `$DSH_HOME/.agent-presets` (symlink do gateway tạo).

### 3.8 `services/gateway` — auth + REST + proxy + supervisor runtime

Container-built, không import package `dsh-*` nào (chỉ `contracts`). Route, luồng kết nối, cô lập và cấu hình: xem
`services/gateway/README.md`. Điểm cốt lõi: gateway là nơi DUY NHẤT biết user là ai; mọi đường dẫn đĩa dựng từ id đã qua
kiểm tra quyền (`users/<userId>/<sessionId>`); runtime nhận env allow-list, secret mỗi lần boot, và chạy trong thư mục
không có `.env`.

### 3.9 Supervisor runtime (`services/gateway/src/runtime/`) — thay cho `services/orchestrator`

Khởi động `FOX_RUNTIME_COUNT` tiến trình `dsh`, chờ tới khi nhận được WS handshake thật, restart có backoff, chọn shard
`hash(sessionId) % N`, dừng êm (SIGTERM → runtime flush log → SIGKILL sau `FOX_SHUTDOWN_GRACE_MS`). Ở production **từ chối
khởi động nếu không có sandbox chặt** (`fox-confine.sh` + bubblewrap) hoặc data dir nằm trong git checkout.
Skill theo user ghi vào `<workspace>/.dsh/skills`; purge session = runtime nhả session, xoá workspace + log dsh.
Không còn warm pool, affinity Redis, hibernate bằng container, archive (chưa chuyển sang — xem mục 5).

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

- **Multi-user thật**: đăng ký/đăng nhập/đăng xuất thật, 2 role, token thu hồi được ngay (Redis), TTL trượt theo hoạt
  động thật, gateway là điểm enforce authorization DUY NHẤT (theo user id, mọi route), rate-limit thật.
- **Multi-session thật trong một runtime**: mỗi runtime `dsh` phục vụ nhiều session của nhiều user; mỗi agent có scope
  riêng, flow là agent preset. Session idle bị gỡ khỏi RAM và resume từ log; runtime chết thì session tự resume ở lần
  kết nối sau (đã test bằng `docker restart` và `kill -9`).
- **Cô lập giữa user — tự xây, nhiều lớp** (dsh nói rõ scope/preset KHÔNG phải ranh giới bảo mật): (1) authorization +
  đường dẫn dựng từ id đã kiểm; (2) `workspace-guard` từ chối tool có đường dẫn ra ngoài workspace (theo symlink);
  (3) `fox-confine.sh` — bubblewrap root rỗng cho bash/python, env allow-list (`env -i`); (4) secret mỗi lần boot giữa
  gateway và runtime. Đo thật: 22 vector đọc/ghi chéo + 8 kiểm tra python, 0 rò rỉ (docs/single-backend-architecture-plan.md §13).
- **Chat turn thật**: streaming qua model OpenAI-compatible thật, resume được giữa chừng dù reload trang hay runtime bị kill.
- **Tool thật**: `web_search` (Serper), `python` (1 kernel/cuộc hội thoại, ngắt được cell quá hạn), `analyze_data` (pool
  worker + hàng đợi), skill theo user (`<workspace>/.dsh/skills`), file/project theo user.
- **Quota thật**: số session đồng thời (toàn cục và theo user), token budget/session (dựng lại từ log nên không reset khi resume).
- **Năng lực cố định, giống nhau cho mọi user**: capability là bundle cố định trong profile hoặc preset của flow — không
  có "user tự chọn/bật-tắt". Thêm năng lực = package + profile/preset + `dependencies` + build lại image.
- **1 UI thật, dùng chung mọi user** (theme, i18n vi/en, sidebar, toast…).
- **Xoá theo yêu cầu**: `DELETE /sessions/:id` (runtime nhả session, xoá workspace + log), xoá project xoá cả chat của nó.
- **Telemetry**: log JSON có `sessionId` xuyên gateway → runtime; `/healthz`, `/readyz`.
- **Deploy 2 service**: image `backend` + `web`, compose ở `infra/deploy/`, test e2e `scripts/e2e-backend.mjs`.

## 5. Giới hạn/gap thật hiện tại (ghi rõ, không giả vờ đã xong)

- **Cô lập logic, không phải ranh giới kernel cho tool chạy trong process**: `workspace-guard` là policy fence (còn
  cửa sổ check-then-use, không nhìn được vào dòng lệnh `bash`); ranh giới thật cho bash/python là bubblewrap. Một lỗ
  hổng trong runtime hoặc thoát được sandbox là đọc được dữ liệu của mọi user cùng lúc. Production bắt buộc có sandbox
  (gateway từ chối khởi động nếu thiếu). gVisor/microVM mới chỉ có chiến lược (`docs/microvm-isolation-strategy.md`).
- **Trần thông lượng của một runtime**: ~2.300–2.800 chunk-event/s ≈ 100–150 session *đang stream cùng lúc* (đo bằng
  mock LLM, máy dev). Dùng `FOX_RUNTIME_COUNT` để dùng nhiều core; chưa đo với LLM thật và phần cứng thật.
- **Một replica BE**: nhiều replica cần sticky routing theo session id + storage dùng chung + khoá mở session.
- **Mất log chưa flush khi runtime bị kill**: phần reply đang stream bị mất (turn được đóng là `interrupted`).
- **`OPENAI_API_KEY` dùng chung**, runtime giữ trong env của nó (không lọt vào bash/python) — chưa có LLM-call proxy riêng.
- **Archive/hibernate ra ngoài đĩa chưa chuyển sang** kiến trúc mới (orchestrator cũ có, mặc định tắt). Chat log lưu
  đĩa cục bộ của 1 volume, chưa lên object storage (`docs/object-storage-strategy.md`).
- **bash của flow `default` còn mạng và đọc được `/usr`, `/etc` tối thiểu** (allow-list); chưa cắt mạng.
- **Chọn model chỉ lúc tạo session**; chưa có reasoning-effort picker, chưa có UI quản lý nhiều provider.
- **Chưa từng chạy qua browser thật** — verify FE là Node WS client thật hoặc jsdom + React.
- **Escalation `danger-full-access` luôn bị chặn, có chủ đích** — không có approval channel.
- **dsh ghim `0.1.1-rc.2`**; bản mới hơn (0.2.0-rc.2) đổi preset sang plugin bundle, `agent/created`, log V4 — nâng cấp là dự án riêng.

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
