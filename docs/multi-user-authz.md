# Multi-user và phân quyền (trạng thái 2026-10-06)

## 1. Tài khoản và đăng nhập

- Tài khoản ở MariaDB `discovery_users`, `role` = `admin` | `user`.
- Không tự đăng ký: chỉ admin tạo tài khoản (`POST /users`; `/auth/register` cũng chỉ admin).
- `POST /auth/login` (có giới hạn số lần thử) trả token ngẫu nhiên. Redis chỉ lưu **hash** token + `{userId, role}`.
  Hết hạn sau 1 giờ không dùng (`TOKEN_TTL_MS`), mỗi lần dùng được gia hạn.
- Logout thu hồi token. Admin đổi role/mật khẩu (`PATCH /users/:id`) thu hồi mọi token của user đó (`fh:gwuser:<id>`).

## 2. Role ở tầng HTTP

Mọi request đi qua `adminGate` (`api/services/gateway/src/index.ts`) trước khi tới route.

| Route                                                                                | admin | user         |
| ------------------------------------------------------------------------------------ | ----- | ------------ |
| `/users`, `/auth/register`                                                           | ✓     | 403          |
| `/data-studio/*` (nguồn, bảng, cột, quan hệ, chỉ số, thuật ngữ, sync, hồ sơ, chart…) | ✓     | 403          |
| `/data-studio/dashboards*`, `/data-studio/charts/:id` (của mình)                     | ✓     | ✓ (của mình) |
| Chat, project, file, skill                                                           | ✓     | ✓ (của mình) |

FE ẩn mục admin, nhưng chặn thật ở gateway.

## 3. Cô lập giữa các user

| Thành phần   | Quy tắc                                                                                                                                  |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Session      | Có `owner_id`; chỉ liệt kê của mình; mở lại WS phải là chủ hoặc admin (403); flow/model/project lấy từ DB                                |
| Project      | Cùng quy tắc chủ sở hữu; chat trong project phải là project của mình, luôn flow `data-analysis`                                          |
| File, skill  | Lọc theo chủ sở hữu (B đọc file của A → 404, xoá session của A → 403)                                                                    |
| Workspace    | Thư mục riêng `data/users/<userId>/<sessionId>/`; `workspace-guard` chặn tool đọc/ghi ngoài thư mục (kể cả symlink), subagent thừa hưởng |
| bash, python | Sandbox `bwrap`: không mạng, không capability, chỉ thấy thư mục session                                                                  |
| Runtime      | 1 process cho mọi user; gateway ↔ runtime qua loopback + secret nội bộ mỗi lần boot; session đang mở từ chối kết nối khác user/role      |
| Hạn mức      | Giới hạn session đồng thời theo user và toàn hệ thống                                                                                    |

## 4. Role xuống agent và Data Studio

- Gateway gửi role **của chủ session** (không phải người xem) → runtime → tool `analyze_data`. Không bao giờ lấy từ
  model; thiếu thì là `user`.
- User chỉ thấy bảng/cột admin bật "Cho phép role user" (`allowed_roles` có `user`). Cột `is_pii` không bao giờ mở cho
  user. Admin thấy mọi thứ đang bật.
- Nguồn bị tắt (`disabled_at`) hoặc xoá (`deleted_at`) ẩn với mọi role khi trả lời.

| Pipeline      | Lớp chặn                                                                                              |
| ------------- | ----------------------------------------------------------------------------------------------------- |
| v3 (mặc định) | Lọc ở crud → `sql_validator` (bảng, cột, alias, `SELECT *`) → kiểm lại bảng trong SQL trước Dremio    |
| v4 (cờ)       | Catalog lọc theo role + bỏ metric/quan hệ/thuật ngữ dựa trên phần ẩn → `sql_gate` trong `AsyncDremio` |

Dremio dùng một tài khoản chung: toàn bộ phân quyền dữ liệu nằm trong code.

## 5. Chưa sửa / cần biết

| #   | Vấn đề                                                                                                                                    | Mức      |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 1   | ~~Dashboard admin chứa dữ liệu user không được hỏi~~ — đã sửa: dashboard và chart riêng từng user (`data-studio-user-dashboards-plan.md`) | Đã sửa   |
| 2   | Hạ quyền không đóng WebSocket đang mở; agent đang chạy giữ role cũ tới khi ngắt                                                           | Cao      |
| 3   | Admin mở được session của mọi user (có chủ ý), chưa có log riêng cho việc này                                                             | Thấp     |
| 4   | ~~Token đi qua `?token=` khi mở WebSocket~~ — đã sửa: vé dùng một lần (`POST /auth/ws-ticket`)                                            | Đã sửa   |
| 5   | Chỉ phân quyền bảng/cột; không có theo dòng, nhóm, phòng ban                                                                              | Thiết kế |

Giới hạn và rate limit của gateway (2026-10-06): đăng nhập theo email (và theo IP khi `TRUST_PROXY`), body JSON
≤ 1 MB, chat 20 tin/phút/user, thao tác tốn tiền (gợi ý AI, Run, import, sync, reindex, upload) 10 lần/phút/user, CORS
theo `ALLOWED_ORIGINS`. Phần thuộc tầng deploy: `deploy-security-checklist.md`.

## 6. Kiểm thử

Tài khoản test local: `rbac-admin@local.test` / `rbac-admin-pw-123`, `rbac-user@local.test` / `rbac-user-pw-123`.

| Thử                                                       | Kỳ vọng                                    |
| --------------------------------------------------------- | ------------------------------------------ |
| Đăng nhập user, mở Data Studio                            | Chỉ có Trò chuyện, Bảng điều khiển         |
| User hỏi "Có bao nhiêu workflow?"                         | Không ra 77 (chưa có bảng nào mở cho user) |
| Admin bật "Cho phép role user" cho một bảng, user hỏi lại | Ra số đúng; cột PII vẫn bị chặn            |
| Copy link chat của user A sang trình duyệt user B         | 403                                        |
| Admin đổi role của user                                   | Tab của user đó bị đăng xuất ở request kế  |

Tự động: `sh scripts/e2e-up.sh && node scripts/e2e-backend.mjs` — `ownership`, `crossUserIsolation`,
`subagentIsolation`, `roleGate` (30 check), `roleReachesRuntime`, `sandboxNoNetwork`, `tokensHashedInRedis`.
Data Studio: `api/packages/tool/data-studio-agent/python/tests/role_authz_test.py`,
`tests/pipeline_v4/test_catalog_roles.py`.
