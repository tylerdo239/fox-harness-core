# Agent Core trên DeepSeek Harness — Kiến trúc tổng & lộ trình build

Tài liệu này gom lại các quyết định kiến trúc và chia việc thành các phase thực thi.

Trạng thái upstream: dsh đang ở **developer preview**, upstream cảnh báo sẽ có breaking change. Mọi quyết định dưới đây được chọn theo hướng giảm chi phí khi upstream đổi.

---

## 0. Nguyên tắc nền

Bốn nguyên tắc này quyết định gần như mọi lựa chọn còn lại trong tài liệu.

**0.1 — Không viết core mới.** Cordis đã là plugin runtime với reversible effect. dsh đã có session log, tool registry, LLM adapter seam, sandbox seam, approval policy. Không món nào là điểm khác biệt của sản phẩm. Giá trị của bạn nằm ở chỗ user tự lắp plugin thành flow riêng.

**0.2 — Quyền kiểm soát lấy ở nấc 2.** Thang độ kiểm soát:

| Nấc   | Cách làm                                     | Chi phí    | Quyền kiểm soát |
| ----- | -------------------------------------------- | ---------- | --------------- |
| 1     | Patch config row                             | Rất thấp   | Thấp            |
| **2** | **Thay `core/agent-loop` bằng driver riêng** | **Thấp**   | **Cao**         |
| 3     | Vendor vài package vào repo                  | Trung bình | Cao             |
| 4     | Viết lại từ đầu                              | Rất cao    | Toàn phần       |

Chọn nấc 2. `core/agent` giữ interface `Agent`, registry và event `agent/*`; `core/agent-loop` chỉ là driver mặc định. Viết driver riêng nghĩa là sở hữu toàn bộ turn flow mà vẫn dùng lại phần còn lại.

An toàn cho lựa chọn này: extension plugin phụ thuộc vào Service Definition chứ không phụ thuộc provider cụ thể; `dsh-agent-loop` là thứ swap được, còn plugin UI, hook và tool đều dùng `dsh-agent`. **Thay loop không làm gãy UI và tool.**

**0.3 — Fork mỏng, không clone.** Repo riêng, consume `@deepseek-ai/dsh` như dependency. Code của bạn chỉ là bundle + profile + control plane. Chỉ fork khi thật sự phải sửa `packages/`.

**0.4 — Log là nguồn sự thật duy nhất.** Session log là nguồn của context mà model nhìn thấy; `deriveMessages()` chiếu model history từ đó. Invariant của dsh: cái gì model nhìn thấy thì phải dựng lại được từ log. Đây là điều kiện để hibernate/rehydrate hoạt động, và là lý do state của session **không** được nằm trong process.

---

## 1. Kiến trúc tổng

### 1.1 Ba tầng

```
                    ┌──────────────────────────┐
   Edge             │  FE bundle tĩnh (CDN)    │   1 bản cho mọi user
                    └────────────┬─────────────┘
                                 │
                    ┌────────────▼─────────────┐
   Control plane    │        Gateway           │   auth, routing, streaming
                    └──────┬────────────┬──────┘
                           │            │
              ┌────────────▼──┐   ┌─────▼──────────────┐
              │ Orchestrator  │   │ Plugin registry    │
              │ spawn/hibern. │   │ duyệt, build, patch│
              └───────┬───────┘   └────────────────────┘
                      │
   Data plane   ┌─────┴──────┬─────────────┐
                ▼            ▼             ▼
          ┌──────────┐ ┌──────────┐ ┌──────────┐
          │ Harness  │ │ Harness  │ │ Harness  │  1 instance / user
          │ worker A │ │ worker B │ │ worker C │
          └──────────┘ └──────────┘ └──────────┘

   Stores: Postgres  ·  Redis  ·  Log store (object storage)
```

### 1.2 Cấu phần và trách nhiệm

| Cấu phần        | Ai viết              | Trách nhiệm                                                                   | Tuyệt đối không làm                                         |
| --------------- | -------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------- |
| FE bundle       | Bạn                  | Render từ `session/event`, gửi input qua `agent.followup()` / `agent.steer()` | Không chứa logic tenant; không nằm trong worker             |
| Gateway         | Bạn                  | Auth, phát token, routing + affinity, streaming fan-out, sinh manifest FE     | Không chạy agent logic                                      |
| Orchestrator    | Bạn                  | Spawn, hibernate, rehydrate, TTL, warm pool                                   | Không biết nội dung session                                 |
| Plugin registry | Bạn                  | Catalog, review, build/verify artifact, sinh `cordis.patch.yml` theo user     | Không cho worker tự `git clone` lúc runtime                 |
| Harness worker  | dsh + bundle của bạn | Agent logic, tool, plugin của user                                            | Không biết user là ai; không serve HTML; không multi-tenant |
| Postgres        | —                    | User, catalog plugin, bảng "user X bật plugin nào, config gì"                 | —                                                           |
| Redis           | —                    | `sessionId → node`, lock lúc spawn                                            | Không lưu dữ liệu cần bền                                   |
| Log store       | —                    | Session event log                                                             | —                                                           |

**Quy tắc phân tầng:** worker không biết gì về multi-tenant. Toàn bộ khái niệm "user" sống ở control plane. Nếu bạn thấy mình phải truyền `userId` vào trong harness để nó xử lý khác đi, đó là dấu hiệu logic đã rơi nhầm tầng.

### 1.3 Profile của bạn

Không dùng `dsh-web-app` (nó thêm browser application, mặc định phục vụ một người dùng cục bộ ở `127.0.0.1:3080`). Không dùng `dsh-headless` (one-shot runner, không có server).

Profile riêng, xếp lớp theo thứ tự:

```
1. dsh-base                    model adapter, tool, persistence,
                               sandbox, approval policy, settings,
                               credentials, telemetry
2. <your>-core                 9 component của bạn + driver thay agent-loop
3. <your>-transport            expose event stream + command endpoint
4. <your>-client-ui-theme      design token, primitive, component contract
5. cordis.patch.yml (per-user) plugin user bật, sinh bởi registry
```

Thứ tự áp dụng layer trong dsh: từng bundle theo thứ tự profile khai báo, rồi `cordis.patch.yml` của profile, rồi của home, rồi overlay `--patch`. Một patch nhắm vào row theo id và thay toàn bộ config của row đó, hoặc chèn row mới.

Profile của bạn **phải là kiểu live patch reload**. Profile `web` mặc định live; `headless`, `sdk`, `sdk-minimal`, `acp` chỉ apply một lần lúc khởi động vì thay dependency của ứng dụng one-shot hoặc stdio giữa chừng sẽ phá vòng đời của nó.

### 1.4 Cấu trúc repo

Một monorepo, pnpm workspace. Lý do không tách repo ngay: các package bundle phải resolve được qua `node_modules` để dsh compose profile, `contracts` dùng chung giữa FE và gateway, và ở Phase 1–3 interface còn đổi liên tục — tách repo lúc đó chỉ tạo vòng version bump vô ích. Tách khi nào một phần đã ổn định và có nhịp release riêng.

```
agent-platform/
├── pnpm-workspace.yaml
├── package.json
├── .npmrc                        trỏ internal npm registry
│
├── packages/                     ← PUBLISH lên internal registry
│   ├── core/                     @acme/dsh-core
│   │   ├── src/components/       9 component, mỗi cái 1 file/thư mục
│   │   ├── src/index.ts
│   │   ├── cordis.patch.yml      config row bundle này chèn
│   │   └── package.json          field dsh.bundle
│   ├── agent-driver/             @acme/dsh-agent-driver
│   │   └── src/                  implement interface Agent
│   ├── transport/                @acme/dsh-transport
│   ├── client-ui-theme/          @acme/dsh-client-ui-theme
│   │   ├── src/index.ts          host loader entry
│   │   ├── src/client/           browser implementation
│   │   ├── cordis.patch.yml      layer opt-in cho browser
│   │   └── package.json          dsh.bundle + dshClient
│   ├── contracts/                @acme/contracts — type dùng chung
│   └── profile/                  @acme/dsh-profile — field dsh.profile
│
├── services/                     ← KHÔNG publish, build ra container
│   ├── gateway/
│   ├── orchestrator/
│   └── plugin-registry/
│
├── apps/
│   └── web/                      FE bundle tĩnh
│
├── infra/
│   ├── docker/                   image cho worker và từng service
│   ├── deploy/
│   └── migrations/
│
└── docs/
```

**Ranh giới `packages/` với `services/` là quan trọng nhất.** `packages/` là npm package thật, có version, publish, và được worker resolve lúc boot. `services/` là ứng dụng, không bao giờ publish. Nếu thấy `services/gateway` import trực tiếp từ `packages/core`, dừng lại — gateway chỉ được biết `contracts`, không được biết nội tại của bundle. Đây là phiên bản code-level của quy tắc phân tầng ở mục 1.2.

**Hình dạng package client-ui** copy đúng convention của dsh: `package.json` mang manifest `dsh.bundle` và `dshClient`, `cordis.patch.yml` là layer opt-in cho browser, `src/index.ts` là host loader entry, `src/client/` là phần chạy trong browser, `lib/` chứa artifact sinh ra cho host và client. Theo đúng hình dạng này thì loader của dsh nhận ra package mà không cần patch thêm.

**Đặt tên `@acme/dsh-*`.** dsh quy ước mọi package scope `@deepseek-ai/dsh-*` và mỗi package thuộc đúng một nhóm capability. Giữ tiền tố `dsh-` cho package nào là plugin, bỏ nó cho package nào không phải (`contracts`) — nhìn tên là biết cái nào được compose vào cây plugin.

**Plugin của user: mỗi cái một repo riêng.** Bạn không kiểm soát phần này, nên phát hành một repo template có sẵn `package.json`, `cordis.patch.yml`, một conversation node mẫu, và test kiểm tra plugin unwind sạch khi dispose. Registry build từ repo đó (Phase 5), không cho worker tự clone.

**Cảnh báo sinh ra từ chính layout này.** Gotcha ở Phase 4 đến từ cách pnpm link package dạng symlink. Bạn sẽ đụng nó ngay khi `packages/client-ui-theme` được kéo vào qua dependency của package khác thay vì khai báo trực tiếp. Cách né rẻ nhất: **khai báo mọi package `dsh-client-ui-*` trực tiếp trong profile, không để chúng là dependency transitive.**

### 1.5 Mô hình UI

Web app của dsh không phải SPA monolith. Trang `index.html` mang theo boot manifest `window.__DSH_BOOT__`, từng plugin UI được serve ở đường dẫn dạng `/plugins/@deepseek-ai/dsh-client-ui-renderer/client.js`, khai báo trong `packages/bundle/web-app/cordis.patch.yml`.

Primitive (button, input, tag, label) **không** nằm trong một thư mục `components/`. Chúng nằm trong các package `@deepseek-ai/dsh-client-ui-*`, mỗi cái là một plugin: renderer là một plugin, brand/theme là plugin khác, attachment là plugin khác nữa. Có project cộng đồng đã tách design token và component contract riêng thành package theme.

**Hệ quả:** đường rẻ nhất là giữ shell + renderer, thay package brand/theme bằng của bạn. Bạn sở hữu token và primitive mà không phải viết lại streaming, conversation node, attachment. Chỉ thay renderer khi shell thật sự gò bó.

Contract giữa plugin và design system — chọn một, không trộn tùy tiện:

| Kiểu                         | Cách hoạt động                                                          | Ưu                                                       | Nhược                                                          |
| ---------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------- |
| **Khai báo** (mặc định)      | Plugin gửi node có `type` + data; FE tra key ra renderer đã compile sẵn | Không ship JS bên thứ ba; cache tốt; giao diện đồng nhất | Chỉ vẽ được cái đã định nghĩa trước                            |
| **Custom element** (hạn chế) | Mở slot, plugin ship JS riêng, mount vào                                | Plugin làm được mọi thứ                                  | Chạy code bên thứ ba trong origin của bạn, cùng session cookie |

Khuyến nghị: mặc định khai báo. Custom element chỉ mở cho plugin first-party hoặc đã review. Nếu bắt buộc mở rộng hơn, đẩy sang iframe origin riêng với postMessage thay vì mount thẳng vào DOM chính.

---

## 2. Luồng runtime

### 2.1 Một lượt chat

```
Gateway xác thực và route      token, sessionId → node
        │                      (nếu chưa có instance → spawn worker)
        ▼
Harness chạy turn              step, tool, assistant chunk
        ▼
Ghi session event log          durable TRƯỚC khi phát
        ▼
Fan-out SSE về browser         reload vẫn replay được
```

Thứ tự ghi-log-trước-rồi-mới-fan-out là bắt buộc. Nếu chunk chỉ đi thẳng tới browser, reload trang là mất nội dung.

### 2.2 Turn flow bên trong harness

Tham chiếu để viết driver riêng. Một **step** là một model request cộng các tool nó gọi. Một **turn** là zero hoặc nhiều step: mở trước khi input đầu tiên được claim, đóng khi không còn gì nợ.

```
turn/start
  claim next-step input + một queued message
  assemble prompt sections + tool schemas
  → agent/pre-step            reject | enter(messages)
     step/start
     append entered messages as user/message
     derive model history từ log
     agent/request → llm/stream → assistant/chunk* → assistant/message
     tool/call* → tools/pre-execute → tools/execute → tools/post-execute → tool/result*
     step/end
     còn nợ request hoặc có input mới → claim → step tiếp
  → agent/turn-stopping
turn/end
```

`turn/*`, `step/*`, `user/message`, `assistant/*`, `tool/*` là session event durable. `agent/pre-step`, `agent/request`, `llm/stream` và ba event `tools/*` là waterfall — listener phải gọi `next()` để ủy quyền. `agent/turn-stopping` là serial, không có `next()`.

Driver của bạn phải phát đúng các event durable này, nếu không UI và persistence sẽ gãy.

### 2.3 Cold start

```
1. Redis miss
2. Orchestrator lấy lock (tránh spawn trùng)
3. Hỏi plugin registry: user này bật plugin nào
4. Registry sinh cordis.patch.yml
5. Spawn container: profile + patch, mount log volume
6. Harness boot, compose cây plugin, đăng ký transport
7. Gateway đọc cây vừa dựng → sinh manifest cho FE
8. Ghi affinity vào Redis
```

Đây là đường chậm nhất user cảm nhận được. Warm pool để che.

### 2.4 Hibernate / rehydrate

- Idle quá N phút → orchestrator kill container, xóa key affinity, **giữ log**.
- User quay lại → rehydrate ở node bất kỳ từ log.
- Điều kiện an toàn: nguyên tắc 0.4. Nếu có state nằm ngoài log, hibernate sẽ mất dữ liệu âm thầm.

Đây là khác biệt lớn nhất giữa 200 user và 20.000 user trên cùng hạ tầng: giữ process theo **hoạt động**, không theo user.

### 2.5 Bật/tắt plugin lúc chạy

```
User toggle trên UI
  → Gateway ghi Postgres
  → Registry sinh patch mới
  → Orchestrator apply lên instance đang chạy
  → Cordis unload subtree, unwind registration   (server)
  → Gateway đẩy manifest mới, FE unmount client.js (browser)
```

Bạn **không phải viết cơ chế reload** — nó rơi ra từ patch + reversible effect của Cordis. Yêu cầu duy nhất: plugin phía client phải đảo ngược mọi thay đổi DOM khi Cordis dispose hoặc khi client-plugin HMR. Đây là tiêu chí bắt buộc trong review plugin store.

**Nhìn lại:** plugin store về bản chất là một service sinh `cordis.patch.yml` theo user. Không hơn.

---

## 3. Các phase

Mỗi phase có tiêu chí hoàn thành rõ ràng. Không sang phase sau khi tiêu chí chưa đạt — đặc biệt Phase 1 và 2.

### Phase 0 — Thẩm định (1–2 tuần)

**Mục tiêu:** trả lời các câu hỏi mà mọi thiết kế sau phụ thuộc vào.

Việc cần làm:

1. Chạy `dsh --profile web --dump-config`, đọc toàn bộ cây plugin thật. Đối chiếu 9 component dự định viết với các row đã có — rất có thể vài cái đã tồn tại và chỉ cần patch.
2. Đọc `packages/bundle/web-app` để xác định transport giữa browser và harness (SSE, WebSocket, hay RPC riêng). Quyết định: proxy lại transport đó, hay định nghĩa API riêng ở gateway.
3. Đọc `docs/subsystems/core.md` và `core/agent` để nắm interface `Agent` cần implement.
4. Đọc `docs/api-gateway.md` — upstream có sẵn tài liệu về gateway, cần biết nó cover tới đâu trước khi tự viết.
5. Chốt hai con số: **peak session đồng thời**, và **plugin của user có được chạy code tùy ý không**.

**Hoàn thành khi:** có sơ đồ cây plugin thật, danh sách 9 component đã lọc lại, và hai con số ở mục 5.

---

### Phase 1 — Bundle và driver riêng

**Mục tiêu:** sở hữu core logic, chạy được local, chưa có gateway.

Việc cần làm:

1. Dựng npm workspace consume `@deepseek-ai/dsh`.
2. Viết bundle `<your>-core` với các component đã lọc ở Phase 0, khai báo qua `dsh.bundle` trong `package.json`.
3. Viết driver thay `core/agent-loop`, implement interface `Agent`, phát đủ các event durable ở mục 2.2.
4. Viết profile riêng (`dsh.profile`), kiểu live patch reload.
5. Test: chạy song song driver mặc định và driver của bạn trên cùng bộ prompt, so sánh session log.

**Hoàn thành khi:** `dsh --profile <your>` chạy được một session end-to-end với driver của bạn, log tương thích, tool hoạt động.

**Rủi ro:** đây là phase dễ sa đà nhất. Nếu thấy mình phải sửa `packages/` của upstream, dừng lại và cân nhắc nấc 3.

---

### Phase 2 — Gateway và một worker cố định

**Mục tiêu:** thông luồng stream hai chiều qua network. **Chưa multi-user.**

Việc cần làm:

1. Bundle transport: expose event stream + command endpoint.
2. Gateway: auth cơ bản, phát token, proxy stream.
3. Ghi session event vào log store **trước** khi fan-out.
4. FE tối thiểu: render từ `session/event`, gửi input qua `agent.followup()` / `agent.steer()`.
5. Test replay: reload trang giữa lúc model đang stream, nội dung phải dựng lại đầy đủ.

**Hoàn thành khi:** test replay pass. Đây là tiêu chí quan trọng nhất của cả dự án — nếu nó không pass, mọi thứ ở Phase 3 sẽ hỏng theo cách rất khó debug.

---

### Phase 3 — Orchestrator và multi-user

**Mục tiêu:** mỗi user một instance, tự spawn và hibernate.

Việc cần làm:

1. Redis affinity `sessionId → node` + lock lúc spawn.
2. Spawn container theo profile, mount log volume riêng.
3. Hibernate theo idle TTL; rehydrate từ log.
4. Warm pool che cold start.
5. Test: hibernate giữa session, rehydrate ở node khác, context phải nguyên vẹn.

**Hoàn thành khi:** kill container giữa chừng, user quay lại thấy đúng lịch sử và tiếp tục được.

**Rủi ro:** state rò rỉ ra ngoài log. Test bằng cách kill process bất ngờ, không phải shutdown sạch.

---

### Phase 4 — FE theme và manifest động

**Mục tiêu:** giao diện của bạn, và UI phản ánh đúng plugin từng user bật.

Việc cần làm:

1. Package `<your>-client-ui-theme`: design token, primitive, component contract.
2. Gateway sinh manifest theo user (dựa trên cây plugin instance đó đã compose).
3. FE nạp `client.js` theo manifest, không hardcode danh sách.
4. Định nghĩa contract khai báo cho conversation node: `type` + schema + keyed renderer.

**Hoàn thành khi:** hai user bật bộ plugin khác nhau thấy hai màn hình khác nhau, từ cùng một FE bundle.

**Gotcha đã biết:** quá trình heal profile lúc boot đi BFS qua dependency closure và tạo symlink phẳng, nhưng `resolve.paths()` không resolve symlink nên không tìm ra `packages/bundle/web-app/node_modules/`, khiến client UI plugin transitive bị thiếu khỏi boot manifest dù đã khai báo trong `cordis.patch.yml`. Triệu chứng: plugin im lặng không xuất hiện, server vẫn khởi động bình thường. Bạn sẽ đụng đúng chỗ này khi ship package `dsh-client-ui-*` qua workspace pnpm.

---

### Phase 5 — Plugin store

**Mục tiêu:** user tự lắp plugin thành flow riêng. Đây là điểm khác biệt của sản phẩm.

Làm sau cùng vì nó đòi hỏi mô hình isolation đã chốt, mà mô hình đó phụ thuộc hai con số ở Phase 0.

Việc cần làm:

1. Schema catalog: plugin, version, tương thích profile, quyền yêu cầu.
2. Pipeline build/verify phía bạn. **Không** để instance tự `git clone` lúc runtime — cách cài của dsh là `dsh plugin --profile web add github:...`, tức cài từ source, không dùng nguyên si được cho multi-tenant.
3. Sinh patch theo user từ bảng plugin đã bật.
4. Apply patch lên instance đang chạy (mục 2.5).
5. Review policy. Tiêu chí bắt buộc: plugin phải đảo ngược mọi DOM mutation khi dispose; khai báo đủ quyền; không mount custom element nếu chưa được duyệt.

**Hoàn thành khi:** user bật/tắt plugin trên UI, thấy hiệu lực ngay, không restart, không rác DOM để lại.

**Rủi ro lớn nhất của cả dự án:** plugin chạy in-process với full quyền trên `ctx`. User viết plugin nghĩa là user chạy code tùy ý trong instance. Nếu mỗi user một container thì blast radius chấp nhận được. Nếu multi-tenant chung process thì gần như không thể an toàn — đừng đi đường đó.

---

### Phase 6 — Vận hành

Việc cần làm:

1. Quota: token, thời gian chạy, số session đồng thời theo user.
2. Telemetry xuyên tầng: gateway → orchestrator → worker, gắn `sessionId`.
3. Chiến lược nâng cấp upstream: pin version, đọc changelog, có smoke test cho từng seam bạn phụ thuộc.
4. Chính sách lưu trữ log: nén, archive, xóa theo yêu cầu user.
5. Nếu plugin chạy code tùy ý: siết isolation xuống microVM (Firecracker, gVisor) thay vì container thường.

---

### Phase 7 — Authentication & Authorization thật, 2 role (admin, user)

**Thêm sau (2026-09-07), không nằm trong 6 phase gốc.** Từ Phase 2, mọi nơi
đụng tới auth đều để lại 1 câu ghi chú kiểu "real per-user auth is Phase 3+
scope" / "Phase 5+ scope" — chưa bao giờ có phase nào thật sự nhận việc đó.
Hiện trạng thật (đọc thẳng `services/gateway/src/auth.ts` +
`services/gateway/src/index.ts`, không phải suy đoán): đúng **1 mật khẩu
chung** (`GATEWAY_SHARED_SECRET`) đổi lấy 1 token tạm, và token đó **chỉ
được kiểm tra ở đúng 1 đường — WS upgrade**. Mọi route HTTP khác gateway
proxy (`GET .../manifest`, `.../client.js`, `/plugin-catalog`,
`.../plugins`, `POST .../enable`/`disable`, `DELETE /sessions/:id`) **không
kiểm tra token gì cả** — ai gọi cũng được nếu biết đúng URL. Không có khái
niệm user thật, không có quyền sở hữu session, không có role. Phase này
đóng đúng khoảng trống đó.

**Mục tiêu:** tài khoản người dùng thật, 2 role cố định — `user` (chỉ thấy
và điều khiển được session của chính mình) và `admin` (mọi quyền của
`user`, cộng thêm quyền duyệt plugin, xem/quản lý session của bất kỳ ai,
cấu hình quota) — thay hẳn mô hình 1-mật-khẩu-chung hiện tại, và bịt lại
toàn bộ những route đang không kiểm tra token.

Việc cần làm:

1. **Bảng `users` thật trong Postgres** (`infra/migrations`, cùng database
   Phase 5 đã dựng cho `plugin_catalog`) — `id`, `email`, `password_hash`
   (argon2/bcrypt, không lưu plaintext), `role` (`'admin' | 'user'`),
   `created_at`. Bootstrap tài khoản admin đầu tiên qua seed script/CLI
   riêng — **không** để `role='admin'` tự chọn được lúc đăng ký công khai
   (một endpoint đăng ký mở tự cho ai cũng thành admin là lỗ hổng, không
   phải tính năng).
2. **Thay `POST /auth/token` (đổi shared secret lấy token) bằng
   `POST /auth/login {email, password}`** thật — verify password hash,
   token trả về giờ mang theo `{userId, role}`, không còn chỉ là
   true/false như hiện tại (`isTokenValid()`'s check hiện tại).
3. **Quyền sở hữu session — ownership thật, không chỉ ID khó đoán.** Mỗi
   session tạo mới phải gắn `ownerId` (đề xuất: thêm cột vào
   `services/orchestrator`'s `SessionRecord` trong Redis, hoặc 1 bảng
   Postgres `user_sessions` nếu cần truy vấn "tất cả session của user X" —
   cân nhắc cả hai, quyết định lúc build). Gateway phải resolve
   `{userId, role}` từ token trước khi gọi `ensureSession`, rồi truyền
   `ownerId` xuống để orchestrator lưu lại.
4. **Bịt mọi route đang thiếu check token** (danh sách đã liệt kê ở trên) —
   mỗi route phải xác minh: có token hợp lệ, VÀ (là chủ session được nhắc
   tới trong URL HOẶC role là `admin`). Không có ngoại lệ "route này ít
   quan trọng nên bỏ qua" — đúng bài học đã ghi nhận nhiều lần trong
   `docs/code-rules.md`: 1 gap "biết nhưng chưa fix" mà không có deadline
   rất dễ trở thành gap vĩnh viễn.
5. **Route admin-only mới:**
   `POST /catalog/:id/approve`/`reject` (hiện tại `services/plugin-registry`
   cho phép BẤT KỲ ai gọi cũng duyệt được plugin — lỗ hổng nghiêm trọng hơn
   hẳn các route thiếu check khác, vì hậu quả là chạy code tùy ý chưa được
   review), cộng `GET /sessions` (liệt kê mọi session, mọi user) và
   `GET /users` — cả hai chỉ admin mới gọi được.
6. **Quyết định lưu token ở đâu** (ghi rõ đây là quyết định kiến trúc cần
   cân nhắc, không tự chọn khi build): `Map` in-memory hiện tại
   (`services/gateway/src/auth.ts`) mất sạch khi gateway restart, và không
   chia sẻ được nếu chạy nhiều gateway replica. Hai hướng thật: (a) JWT ký
   bằng 1 secret — stateless, verify không cần tra store nào, nhưng thu hồi
   token trước hạn khó (phải giữ blocklist); (b) token ngẫu nhiên tra qua
   Redis (đã có sẵn hạ tầng từ Phase 3) — thu hồi tức thì, nhưng mỗi request
   thêm 1 lần round-trip Redis. Chọn 1 trong 2 trước khi code, không trộn.
7. **Quyết định ai enforce authorization** (cũng là quyết định kiến trúc,
   không tự chọn khi build): gateway đã sở hữu vai trò auth theo đúng bảng
   trách nhiệm gốc (mục 1.2: *"Gateway — Auth, phát token..."*) — có thể
   coi gateway là điểm enforce DUY NHẤT (đơn giản, nhưng orchestrator/
   plugin-registry vẫn hoàn toàn mở nếu ai đó gọi thẳng cổng nội bộ của
   chúng, bỏ qua gateway), hoặc cho cả `services/orchestrator`/
   `services/plugin-registry` tự kiểm tra lại (defense-in-depth — 2 dịch vụ
   này được phép biết khái niệm "user", đúng quy tắc phân tầng mục 1.2,
   khác với harness worker) bằng cách gateway forward `{userId, role}` đã
   resolve qua 1 header nội bộ ký sẵn. Phương án 2 an toàn hơn thật, nhưng
   tốn công hơn — quyết định dựa trên việc các cổng nội bộ (orchestrator
   `:4100`, plugin-registry `:4200`) có thật sự bị chặn khỏi mạng ngoài hay
   không trong môi trường triển khai thật.

**Hoàn thành khi:** 2 tài khoản thật (1 `admin`, 1 `user`) đăng nhập được
bằng email/password thật; user thường tạo/xem/tắt-mở-plugin/xoá được CHỈ
session của chính mình — thử gọi bất kỳ route nào ở trên nhắm vào session
của người khác phải bị từ chối thật (401/403), verify bằng test thật, không
chỉ đọc code; user thường gọi `approve` plugin bị từ chối, admin gọi được;
`GET /sessions`/`GET /users` chỉ admin gọi được.

**Rủi ro:** session đã tồn tại TRƯỚC khi phase này chạy (tạo dưới mô hình
1-mật-khẩu-chung, không có `ownerId`) cần 1 quyết định di trú rõ ràng — gán
hết cho tài khoản admin đầu tiên, hay coi là mồ côi và purge — không được
để im lặng "không thuộc ai" (một session không chủ sở hữu dưới model mới là
lỗ hổng, không phải trạng thái trung tính). Quota Phase 6 (hiện tại global
hoặc theo-session vì chưa có user thật) nên chuyển thành theo-user thật một
khi phase này xong — ghi nhận là việc nối tiếp tự nhiên, không bắt buộc phải
làm chung 1 lần với phase này.

---

**Ghi chú (2026-09-08): toàn bộ cơ chế "UI plugin" tải động theo-từng-session
mà Phase 8-12 dưới đây xây dựng — boot manifest, module loader dùng chung,
`client.js` tải qua `import()` động, hệ slots outlet — ĐÃ BỊ GỠ BỎ HOÀN
TOÀN.** User quyết định sau nhiều lượt "UI vẫn sai" không giải quyết dứt
điểm được bằng debug cache/redeploy: chính cơ chế nhiều tầng gián tiếp này
là nguồn gốc của các bug loading/cache rất khó debug khi không có browser
thật. Quay về 1 web app React build sẵn, dùng chung cho mọi user
(`apps/web/src/App.tsx` + `src/components/*`) — xem `docs/code-rules.md` §30
và `apps/web/README.md`. TOÀN BỘ tính năng thật (theme, chat/composer/command
palette, session list, plugin enable/disable, plugin inventory, model
picker, settings dialog) vẫn còn — chỉ đổi cách phân phối, không mất tính
năng. Các phase dưới đây GIỮ NGUYÊN làm hồ sơ lịch sử (research thật về dsh,
lý do thiết kế) — không xoá, không cập nhật lại cho khớp hiện trạng mới.

### Phase 8 — Declarative UI contract (hệ slots), giảm phụ thuộc custom element

**Thêm sau (2026-09-07), không nằm trong 6 phase gốc.** User hỏi thẳng "UI
plugin nên triển khai thế nào", rồi "chưa hiểu dsh làm như thế nào" —
research thật (không đoán) cho thấy dsh thật có 1 hệ **slots** khá phong phú
(`ctx.slots.install/inject/register`, 4 kiểu outlet: single/keyed/list/chain
— docs/code-rules.md §18) đứng sau cái mà roadmap mục 1.5 gọi đơn giản là
"contract khai báo". Hiện trạng thật của dự án này (đọc thẳng code, không
suy đoán): **100% UI plugin hiện có — kể cả 3 package first-party lẫn mọi
plugin bên thứ ba qua plugin store — đi đường custom element**
(`mount(root): () => void`, chạy full quyền DOM/cookie trong origin của
shell). Cơ chế declarative đã có HẠ TẦNG (`window.__FOX_HARNESS__.registerNodeRenderer`/
`getNodeRenderer`) từ Phase 4 nhưng **0 plugin thật nào dùng nó** — một map
phẳng `type → renderer`, mỏng hơn hẳn hệ slots thật của dsh, và chưa từng
được coi là "contract chính thức" ở đâu cả.

**Mục tiêu:** cho phần LỚN plugin (hiển thị nội dung, đóng góp 1 hành động/
panel UI) không cần ship `client.js` nào cả — chỉ gửi DỮ LIỆU có cấu trúc từ
phía worker, FE tự tra ra renderer đã review sẵn để vẽ. Giữ custom element
làm lối thoát cho plugin thật sự cần (first-party, hoặc third-party đã
review kỹ) — không xoá bỏ, chỉ không còn là đường DUY NHẤT. Đây là cách
trực tiếp giảm "blast radius" mà chính roadmap gọi là rủi ro lớn nhất dự án
(mục 2.5/Phase 5), vì code thật của 1 plugin thuần-declarative không bao giờ
chạy trong DOM của shell.

**Phạm vi v1 — 2 outlet kind, không phải cả 4 như dsh thật (nấc 2, không
port nguyên hệ slots):**

Việc cần làm:

1. **Outlet kind 1 — `keyed`: vocabulary content-block CỐ ĐỊNH.** Không phải
   "plugin tự đăng ký renderer cho type riêng của nó" (làm vậy là custom
   element trá hình — vẫn chạy code thật của plugin). Thay vào đó: một tập
   `type` hữu hạn do package first-party định nghĩa renderer sẵn (vd
   `card`, `table`, `key-value`, cộng các type đã có sẵn từ
   `packages/client-ui-conversation`) — plugin (kể cả third-party) chỉ được
   GỬI dữ liệu khớp 1 type đã tồn tại trong vocabulary đó, không tự thêm
   type mới. Đúng tính chất declarative thật: *"Chỉ vẽ được cái đã định
   nghĩa trước"* (mục 1.5's bảng). Hạ tầng gửi/nhận đã có sẵn từ Phase 1-2
   (content block trong `assistant/message`/`tool/result`) — việc thật cần
   làm là formalize vocabulary + build renderer cho các type generic mới
   (`card`/`table`/`key-value`), không phải xây cơ chế truyền tải mới.
2. **Outlet kind 2 — `list`: panel/action KHÔNG cần ship JS.** Cơ chế MỚI
   hoàn toàn, chưa có gì tương tự hôm nay — mọi UI ngoài luồng chat (sidebar
   panel như `client-ui-settings-plugins`, nút toolbar, ...) hiện chỉ làm
   được qua `mount(root)` custom element. Thiết kế: 1 Cordis service mới
   (`ctx.uiSlots`, cạnh `ctx.clientManifest` chứ không thay thế) mà plugin
   `register('sidebar', { id, title, schema })` trong `apply(ctx)` của
   chính nó — `schema` là 1 JSON schema TỐI GIẢN (chỉ text/label/button
   phát ra 1 wire command có sẵn như `followup`/`enable-plugin` — KHÔNG
   phải HTML tuỳ ý, không phải JS tuỳ ý). FE có 1 renderer chung cho schema
   này, review 1 lần, dùng lại cho mọi plugin khai declarative.
3. **`packages/transport`: route mới cho slot descriptor** — `GET /slots`
   (song song `GET /manifest` đã có), trả về mọi `ctx.uiSlots` đã đăng ký
   cho session đó. `services/gateway` proxy + auth y hệt cơ chế đã xây ở
   Phase 7 (ownership-or-admin), không phát minh luật mới.
4. **`apps/web`: renderer cho `list` slot mới** — đọc `GET /slots`, vẽ theo
   schema tối giản ở mục 2, gắn vào 1 khu vực cố định trong shell (không
   phải plugin tự chọn chỗ chèn DOM như custom element hiện tại — đây chính
   là điểm khác biệt an toàn: layout do SHELL quyết, không phải plugin).
5. **Chính sách review `services/plugin-registry` — câu hỏi mở, không tự
   chọn khi build:** 1 plugin CHỈ khai declarative (không có `dsh.client`/
   `client.js` nào cả) có xứng đáng 1 tier review NHẸ HƠN không (vì code
   của nó tuyệt đối không chạy trong DOM shell, khác hẳn plugin có
   `client.js`)? Đây là quyết định chính sách bảo mật thật, cần cân nhắc kỹ
   trước khi build, không phải chi tiết kỹ thuật tự quyết được.

**Ngoài phạm vi v1 (ghi rõ, không làm):** outlet kind `single`/`chain` (chưa
có nhu cầu thật nào cần đến — thêm khi có plugin thật cần, không thêm
trước); 1 ngôn ngữ schema UI đầy đủ kiểu JSON-Forms (list slot ở mục 2 chỉ
cần vài field kiểu cố định, không phải form builder tổng quát); port hệ
`ctx.slots` thật của dsh (nấc 2 vẫn áp dụng — tự viết bản mỏng hơn, không
copy).

**Hoàn thành khi:** 1 plugin demo thật, submit qua đúng pipeline
`plugin-registry` (`pnpm add` thật), **không có `dsh.client`/`client.js`
nào trong package.json của nó** — chỉ đăng ký 1 content-block type đã có
sẵn trong vocabulary (outlet `keyed`) VÀ 1 panel `list` — sau khi approve +
enable cho 1 session thật, cả 2 đều hiện đúng trên UI mà KHÔNG có dòng JS
nào của plugin đó từng chạy trong trình duyệt (verify được qua network tab/
việc `client.js` route 404 cho plugin đó — nó không tồn tại). So sánh trực
tiếp với plugin demo `fox-harness-demo-hello` hiện có (custom element, có
`client.js` thật) để chứng minh 2 đường cùng tồn tại song song, không cái
nào thay thế cái nào.

**Rủi ro:** schema quá hẹp thì không ai dùng, mọi plugin vẫn chọn custom
element vì declarative không đủ biểu đạt — nếu vậy phần đầu tư này không
giảm được blast radius thật nào, chỉ thêm code không ai gọi. Ngược lại,
mở rộng schema quá tay thì rơi vào bẫy tự xây lại 1 UI framework nhỏ ngay
trong dự án — đúng cạm bẫy đã né ở Phase 4 khi quyết định không port hệ
slots thật của dsh. Cân bằng này cần review lại sau khi có 1-2 plugin thật
dùng thử, không chốt cứng ngay từ đầu.

---

### Phase 9 — Chuyển sang React + module loader tự chế kiểu dsh (đảo ngược quyết định "framework-free" ở Phase 4)

**Thêm sau (2026-09-07), đảo ngược có chủ đích 1 quyết định đã chốt trước
đó.** Phase 4 (docs/code-rules.md §19) từng cân nhắc kỹ rồi CHỌN framework-free
— lý do lúc đó: dsh's real UI package không có source (chỉ compiled
`lib/client.js`), là React thật bọc trong `window.__ModuleLoader__` tự chế,
kéo theo cả chuỗi phụ thuộc (`dsh-client-connection`, `dsh-client-runtime`,
...) — chi phí port nguyên xi không xứng đáng ở quy mô dự án lúc đó. User
giờ chủ động muốn đảo ngược: dùng React thật, viết UI plugin theo PHONG
CÁCH dsh (không phải copy code dsh — vẫn không có source để copy, sự thật
đó không đổi). Quyết định này được cân nhắc lại có chủ đích, không phải quên
lý do cũ — ghi rõ ở đây để phiên làm việc sau không tưởng nhầm đây là mâu
thuẫn với §19.

**Vấn đề kỹ thuật cốt lõi phải giải — không có ở kiến trúc framework-free
hiện tại:** mỗi UI plugin là 1 bundle `client.js` tải độc lập qua `import()`
động từ 1 origin khác, không chia sẻ module graph với shell hay plugin khác.
Với React, nếu mỗi bundle tự đóng gói React riêng → **nhiều instance React
cùng chạy trên 1 trang** → lỗi thật (invalid hook call, context vỡ giữa các
plugin, bundle size cộng dồn). Đây chính xác là lý do dsh thật phải tự chế
`window.__ModuleLoader__` — không phải sở thích, mà bắt buộc để chia sẻ ĐÚNG
1 bản React giữa các bundle tải riêng lẻ.

**Quyết định đã hỏi rõ, KHÔNG chọn giải pháp rẻ hơn (import map chuẩn của
trình duyệt — đạt cùng mục tiêu, không cần code loader tự chế) — user chọn
đi đúng hướng dsh: tự viết 1 module loader kiểu `factory(require)`.** Ghi
nhận: import map là lựa chọn rẻ hơn đã được đề xuất và từ chối có chủ đích,
không phải bị bỏ sót.

Việc cần làm:

1. **Module loader runtime mới** — `window.__FOX_MODULES__` (tên tạm), 2 hàm
   cốt lõi: `define(id, factory)` đăng ký 1 module (factory nhận `require`,
   trả về exports thật), `require(id)` resolve module đã đăng ký (memoize —
   gọi factory đúng 1 lần). Shell (`apps/web`) đăng ký `react`/
   `react-dom/client` TRƯỚC khi tải bất kỳ plugin nào — thứ tự này bắt buộc,
   không đảo được.
2. **Bundler thật lần đầu tiên trong dự án** — hiện tại KHÔNG có bundler nào
   (chỉ `tsc` biên dịch thẳng ES module, phẳng, phục vụ nguyên si). Cần thêm
   esbuild (nhanh, ít cấu hình) để build mỗi package UI thành 1 file, đánh
   dấu `react`/`react-dom` là `external` (không bundle vào, để lại
   `require()`), rồi bọc output bằng 1 lớp mỏng gọi
   `window.__FOX_MODULES__.define(id, (require) => {...})`. Đây là thay đổi
   toolchain THẬT, không nhỏ — mọi package UI build lại theo pipeline khác
   hẳn cách hiện tại.
3. **Shell đổi cách tải plugin** — hiện tại `loadManifest()` làm 1 bước
   (`await import(url)` rồi gọi thẳng `.mount`). Sau Phase 9: 2 bước —
   `import(url)` chỉ để CHẠY side-effect của file (đăng ký vào loader), rồi
   `window.__FOX_MODULES__.require(entry.id)` để lấy component/mount thật.
4. **Viết lại 3 package UI hiện có bằng React thật** — `client-ui-theme`,
   `client-ui-conversation`, `client-ui-settings-plugins`. Không port logic
   cũ nguyên xi — viết lại bằng React idioms (function component + hooks),
   GIỮ NGUYÊN hành vi đã verify qua các phase trước (dispose sạch khi
   unmount, đúng wire protocol qua `window.__FOX_HARNESS__`).
5. **Tiêu chí review "dispose sạch DOM" (docs/code-rules.md §6) áp dụng lại
   cho React** — điểm dispose chính thức giờ là
   `ReactDOM.createRoot(...).unmount()`, không phải plugin tự tay xoá DOM
   như trước. An toàn hơn NẾU component viết đúng (React tự cleanup), nhưng
   cần xác nhận lại bằng test thật, không giả định.
6. **Style — câu hỏi mở, chưa tự chọn:** giờ mới thật sự có thể "clone
   style" (không chỉ token màu như Phase 4 đã làm) — dùng CSS-in-JS/
   styled-components, hay giữ nguyên hệ token CSS custom properties
   (`--fh-*`) đã xây từ Phase 4 nhưng áp dụng qua React thay vì DOM thuần?

**Hoàn thành khi:** build lại ít nhất 1 package UI bằng React thật, chạy
qua đúng pipeline mới (esbuild → module loader → shell) và verify được 3
điều bằng dữ liệu thật, không suy đoán: (a) chỉ tồn tại ĐÚNG 1 instance
React trên trang dù tải nhiều plugin cùng lúc, (b) dispose đúng khi tắt 1
plugin (không rác DOM, không rác React fiber tree), (c) 2 plugin React
khác nhau tương tác qua lại (vd chia sẻ context) vẫn hoạt động đúng — đây
là bằng chứng thật rằng vấn đề "nhiều instance" đã được giải, không phải
chỉ "build được, không crash".

**Rủi ro:** đây là thay đổi TOOLCHAIN LỚN NHẤT từ đầu dự án tới giờ (bundler
thật lần đầu tiên) — không tương thích ngược với cách build hiện tại
(`tsc` phẳng, không bundler). Toàn bộ chuỗi manifest → import → mount đã
verify nhiều lần qua Phase 2/4/5 cần re-test lại từ đầu sau khi đổi cơ chế
tải. Tự viết module loader (thay vì import map chuẩn) nghĩa là có 1 hệ
thống module tự chế phải tự bảo trì lâu dài — chi phí đã được nói rõ trước
khi user chọn, không phải phát sinh bất ngờ.

---

### Phase 10 — Nhái cấu trúc layout/component thật của dsh (hành vi, không phải code)

**Thêm sau (2026-09-07).** User hỏi lại UI layout/component vẫn chưa giống
dsh, có clone được không. Đi kiểm tra lại thật kỹ (không dựa vào kết luận cũ
ở §19, vốn chỉ mới xem `dsh-client-ui-conversation`) và phát hiện quan
trọng: **kho `node_modules/@deepseek-ai/` cục bộ đang có SẴN cả 1 hệ sinh
thái package UI thật của dsh** (là transitive dep của `@deepseek-ai/dsh`,
không phải dự án này cài riêng) — `dsh-client-ui-layout`,
`dsh-client-ui-sidebar`, `dsh-client-ui-renderer`, `dsh-client-ui-settings`,
`dsh-client-ui-commands`, `dsh-client-ui-cordis`, và nhiều package khác nữa
— và **code compiled của chúng KHÔNG bị minify**: JSDoc thật, tên hàm/biến
rõ nghĩa, `//#region` đầy đủ. Ví dụ thật đã đọc: `dsh-client-ui-layout`
("Shell plugin: three-column AppFrame with drag handles") có hàm
`computeColumns(viewport, sidebar, details)` thật, hằng số
`SIDEBAR_AUTO_COLLAPSE = 1024`, thuật toán clamp width theo range cụ thể —
`dsh-client-ui-renderer` ("Browser UI renderer: React slot bindings,
ctx.uiRenderer, and the assembled application root") là chính bản triển
khai THẬT của hệ slots Phase 8 mới chỉ thiết kế lại từ mô tả gián tiếp.

**Vẫn KHÔNG đổi kết luận cũ — không thể chạy/copy nguyên xi code này**:
`exports["./src/*"]` của mọi package trên đều trỏ tới thư mục `src/` không
tồn tại trong bản publish (chỉ có `lib/client.js` compiled), và mỗi file
`require()` cả chuỗi package nội bộ khác của dsh (`dsh-client-ui-slots`,
`dsh-client-ui-primitives`, `dsh-client-runtime/client`, ...) — nhiều package
trong chuỗi đó (`dsh-client-ui-slots`, `dsh-client-ui-primitives`) THẬM CHÍ
KHÔNG có mặt trong `node_modules` (chỉ được `require()` tới trong code, chưa
từng được cài vì không nằm trong dependency graph thật của dự án này). Copy
nguyên code cũng là đúng kiểu "clone" đã từ chối có chủ đích từ Phase 0
(§0.3).

**Cái THẬT SỰ đổi so với trước:** trước đây (§19) chỉ trích xuất được GIÁ
TRỊ (màu sắc). Giờ đọc được cả CẤU TRÚC/HÀNH VI thật (thuật toán resize,
breakpoint, ranh giới component/store) — đúng cùng nguyên tắc "đọc thật,
viết lại bằng code của mình" nhưng áp dụng sâu hơn hẳn.

**Mục tiêu:** `apps/web` có layout 3-cột thật (sidebar/center/details, có
thể resize/collapse) thay vì 1 cột đơn hiện tại, và cấu trúc component của
`client-ui-conversation` mô phỏng đúng ranh giới thật của dsh (tách
`selection`/`draft`/`view` thành 1 store riêng thay vì `useState` phẳng như
hiện tại) — **hoàn toàn bằng code React gốc của dự án này**, không port
dòng nào từ compiled output.

Việc cần làm:

1. **Layout 3-cột** — đọc kỹ `dsh-client-ui-layout/lib/client.js` thật (455
   dòng, đã đọc sơ bộ) để hiểu đúng thuật toán `computeColumns` + ngưỡng
   collapse, viết lại thành 1 component `AppFrame` gốc trong `apps/web`
   (hoặc 1 package `client-ui-layout` mới, theo đúng convention nhóm
   package hiện có). Sidebar column là nơi tự nhiên để chuyển
   `client-ui-settings-plugins`'s panel vào (hiện đang chèn khá gượng ép
   ngay sau session-bar) — không phải tính năng mới, chỉ đổi CHỖ hiển thị.
2. **Cập nhật lại Phase 8 dựa trên nguồn thật vừa tìm được** — Phase 8's
   thiết kế "2 outlet kind" viết TRƯỚC khi biết `dsh-client-ui-renderer` có
   source thật đọc được; cần đọc kỹ 988 dòng đó rồi xác nhận lại (hoặc sửa)
   thiết kế slots hiện tại của Phase 8 cho khớp đúng hành vi thật, thay vì
   suy luận gián tiếp như lúc viết Phase 8.
3. **Restructure `client-ui-conversation`'s state** — đọc
   `dsh-client-ui-conversation`'s store pattern thật (`createChatStore`,
   tách `selection`/`draft`/`view`/`inspect`) và áp dụng cấu trúc tương tự
   cho `entries`/`liveBubbles` hiện có — mục tiêu là ranh giới state RÕ RÀNG
   hơn, không nhất thiết đổi hành vi quan sát được.

**Cố tình để ngoài phạm vi:** `dsh-client-ui-sidebar`'s tính năng "session
multi-level tree, search, grouping" — đây là TÍNH NĂNG MỚI (multi-session
browsing), dự án này hiện chưa có khái niệm "danh sách nhiều session" ở FE
nào cả (mỗi tab chỉ có đúng 1 session tại 1 thời điểm) — không phải việc
"nhái layout cho cái đã có", nên không nằm trong phạm vi phase nhái-UI này;
cân nhắc như 1 phase RIÊNG nếu muốn tính năng đó thật sự. Tương tự
`dsh-client-ui-commands`/`dsh-client-ui-settings`/`dsh-client-ui-cordis` —
đọc được nhưng không có tính năng tương ứng ở dự án này để "nhái vào", để
lại nếu sau này có nhu cầu thật.

**Cập nhật (2026-09-07):** nhu cầu thật đã đến — xem Phase 12, phase riêng
đúng như đã hẹn ở đây, cộng thêm phát hiện sửa lại 1 chỗ hiểu sai của
Phase 10: `dsh-client-ui-cordis` KHÔNG phải UI quản lý plugin, mà là UI cho
agent tự định nghĩa plugin trong phiên (`cordis_define/run/stop`) — xem chi
tiết ở Phase 12 mục 4.

**Hoàn thành khi:** `apps/web` có layout 3-cột thật, resize/collapse đúng
hành vi đã đọc từ `computeColumns` (verify bằng cách thay đổi viewport
width thật, xác nhận sidebar tự collapse đúng ngưỡng), sidebar chứa đúng
panel settings-plugins đã có (không phải tính năng mới), và
`client-ui-conversation`'s code nội bộ có ranh giới store rõ ràng hơn hẳn
hiện tại — verify bằng review code + hành vi observable không đổi (vẫn pass
lại được bộ test Phase 9 đã viết).

---

### Phase 11 — Plugin bên thứ ba tự động tương thích với module loader chia sẻ React (đóng gap Phase 9 để lại)

**Thêm sau (2026-09-07).** User hỏi thẳng: xây UI theo hướng Phase 9 thì
việc gắn thêm 1 tool có UI có dễ không. Trả lời có 2 vế khác hẳn nhau, xác
nhận bằng cách đọc thẳng `services/plugin-registry/src/build.ts` thật (không
suy đoán): **package first-party (tự viết) thì dễ thật** — chỉ cần viết
`src/client/index.tsx` + thêm 1 dòng vào `scripts/build-client-plugins.mjs`'s
`PACKAGES` list. **Plugin bên thứ ba qua plugin store thì CHƯA dễ — đây là
gap thật, không phải giả định.** `buildPlugin()` hiện tại chỉ chạy `pnpm add
<source>` rồi copy nguyên trạng, KHÔNG chạy esbuild, KHÔNG bọc vào
`window.__FOX_MODULES__.define(...)` — một plugin bên ngoài muốn dùng React
an toàn (chia sẻ đúng 1 instance) buộc phải tự tay biết và tuân theo đúng
format module loader nội bộ của dự án này, điều không thể đòi hỏi ở tác giả
plugin bên ngoài.

**Ràng buộc kỹ thuật quan trọng cần hiểu trước khi thiết kế:** plugin-registry
nhận plugin qua `pnpm add <source>` — nghĩa là nhận đúng NHỮNG GÌ tác giả
plugin đã publish/build sẵn (thường là JS đã compile, như cách chính các
package trong dự án này cũng ship `lib/client/index.js` chứ không ship
`src/client/index.tsx`), KHÔNG PHẢI source TSX gốc. Registry **không thể tự
chạy esbuild bundle lại từ đầu** vì không có source để bundle — chỉ có thể
**BỌC (wrap)** cái đã build sẵn, giống hệt kỹ thuật `scripts/build-client-plugins.mjs`
đã dùng cho first-party.

**Research thật trước khi chốt thiết kế (2026-09-07) — đọc trực tiếp
`node_modules/@deepseek-ai/dsh-client-modules/lib/client.js` (323 dòng,
không minify, đây chính là code thật đứng sau `window.__ModuleLoader__`),
sau khi user hỏi thẳng "có tham khảo dsh chưa" và câu trả lời lúc đó là
CHƯA:**
1. **`external` là 1 field khai báo THẬT trên từng manifest entry**
   (`row.external`, validate bằng `optionalStringArray(subject, "external",
   row.external)`, đọc từ *"a `dsh.client` declaration or from the boot
   wire"*) — server (lúc sinh manifest) đọc field `external` từ `dsh.client`
   của package và ghi thẳng vào wire (`{id, url, rev, external: [...]}`).
   KHÔNG phải browser tự đoán/grep bundle để biết nó cần gì.
2. **React tự nó cũng chỉ là 1 "row" trong graph** (hoặc 1 "seed" — module
   host cung cấp trực tiếp, không qua bundle nào) — `arriveGraphRow()` xử
   lý MỌI entry đồng nhất bằng cách đệ quy load hết `row.external` trước khi
   load chính entry đó. Không có case đặc biệt hard-code nào cho React cả —
   đây là điểm khác thật với `window.__FOX_MODULES__` hiện tại của dự án
   này (Phase 9 hard-code 4 dòng `define('react', ...)` trong shell, không
   phải 1 cơ chế graph tổng quát).
3. **"Build-time bundle purity gate"** (nhắc tới 2 lần trong code) — dsh
   thật có 1 bước kiểm tra Ở LÚC BUILD (bằng chính build tool của họ,
   `tsdown`) xác nhận bundle thật sự khớp với `external` đã khai báo. Đây là
   verify ở PHÍA TÁC GIẢ PLUGIN (build tool họ dùng), không phải ở registry
   — chỉ áp dụng được nếu tác giả dùng đúng tooling đó, thứ dự án này không
   kiểm soát được với tác giả plugin bên thứ ba.

**Kết luận từ research — sửa lại thiết kế:** dùng ĐÚNG tên field `external`
(không phát minh tên riêng) trong `dsh.client` của plugin, theo sát convention
thật của dsh — nhưng vì KHÔNG kiểm soát được build tool của tác giả bên thứ
ba (khác dsh, họ chỉ có 1 build tool chính thức), verify NỘI DUNG bundle sau
build (cách đã thiết kế ban đầu — grep tìm dấu hiệu React bị nhúng) vẫn cần
giữ lại làm lớp phòng vệ THẬT SỰ, không chỉ tin vào field khai báo suông.

Việc cần làm:

1. **Phát hành plugin template thật** (roadmap §1.4 đã nhắc từ đầu dự án,
   chưa từng làm) — 1 repo mẫu có `package.json` với `dsh.client.external:
   ["react", "react-dom"]` (đúng tên field thật của dsh, không phải
   `peerDependencies` như bản thiết kế đầu — `peerDependencies` vẫn cần có
   cho tooling npm resolve type/version, nhưng `dsh.client.external` mới là
   field dsh THẬT SỰ đọc), build script dùng ĐÚNG cấu hình esbuild
   `scripts/build-client-plugins.mjs` đang dùng (external react, format
   `cjs`) — nhưng KHÔNG tự wrap (wrap là việc của registry).
2. **`services/plugin-registry/src/build.ts`: đọc `dsh.client.external`,
   thêm bước wrap** — sau khi verify `dsh.bundle.patch` (đã có), nếu
   `manifest.dsh.client` tồn tại: đọc `external` list (mặc định `[]` nếu
   thiếu), đọc file `client.js` đã resolve, áp đúng kỹ thuật wrap
   `window.__FOX_MODULES__.define(id, function(require) {...})` mà
   `scripts/build-client-plugins.mjs` đã verify hoạt động đúng ở Phase 9.
   Hàm wrap dùng chung ở cả 2 nơi (mirrored, not imported).
3. **Verify NỘI DUNG thật, không chỉ tin field khai báo** — thêm 1 check
   tĩnh vào `buildPlugin()`: nếu `client.js` sau build chứa dấu hiệu React
   source thật bị nhúng vào (grep `ReactCurrentDispatcher` hoặc tương tự —
   đúng cách đã tự kiểm tra thủ công lúc verify Phase 9) DÙ đã khai báo
   `external: ["react"]` → từ chối build với lỗi rõ ràng ("plugin declares
   react as external but bundles it anyway"), không âm thầm cho qua rồi vỡ
   lúc runtime thật — đây là lớp phòng vệ THẬT vì dự án này không có "build-
   time purity gate" như dsh để bắt lỗi này từ phía tác giả plugin.
4. **Cập nhật tiêu chí review** (`docs/code-rules.md` §7) — thêm dòng mới:
   "client.js không được tự nhúng React/ReactDOM dù có khai báo external
   hay không — verify nội dung thật, không chỉ tin field khai báo."

**Ngoài phạm vi:** không tự động "sửa" plugin sai convention (không thử bóc
tách/re-bundle lại React đã nhúng sẵn — phức tạp, dễ vỡ, không đáng công
theo tinh thần "no more than needed" đã áp dụng suốt dự án); không hỗ trợ
framework khác ngoài React (Vue, Svelte, ...) — 1 plugin không dùng React
vẫn wrap được bình thường (không ép buộc dùng React), chỉ riêng NẾU dùng
React thì mới cần theo đúng convention external.

**Hoàn thành khi:** 1 plugin demo MỚI (khác `fox-harness-demo-hello` — có UI
React thật, dùng `useState`/`useEffect`) viết theo đúng template mới, build
qua real `pnpm add` pipeline, verify: (a) `client.js` sau build chứa
`require("react")` chứ không nhúng React source thật, (b) mount được, chia
sẻ đúng 1 instance React với plugin first-party khác đang chạy cùng lúc
(không "invalid hook call" — đúng bài test Phase 9 đã viết, áp lại cho
plugin third-party lần này), (c) 1 phiên bản plugin CỐ Ý sai convention (tự
bundle React riêng) bị registry TỪ CHỐI ngay ở bước build, không lọt qua.

---

### Phase 12 — Tính năng UI mới theo dsh thật: đa-session, command palette, chọn model, settings shell (docs-only, thêm 2026-09-07)

**Bối cảnh.** User yêu cầu thẳng: "đổi hoàn toàn design UI... chia thành
các plugin như của dsh từ code cho đến theme style", và khi hỏi lại phạm vi
(làm sâu hơn cái đã có, hay xây thêm tính năng mới giống dsh), user chọn
**xây thêm tính năng mới giống dsh**. Đây là phạm vi LỚN HƠN hẳn Phase 10
(Phase 10 cố tình giới hạn "chỉ nhái layout cho cái đã có", và ghi rõ để
ngoài phạm vi đúng nhóm tính năng này — xem cuối Phase 10 — vì dự án
"hiện chưa có khái niệm nhiều session ở FE nào cả"). Phase 12 chính là
"1 phase riêng" mà Phase 10 đã hẹn.

**Research thật trước khi thiết kế (2026-09-07)** — đọc trực tiếp
`node_modules/@deepseek-ai/dsh-client-ui-{sidebar,workspace,commands,model-selection,settings,settings-general,settings-models,settings-plugin-inventory,brand-official,theme,cordis}` (không đoán từ tên package), và đọc lại
`services/gateway/src/{index.ts,db.ts,auth.ts}`,
`services/orchestrator/src/{postgres.ts,redis.ts}`, `apps/web/src/main.ts`,
`packages/core/src/index.ts` để biết chính xác nền tảng hiện có. Phát hiện
quan trọng nhất: **hầu hết tính năng "giống dsh" mà user muốn hiện KHÔNG có
nền tảng backend nào cả** — đây không phải việc "thêm UI", mà là việc thêm
cả model dữ liệu mới ở Postgres/Redis/gateway trước, UI chỉ là phần cuối.

1. **Sidebar đa-session — dsh thật KHÔNG gộp 2 việc vào 1 package.**
   `dsh-client-ui-sidebar` (321 dòng) chỉ là shell: logo, nút New Session,
   nút collapse/rail, và 5 slot rỗng (`sidebar.brand.mark`,
   `sidebar.brand.name`, `sidebar.workspaces`, `sidebar.settings`,
   `sidebar.footer.action`) — `apply()` phía host **rỗng, không làm gì**.
   Toàn bộ cây session/search/group nằm ở package RIÊNG,
   `dsh-client-ui-workspace` (2460 dòng), fill vào slot `sidebar.workspaces`.
   Data shape 1 dòng session thật:
   `{id, title, blank, running, runningSubagentCount, completed, updatedAt, pendingInteraction?}`
   (`pendingInteraction`: `'approval'|'plan-review'|'question'`). Group
   theo **Workspace** (project/folder thật, có `path/cwd`) — dự án này
   KHÔNG có khái niệm workspace/folder (mỗi session tự spawn container từ
   `profile-template`, không gắn thư mục người dùng nào) nên group-theo-
   workspace **không áp dụng được** — dùng đúng chế độ `"flat"` mà
   `dsh-client-ui-workspace` tự nó cũng hỗ trợ như 1 lựa chọn thay thế
   (`groupBy: "flat"`, `orderBy: "updated"`), không phải bịa ra group mới.
   Search thật của dsh là RPC `ctx.sessions.search()` (server-side, debounce
   250ms) — v1 ở đây chỉ làm search substring theo `title` NGAY TRÊN DANH
   SÁCH ĐÃ CÓ ở client (không xây search-content RPC riêng, tốn công không
   cần thiết ở quy mô hiện tại).
   **Nền tảng backend hiện tại KHÔNG đủ**: không có bảng `sessions` nào cả
   (chỉ có `session_owners(session_id, owner_id, created_at)` — không
   `title`, không `updated_at`, không trạng thái); `GET /sessions` hiện tại
   **chỉ admin gọi được** (`requireRole(identity,'admin')`,
   `services/gateway/src/index.ts:296`), user thường không tự liệt kê được
   session của chính mình; tạo session mới hiện luôn là UUID mới hoàn toàn,
   nút "New Session" hiện tại XOÁ LUÔN session id cũ khỏi `localStorage`
   (`apps/web/src/main.ts:540`) — không có cách nào quay lại session cũ từ
   UI. Trạng thái running/hibernated đã có sẵn ở Redis
   (`SessionRecord.status`, `services/orchestrator/src/redis.ts:10`) nên
   tận dụng được, không cần bịa cờ mới.

2. **Command palette — dsh thật KHÔNG phải overlay toàn màn hình, KHÔNG
   có phím tắt global.** Đọc hết `dsh-client-ui-commands` (1144 dòng), grep
   `keydown|KeyboardEvent|metaKey|ctrlKey|shortcut` ra **0 kết quả** — trigger
   duy nhất là gõ `"/"` ở đầu ô soạn tin nhắn
   (`inputTriggers.registerSource({trigger:"/"})`). UI là 1 dropdown neo
   PHÍA TRÊN composer (`position:absolute; bottom:calc(100% + 4px)`), không
   phải modal/overlay riêng. Danh sách lệnh fetch qua RPC
   `ctx.remote.commands.list(sessionId)`, merge với contribution client-side
   đăng ký qua `commandUi.register({name, description, available, ui})` —
   đây chính là cách package model-selection ở mục 3 tự thêm `/model` vào.

3. **Chọn model — đây là thay đổi BACKEND lớn, không phải chỉ thêm UI.**
   Hiện tại model là **1 giá trị cố định toàn tiến trình**: waterfall
   `agent/request` đọc thẳng `OPENAI_MODEL_ID` từ env
   (`packages/core/src/index.ts:20`), orchestrator truyền y nguyên biến
   này vào container lúc spawn qua `workerEnvPassthrough`
   (`services/orchestrator/src/config.ts:73`) — **không có API nào để user
   chọn**, và không có khái niệm "danh sách model khả dụng" ở đâu cả. dsh
   thật tách 2 việc: `dsh-client-ui-settings-models` (2811 dòng, quản trị
   catalog — thêm provider, API key, fetch model list từ provider) khác
   hẳn `dsh-client-ui-model-selection` (803 dòng, CHỈ chọn trong catalog đã
   có, gọi `sessions.selectModel({sessionId, provider, model,
   reasoningEffort?})` — RPC theo từng session, đổi được cả giữa phiên).
   **V1 ở đây đơn giản hoá đáng kể** (xem Ngoài phạm vi) — vì
   `packages/llm/openai-compat` hiện chỉ có 1 provider cố định (OpenAI-
   compat endpoint duy nhất, không có khái niệm nhiều provider/API key per
   user), và vì mỗi session đã là 1 container riêng (Phase 0), cách rẻ nhất
   khớp đúng kiến trúc hiện có là: model chọn **lúc tạo session** (spawn
   time) từ 1 danh sách tĩnh do operator cấu hình
   (`OPENAI_ALLOWED_MODELS` — đổi từ 1 giá trị thành 1 danh sách), lưu vào
   dòng session, truyền đúng giá trị đã chọn (không phải giá trị mặc định
   toàn cục) vào env container lúc spawn. Đổi model GIỮA phiên (như dsh thật
   làm) yêu cầu 1 cơ chế live-swap trong `packages/core` chưa tồn tại —
   để ngoài phạm vi v1, ghi rõ bên dưới.

4. **Settings hiện tại (Phase 5's `client-ui-settings-plugins`) đặt sai
   chỗ so với dsh thật — không phải sai tên, mà sai CẤU TRÚC.** Phát hiện
   quan trọng: `dsh-client-ui-settings` (package) **không có UI nào cả** —
   chỉ là data layer (`SettingsSchemaService`, đọc/ghi qua RPC
   `settings.describe`/`settings.mutate`). Dialog thật (mask, panel, nav
   rail, danh sách section) nằm ở `dsh-client-ui-settings-general` — package
   này định nghĩa slot `settings.section` (list) để các package tính năng
   khác tự đăng ký tab, và tự nhận `id:"general", order:0`. Tên package
   `dsh-client-ui-settings-plugins` (khác `-settings-plugin-inventory`) mới
   đúng là chủ sở hữu section `"plugins"` thật — **tên package hiện có của
   dự án này (`client-ui-settings-plugins`) đã ĐÚNG quy ước đặt tên dsh**,
   chỉ là hiện đang mount thẳng vào rail sidebar thay vì qua 1 dialog
   settings thật có nav rail riêng. `dsh-client-ui-settings-plugin-inventory`
   (301 dòng, đọc hết) là 1 sub-tab RIÊNG, READ-ONLY, liệt kê state sống của
   Cordis Loader (`{moduleName, entryId, enabled, fiberPhase}`) qua RPC
   `ctx.remote.pluginInventory.list()` — khác hẳn việc bật/tắt plugin đã có.
   **Sửa hiểu biết cũ (Phase 10's Ngoài-phạm-vi ghi `dsh-client-ui-cordis`
   là UI quản lý plugin)** — SAI: đọc thật `dsh-client-ui-cordis` (grep +
   đọc phần đăng ký slot) cho thấy package này là UI cho tool call
   `cordis_define/run/stop/undefine` — tức UI cho **agent tự động định
   nghĩa plugin nhỏ ngay trong phiên** (dynamic in-session tool), một khái
   niệm hoàn toàn khác plugin store (`services/plugin-registry`) của dự án
   này. Không có analogue thật nào cho tính năng này ở dự án — để ngoài
   phạm vi, không bịa ra.

5. **Slots: bằng chứng mới cho thấy Phase 8's quyết định bỏ outlet kind
   `single` cần xem lại.** Phase 8 (docs-only, chưa implement) chốt v1 chỉ
   cần `keyed` + `list`, ghi "`single`/`chain` chưa thấy nhu cầu thật".
   Research phase này đọc trực tiếp thấy `single` được dùng RẤT nhiều cho
   đúng các slot mục 1 và 4 cần: `sidebar.brand.mark`, `sidebar.brand.name`,
   `settings.trigger`, `settings.header`, `settings.close` đều khai kind
   `single` (đúng bản chất: đúng 1 node được phép chiếm, không phải danh
   sách). Không triển khai được sidebar shell + settings shell (mục 1, 4)
   đúng đắn nếu vẫn giữ cơ chế hiện tại
   (`window.__FOX_HARNESS__.registerNodeRenderer`, 1 map phẳng
   `type→renderer`, không có khái niệm outlet/slot nào) — **Phase 12 phải
   implement Phase 8's slots system TRƯỚC** (bao gồm outlet kind `single`,
   sửa lại quyết định "chưa cần"), coi như đóng luôn Phase 10's việc-2 còn
   mở (đọc `dsh-client-ui-renderer`, 988 dòng, để chốt hành vi observable
   của slots — vẫn CHƯA đọc, phải đọc trước khi implement, không suy diễn
   từ 5 package trên).

6. **Theme/brand — khoảng cách token lớn, nhưng KHÔNG nên chép nguyên
   350 token.** `dsh-client-ui-theme` thật (`ThemeRuntime`, đọc hết class)
   dùng cơ chế JS-driven (`BUILTIN_THEMES`, `overrideTokens()` — layer đè
   token runtime, không chỉ CSS tĩnh), tổng **350 token `--dsw-*`** riêng
   biệt, đặt tên theo 3 tầng `static/alias/specific` (vd
   `--dsw-alias-bg-layer-1/2/3`, `--dsw-alias-button-*` theo từng
   variant×state). Dự án này hiện có đúng **16 token `--fh-*`**
   (`packages/client-ui-theme/src/client/index.tsx:41`). Khoảng cách ~22
   lần là DO khoảng cách về SỐ LƯỢNG THÀNH PHẦN UI thật (dsh có hàng chục
   package UI, dự án này chưa có), không phải do thiếu token — **v1 chỉ mở
   rộng token đủ cho các thành phần UI MỚI mà chính Phase 12 này thêm**
   (session row/status dot, command dropdown, model picker, settings
   dialog/nav rail) theo ĐÚNG quy ước đặt tên 3 tầng
   `static/alias/specific` của dsh (để tương thích mở rộng sau này), ước
   tính ~40-60 token — không chép nguyên 350. `dsh-client-ui-brand-official`
   thật (49 dòng) chỉ đăng ký lại component `FishLogo`/`BrandWordmark` (từ
   `dsh-client-ui-primitives`, chưa đọc) vào slot `sidebar.brand.mark` +
   `sidebar.brand.name` — dự án này không có logo/asset thật nào, v1 chỉ
   đăng ký 1 wordmark chữ ("Fox Harness") vào `sidebar.brand.name`, để
   `sidebar.brand.mark` trống (đúng tinh thần "không bịa asset không có").

Việc cần làm (thứ tự triển khai đề xuất — có phụ thuộc thật giữa các mục,
không làm tuỳ ý thứ tự):

1. **`packages/core`: implement slots system thật của Phase 8** (đọc
   `dsh-client-ui-renderer` — 988 dòng — trước, sửa Phase 8's design theo
   đúng hành vi thật, bao gồm thêm outlet kind `single`), thay
   `ClientManifestRegistry`'s flat map hiện tại. Đây là nền cho mọi UI mới
   bên dưới — không làm được mục 2/5 nếu bỏ qua bước này.
2. **Backend: bảng `sessions` thật** (Postgres, thay/mở rộng
   `session_owners`) — cột `id, owner_id, title, status, created_at,
   updated_at`; `status` derive từ Redis `SessionRecord.status` lúc list
   (không duplicate nguồn sự thật, chỉ cache `title`/`updated_at` ở
   Postgres vì Redis không phù hợp lưu lâu dài). Route mới:
   `GET /sessions/mine` (user tự liệt kê, không cần admin), `PATCH
   /sessions/:id {title}` (rename), giữ nguyên `GET /sessions` admin-only
   hiện có. Sửa nút "New Session" ở `apps/web` — không xoá session cũ khỏi
   localStorage nữa, thay bằng danh sách thật.
3. **Sidebar đa-session thật**: `packages/client-ui-sidebar` (shell, theo
   khuôn `dsh-client-ui-sidebar` — logo, New Session, collapse, slot
   `sidebar.workspaces`/`sidebar.brand.*`/`sidebar.settings`/
   `sidebar.footer.action`) + `packages/client-ui-session-list` (fill
   `sidebar.workspaces`, chế độ flat, sort theo `updated_at desc`, search
   substring theo `title`, status dot theo `SessionRecord.status`, action
   rename/archive/switch — KHÔNG có kéo-thả sắp xếp).
4. **Model chọn lúc tạo session**: `OPENAI_ALLOWED_MODELS` (danh sách,
   thay `OPENAI_MODEL_ID` đơn), lưu `model` vào dòng `sessions`, orchestrator
   dùng giá trị đã chọn (không phải default) lúc spawn container.
   `packages/client-ui-model-picker` — nút chọn model ở màn hình tạo
   session mới (KHÔNG phải composer button như dsh thật — vì đổi giữa
   phiên chưa hỗ trợ, đặt nút ở đúng chỗ hành động có tác dụng thật).
5. **Settings shell thật**: `packages/client-ui-settings-shell` (theo khuôn
   `dsh-client-ui-settings-general` — dialog mask/panel/nav rail, slot
   `settings.section` list, tự nhận section `"general"` mặc định trống nếu
   chưa có nội dung gì). Chuyển `client-ui-settings-plugins` từ mount thẳng
   sidebar rail sang đăng ký vào `settings.section` (`id:"plugins"` — đúng
   tên dsh thật). Thêm `packages/client-ui-plugin-inventory` (mới, đọc
   Cordis Loader/registry entries THẬT của chính worker qua 1 route RPC mới
   trong `packages/transport`, hiển thị read-only, sub-tab riêng).
6. **Command palette tối giản**: `packages/client-ui-commands` — trigger
   `"/"` trong composer, dropdown neo trên composer (không phải global
   overlay). Danh sách lệnh v1 là TĨNH (không xây contribution-registry
   RPC như dsh thật — chưa đủ command để cần cơ chế mở rộng): `/new`
   (session mới), `/rename` (đổi title). Không làm `/model` (đổi model
   giữa phiên chưa hỗ trợ — mục 4 chỉ chọn lúc tạo).
7. **Theme mở rộng có kiểm soát**: thêm ~40-60 token `--fh-*` mới theo quy
   ước 3 tầng `static/alias/specific`, đủ cho UI mới ở mục 3/5/6 (session
   row, status dot, settings dialog/nav rail, command dropdown, model
   picker) — không đổi cơ chế hiện tại (`@media prefers-color-scheme` +
   `data-theme`) sang JS-driven `ThemeRuntime` (dự án này chưa có nhu cầu
   nhiều theme/registration động, chỉ có light/dark). Thêm wordmark "Fox
   Harness" vào `sidebar.brand.name`.

**Ngoài phạm vi (ghi rõ, không làm ở Phase 12):**
- Nhóm session theo "workspace/folder" — dự án này không có khái niệm
  thư mục người dùng, dùng `"flat"` mode như dsh thật cũng hỗ trợ.
- Search nội dung phiên qua RPC server-side (`ctx.sessions.search()`) —
  chỉ search substring theo `title` ở client.
- Kéo-thả sắp xếp lại session/workspace.
- Đổi model GIỮA phiên đang chạy (`sessions.selectModel` live RPC) — cần
  cơ chế live-swap trong `packages/core` chưa có, để dành phase riêng nếu
  cần thật.
- Quản trị nhiều provider/API key (`dsh-client-ui-settings-models`'s
  catalog admin) — dự án này chỉ có 1 provider OpenAI-compat cố định qua
  env, không có model "add provider" nào.
- Reasoning-effort picker — `packages/llm/openai-compat` không hỗ trợ field
  này.
- Contribution-registry cho command palette (`commandUi.register` kiểu
  dsh) — danh sách lệnh tĩnh, đủ dùng ở quy mô hiện tại.
- UI cho `cordis_define/run/stop/undefine` (agent tự định nghĩa plugin
  trong phiên) — không có tính năng backend tương ứng ở dự án này.
- Copy nguyên 350 token theme hoặc chuyển sang `ThemeRuntime` JS-driven —
  chỉ mở rộng đúng số token UI mới cần.
- Logo/asset đồ hoạ thật cho brand — chỉ wordmark chữ.

**Hoàn thành khi:** user tạo được nhiều session, thấy danh sách session của
chính mình (không cần role admin) ở sidebar thật (không phải rail rỗng như
hiện tại), search/switch/rename được; chọn được model từ danh sách khi tạo
session mới và xác nhận đúng model đó được dùng (verify qua log request
thật tới LLM, không chỉ tin UI); gõ `/` trong composer thấy dropdown lệnh
thật, chạy được `/new`/`/rename`; mở được 1 dialog Settings thật (không
phải panel nổi trong rail) có nav rail với ít nhất 2 section
(`general`, `plugins`) + 1 sub-tab plugin-inventory read-only hiển thị đúng
entry Cordis đang sống; toàn bộ dùng slots system thật (outlet `single` +
`list` + `keyed`) thay flat map cũ — verify bằng cách gỡ 1 package UI bất kỳ
ra khỏi bundle, xác nhận đúng 1 slot trống đúng vị trí đó, không vỡ layout
khác. Test end-to-end thật (không mock), theo đúng kỷ luật đã áp dụng suốt
dự án — bao gồm test qua nhiều session/nhiều container thật cùng lúc, không
phải 1 session giả lập.

---

### Phase 13 — Hiện/ẩn 1 phần tử UI theo plugin BE đã bật cho session (docs-only, thêm 2026-09-08)

**Bối cảnh.** Sau khi gỡ hẳn hệ UI-plugin động (2026-09-08, `docs/code-rules.md`
§30) — plugin giờ CHỈ thêm được capability backend (tool/behavior qua
`cordis.patch.yml`), không tự ship UI được nữa. User hỏi: nếu 1 plugin
backend (vd 1 tool search) muốn có thêm 1 nút riêng trên sidebar, chỉ hiện
với user đã bật plugin đó — có làm được không, mà không cần dựng lại cả hệ
đã gỡ? Trả lời: **có**, vì đây là 2 việc khác hẳn nhau đã bị nhầm lẫn suốt
từ Phase 4 tới giờ:

1. *"Plugin bên ngoài tự mang code UI, không ai đụng `apps/web` mà vẫn chạy
   được"* — đây là cái đã gỡ, không làm lại.
2. *"1 phần tử UI đã viết SẴN trong `apps/web`, chỉ ẩn/hiện theo dữ liệu
   thật (session này có bật plugin X hay không)"* — đây là render có điều
   kiện dựa trên dữ liệu, không phải tải code động — không hề cần
   `import()` động, module loader, hay client.js riêng nào cả. Phase này
   chỉ làm đúng mục 2.

**Dữ liệu đã có sẵn, không cần xây mới:** `GET /sessions/:id/plugins`
(`services/plugin-registry`, proxy qua `services/gateway`) đã trả về đúng
danh sách plugin id đang bật cho 1 session — `SettingsPlugins.tsx` đang
dùng data này để tick checkbox. Phase 13 chỉ thêm 1 lớp ĐỌC lại đúng data
đó ở 1 chỗ khác (sidebar), không thêm route/bảng nào mới ở backend.

Việc cần làm:

1. **`apps/web/src/pluginUi.tsx` (file mới)** — 1 bảng ánh xạ TĨNH, viết tay,
   biên dịch cùng app (không phải tải động):
   ```ts
   export const KNOWN_PLUGIN_UI: Record<string, React.ComponentType> = {
     // '@fox-harness/tool-search-demo': SearchSidebarButton,
   }
   ```
   Chỉ những plugin đã có component viết SẴN trong repo mới xuất hiện ở
   đây — thêm 1 dòng vào bảng này LÀ 1 thay đổi code thật, cần build lại,
   deploy lại (đúng như đã giải thích với user: build lại áp dụng cho MỌI
   user, còn HIỆN hay ẨN với từng user cụ thể mới là phần động).
2. **1 hook dùng chung, `useEnabledPlugins()`** (`apps/web/src/runtime.ts`
   hoặc file riêng) — fetch `GET /sessions/:id/plugins` (đã có), trả về
   `Set<string>`, refetch khi `sessionId` đổi — cùng pattern
   `SettingsPlugins.tsx` đang dùng, factor ra dùng chung thay vì viết lại 2
   lần (2 nơi cùng cần đúng 1 tập dữ liệu này: `SettingsPlugins.tsx` hiện
   tại, và `Sidebar.tsx` mới).
3. **`Sidebar.tsx`** — sau `SessionList`, thêm 1 khu vực mới: với mỗi
   `(pluginId, Component)` trong `KNOWN_PLUGIN_UI` mà `pluginId` có mặt
   trong tập plugin đã bật (từ hook mục 2) → render `<Component/>`. Plugin
   chưa bật hoặc không có trong bảng ánh xạ → không render gì, không lỗi.
4. **1 component demo thật** (vd `SearchToolButton.tsx` — 1 nút đơn giản,
   không cần chức năng thật gì đặc biệt, chỉ để verify cơ chế) + đăng ký nó
   trong `KNOWN_PLUGIN_UI` gắn với 1 plugin backend demo có sẵn/mới tạo
   trong catalog (dùng lại đúng plugin demo local đã có từ Phase 5/11 nếu
   còn dùng được, hoặc tạo demo mới tối giản).

**Ngoài phạm vi (ghi rõ):** không xây lại cơ chế "plugin tự khai mình cần
slot nào" (đó là đúng thứ đã gỡ) — bảng ánh xạ luôn do người có quyền sửa
repo viết tay, không phải plugin tự đăng ký; không hỗ trợ nhiều vị trí
chèn (chỉ 1 khu vực cố định trong sidebar cho v1, không phải hệ outlet
tổng quát); không ẩn/hiện MID-SESSION theo real-time push (dữ liệu chỉ
refetch khi đổi session hoặc khi `SettingsPlugins.tsx` tự gọi refresh sau
khi user bấm toggle — đủ dùng, không cần dựng lại cơ chế push đã gỡ).

**Hoàn thành khi:** user bật plugin demo (qua Settings dialog đã có) → nút
demo xuất hiện thật trên sidebar KHÔNG CẦN reload trang (state React tự
cập nhật sau khi `SettingsPlugins.tsx`'s toggle gọi refresh chung); user
khác (hoặc user này tắt lại) → nút biến mất. Verify thật qua 2 tài khoản
thật, không phải suy luận từ code.

---

### Phase 14 — Clone style thật (typography/shadow/radius/component) từ dsh, không chỉ vài màu (docs-only, thêm 2026-09-08)

**Bối cảnh.** User nhận xét UI hiện "rất xấu" — đúng, vì từ Phase 4 tới
Phase 12 mới chỉ trích được ~20 token MÀU (`--fh-*`), chưa từng đọc
typography scale, shadow scale, hay cách các component thật (button/card/
input/dialog/bubble) của dsh thật sự trông ra sao. Research lần này đọc
sâu `dsh-client-ui-theme` (đọc lại hết 1354 dòng, phân loại lại đúng 350
token theo NHÓM chứ không chỉ màu) + suy ra cách dựng component thật từ
CSS-in-JS của các package tiêu thụ (`dsh-client-ui-sidebar`,
`-conversation`, `-settings-plugins`, `-settings-general`, `-workspace`,
`-attachment`) — vì `dsh-client-ui-primitives` (nơi giữ Button/Modal/Icon/
StateDot thật) **xác nhận KHÔNG hề được cài trên máy này** (không giống
các package khác đã đọc được suốt dự án) — mọi giá trị dưới đây là suy ra
từ nơi GỌI primitive đó, không phải đọc thẳng primitive.

**Phát hiện quan trọng nhất — dsh KHÔNG có token spacing/radius/z-index
nào cả**, chỉ có: **màu** (3 tầng static/alias/specific, 152 token),
**typography** (181 token — nhóm lớn nhất, phẳng không theo tầng),
**shadow** (4 mức), **motion** (1 easing + 3 duration). Spacing/radius/
z-index là **literal viết tay trực tiếp trong từng component**, không tập
trung hoá — nghĩa là "clone style" đúng nghĩa không phải "thêm 1 bảng
token radius" (dsh thật không làm vậy), mà là **áp dụng ĐÚNG literal thật
đã đọc được, nhất quán theo từng nhóm component**, giống cách dsh thật
làm.

**Giá trị thật đã đọc được, dùng làm căn cứ thiết kế (không suy đoán):**
- **Radius theo NGỮ CẢNH** (không phải 1 scale tuyến tính): 8px (input,
  session/workspace row, nút nhỏ/save-discard), 12px (card, nút sidebar
  chính, settings nav-cell, message tool-card), **22px dùng CHUNG cho cả
  message bubble LẪN composer** (chủ ý lặp lại 1 giá trị để tạo liên kết
  thị giác giữa 2 khu vực), 24px (dialog LỚN — settings), 999px (pill/badge/
  nút tròn/icon button).
- **Shadow** (4 mức thật, dùng nguyên): `lv1: 0 2px 4px 0 #0000000d`,
  `lv1-blur: 0 4px 12px 0 #00000005`, `lv2: 0 4px 12px 0 #00000005, 0 2px
  8px 0 #0000000a`, `lv3: 0 0 1px 0 #0003, 0 0 4px 0 #00000005, 0 12px 32px
  0 #00000014` — giống nhau ở light/dark.
- **Motion**: 1 easing `cubic-bezier(.4,0,.2,1)` + 3 duration (`.1s`/`.2s`/
  `.3s`) — dùng lại cho MỌI transition (sidebar collapse, dialog mở/đóng,
  hover), không phải mỗi chỗ tự bịa 1 con số.
- **Typography**: rút gọn 181 token thật xuống đúng 1 bộ lõi khớp "general
  UI scale" thật (không lấy hết, chỉ lấy phần dùng được): `xxxs-11`,
  `xxs-12`, `xs-13`, `s-14`, `base-16`, `m-16` (tên gốc ghi 18 nhưng giá trị
  thật là 16px — giữ đúng vậy, không tự sửa), `l-20`, `xl-24` — mỗi mức có
  bản `-strong` (weight 500/600) đi kèm, đúng cấu trúc thật.
- **Component thật đã đọc**: input 34px cao, focus CHỈ đổi màu viền (không
  glow/ring); button sidebar chính 38px cao; icon button 28×28 hình tròn;
  nút gửi (composer) 34×34 tròn; session/workspace row 32-34px cao, hover =
  đổi NGUYÊN màu nền (không phải viền trái như hiện tại); settings dialog
  overlay `z-index:1000` + `backdrop-filter: blur(2px)`; settings nav-cell
  40px cao; scrollbar riêng 8px, không dùng mặc định trình duyệt.

Việc cần làm:

1. **`apps/web/public/theme.css`** — thêm token mới theo đúng nhóm đã xác
   nhận (không thêm nhóm radius/spacing tập trung — dsh thật không có,
   giữ literal trực tiếp trong CSS từng chỗ, đúng cách dsh làm):
   - `--fh-shadow-lv1/-lv1-blur/-lv2/-lv3` (4 giá trị thật ở trên, thay
     `--fh-shadow-sm/-md` hiện có bằng đúng 4 mức thật).
   - `--fh-ease`, `--fh-duration-fast/-base/-slow` (motion, 4 token).
   - `--fh-text-xxxs/-xxs/-xs/-s/-base/-m/-l/-xl` + bản `-strong` (8 cặp =
     16 token, dùng `font: <weight> <size>/<line-height> var(--fh-font)`
     đúng dạng shorthand thật).
   - Alias màu mở rộng thêm (không lấy hết 78+73, chỉ thêm đúng cái các
     component ở mục 2 cần): border-l1/l2, bg-layer-1/2/3, interactive-bg-
     hover, label-primary/secondary/dimmed — map vào đúng giá trị hiện có
     của `--fh-*` cũ, KHÔNG đổi bảng màu gốc đã chọn từ Phase 4.
2. **Restyle từng component theo đúng literal đã đọc** (áp trực tiếp vào
   CSS của TỪNG chỗ, không qua 1 token radius chung):
   - Button: phân biệt lại 3 kiểu — primary/pill (submit, gửi tin — 999px,
     nền accent), sidebar/nav (12px, viền + nền trong suốt), icon-only
     (tròn, 28×28).
   - Input/select: 8px, cao 34px, focus đổi màu viền (bỏ outline mặc định
     trình duyệt).
   - `.card`/tool-call card/`.fh-session-row`: 12px cho card, 8px cho
     session row — **đổi session row từ viền-trái-khi-active sang đổi màu
     nền khi active/hover**, đúng convention thật (không giữ pattern viền
     trái cũ).
   - Message bubble + composer card: cả 2 cùng 22px (hiện đang 14px/khác
     nhau) — chủ ý lặp lại như thật.
   - Settings dialog: 24px (hiện 10px), thêm `backdrop-filter: blur(2px)`
     cho mask, `z-index:1000`.
   - Scrollbar: `::-webkit-scrollbar` tuỳ biến 8px cho `#log` và
     `#sidebar-workspaces` (2 khu vực cuộn chính) thay vì mặc định trình
     duyệt.
3. **Icon tối giản — KHÔNG xây hệ 63 icon SVG thật của dsh** (không đọc
   được nội dung SVG thật vì `dsh-client-ui-primitives` không cài trên
   máy, và dù đọc được cũng không nên chép asset của họ) — thay 4 emoji
   hiện có (⚙ ✕ ☰ ✎) bằng SVG inline tự vẽ, tối giản (đường nét đơn giản,
   không phải icon font/thư viện ngoài), CÙNG kích thước chuẩn 16/20px như
   quy ước thật đã đọc được — chỉ đủ cho đúng số nút đang có, không xây
   thư viện icon tổng quát.
4. **Chat column**: gap 16px giữa các turn (đúng giá trị thật đọc được),
   thay giá trị gap hiện tại.

**Ngoài phạm vi (ghi rõ):** không tự tạo 1 bảng token `--fh-radius-*` tập
trung (dsh thật không có, làm vậy là bịa thêm thứ họ không có — literal
trực tiếp mới đúng); không đọc/chép `dsh-client-ui-primitives` (không cài
được, và dù cài được cũng không chép code/asset của họ — chỉ dùng GIÁ TRỊ
suy ra từ nơi gọi); không xây lại cấu trúc nav-rail cho settings dialog
(đó là quyết định CẤU TRÚC đã chốt ở Phase 12, phase này chỉ đổi giao diện
thị giác của cấu trúc đang có, không đổi cấu trúc); không đổi cơ chế theme
sang JS-driven `ThemeRuntime` (vẫn giữ `@media`/`data-theme` đơn giản hiện
tại — quyết định đã chốt ở Phase 12, không đảo lại); không xây icon system
tổng quát cho tương lai (chỉ đủ 4 icon đang cần).

**Hoàn thành khi:** so sánh trực quan trước/sau (screenshot hoặc mô tả rõ
từng khu vực) cho thấy bubble/composer cùng bo góc 22px, session row đổi
nền khi hover/active thay vì viền trái, settings dialog bo góc 24px có
backdrop blur, input/button có kích thước/bo góc đúng như liệt kê ở trên —
đối chiếu từng giá trị với đúng dòng/file thật đã đọc trong research phase
này, không phải "nhìn đẹp hơn là được". `pnpm run typecheck` sạch,
`scripts/upstream-smoke-test.mjs` không hỏng gì (đây là thay đổi CSS
thuần, không đụng logic).

---

### Phase 15 — Build lại sidebar layout đúng cấu trúc thật của dsh (thêm 2026-09-08)

**Bối cảnh.** User: "lên phase đọc UI của dsh và build sidebar layout y
chang được ko" — sidebar hiện tại (`apps/web/src/components/Sidebar.tsx`)
chỉ có 3 phần: danh sách session, vùng plugin UI (Phase 13), 1 nút Settings
— thiếu hẳn brand/logo row, nút "New session" (đang nằm sai chỗ, trong
`#session-bar` ở header, không phải trong sidebar), và cơ chế thu gọn
(collapse) thủ công user tự bật/tắt được — hiện tại chỉ tự thu gọn khi
viewport hẹp, không có cách nào user chủ động ghim (pin) sidebar ở dạng rail
trên màn rộng.

**Research thật (đọc thẳng `node_modules/@deepseek-ai/dsh-client-ui-{sidebar,workspace}/lib/client.js`
đã cài — `dsh-client-ui-primitives` vẫn KHÔNG cài trên máy này, giống mọi
lần trước, nên đây vẫn là suy luận từ nơi GỌI, không phải primitive gốc):**

**1. `dsh-client-ui-sidebar` — cấu trúc gốc thật (đọc từ toàn bộ tên class
CSS-module thật, không đoán):**
```
root
├─ logoRow
│  └─ brand → brandIdentity → brandMark (icon) + brandName (text)
│           → buildRevision (badge nhỏ, version — KHÔNG áp dụng cho dự án
│             này, bỏ qua)
│  └─ toggle (nút thu/mở, icon panelIcon bên trong; railMark = brandMark
│     khi ở dạng rail)
├─ newSession (nút CTA, icon + newSessionLabel)
├─ regionArea (slot chứa danh sách session — nơi `dsh-client-ui-workspace`
│  render vào)
└─ footArea → footerActions → settingsArea
```
Rule CSS thật quan trọng nhất: `.root{padding:6px 12px}`,
`.logoRow{height:60px}` (mở rộng) / `{height:36px}` (rail), `.brandName{
font-size:18px;font-weight:600;letter-spacing:.04em}`, `.newSession{
height:38px;border:1px solid var(--border-l2);background:var(--button-
elevated-fill);border-radius:12px;padding:8px 16px;font-size:14px;font-
weight:500}` mở rộng → `{background:0 0;border-color:transparent;width:
36px;height:36px;padding:0}` khi rail (chỉ còn icon, mất label — xác nhận
LẠI đúng con số 36px/56px rail width App.tsx đã port từ Phase 10). `.icon
Button{width:28px;height:28px;border-radius:50%}` hover đổi bg — nav-context
icon button, khớp đúng `.fh-sidebar-toggle`/`.fh-theme-toggle` đã có.

**2. `dsh-client-ui-workspace` — session-list thật (2 CSS-module khác nhau
trong CÙNG package, 1 cho khung/search, 1 cho từng row):** package này thật
ra là 1 hệ TREE/folder/drag-drop rất lớn (workspace, folder, tìm kiếm nâng
cao, rename qua modal, xoá có xác nhận) — **ngoài phạm vi thật sự cần**,
đúng quyết định đã chốt từ Phase 12 (dự án này không có khái niệm folder/
workspace, chỉ có 1 danh sách phẳng theo user). Chỉ trích phần THẬT SỰ ÁP
DỤNG được cho danh sách phẳng:
- **Search thật là 1 nút tròn 28px BUNG RA thành ô nhập khi bấm**, không
  phải 1 input luôn hiện sẵn như hiện tại: `.search{width:28px;height:28px;
  border-radius:50%;transition:width .18s}` → bấm vào bung thành
  `.searchExpanded{border:1px solid var(--border-l2);height:30px;border-
  radius:10px}` chứa `.searchInput` thật (opacity/width transition, không
  phải remount).
- **Session row thật**: `.sessionRow{height:32px;border-radius:8px;padding:
  0 8px;gap:6px}`, `.title{font-size:14px;line-height:20px}`, `.time`/
  `.meta{font-size:12px;color:label-tertiary}`, `.selected{background:
  interactive-bg-hover}` (CHÍNH XÁC bằng background hover — đúng lại thiết
  kế Phase 14 đã làm, xác nhận thêm 1 nguồn độc lập).
- **Phát hiện quan trọng, sửa lại `.fh-session-row-rename` LẦN NỮA (đã sửa
  1 lần ở Phase button-research trước) — số liệu chính xác hơn vừa tìm
  được**: nút hành động TRONG 1 hàng session (rename) dùng
  `.iconButton{width:16px;height:16px;border-radius:4px}` — nhỏ và bo góc
  ít hơn hẳn con số 22px/6px trước đó suy luận từ package KHÁC
  (`settings-models`, ngữ cảnh khác — 1 hàng cài đặt, không phải 1 hàng
  session). Đây mới là citation ĐÚNG NGỮ CẢNH nhất từng tìm được cho đúng
  element này.
- **`.rowActions{display:none}` mặc định, chỉ hiện khi hover row** — hành
  vi thật là ẩn/hiện theo hover, KHÔNG phải luôn hiện như
  `.fh-session-row-rename` hiện tại.

**Quyết định phạm vi v1 (ghi rõ, không làm quá tay):**
- **Làm:** brand row (mark + tên, KHÔNG dùng logo/asset thật của dsh — chữ
  "fox-harness" + 1 icon lucide trung tính, đúng nguyên tắc "cùng thể loại,
  không phải thương hiệu của họ" đã áp dụng xuyên suốt dự án); nút collapse/
  expand THẬT trong sidebar (không chỉ trong header khi màn hẹp như hiện
  tại) — mở rộng cơ chế đang có (`sidebarManuallyExpanded`, chỉ áp cho màn
  hẹp) thành 1 preference RIÊNG cho màn rộng (`sidebarPinnedCollapsed`, lưu
  `localStorage`, cùng pattern `useTheme.ts` đã dùng); nút "New session"
  CHUYỂN từ `#session-bar` (header) vào sidebar, đúng vị trí thật; search
  bung-khi-bấm thay vì luôn hiện; session row đúng kích thước thật (32px/
  8px), rename button đúng 16px/4px, rowActions ẩn/hiện theo hover thay vì
  luôn hiện.
- **KHÔNG làm** (ngoài phạm vi, đã ghi rõ để không tự ý mở rộng): folder/
  workspace/tree/drag-drop (dự án không có khái niệm này, đã chốt Phase
  12); rename qua modal riêng (giữ nguyên `window.prompt()` hiện có, không
  phải bug, chỉ đơn giản hơn thật); hover-preview card (`hoverTitle`/
  `hoverPath`/…) — tính năng thật nhưng không cần thiết cho quy mô session
  list nhỏ của dự án này; `buildRevision` badge (không có khái niệm version
  hiển thị); logo/brand asset thật của dsh (không được phép, không phải
  thương hiệu của dự án này).

**Hoàn thành khi:** `Sidebar.tsx` có đủ 4 vùng thật (logo row + toggle,
New Session, region chứa SessionList, footer Settings) đúng thứ tự thật;
`SessionList.tsx`'s search bung/thu đúng hành vi thật; session row + rename
button đúng kích thước thật vừa đọc được; collapse toggle hoạt động thật
trên CẢ màn rộng lẫn hẹp, có persist qua reload trên màn rộng. Verify bằng
jsdom + React thật (không phải "nhìn đẹp hơn là được" — đối chiếu đúng
class/kích thước đã áp dụng), `pnpm run typecheck` sạch,
`scripts/upstream-smoke-test.mjs` không hỏng (thuần FE, không đụng backend).

---

### Phase 16 — Bỏ hẳn kho plugin theo user/session (catalog + duyệt + bật/tắt) — quyết định kiến trúc đảo ngược lần 2 (thêm 2026-09-08)

**Bối cảnh — đúng nguyên văn lý do user đưa ra, quan trọng để hiểu quyết
định này không phải "dọn rác" mà là sửa lại giả định sai từ đầu:** trong
lúc hỏi lại về mô hình session, user mô tả kỳ vọng thật: "user sẽ có 1
workspace riêng của họ có các plugin tuỳ họ chọn và mỗi 1 đoạn chat sẽ lưu
theo họ như 1 platform chat". Đối chiếu với thiết kế thật (Phase 5) thì
phát hiện 2 điều:
1. `session_enabled_plugins` khoá theo **session**, không phải theo user —
   bật 1 plugin ở đoạn chat A không tự có ở đoạn chat B, dù cùng 1 user tạo
   ra cả 2. Không khớp mô hình "platform chat thật" user mô tả.
2. Hỏi sâu hơn thì lộ ra nhu cầu THẬT: **mọi user cần giống nhau về năng
   lực** (search + phân tích), không ai cần tự chọn bộ tool khác nhau —
   nghĩa là cả cơ chế catalog (nộp/duyệt) LẪN cơ chế bật/tắt theo user/
   session đều **không giải quyết vấn đề thật nào cả**, chỉ thêm độ phức
   tạp (schema, service riêng, build pipeline, review gate, FE toggle) cho
   1 nhu cầu không tồn tại.

**Quyết định:** bỏ hẳn toàn bộ "kho plugin" (catalog + submit + duyệt +
bật/tắt theo user/session) — KHÔNG phải bỏ Cordis plugin mechanism (đó vẫn
là cách `dsh` hoạt động, xem mục 0), chỉ bỏ **1 tầng quản trị được XÂY THÊM
lên trên** cho 1 nhu cầu ("mỗi user chọn bộ năng lực khác nhau") mà thực tế
không cần. Thêm năng lực mới (search, phân tích công ty, ...) từ giờ làm
đúng như `packages/tool/duckduckgo-web-search` đã làm từ Phase 1: viết 1
package thật, `insert:` vào cây plugin qua `cordis.patch.yml`, LUÔN CÓ SẴN
cho mọi session — không qua catalog, không cần duyệt/bật/tắt gì cả. Thêm
năng lực mới = 1 lần sửa code + redeploy, không phải 1 luồng vận hành riêng.

**Đây là quyết định kiến trúc đảo ngược THỨ 2 của dự án** (lần 1: bỏ hệ
UI-plugin động, `docs/code-rules.md` §30). Cùng bài học: 1 cơ chế được xây
để giải quyết 1 nhu cầu ("mỗi user/session cần bộ năng lực khác nhau") hoá
ra chưa từng thực sự cần dùng tới.

**Giữ lại, KHÔNG đụng:**
- `GET /sessions/:id/plugin-inventory` (gateway) + `GET /plugin-inventory`
  (`packages/transport`) + `PluginInventory.tsx` (FE) — đây là công cụ chẩn
  đoán ĐỌC live Cordis Loader state thật của 1 worker, hoàn toàn độc lập
  với cơ chế catalog/bật-tắt vừa bỏ, vẫn còn giá trị (xem cây plugin thật
  đang chạy trong session, phục vụ debug).
- Cordis plugin mechanism của `dsh` (không phải thứ dự án này tự xây, xem
  mục 0-1) — mọi package `packages/*` vẫn là plugin thật, chỉ không còn
  "catalog cho user tự chọn" nữa.

**Sẽ xoá thật (liệt kê đầy đủ, đã rà `grep` toàn repo trước khi viết mục
này):**
- **Backend:** `services/plugin-registry/` (toàn bộ service — catalog CRUD,
  build/verify `pnpm add` pipeline, duyệt, sinh `cordis.patch.yml` per-session).
  2 bảng Postgres `plugin_catalog`/`session_enabled_plugins` (migration MỚI
  để drop, không sửa lại migration cũ). `services/gateway`'s 4 route
  (`GET/POST /plugin-catalog`, `POST /plugin-catalog/:id/approve`,
  `GET/POST /sessions/:id/plugins(...)`) + `config.pluginRegistryUrl`.
  `services/orchestrator`'s `postgres.ts` (toàn bộ file — chỉ tồn tại để
  đọc `plugin_catalog`) + `materialize.ts`'s phần approved-plugin-row +
  `config.pluginArtifactsDir`. Dependency `pg`/`@types/pg` khỏi
  `services/orchestrator/package.json` (chỉ dùng trong `postgres.ts` vừa
  xoá). `tsconfig.json`'s reference tới `services/plugin-registry`.
- **Frontend:** `SettingsPlugins.tsx`, `useEnabledPlugins.ts`, `pluginUi.tsx`
  (Phase 13's `KNOWN_PLUGIN_UI` — cơ chế "plugin backend góp UI theo trạng
  thái bật/tắt" không còn ý nghĩa gì khi không còn khái niệm bật/tắt),
  `DemoPluginButton.tsx` (chỉ tồn tại để demo cơ chế trên). `Sidebar.tsx`
  bỏ `PluginUiArea`. `SettingsDialog.tsx` bỏ section `SettingsPlugins`
  (giữ nguyên `PluginInventory`).

**Hoàn thành khi:** `pnpm run typecheck` sạch trên workspace ĐÃ GIẢM (còn
lại đúng số package/service thật, `services/plugin-registry` không còn
trong danh sách); mọi route catalog/toggle cũ trả về 404 thật (route không
còn tồn tại, không phải lỗi); 1 session mới vẫn có `duckduckgo_web_search`
sẵn dùng ngay (không cần bật gì) — chứng minh năng lực THẬT vẫn còn, chỉ
mất đi lớp quản trị thừa; `GET /sessions/:id/plugin-inventory` vẫn hoạt
động bình thường (không bị xoá nhầm cùng lúc). Verify bằng dữ liệu thật
(register/login/chat/tool-call thật qua chuỗi gateway→orchestrator→worker),
không chỉ đọc code.

### Phase 17 — Migrate database engine từ Postgres sang MariaDB (thêm 2026-09-09)

**Bối cảnh:** user hỏi deploy lên prod VM thật khác gì so với dev hiện tại,
lộ ra 1 ràng buộc thật: prod VM đã có sẵn MariaDB, và user xác nhận thẳng
"DB server buộc phải dùng MariaDB". `services/gateway` từ Phase 7 tới nay
dùng `pg` — driver này nói chuyện **Postgres wire protocol**, không kết nối
được với MariaDB (2 engine khác hẳn nhau, không phải chuyện đổi
`DATABASE_URL`). Cần migrate thật, không phải chỉnh config.

**Rà soát phạm vi trước khi sửa** (grep toàn repo — services/, packages/,
apps/, docs/, infra/, scripts/): chỉ đúng 2 chỗ có code Postgres thật —
`services/gateway/src/db.ts` (8 hàm query) và `scripts/create-admin.mjs`
(SQL riêng, KHÔNG import từ `db.ts` — script này chạy độc lập ngoài module
graph của gateway, tự có `pg.Pool` + SQL của riêng nó). Không service nào
khác đụng Postgres (`services/orchestrator` chỉ còn Redis từ Phase 16).

**Quyết định kỹ thuật:**
1. **Driver:** `mariadb` npm package (driver chính thức của MariaDB
   Foundation) thay `pg`/`@types/pg` — đúng convention "1 client chuyên cho
   1 protocol thật" dự án đã dùng cho `ws`/`ioredis`/`dockerode`. Xác nhận
   thật qua `node_modules/mariadb/types/index.d.ts` VÀ
   `node_modules/mariadb/lib/config/connection-options.js` (không đoán):
   `createPool(config: PoolConfig | string)` nhận thẳng connection string,
   nhưng bắt buộc đúng scheme `mariadb://` (`url.protocol !== 'mariadb:'`
   throw), `pool.query(sql, values)` trả thẳng mảng row (không bọc trong
   `.rows` như `pg`), placeholder `?` (không phải `$1`).
2. **Rewrite query** (8 hàm `db.ts` + SQL riêng của `create-admin.mjs`):
   `$1,$2,...` → `?`, **thứ tự mảng params phải khớp thứ tự `?` xuất hiện
   trong text SQL** (không chỉ đổi tên) — ví dụ `renameSession` cũ
   `set title=$2 ... where session_id=$1` với params `[sessionId, title]`,
   giờ `set title=? ... where session_id=?` cần params `[title, sessionId]`.
   `insert ... on conflict (...) do nothing` → `insert ignore into ...`.
   `insert ... on conflict (email) do update set ...` (`create-admin.mjs`)
   → `insert ... on duplicate key update password_hash = values(...), ...`.
   `returning *` giữ nguyên — MariaDB 10.5+ hỗ trợ `RETURNING` trên INSERT
   thật (bản target 10.11 xác nhận đủ).
3. **Schema dialect** (`infra/migrations/001_init.sql`, MỚI, dựng
   lại từ schema Postgres LIVE hiện tại qua `psql \d users`/`\d sessions` —
   không phải replay máy móc 5 file migration Postgres cũ, vì 5 file đó mô
   tả delta trên 1 Postgres instance chưa từng tồn tại trên MariaDB):
   `text` (cột khoá) → `varchar` có size (`varchar(36)` cho UUID,
   `varchar(255)` cho email); `timestamptz` → `datetime` (không dùng
   `timestamp` — giới hạn 2038); `check(role in (...))` giữ nguyên (MariaDB
   10.2+); `create index ... desc` + `if not exists` giữ nguyên (cần
   10.5+/10.8+, đủ ở bản target 10.11); FK viết dạng `constraint ... foreign
   key` tường minh, KHÔNG dùng `references` inline trên cột — phát hiện
   thật: MySQL/MariaDB parse `references` inline nhưng KHÔNG enforce thật
   trên InnoDB (khác Postgres, nơi inline `references` tương đương hoàn
   toàn) — chỉ dạng table-level constraint mới chắc chắn tạo FK thật.
4. **5 file migration Postgres cũ (`../001-005*.sql`) giữ nguyên trên đĩa**
   — không sửa, không xoá, làm bản ghi lịch sử (đúng nguyên tắc "không viết
   lại lịch sử" đã dùng ở `004_remove_plugin_store.sql`). `mariadb/` là
   track schema sống từ giờ. `infra/migrations/README.md` viết lại giải
   thích rõ 2 track. **Đảo ngược cùng ngày (Phase tiếp theo cùng
   2026-09-09):** user yêu cầu thẳng bỏ hết Postgres khỏi `infra/migrations`
   — 5 file trên đã xoá hẳn, `mariadb/001_init.sql` chuyển phẳng lên
   `infra/migrations/001_init.sql`, không còn "2 track" nữa. Xem
   `docs/code-rules.md` §51.
5. **`infra/docker/docker-compose.dev.yml`**: thay hẳn service `postgres`
   bằng `mariadb:10.11` (đúng bản prod đã xác nhận với user — quan trọng vì
   CHECK constraint/DESC-index/IF NOT EXISTS đều gate theo version), port
   `3307:3306` (tránh đụng MariaDB/MySQL cục bộ có sẵn, cùng kiểu né 5433-
   không-phải-5432 cũ).

**Verify thật (không chỉ typecheck):** dựng container `mariadb:10.11` thật
qua compose file mới, áp `mariadb/001_init.sql` thật (`docker exec ...
mariadb ...`), xác nhận qua `show create table` thấy đúng FK/CHECK/DESC
index như thiết kế. Trỏ `DATABASE_URL` sang đó, restart `services/gateway`
thật. Chạy lại đúng bộ test đầu-cuối đã dùng để verify Postgres trước đây
(2 account thật, WS đồng thời, chat turn thật, cross-user 403, session-list
cô lập) — PASS toàn bộ trên MariaDB, thêm 1 assertion mới cho rename để
chứng minh thứ tự params `?` đã đổi đúng. Chạy `scripts/create-admin.mjs`
thật 2 lần liên tiếp (tạo mới rồi chạy lại) — xác nhận `ON DUPLICATE KEY
UPDATE` giữ nguyên `id`, chỉ cập nhật password/role, không tạo row trùng.
`pnpm run typecheck` sạch. Container Postgres dev cũ dừng lại (không xoá) —
chỉ chứa dữ liệu test synthetic của các phiên verify trước đó.

### Phase 18 — Sandbox thật cho bash/fs tool: bwrap trong worker + fix crash escalation (thêm 2026-09-11)

**Bối cảnh:** user hỏi bộ core plugin hiện tại có chuẩn không, và có nên
xây thêm plugin skill/loop/sandbox không. Điều tra thật (đọc thẳng
`node_modules`, không đoán) phát hiện: `dsh-sandbox`/`dsh-sandbox-local`/
`dsh-sandbox-policy`/`dsh-bash-sandbox`/`dsh-fs-sandbox`, `tool-bash`,
`tool-fs`, `skill`/`tool-skill`, `subagent`/`tool-subagent`,
`tool-workflow` **ĐÃ ĐƯỢC MOUNT SẴN** — tất cả đến từ `@deepseek-ai/
dsh-base` (bundle đầu tiên trong `packages/profile-template`'s
`profile.package.json`), profile overlay riêng của fox-harness
(`cordis.patch.yml`) không tắt row nào trong số đó. Không cần xây gì mới
— vấn đề thật là 2 gap khiến năng lực có sẵn này CHƯA HOẠT ĐỘNG, phát
hiện qua 1 test thật (đăng ký user thật, mở WS thật, yêu cầu model chạy
`echo` qua bash tool):

1. `SANDBOX_UNAVAILABLE` — không backend nào dùng được trong container
   worker (`infra/docker/worker/Dockerfile` thiếu `bubblewrap`).
2. Crash thật ở `packages/agent-driver/src/agent.ts` khi model thử
   escalate lên `danger-full-access` lúc backend không dùng được —
   `result.error.info` là `undefined` (lỗi `approveEscalation()` throw
   là `Error` thường, không phải `HarnessError`), đưa `error: undefined`
   vào event `tool/result` làm `Session.append()` từ chối, sập cả turn.

**Quyết định kỹ thuật:**
1. **`infra/docker/worker/Dockerfile`**: thêm `bubblewrap` vào
   `apt-get install`. CHƯA ĐỦ — verify thật vẫn thấy
   `SANDBOX_UNAVAILABLE` sau khi cài.
2. **Root cause thật thứ 2, tìm bằng `docker exec` trực tiếp**: `bwrap`
   cài xong chạy được với test tay rộng (`--unshare-all`), nhưng probe
   THẬT của `dsh-sandbox-local` (đọc thẳng source compiled,
   `bwrapProfileArgs()`/`defaultProbeBwrap()`) dùng đúng
   `--unshare-pid --proc /proc` — chạy `docker exec` với ĐÚNG lệnh này
   cho ra `bwrap: Creating new namespace failed: Operation not
   permitted`. Nguyên nhân: tạo PID namespace (cần để remount `/proc`
   bên trong `bwrap`) đòi `CAP_SYS_ADMIN`, mà Docker container không có
   theo default.
3. **Fix**: thêm `HostConfig.CapAdd: ['SYS_ADMIN']` vào
   `services/orchestrator/src/docker.ts`'s `spawnWorker()`. Đánh đổi ghi
   rõ trong comment tại chỗ: capability này cấp cho tiến trình `dsh`
   (trusted, không phải lệnh bash của model) — `bwrap` tự DROP quyền cho
   tiến trình con nó wrap, nên lệnh bash model chạy vẫn bị confine đúng
   `workspace-write`. Lớp cô lập multi-tenant hiện có (1 container Docker/
   session, `Binds` riêng biệt — xem mục 3 dưới) không đổi.
4. **`packages/agent-driver/src/agent.ts`** (quanh dòng tool-result
   append trong `runStep()`): đổi
   `...(result.isError ? { error: result.error.info } : {})` thành
   `...(result.isError && result.error.info !== undefined ? { error:
   result.error.info } : {})` — chỉ đưa `error` vào event khi THẬT SỰ có
   `.info`, không giả định mọi tool error là `HarnessError`.

**Xác nhận cô lập theo session (Phase 3 cũ):** `services/orchestrator/
src/docker.ts`'s `spawnWorker()` — `HostConfig.Binds: [\`${dshHomeDir}:/
data\`]`, `dshHomeDir` build từ `join(config.dataDir, sessionId)` (session
thật) hoặc `join(config.dataDir, '_pool', randomUUID())` (pool member) —
`docker inspect` thật trên nhiều container cùng lúc xác nhận mỗi container
1 `Binds` khác nhau, trỏ thư mục host khác nhau hoàn toàn.

**Verify thật (không chỉ đọc code) — và 1 bẫy thật gặp phải lúc verify,
đáng ghi lại**: lặp lại bài test bash qua WS thật nhiều lần. Lần đầu sau
khi thêm `CapAdd` + rebuild image + restart orchestrator VẪN thấy
`SANDBOX_UNAVAILABLE` — tưởng fix chưa đúng, nhưng `docker inspect` +
`docker exec bwrap ...` trực tiếp trên container MỚI NHẤT lại cho thấy
probe THÀNH CÔNG. Root cause của sự mâu thuẫn này: `services/orchestrator/
src/warmpool.ts` lưu warm pool trong **Redis** (`fh:warmpool`), KHÔNG
phải in-memory — restart orchestrator KHÔNG xoá pool cũ. Request thật đã
`popWarmPool()` trúng 1 entry pool CŨ (container spawn từ nhiều giờ trước,
image cũ, chưa có `CapAdd`) còn tồn tại từ trước khi fix — trong khi
`claimWarmPoolMember()`'s replenish (fire-and-forget) lại spawn container
MỚI đúng fix ngay sau đó, khiến "container mới nhất" nhìn thấy qua
`docker ps` không phải container thật sự phục vụ request. Xác nhận bằng
`docker exec grep`/`docker inspect` trên ĐÚNG container theo
`containerId` ghi trong log JSON của orchestrator (event `hibernate_idle`
gắn `sessionId`), không đoán qua "container mới nhất". Sau khi `DEL
fh:warmpool` + xoá 2 container pool cũ, request thật tiếp theo cold-spawn
(pool rỗng) từ image/`docker.ts` hiện tại — `tool/result` trả về
`isError:false`, `content` là stdout thật (`"SANDBOX_FIXED_98765\n"`),
không còn `SANDBOX_UNAVAILABLE`, không cần escalation. `pnpm run
typecheck` sạch trước khi build image.

**Không làm trong phase này (quyết định có chủ đích):** không build UI
duyệt `approval/asked` — hệ thống multi-tenant không có human-in-the-loop,
escalation `danger-full-access` luôn bị chặn (an toàn hơn). Không đổi
`dsh-sandbox-policy`'s default mode (`workspace-write`). Không dọn 76 thư
mục `data/dsh-home/_pool/<uuid>` mồ côi tích luỹ từ nhiều ngày trước (pool
member cũ bị thay thế nhưng thư mục không tự xoá) — gap dọn dẹp có thật
của `warmpool.ts`, ngoài phạm vi phase này, ghi lại ở mục 5
`docs/core-overview.md`.

## 4. Rủi ro cần theo dõi

| Rủi ro                            | Ảnh hưởng                         | Giảm thiểu                                                           |
| --------------------------------- | --------------------------------- | -------------------------------------------------------------------- |
| Upstream breaking change          | Cao, liên tục                     | Fork mỏng (0.3), pin version, smoke test theo seam                   |
| Plugin store = RCE trong instance | Nghiêm trọng                      | Container/microVM riêng mỗi user; review; contract khai báo mặc định |
| State rò ra ngoài log             | Mất dữ liệu âm thầm khi hibernate | Test kill đột ngột, không test shutdown sạch                         |
| Chunk chỉ tới browser             | Reload mất nội dung               | Ghi log trước, fan-out sau — tiêu chí Phase 2                        |
| Cold start                        | Trải nghiệm tin nhắn đầu          | Warm pool, hibernate theo hoạt động                                  |
| Symlink / boot manifest           | Client plugin im lặng biến mất    | Xem gotcha Phase 4                                                   |
| Route không kiểm tra token (hiện tại, THẬT) | Ai biết URL cũng gọi được — kể cả duyệt plugin, xoá session của người khác | Phase 7 — bịt từng route + ownership + role |

## 5. Câu hỏi còn mở

1. ~~**Peak session đồng thời?**~~ **Đã chốt (2026-09-04, sửa từ 100–1.000): 1.000–10.000.** Quyết định mô hình worker và ngân sách hạ tầng ở Phase 3 — ở quy mô này, Redis affinity (`sessionId → node`) như roadmap Phase 3 mục 1 mô tả là bắt buộc thật, không còn là lựa chọn có thể đơn giản hóa; cần orchestrator thật với warm pool + hibernate theo hoạt động, và thiết kế affinity/lock phải chịu được tải multi-node thật sự, không phải vài worker cố định.
2. ~~**Plugin user có chạy code tùy ý không?**~~ **Đã chốt (2026-09-03): Có.** Hệ quả trực tiếp (docs/code-rules.md §7, đã là rule bắt buộc chứ không còn là giả định): mỗi user phải có container/microVM riêng, không bao giờ chung process. Rủi ro lớn nhất của Phase 5 (mục "Rủi ro lớn nhất của cả dự án") giờ là rủi ro thật, không phải kịch bản giả định.
3. ~~**9 component cụ thể là gì?**~~ **Đã đối chiếu (2026-09-03)** với `--dump-config` thật (135 row, `docs/reference/dsh-web-profile-dump-config.yml`). Danh sách row giả định "local/single-user" cần thay cho multi-tenant: xem `packages/core/README.md`. Không có con số "9" cố định nào cả — số component thật phụ thuộc vào bao nhiêu row trong 135 row đó cần override.
4. **Transport của `dsh-web-app` có tái dùng được không?** Vẫn mở — đã biết Typert (docs/api-gateway.md) KHÔNG phải thứ cần, nhưng chưa xác định `Connection` bên dưới `dsh-web-app` dùng SSE hay WebSocket. Không chặn Phase 0 (không nằm trong 3 tiêu chí hoàn thành ở trên), nhưng chặn quyết định phạm vi Phase 2 — cần giải quyết trước khi bắt đầu `packages/transport` thật.
