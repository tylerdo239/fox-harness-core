# TikTok Ads MCP và Meta Ads MCP: là gì, kết nối thế nào, gắn vào core ra sao

Trạng thái: **tìm hiểu + đề xuất, chưa code** (2026-10-27, nhánh `feat/fb-tiktok-mcp`).

## 0. Tóm tắt

- Cả hai là **MCP server do chính TikTok và Meta host**, nói chuyện qua **Streamable HTTP**. Không cần cài gì, chỉ cần một
  MCP client trỏ tới URL.
- Cả hai dùng **OAuth 2.1 (PKCE, public client)**. Người dùng đăng nhập TikTok for Business / Facebook Login for Business
  và cấp quyền. Token đại diện cho **chính người đó** và các tài khoản quảng cáo họ có quyền.
- Cả hai **có tool ghi**: tạo/sửa chiến dịch, ngân sách, đối tượng, xoá audience/catalog… Bật chiến dịch là **tiêu tiền thật**.
- Core đã có sẵn plugin `@deepseek-ai/dsh-mcp-client` của dsh. Nó nối được tới server HTTP nhưng chỉ nhận **header tĩnh**:
  một token cố định cho mọi session trong một runtime. Không có OAuth, không có token theo từng user.
- Đề xuất:
  - **Giai đoạn A (POC):** dùng `dsh-mcp-client` với **một tài khoản chung** và chỉ bật tool đọc.
  - **Giai đoạn B (production):** OAuth theo từng user ở gateway, gateway làm **proxy MCP** gắn token của user. Runtime
    không bao giờ cầm token.

## 1. TikTok for Business MCP Server

Nguồn: [bài giới thiệu](https://ads.tiktok.com/resources/help/article/about-tiktok-for-business-mcp-server?lang=vi),
[server guide v1.3](https://business-api.tiktok.com/portal/docs/tiktok-ads-mcp-server/v1.3),
[danh sách tool](https://business-api.tiktok.com/portal/docs/available-tools-in-tiktok-for-business-mcp-server/v1.3).
Trang portal render bằng JS nên không đọc tự động được. Phần OAuth bên dưới lấy từ metadata server tự công bố, kiểm
bằng curl ngày 2026-10-27.

### 1.1 Endpoint

| URL | Cách nạp tool | Ghi chú |
|---|---|---|
| `https://business-api.tiktok.com/open_mcp/tt-ads-mcp-flat` | **Full disclosure**: khoảng **400 tool** trả về ngay khi kết nối | TikTok ghi "được đề xuất cho Claude". Với core thì **quá nặng** (mục 4.3). |
| `https://business-api.tiktok.com/open_mcp/tt-ads-mcp-layer` | **Progressive disclosure**: khoảng **40 tool lõi**, tool khác được khám phá khi cần | Dành cho context hẹp. **Nên dùng cho core.** |
| `https://business-api.tiktok.com/open_mcp/tt-ads-mcp-layer-anthropic` | Bản dùng cho connector của Claude marketplace | Không dùng. |

Tool phủ các mảng: quản lý campaign / ad group / ad, báo cáo hiệu quả, đối tượng (audience, targeting), creative, catalog,
Business Center.

### 1.2 Xác thực (OAuth 2.1, đã kiểm)

```
POST /open_mcp/tt-ads-mcp-flat (không token)
  → 401, WWW-Authenticate: Bearer resource_metadata=".../.well-known/oauth-protected-resource/open_mcp/tt-ads-mcp-flat"

GET .well-known/oauth-protected-resource/open_mcp/tt-ads-mcp-flat
  → authorization_servers: [https://business-api.tiktok.com/open_mcp/tt-ads-mcp-flat/oauth]
    scopes_supported: ["mcp:tt4b"]

GET https://business-api.tiktok.com/open_mcp/tt-ads-mcp-flat/oauth/.well-known/oauth-authorization-server
  authorization_endpoint   https://business-api.tiktok.com/portal/mcp-tt4b-authorize
  token_endpoint           .../oauth/token
  registration_endpoint    .../oauth/register          (Dynamic Client Registration)
  revocation_endpoint      .../oauth/revoke
  client_id_metadata_document_supported: true
  code_challenge_methods   S256 (PKCE bắt buộc)
  grant_types              authorization_code, refresh_token
  token_endpoint_auth      none (public client, không có client secret)
```

Endpoint `-layer` có bộ OAuth riêng cùng dạng (`.../tt-ads-mcp-layer/oauth`).

Ý nghĩa:
- **Không cần tạo app trên TikTok Developer.** Client tự đăng ký qua `registration_endpoint` hoặc dùng client-id metadata
  document. Đúng như bài viết nói: "không cần thông tin đăng nhập của nhà phát triển hay khoá API".
- Người dùng phải có **tài khoản TikTok for Business** và quyền trên advertiser account. Tool chỉ thấy những advertiser
  mà người đó được cấp.
- Theo hướng dẫn kết nối Claude của TikTok, quyền cấp có hạn khoảng **30 ngày**. Hết hạn thì user phải cấp lại, refresh
  token không cứu được.
- TikTok **không công bố cách lấy token tĩnh hay service account** cho MCP. Muốn tự động hoá thì vẫn phải qua OAuth một
  lần rồi refresh.

## 2. Meta Ads MCP Server

Nguồn: [overview](https://developers.facebook.com/documentation/ads-commerce/ads-ai-connectors/ads-mcp-server/ads-mcp-server-overview),
[get started](https://developers.facebook.com/documentation/ads-commerce/ads-ai-connectors/ads-mcp-server/ads-mcp-server-get-started),
[mục lục cho LLM](https://developers.facebook.com/documentation/ads-commerce/llms.txt). Metadata OAuth kiểm bằng curl
ngày 2026-10-27.

### 2.1 Endpoint và xác thực

- URL: `https://mcp.facebook.com/ads` (Streamable HTTP).
- Ba cách xác thực:

| Cách | Dùng khi | Ghi chú |
|---|---|---|
| **OAuth** (Facebook Login for Business) | Mỗi user tự kết nối | Cần **Meta developer app** đã thêm use case *"Create & manage ads with ads MCP server"*. **Redirect URL** của app phải khớp callback của mình. `client_id` = Meta App ID. |
| **User access token** | Thử nhanh | Tạo ở Graph API Explorer. Gửi `Authorization: Bearer <token>`. |
| **System user access token** | Server-to-server, tài khoản chung | **Chỉ system user role Employee**, token role Admin bị từ chối. Đây là cách duy nhất để có token "tĩnh" lâu dài. |

- Permission tối thiểu: `ads_mcp_management` + (`ads_read` **hoặc** `ads_management`). Thêm `ads_management`,
  `catalog_management`, `business_management`, `pages_show_list`, `instagram_basic` thì có thêm tool. Server công bố thêm
  `pages_manage_ads`, `facebook_branded_content_ads_brand`, `instagram_branded_content_ads_brand`.
- Metadata OAuth đã kiểm:
  - Authorization server `https://www.facebook.com/ads`
  - `authorization_endpoint` = `https://www.facebook.com/v26.0/dialog/oauth`
  - `token_endpoint` = `https://graph.facebook.com/v26.0/oauth/access_token`
  - `registration_endpoint` = `https://mcp.facebook.com/.well-known/register/ads`
  - PKCE S256, có `refresh_token`, `token_endpoint_auth: none`
- Muốn user **ngoài** business của app kết nối thì gần như chắc phải qua **App Review** để có Advanced Access cho
  `ads_management` / `ads_read`, theo quy trình chung của Meta. Trang MCP không nói rõ, **cần xác nhận**.

### 2.2 Tool (khoảng 90, theo nhóm)

| Nhóm | Tool đọc (ví dụ) | Tool ghi |
|---|---|---|
| Báo cáo | `ads_get_ad_entities` (tool báo cáo chính: spend, impressions, CTR, CPC, CPM, conversions, breakdown, date range), `ads_get_opportunity_score`, `ads_insights_performance_trend`, `ads_insights_anomaly_signal`, `ads_insights_industry_benchmark`, `ads_insights_auction_ranking_benchmarks`, `ads_insights_advertiser_context` | không có |
| Tài khoản, Page, IG | `ads_get_ad_accounts`, `ads_get_ad_account_pages`, `ads_get_user_pages`, `ads_get_pages_for_business`, `ads_get_ig_accounts`, `ads_get_ig_media`, `ads_get_field_context` | `ads_boost_ig_post` |
| Campaign, ad set, ad, creative | `ads_get_creatives`, `ads_get_creative_ads`, `ads_get_ad_images`, `ads_get_ad_videos`, `ads_get_ad_preview`, `ads_library_search` | `ads_create_campaign`, `ads_create_ad_set`, `ads_create_ad`, `ads_create_creative`, `ads_update_entity`, **`ads_activate_entity`** |
| Custom audience | `ads_get_ad_account_custom_audiences`, `ads_get_custom_audience`, `ads_get_custom_audience_adsets` | `ads_create_custom_audience`, `ads_update_custom_audience`, `ads_update_custom_audience_users` (dữ liệu cá nhân đã hash), `ads_delete_custom_audience` |
| Catalog | `ads_catalog_list_*`, `ads_catalog_get_diagnostics`, `ads_catalog_get_dynamic_ads_health`, `ads_catalog_event_source_get*` | `ads_catalog_create*`, `ads_catalog_update_*`, `ads_catalog_*delete*`, `ads_catalog_event_source_connect/disconnect` |
| Signals, dataset, pixel | `ads_get_datasets`, `ads_get_dataset_details`, `ads_get_dataset_stats`, `ads_get_dataset_quality`, `ads_get_customconversions`, `ads_pixel_event_read`, `ads_pixel_parameter_read` | `ads_pixel_event_create/update/delete`, `ads_pixel_parameter_create/update/delete` |
| A/B test, lift | `ads_experiment_list_tests`, `ads_experiment_check_eligibility`, `ads_experiment_abtest_get_test`, `ads_experiment_lift_get_test` | `ads_experiment_abtest_create_test`, `ads_experiment_abtest_update_test`, `ads_experiment_lift_create_test` |
| Help, lỗi, lịch sử | `ads_get_errors`, `ads_get_help_article`, `ads_account_get_activity_logs` | không có |

An toàn phía Meta:
- Campaign, ad set và ad mới tạo luôn ở trạng thái **paused**.
- `ads_activate_entity` mới bắt đầu tiêu ngân sách. Meta ghi rằng *client* phải hỏi xác nhận trước bước này, tức là
  **việc của mình**.
- Rate limit không ghi riêng cho MCP. Nhiều khả năng áp theo
  [rate limiting của Marketing API](https://developers.facebook.com/documentation/ads-commerce/marketing-api/overview/rate-limiting.md).

## 3. So sánh nhanh

| | TikTok | Meta |
|---|---|---|
| URL | `business-api.tiktok.com/open_mcp/tt-ads-mcp-{flat,layer}` | `mcp.facebook.com/ads` |
| Transport | Streamable HTTP | Streamable HTTP |
| Cần app của mình | Không (DCR) | Có: Meta app + use case MCP + redirect URL (hoặc system user token) |
| Token tĩnh cho server | Không có cách chính thức | System user token, role Employee |
| Scope | `mcp:tt4b` | `ads_mcp_management` + `ads_read`/`ads_management` + tuỳ chọn |
| Số tool | khoảng 400 (flat) / khoảng 40 (layer) | khoảng 90 |
| Ghi / tiêu tiền | Có | Có (mặc định paused, `ads_activate_entity` mới chạy) |
| Hết hạn quyền | khoảng 30 ngày phải cấp lại | Token user có refresh, system user token lâu dài |

## 4. Gắn vào core

### 4.1 Core đang có gì

- `@deepseek-ai/dsh-mcp-client` (`api/node_modules/@deepseek-ai/dsh-mcp-client/README.md`):
  - Có sẵn trong `node_modules`, nhưng **chưa nằm trong `dsh-base`** và chưa có row nào bật.
  - Mỗi row là một server, hỗ trợ `transport: streamable-http`, `url`, `headers`.
  - Tool hiện cho model dưới tên `mcp__<serverName>__<tool>`, ví dụ `mcp__meta__ads_get_ad_entities`.
  - Tự reconnect và re-sync khi server báo `tools/list_changed`.
- **Giới hạn quan trọng:**
  - `headers` là giá trị tĩnh lúc nạp plugin. Không có `authProvider` OAuth, không refresh token.
  - Preset được mount **một lần cho mỗi process** (`dsh-agent-presets`: "the roster mounts it ONCE per process"). Đặt
    `dsh-mcp-client` trong preset nghĩa là **một kết nối, một token cho mọi user** của runtime đó.
- Tool chạy trong process runtime, **không trong sandbox**: sandbox chỉ áp cho `bash`/`python` và không có mạng. Runtime
  chỉ nhận env trong `runtimeEnvPassthrough` (`api/services/gateway/src/config.ts`).
- Usage dashboard ghi tên tool vào `discovery_usage_turn_tools.tool varchar(64)`. `dsh-mcp-client` đã cắt tên còn 64 ký
  tự, nên vẫn vừa.

### 4.2 Giai đoạn A: POC với một tài khoản chung (ít code)

Mục tiêu: thử chất lượng model với tool ads, **chỉ đọc**, trên một ad account test.

1. Thêm flow `ads`:
   - `api/packages/profile-template/presets/ads/agent.cordis.yml` (persona marketing).
   - Thêm `ads: { workspace: false }` vào `flows` trong `services/gateway/src/config.ts`.
   - Thêm `FLOW_TOOL_MASK.ads = 'all'` trong `agent-core/src/transport/flows.ts`, để model chỉ thấy tool ads.
2. Thêm dependency `@deepseek-ai/dsh-mcp-client@0.1.1-rc.2` vào `api/package.json` (ghim cùng bản dsh).
3. Thêm row trong preset:

   ```yaml
   - id: mcp-meta
     name: '@deepseek-ai/dsh-mcp-client'
     config:
       serverName: meta
       transport: streamable-http
       url: https://mcp.facebook.com/ads
       headers:
         Authorization: !!js '`Bearer ${process.env.META_ADS_MCP_TOKEN}`'   # system user token, role Employee, chỉ ads_read
       toolCallTimeoutMs: 60000
   - id: mcp-tiktok
     name: '@deepseek-ai/dsh-mcp-client'
     config:
       serverName: tiktok
       transport: streamable-http
       url: https://business-api.tiktok.com/open_mcp/tt-ads-mcp-layer
       headers:
         Authorization: !!js '`Bearer ${process.env.TIKTOK_ADS_MCP_TOKEN}`'  # access token lấy qua OAuth một lần
   ```

4. Thêm `META_ADS_MCP_TOKEN` và `TIKTOK_ADS_MCP_TOKEN` vào `runtimeEnvPassthrough`, và vào `api/.env` của người chạy.
5. Chặn tool ghi bằng mask:
   - Thêm `agentCtx.tools.restrict({ deny: [...] })` theo danh sách tool ghi ở mục 2.2.
   - Hoặc theo luật tên: Meta có `create|update|delete|activate|boost|connect|disconnect`, TikTok tương tự.

Hạn chế của POC:
- Mọi user dùng chung một tài khoản quảng cáo.
- Token TikTok hết hạn thì phải lấy lại tay và restart runtime.
- Token nằm trong env của runtime. Runtime không cho code model chạy ngoài sandbox, nhưng đây vẫn là bí mật có giá trị.
- **Không đưa POC lên staging cho user thật.**

### 4.3 Kiểm soát số tool (bắt buộc cả hai giai đoạn)

`dsh-mcp-client` gửi schema của **mọi** tool trong mỗi request. Với khoảng 400 tool của TikTok flat, prompt vượt xa
context của model nội bộ (xem `docs/compaction-24k-issue-2026-10-16.md`). Khoảng 90 tool của Meta cũng đã nặng.

- TikTok dùng endpoint **`-layer`**.
- Cho mỗi server một **allowlist** tool. Khởi điểm khoảng 10–15 tool đọc:
  - Meta: `ads_get_ad_accounts`, `ads_get_ad_entities`, `ads_get_field_context`, `ads_insights_performance_trend`,
    `ads_insights_anomaly_signal`, `ads_get_errors`, `ads_get_help_article`, `ads_account_get_activity_logs`.
  - TikTok: lấy từ `tools/list` thật sau khi kết nối.
- `restrict` của core lọc theo **tên tool trên `ctx.tools`**, không quan tâm tool đến từ đâu. Vì vậy allowlist làm
  bằng `deny = tất cả mcp__* − allowlist` sau khi tool đã đăng ký.
- Đo kích thước prompt trước và sau khi bật, như đã làm với flow data-analysis.

### 4.4 Giai đoạn B: production, OAuth theo từng user (đề xuất)

```
FE: Settings > Kết nối  ──"Kết nối Meta/TikTok"──►  gateway /connections/<provider>/start
   gateway: PKCE + state (Redis, 10 phút) → redirect tới trang cấp quyền của Meta/TikTok
   user đồng ý → provider redirect về gateway /connections/<provider>/callback?code&state
   gateway: đổi code lấy access + refresh token → MÃ HOÁ → lưu MariaDB

Chat (flow ads)
  runtime: plugin tool-ads-mcp (của mình) mở MCP client tới GATEWAY, không tới Meta/TikTok:
     POST http://gateway-internal/internal/mcp/<provider>
       headers: X-Fox-Runtime-Secret, X-Fox-Session: <sessionId>
  gateway: secret đúng → sessionId → chủ session → token của user đó (refresh nếu sắp hết)
           → chuyển nguyên JSON-RPC tới https://mcp.facebook.com/ads | tiktok,
             thêm Authorization: Bearer <token user>
           → trả nguyên response (JSON hoặc SSE) về runtime
  user chưa kết nối / hết hạn → tool trả lỗi rõ ràng: "Bạn chưa kết nối Meta Ads, vào Cài đặt > Kết nối"
```

Vì sao làm proxy ở gateway:
- Theo đúng nguyên tắc của core (`core-architecture.md` §4.4): bí mật của user nằm ở gateway, runtime không có DB.
- Token không bao giờ vào runtime, log session hay prompt.
- Refresh, thu hồi và audit nằm một chỗ.
- Có sẵn điểm chặn tool ghi: gateway đọc `method: tools/call` + `params.name` và từ chối tool ngoài allowlist **ở phía
  server**, kể cả khi model gọi bừa.

Phần cần viết:

| Phần | Ở đâu | Ghi chú |
|---|---|---|
| Bảng `discovery_mcp_connections` | `api/migrations/004_mcp_connections.sql` | `id`, `user_id`, `provider` (`meta`/`tiktok`), `account_label`, `access_token_enc`, `refresh_token_enc`, `scopes varchar(512)` (chuỗi cách nhau bởi dấu cách), `expires_at datetime(3)`, `granted_at`, `created_at`, `updated_at`; `unique (user_id, provider)`. **Không dùng `json`** (code-rules §49). |
| Mã hoá token | gateway | AES-256-GCM, khoá từ env mới `FOX_TOKEN_ENC_KEY` (chỉ gateway có). |
| OAuth start, callback, revoke | gateway REST `/connections/*` | TikTok: DCR một lần, lưu `client_id`. Meta: `client_id` = App ID (`META_APP_ID`), redirect `https://<domain>/api/connections/meta/callback` khai trong Facebook Login for Business. |
| MCP proxy | gateway `/internal/mcp/:provider` | Chỉ nghe nội bộ, bắt buộc runtime secret. Chuyển tiếp Streamable HTTP, giữ header `Mcp-Session-Id`. Allowlist tool. Log audit mỗi `tools/call` (user, tool, thời điểm, ok/lỗi; không log tham số có dữ liệu cá nhân). |
| Plugin runtime | `api/packages/tool/ads-mcp` | Dựa trên `@modelcontextprotocol/sdk` như `dsh-mcp-client`, nhưng **một client cho mỗi session**, URL là gateway, kèm `X-Fox-Session`. Hoặc dùng thẳng `dsh-mcp-client` nếu proxy tự quyết user theo session. Cần kiểm vì danh sách tool lúc nạp là chung cho process. |
| FE | Settings > Kết nối | Nút kết nối/ngắt, trạng thái, ngày hết hạn (TikTok khoảng 30 ngày). |
| Xác nhận trước khi ghi | flow `ads` | Giai đoạn B1 chỉ đọc. B2 mở tool ghi, nhưng `ads_activate_entity`, `*_delete*`, đổi ngân sách và các tool tương ứng của TikTok phải hỏi user (`ask_user` hoặc thẻ xác nhận trên FE) trước khi gateway cho qua. |

Danh sách tool khi mỗi user một token: tool phụ thuộc quyền của token, nhưng schema thì giống nhau. Cách đơn giản là
runtime lấy `tools/list` một lần (qua proxy, bằng token của bất kỳ user hợp lệ nào hoặc danh sách cố định trong
allowlist) rồi đăng ký chung. Gateway chịu trách nhiệm kiểm quyền từng lần gọi.

### 4.5 Rủi ro và việc cần xác nhận

1. **Meta App Review:** cần cho user ngoài business của app hay không. Nếu chỉ nhân viên FPT dùng tài khoản FPT thì có
   thể chỉ cần thêm họ làm tester/role trên app. Cần hỏi team Marketing/Meta partner.
2. **Mạng egress:** pod gateway phải gọi ra được `mcp.facebook.com`, `www.facebook.com`, `graph.facebook.com`,
   `business-api.tiktok.com`. Kiểm proxy/firewall staging (`docs/staging-checklist.md`).
3. **Dữ liệu cá nhân:** `ads_update_custom_audience_users` gửi dữ liệu khách hàng đã hash lên Meta. Không mở tool này nếu
   chưa có duyệt của bộ phận pháp chế/dữ liệu.
4. **Tiền thật:** mặc định chỉ đọc. Mở tool ghi phải có xác nhận người dùng, được kiểm ở gateway chứ không chỉ dựa vào
   prompt.
5. **Model nội bộ** gọi tool có schema lớn và lồng sâu có thể sai tham số. Thử ở giai đoạn A với 10–15 tool trước, đo tỉ
   lệ lỗi trong usage dashboard (`discovery_usage_turn_tools.errors`).
6. **TikTok 30 ngày:** FE phải báo sắp hết hạn, tool phải báo lỗi dễ hiểu khi hết hạn.

## 5. Thử nhanh không cần core

```bash
# Meta, token user hoặc system user (Employee) có ads_mcp_management + ads_read
curl -s -X POST https://mcp.facebook.com/ads \
  -H "Authorization: Bearer $META_TOKEN" -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# Không token: cả hai trả 401 kèm WWW-Authenticate trỏ tới metadata OAuth (đã kiểm 2026-10-27)
curl -si -X POST https://business-api.tiktok.com/open_mcp/tt-ads-mcp-layer -d '{}' | grep -i www-authenticate
```

Lấy token TikTok để thử: dùng một MCP client có OAuth (ví dụ
`claude mcp add --transport http tiktok-ads https://business-api.tiktok.com/open_mcp/tt-ads-mcp-layer`, rồi `/mcp` để
đăng nhập), hoặc tự chạy luồng PKCE theo metadata ở mục 1.2.

## 6. Việc tiếp theo đề xuất

1. Xin một ad account test cho mỗi nền tảng, cùng system user token Meta (Employee, `ads_mcp_management` + `ads_read`).
2. Làm giai đoạn A (flow `ads`, chỉ đọc, allowlist) trên local. Đo prompt, chạy vài câu hỏi báo cáo, xem tỉ lệ lỗi.
3. Chốt mục 4.5 (App Review, egress, PII), rồi viết plan chi tiết cho giai đoạn B.
