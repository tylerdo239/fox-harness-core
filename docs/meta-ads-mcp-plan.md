# Plan: tool Meta Ads (Facebook/Instagram) qua Meta Ads MCP, tới production

Trạng thái: **P1–P3 đã code, e2e xanh với Meta giả; P0 (Meta app thật) và thử thật chưa làm** (2026-10-27, nhánh
`feat/fb-tiktok-mcp`). Mục 11 ghi những gì đã đổi so với plan ban đầu khi rà lại trước lúc code. Tài liệu nền: `docs/ads-mcp-integration.md`
(Meta Ads MCP là gì, OAuth, danh sách tool). TikTok làm sau, dùng lại đúng khung này (§9).

## 0. Mục tiêu và phạm vi

Mỗi user tự **kết nối tài khoản Meta của mình** trong Cài đặt. Sau đó, trong một chat flow riêng, Fox Agent làm được:
- **Đọc:** liệt kê ad account, báo cáo hiệu quả, xu hướng, bất thường, lỗi phân phối, lịch sử thay đổi, tra Help Center.
- **Ghi, luôn có xác nhận của user:** tạo campaign / ad set / ad (Meta tạo ở trạng thái paused), sửa, bật chạy.

Không làm trong plan này:
- Catalog, pixel và dataset ghi.
- Custom audience ghi, vì có dữ liệu cá nhân (§8).
- A/B test, lift study ghi.
- Tài khoản dùng chung cho mọi user.

## 1. Quyết định

| # | Quyết định | Vì sao |
|---|---|---|
| D1 | **Token theo từng user, giữ ở gateway.** Runtime không bao giờ thấy token. | Đúng nguyên tắc của core (`core-architecture.md` §4.4): bí mật nằm ở gateway, runtime chạy code model sinh ra. Mỗi người chỉ thấy và sửa ad account mà Meta cho chính họ. |
| D2 | **Gateway là MCP client** tới `https://mcp.facebook.com/ads`. Runtime gọi gateway qua **cổng nội bộ mới** `POST /internal/meta-ads/call {sessionId, callId, tool, arguments}`. | Không chuyển tiếp JSON-RPC thô: gateway cần biết tool nào đang được gọi để chặn, xác nhận, audit và đổi lỗi. Một client MCP cho mỗi user (cache, tự đóng khi rảnh) nằm gọn ở gateway. |
| D3 | Cổng nội bộ là **listener riêng chỉ nghe `127.0.0.1`** (`FOX_INTERNAL_PORT`, mặc định 4300), bắt buộc header `x-fox-harness-internal-secret`, đúng secret mà gateway đã truyền cho runtime (`FOX_INTERNAL_SECRET`, `runtime/supervisor.ts`). | nginx/ingress chỉ trỏ tới cổng 4000, nên route nội bộ không bao giờ lộ ra ngoài. Code của model không có secret: `fox-confine.sh` / `fox-noconfine.sh` chạy `env -i` với allow-list. Gateway tự tra **chủ session** trong DB, không tin `userId` do runtime gửi. |
| D4 | **Plugin runtime của mình** `@fox-harness/dsh-tool-meta-ads`, không dùng `dsh-mcp-client`. | `dsh-mcp-client` nối thẳng tới server với header tĩnh, một kết nối cho cả process (`ads-mcp-integration.md` §4.1). Plugin của mình đăng ký tool từ **schema đã ghim**, mỗi lần gọi thì chuyển `sessionId` + `callId` cho gateway. |
| D5 | **Schema tool ghim trong repo** (`src/tools.generated.ts`), sinh bằng script `api/scripts/meta-ads-sync-tools.mjs` từ `tools/list` thật. Chỉ chứa tool trong allowlist. | `tools/list` của Meta cần token user, nên runtime không lấy được lúc khởi động. Ghim schema giúp prompt ổn định (KV cache), chạy được khi Meta lỗi, và review được khi Meta đổi schema. |
| D6 | **Allowlist hai tầng**, kiểm ở **cả runtime và gateway**: `read` (P2) và `write` (P3). Gateway từ chối mọi tool ngoài allowlist dù runtime gửi gì. | Phía server mới là chốt an toàn thật. Plugin chỉ quyết model thấy gì. |
| D7 | **Tool ghi phải chờ user bấm xác nhận.** Gateway giữ yêu cầu ở trạng thái *pending* (Redis, TTL 10 phút). FE hiện thẻ xác nhận. User bấm thì gateway mới gọi Meta. Từ chối hoặc hết giờ thì tool trả lỗi rõ ràng. | App không nối kênh approval của dsh (`agent.ts`: "this app never wires one up"). Chặn ở gateway thì model, prompt injection hay plugin lỗi đều không vượt được. Kết quả trả về ngay trong lượt đang chạy, nên model nói tiếp tự nhiên. |
| D8 | **Flow mới `meta-ads`** (preset riêng, `FLOW_TOOL_MASK = 'all'` cộng thêm vài tool global cần thiết). | Prompt flow `default` không phải gánh khoảng 30 schema ads. Persona riêng cho marketing. Giống cách làm Data Studio. |
| D9 | DB: bảng `discovery_ads_connections` có cột `provider` (`meta`, sau này `tiktok`) và `discovery_ads_actions` (audit tool ghi). **Không cột `json`** (code-rules §49). Token mã hoá AES-256-GCM với khoá `FOX_TOKEN_ENC_KEY`, chỉ gateway có. | Dùng lại cho TikTok. Audit cho biết ai đã bật hay sửa gì. |
| D10 | Bật/tắt toàn bộ bằng `META_ADS_ENABLED` (mặc định `false`). | Deploy được trước khi có Meta app hay App Review. |

## 2. Kiến trúc

```
                       ┌──────────────── gateway (:4000 public, :4300 loopback) ─────────────────┐
Settings > Kết nối ───►│ GET  /connections                     trạng thái các provider của user  │
                       │ POST /connections/meta/start          PKCE + state (Redis) → URL login  │
Facebook Login ───────►│ GET  /connections/meta/callback       code → token → mã hoá → MariaDB   │
                       │ DELETE /connections/meta              xoá token (+ thu hồi phía Meta)   │
                       │                                                                         │
thẻ xác nhận (FE) ────►│ POST /meta-ads/actions/:id/decision   {approve|reject}, chỉ chủ session │
                       │                                                                         │
runtime plugin ───────►│ POST /internal/meta-ads/call  (:4300, secret)                           │
                       │   session → chủ → token (refresh nếu cần) → allowlist                   │
                       │   read  → MCP client của user ──► https://mcp.facebook.com/ads          │
                       │   write → pending (Redis) → chờ quyết định → gọi Meta → audit           │
                       └─────────────────────────────────────────────────────────────────────────┘
```

Một lượt chat có tool ghi:

```
model gọi ads_create_campaign(args)
  plugin → POST /internal/meta-ads/call {sessionId, callId, tool, arguments}
  gateway: tool ∈ write → ghi discovery_ads_actions(status=pending) → Redis pending:<id> → giữ request (long-poll)
  FE: thấy tool/call ads_create_campaign chưa có result → thẻ "Xác nhận tạo campaign …" [Đồng ý] [Từ chối]
  user bấm Đồng ý → POST /meta-ads/actions/<id>/decision → gateway publish quyết định
  gateway gọi Meta → status=done/error → trả kết quả cho plugin → tool/result → model nói tiếp
  không ai bấm trong 10 phút / bấm Từ chối → tool lỗi "Người dùng không xác nhận" (status=expired/rejected)
```

F5 hay mất mạng không làm mất thẻ: FE dựng lại từ log (tool/call chưa có result) và hỏi trạng thái qua
`GET /meta-ads/actions?sessionId=`. Runtime restart thì lượt bị đóng `interrupted` và pending hết hạn, an toàn theo
hướng không làm gì.

## 3. Dữ liệu

`api/migrations/004_ads.sql`. Số 003 đã dùng cho `003_memory.sql` ở nhánh `feat/memory`. Merge nhánh nào trước thì
đánh lại số cho khớp.

```sql
create table if not exists discovery_ads_connections (
  id int auto_increment primary key,
  user_id int not null,
  provider varchar(16) not null,              -- 'meta' | 'tiktok'
  external_user_id varchar(64) null,          -- id người dùng phía Meta (/me)
  external_name varchar(255) null,            -- tên hiện trên Cài đặt
  scopes varchar(1024) not null,              -- các scope đã cấp, cách nhau bởi dấu cách
  access_token_enc varbinary(4096) not null,  -- iv(12) | ciphertext | tag(16)
  refresh_token_enc varbinary(4096) null,
  key_id varchar(16) not null,                -- khoá nào đã mã hoá, để xoay khoá
  expires_at datetime(3) null,                -- UTC
  last_used_at datetime(3) null,
  last_error varchar(255) null,               -- 'expired' | 'revoked' | …, xoá khi gọi lại thành công
  created_at datetime not null default current_timestamp,
  updated_at datetime not null default current_timestamp on update current_timestamp,
  unique index ads_connections_user_provider_idx (user_id, provider)
) engine=innodb default charset=utf8mb4 collate=utf8mb4_unicode_ci;

create table if not exists discovery_ads_actions (
  id int auto_increment primary key,
  user_id int not null,
  session_id varchar(64) not null,
  call_id varchar(64) not null,
  provider varchar(16) not null,
  tool varchar(64) not null,
  ad_account_id varchar(64) null,
  summary varchar(1000) not null,             -- mô tả dễ đọc của thay đổi (không phải tham số thô)
  status varchar(16) not null,                -- pending | approved | rejected | expired | done | error
  error varchar(500) null,
  asked_at datetime(3) not null,
  decided_at datetime(3) null,
  finished_at datetime(3) null,
  created_at datetime not null default current_timestamp,
  updated_at datetime not null default current_timestamp on update current_timestamp,
  unique index ads_actions_call_idx (session_id, call_id),
  index ads_actions_user_idx (user_id, asked_at)
) engine=innodb default charset=utf8mb4 collate=utf8mb4_unicode_ci;
```

Không lưu tham số thô: chúng đã nằm trong session log (tool/call). Audit chỉ cần biết ai làm gì, lúc nào, kết quả ra sao.
Xoá user thì xoá theo `user_id`, cùng chỗ với các bảng khác.

Redis:
- `fh:oauth:<state>`: `{userId, provider, codeVerifier}`, TTL 10 phút, dùng một lần (`getdel`).
- `fh:adsact:<id>`: pending, TTL 10 phút. Kênh pub/sub `fh:adsact` để báo quyết định khi chạy nhiều gateway.

## 4. Env mới

| Biến | Ai dùng | Ghi chú |
|---|---|---|
| `META_ADS_ENABLED` | gateway | `true` thì bật route `/connections/meta*`, `/meta-ads/*` và flow `meta-ads`. |
| `META_APP_ID` | gateway | OAuth `client_id`. |
| `META_APP_SECRET` | gateway | Chỉ khi Meta cần cho đổi token dài hạn. MCP metadata ghi `token_endpoint_auth: none`, **P0 kiểm**. |
| `META_LOGIN_CONFIG_ID` | gateway | Facebook Login for Business dùng `config_id` thay danh sách scope. **P0 kiểm.** |
| `META_ADS_REDIRECT_URL` | gateway | `https://<domain>/connections/meta/callback`, phải khớp cấu hình app. |
| `META_ADS_MCP_URL` | gateway | Mặc định `https://mcp.facebook.com/ads`. e2e trỏ tới server giả. |
| `META_OAUTH_AUTHORIZE_URL`, `META_OAUTH_TOKEN_URL` | gateway | Mặc định theo metadata (`www.facebook.com/v26.0/dialog/oauth`, `graph.facebook.com/v26.0/oauth/access_token`). e2e trỏ tới server giả. |
| `FOX_TOKEN_ENC_KEY` | gateway | 32 byte base64. Xoay khoá: `FOX_TOKEN_ENC_KEYS=k2:…,k1:…`, khoá đầu dùng để mã hoá. |
| `FOX_INTERNAL_PORT` | gateway, runtime | Mặc định 4300. Runtime nhận `FOX_INTERNAL_URL=http://127.0.0.1:4300` qua `runtimeEnvPassthrough` (secret đã có sẵn). |

`api/.env.example`, `docs/deploy.md` và `docs/staging-checklist.md` cập nhật theo. Biến `META_*` không vào runtime.

## 5. Các phần cần viết

### 5.1 Gateway (`api/services/gateway/src/`)

- `ads/crypto.ts`: `seal(plain) → Buffer` và `open(buf, keyId)`, AES-256-GCM, iv ngẫu nhiên.
- `ads/connections.ts`: CRUD bảng connection, `tokenFor(userId, 'meta')`:
  - Giải mã token, refresh nếu còn dưới 10 phút. Mỗi user một lock để không refresh hai lần.
  - Meta trả `invalid_token` hoặc refresh thất bại: `last_error='expired'` và báo user kết nối lại.
- `ads/oauth-meta.ts`: start (PKCE S256 + state), callback (đổi code, gọi `/me` lấy tên, lưu), disconnect (xoá hàng,
  gọi Graph `DELETE /me/permissions` nếu có token, lỗi bỏ qua).
- `ads/meta-mcp.ts`: pool `Client` của `@modelcontextprotocol/sdk` (Streamable HTTP, `Authorization: Bearer`):
  - Mỗi user một client, đóng sau `META_MCP_IDLE_MS` (mặc định 10 phút). Đổi token thì tạo lại client.
  - `call(userId, tool, args, signal)`: timeout 60 giây.
  - Kết quả MCP thành text, cắt ở khoảng 20.000 ký tự kèm ghi chú "dùng bộ lọc / date range hẹp hơn".
- `ads/actions.ts`: tạo pending, long-poll chờ quyết định (Redis pub/sub + TTL), `decide(id, userId, decision)` chỉ
  cho chủ session, `summaryOf(tool, args)` (viết cho từng tool ghi: tên campaign, objective, ngân sách/ngày, ad account).
- `internal-server.ts`: listener `127.0.0.1:FOX_INTERNAL_PORT`, chỉ route `/internal/*`, so secret bằng
  `timingSafeEqual`, giới hạn body 1 MB.
- `index.ts`: các route public ở §2, thêm `connections|meta-ads` vào allow-list của nginx (`app/nginx.conf.template`
  dòng 35). Rate limit theo user, ví dụ 60 lần gọi tool Meta mỗi phút.
- Log: `meta_ads_call {userId, sessionId, tool, ms, ok, error}`, `meta_ads_action {id, status}`. Không log tham số hay
  token.

### 5.2 Runtime plugin `api/packages/tool/meta-ads`

- `src/index.ts`: với mỗi schema trong `tools.generated.ts` có tầng được phép theo `META_ADS_TIERS`, gọi `defineTool`.
  `execute` POST tới `FOX_INTERNAL_URL/internal/meta-ads/call` với `sessionId` lấy từ agent gốc (đi ngược `parentSession`
  như `ownerOf` của data-studio-agent), `callId = exec.callId`, và `exec.signal`.
- Timeout: đọc 90 giây, ghi `10 phút + 90 giây`, vì phải chờ user.
- Lỗi do gateway trả về (`not_connected`, `expired`, `rejected`, `timeout`, `rate_limited`, `meta_error`) thành câu
  tiếng Việt và tiếng Anh ngắn cho model, ví dụ "Người dùng chưa kết nối Meta. Hãy nhắc họ vào Cài đặt > Kết nối."
- `cordis.patch.yml`, `package.json` theo mẫu `create-skill`. Nằm trong preset `meta-ads`, không global.
- `api/scripts/meta-ads-sync-tools.mjs`: nhận `META_TOKEN` (token test), gọi `tools/list`, lọc theo allowlist
  (`allowlist.ts`: tên → tầng), ghi `tools.generated.ts`, in diff tool mới/mất.

### 5.3 Flow `meta-ads`

- `profile-template/presets/meta-ads/agent.cordis.yml`, persona:
  - Luôn gọi `ads_get_ad_accounts` khi chưa biết account.
  - Đọc `ads_get_field_context` trước khi lọc `ads_get_ad_entities`.
  - Tiền tệ theo account. Không tự bật campaign.
  - Mọi tool ghi sẽ hỏi user. Không nói đã làm khi tool bị từ chối.
  - Trả lời theo ngôn ngữ của user.
- `services/gateway/src/config.ts`: thêm `'meta-ads': { workspace: false }` vào `flows`, chỉ khi `META_ADS_ENABLED`.
- `agent-core/src/transport/flows.ts`: `'meta-ads'` ẩn mọi tool global trừ những tool cần thiết. Đề xuất giữ `todo_write`,
  bỏ `bash` và file tools. Chốt ở P2 sau khi đo prompt.

### 5.4 FE (`app/src`)

- Settings, tab mới **Kết nối** (`ConnectionsTab.tsx`):
  - Thẻ Meta: trạng thái, tên tài khoản, ngày hết hạn, nút **Kết nối** (mở popup tới URL từ `/start`, popup đóng khi
    callback xong) và **Ngắt kết nối**.
  - Ẩn cả tab khi gateway báo tính năng tắt.
- Chọn flow: thêm mục "Meta Ads" cạnh Data Studio. Chưa kết nối thì banner trên ô chat kèm nút đi tới Kết nối.
- `Conversation.tsx`:
  - Pill cho các tool `ads_*`, với tên dễ đọc trong i18n.
  - **Thẻ xác nhận** cho tool ghi: hiện `summary` lấy từ `GET /meta-ads/actions?sessionId=`, hai nút, đếm ngược 10
    phút. Đã quyết định thì hiện trạng thái.
- i18n `vi`/`en` cho mọi chuỗi mới. Thêm trang hướng dẫn trong `app/docs-site/`.

## 6. Các giai đoạn và tiêu chí xong

Mỗi giai đoạn chỉ coi là xong khi **đã chạy thật**: e2e xanh, và từ P2 trở đi có thử tay trên ad account test.

### P0. Chuẩn bị phía Meta (team / người phụ trách tài khoản)

- [ ] Meta developer app (Business type) do FPT sở hữu, gắn Business Manager của công ty.
- [ ] Thêm use case **"Create & manage ads with ads MCP server"**.
- [ ] Facebook Login for Business: tạo configuration với permission `ads_mcp_management`, `ads_read` (P2), `ads_management`
      (P3), `business_management`, `pages_show_list` (tuỳ chọn). Lấy `config_id`. Redirect URL cho local, staging và prod.
- [ ] Một **ad account test** (ngân sách 0 hoặc có thẻ test), cùng vài user nội bộ được cấp role trên app (tester/developer)
      và trên ad account.
- [ ] Chốt **App Review**: nếu chỉ người có role trên app dùng thì có thể chưa cần. Mở cho mọi nhân viên thì cần Advanced
      Access cho `ads_read`/`ads_management`. Hỏi Meta partner/team Marketing.
- [ ] Egress từ pod gateway tới `mcp.facebook.com`, `www.facebook.com`, `graph.facebook.com` (443).
- [ ] Kiểm hai điểm còn mở: (a) đổi code có cần `client_secret` hay không, (b) FLB dùng `config_id` hay `scope`. Gọi tay
      `/dialog/oauth` một lần.

Ra: các biến ở §4, và một token test cho script sync tool.

### P1. Kết nối tài khoản (gateway + Settings)

- [ ] Migration `004_ads.sql`, cập nhật `api/migrations/README.md`, `docs/schema/schema.md` (+ sample cho DBA nếu cần).
- [ ] `crypto.ts`, `connections.ts`, `oauth-meta.ts`, route `/connections*`, nginx allow-list.
- [ ] Tab Kết nối trên FE.
- [ ] e2e (`scripts/e2e-backend.mjs`, test mới `adsConnections`) với **server OAuth giả** trong `scripts/`:
  - start trả URL có `code_challenge` và `state`.
  - Callback với state sai, đã dùng hoặc hết hạn thì bị từ chối.
  - Callback đúng thì lưu được, token trong DB không phải plaintext.
  - User B không thấy kết nối của user A.
  - Disconnect xoá hàng.
  - Refresh khi gần hết hạn.
- [ ] Thử thật: kết nối bằng tài khoản Meta test trên local (:8080), Settings hiện đúng tên.

### P2. Tool đọc (MVP dùng được)

- [ ] `meta-mcp.ts`, `internal-server.ts`, `/internal/meta-ads/call` (tầng read).
- [ ] Plugin `tool/meta-ads`, script sync, `tools.generated.ts` với allowlist read:
      `ads_get_ad_accounts`, `ads_get_ad_entities`, `ads_get_field_context`, `ads_get_opportunity_score`,
      `ads_insights_performance_trend`, `ads_insights_anomaly_signal`, `ads_insights_industry_benchmark`,
      `ads_get_errors`, `ads_account_get_activity_logs`, `ads_get_help_article`, `ads_get_creatives`,
      `ads_get_ad_preview`, `ads_get_ad_account_pages`.
- [ ] Flow `meta-ads` (preset, mask, config), FE chọn flow, banner chưa kết nối, pill tool.
- [ ] Đo prompt của flow (system prompt + schema). Mục tiêu dưới 12k token. Vượt thì bớt tool.
- [ ] e2e với **MCP server giả** (`scripts/fake-meta-mcp.mjs`, dùng `@modelcontextprotocol/sdk` server, 2–3 tool trả dữ liệu
      cố định):
  - Model gọi tool qua gateway.
  - Cổng nội bộ từ chối khi không có secret.
  - Tool ngoài allowlist bị từ chối.
  - Session của user B không dùng được token của A.
  - Chưa kết nối thì có lỗi dễ hiểu.
  - Tool ghi bị từ chối ở P2.
  - `python` trong flow khác không gọi được cổng 4300 có secret.
- [ ] Thử thật trên ad account test, khoảng 10 câu hỏi báo cáo, ví dụ "chi tiêu 7 ngày qua theo campaign", "campaign nào
      CPC tăng bất thường", "vì sao ad X không chạy". Ghi kết quả và tỉ lệ lỗi tool (usage dashboard) vào §10.

### P3. Tool ghi có xác nhận

- [ ] Bảng `discovery_ads_actions`, `actions.ts`, route decision và list, long-poll + pub/sub.
- [ ] Allowlist write: `ads_create_campaign`, `ads_create_ad_set`, `ads_create_creative`, `ads_create_ad`, `ads_update_entity`,
      `ads_activate_entity`. `summaryOf` cho từng tool. Riêng `ads_activate_entity` và đổi ngân sách trong
      `ads_update_entity` thì thẻ ghi rõ "**sẽ bắt đầu tiêu tiền**".
- [ ] FE: thẻ xác nhận, dựng lại sau F5, đếm ngược.
- [ ] e2e (MCP giả có tool ghi):
  - Đồng ý thì server giả nhận đúng một lần gọi.
  - Từ chối hoặc hết giờ (TTL ngắn trong test) thì server giả không nhận gì.
  - User B không quyết định được action của A.
  - Bấm hai lần chỉ gọi một lần.
  - Restart runtime giữa chừng thì action thành `expired`, không gọi Meta.
  - Audit có đủ hàng.
- [ ] Thử thật: tạo campaign → ad set → ad (paused) trên account test, kiểm trong Ads Manager, sửa tên, **không** bật,
      trừ khi account test cho phép.

### P4. Production

- [ ] `META_ADS_ENABLED` trong `docs/deploy.md`, `docs/staging-checklist.md`, `api/.env.example`. Secret của k8s (`META_APP_SECRET`,
      `FOX_TOKEN_ENC_KEY`) theo quy trình secret hiện có.
- [ ] Rate limit theo user, đổi lỗi rate limit của Meta (Marketing API trả mã 17/80004…) thành câu "Meta đang giới hạn,
      thử lại sau N phút".
- [ ] Hết hạn hoặc bị thu hồi: Settings hiện "Cần kết nối lại", tool báo đúng.
- [ ] Admin: số user đã kết nối, số action theo trạng thái (thêm vào `/admin/usage` hoặc một ô nhỏ trong admin).
- [ ] Docs: `docs/admin-guide.md` (bật tính năng, App Review, xoay khoá), trang user trong `app/docs-site/`.
- [ ] Rà bảo mật theo `docs/deploy-security-checklist.md`:
  - Cổng 4300 không lộ ra ngoài.
  - Token không có trong log hay session log.
  - CSRF của callback được chặn bằng `state`.
  - Popup chỉ nhận `postMessage` từ origin của mình.
- [ ] Staging: chạy lại P1–P3 trên staging với Meta app thật, rồi mới bật cho nhóm user đầu tiên.

## 7. Thứ tự và ước lượng thô

| Giai đoạn | Ước lượng | Phụ thuộc |
|---|---|---|
| P0 | ngoài code, có thể mất 1–2 tuần nếu cần App Review | — |
| P1 | 2–3 ngày | P0 (code và e2e làm trước được với OAuth giả) |
| P2 | 3–4 ngày | P1. Phần thử thật cần token test từ P0. |
| P3 | 3–4 ngày | P2 |
| P4 | 2–3 ngày | P3, staging |

P1–P3 code và e2e **không chờ P0**: OAuth giả và MCP giả đã đủ. P0 chỉ chặn bước thử thật.

## 8. Rủi ro

1. **Tiền thật:** chặn ở gateway (D6, D7). Mặc định chỉ đọc. Bật tầng write bằng `META_ADS_TIERS=read,write`.
2. **Dữ liệu cá nhân:** `ads_update_custom_audience_users` và các tool custom audience ghi **không** vào allowlist khi chưa
   có duyệt pháp chế.
3. **Schema Meta đổi:** đã ghim schema. Script sync báo khác biệt. Gateway trả lỗi Meta nguyên văn (đã cắt ngắn) để model
   tự sửa tham số.
4. **Model nội bộ gọi sai tham số** với schema lồng sâu: đo ở P2. Tỉ lệ lỗi cao thì thêm skill markdown
   `meta-ads-reporting` hướng dẫn các truy vấn hay dùng.
5. **Prompt dài:** giới hạn số tool. Persona ngắn. Đo ở P2.
6. **Long-poll giữ kết nối 10 phút:** chỉ trên cổng nội bộ, mỗi action một request. Đặt giới hạn số pending mỗi user (ví
   dụ 5).

## 9. TikTok sau này

Dùng lại bảng (`provider='tiktok'`), crypto, cổng nội bộ, actions và thẻ xác nhận. Phần khác:
- OAuth qua DCR (`.../oauth/register`), scope `mcp:tt4b`, không cần app.
- Endpoint `tt-ads-mcp-layer`.
- Quyền hết hạn khoảng 30 ngày.
- Allowlist riêng, plugin `tool/tiktok-ads` hoặc gộp thành `tool/ads-mcp` có tham số provider.

## 10. Nhật ký

- 2026-10-27: P1–P3 code xong. `node scripts/e2e-backend.mjs metaAds` (Meta giả `scripts/mock-meta.mjs`): **46/46**
  check. Đã kiểm:
  - OAuth: PKCE S256, `state` dùng một lần, `state` giả bị từ chối, token mã hoá trong DB.
  - Token theo từng user: B không dùng được của A.
  - Allow-list và flow được kiểm ở gateway.
  - Cổng 4300 cần secret, bash không có secret.
  - Tool ghi: chờ xác nhận, B không quyết được thay A, bấm hai lần chỉ chạy một lần, từ chối, hết giờ, bấm muộn bị 409.
  - Audit, ngắt kết nối (thu hồi phía Meta), refresh token trước khi gọi.
- Chưa: thử với Meta thật (cần P0), đo kích thước prompt với schema thật của Meta.

## 11. Thay đổi so với plan ban đầu (rà lại trước khi code)

| Plan cũ | Đã làm | Vì sao |
|---|---|---|
| D5: schema tool ghim trong repo, sinh bằng script từ token test | Gateway lấy `tools/list` bằng token của user vừa kết nối, lọc theo `ads/tools.ts`, lưu `<dataDir>/meta-ads/tools.json`, làm mới mỗi 24 giờ (`META_ADS_TOOLS_REFRESH_MS`). Runtime xin danh sách qua `GET /internal/meta-ads/tools`, đăng ký khi có, hỏi lại mỗi phút khi còn rỗng. | Không có token test nào trong repo hay CI. Schema luôn đúng bản Meta đang chạy. Log `meta_ads_tools_refreshed` báo tool nào trong allow-list Meta không còn. |
| Plugin dùng `@modelcontextprotocol/sdk` | `ads/mcp-client.ts`: client Streamable HTTP tối giản ở **gateway** (initialize, tools/list, tools/call, đọc được cả JSON lẫn SSE) | SDK chưa được cài trong repo. Gateway không import dsh. Đủ cho một server tool từ xa. |
| Pending ở Redis + pub/sub | Hàng `discovery_ads_actions` (trạng thái) + chờ trong process của gateway. Lúc khởi động, hàng còn `pending` thành `expired`. | Chỉ có một gateway (`docs/deploy.md`: chưa hỗ trợ nhiều replica). |
| Callback cần token đăng nhập | Callback nhận ra user qua `state` (Redis, một lần, 10 phút). Trang callback `postMessage` cho cửa sổ Cài đặt (cùng origin) rồi đóng. | Redirect từ Facebook không mang header `Authorization`. |
| — | nginx allow-list thêm `connections\|meta-ads` | nginx chỉ chuyển các tiền tố đã liệt kê. |
| `config_id` hay `scope`? Có cần `client_secret`? | Cả hai đều là cấu hình: có `META_LOGIN_CONFIG_ID` thì gửi `config_id`, không thì gửi `scope`. Có `META_APP_SECRET` thì gửi kèm. | Chưa kiểm được với Meta thật (P0). |
| Flow mask `'all'` + vài tool | Mask mới `{ allow: ['todo_write'] }` trong `flows.ts` | Ẩn mọi tool global trừ danh sách giữ lại. |

Các file chính:
- Gateway: `api/services/gateway/src/ads/{meta,mcp-client,tools,crypto}.ts`, `internal-server.ts`, route trong `index.ts`.
- Runtime: `api/packages/tool/meta-ads`, preset `profile-template/presets/meta-ads`.
- FE: `app/src/components/features/meta-ads/*`, `settings/ConnectionsTab.tsx`.
- DB: `api/migrations/004_ads.sql`.
- Test: `scripts/mock-meta.mjs` và test `metaAds`.
- Docs: `docs/admin-guide.md` (Meta Ads), trang `app/docs-site/.../chat/meta-ads.md`.
