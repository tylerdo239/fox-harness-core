# Review mức sẵn sàng của core (2026-10-05)

Phạm vi: nhánh `feat/role-based-authz` (commit `e7351c0`), gồm 3 commit chưa push lên `origin`:
`c1306b4` (guard cho subagent), `0aaf8b8` (phân quyền theo role), `e7351c0` (sandbox cắt mạng, bỏ capability,
hash token). `origin/dev` **chưa có** các bản vá này.

Mọi kết luận "đạt" dưới đây đều đã được **chạy thật**: e2e trên stack hai container (nginx → gateway →
runtime, mock LLM), test Python với MongoDB thật, và hỏi đáp bằng LLM thật trên stack local cổng 8080.

## 1. Tóm tắt

| Câu hỏi | Trả lời ngắn |
|---|---|
| Deploy bao nhiêu container? | **2 container của mình**: `web` và `backend`. Các dịch vụ còn lại là hạ tầng bên ngoài. |
| Phân quyền đã chặt nhất chưa? | **Chặt ở tầng ứng dụng, chưa phải mức cao nhất.** Còn 3 việc bắt buộc trước khi cho user thật dùng (mục 3.3). |
| Chat, skill có còn chạy như cũ? | **Có.** 18/18 e2e pass, kể cả chat, resume, skill riêng từng user, python, file, project. |
| DB (`001_init.sql`) đã hoàn thiện chưa? | **Có, sau một bản sửa charset** (mục 7). |
| Thêm skill/tool theo kiểu plugin còn chạy? | **Có, đã thử thật**: thêm một tool plugin mới và một skill mới, cả hai hoạt động, 18/18 e2e vẫn pass. |

## 2. Deploy: hệ thống gồm những container nào

```
Browser ──► web (nginx + bundle React)  ──►  backend (gateway + N runtime dsh)
                                               │
                     hạ tầng bên ngoài: MariaDB · Redis · S3 · MongoDB · Dremio · Meilisearch · LLM
```

| Container | Vai trò | Ghi chú deploy |
|---|---|---|
| `web` | nginx phục vụ SPA, chuyển `/auth`, `/sessions` (cả WebSocket), `/users`, `/data-studio`… sang backend | Không giữ state |
| `backend` | gateway (auth, phân quyền, REST, proxy WS, quota) **và** `FOX_RUNTIME_COUNT` process runtime dsh, mỗi process phục vụ nhiều session | Cần `cap_add: SYS_ADMIN, NET_ADMIN` (cho bubblewrap) và một volume cố định `/data` |

- Không còn orchestrator và không còn container riêng cho từng session.
- `infra/deploy/docker-compose.yml` có profile `local-deps` để dựng nhanh MariaDB, Redis, MinIO và Mongo khi
  chạy local. Trên môi trường thật, đây là các dịch vụ do hạ tầng cung cấp.
- Hiện chỉ chạy được **1 replica** backend: chạy nhiều replica cần sticky routing theo session id và một thư mục
  dữ liệu dùng chung.
- Gateway **từ chối khởi động** trên production nếu sandbox không hoạt động. Self-test lúc boot kiểm tra ba điều:
  bwrap chạy được, thư mục dữ liệu nằm ngoài git checkout, và sandbox không có route mạng nào.

## 3. Phân quyền và cô lập

### 3.1 Các lớp đang có (đều đã có test)

| Lớp | Cơ chế | Bằng chứng |
|---|---|---|
| Đăng nhập | Mật khẩu scrypt; token ngẫu nhiên 256 bit lưu trong Redis, TTL trượt, thu hồi được ngay. **Redis chỉ lưu SHA-256 của token.** | e2e `tokensHashedInRedis` |
| Tài khoản | Không còn tự đăng ký. Chỉ admin tạo tài khoản (`POST /users`) và đổi role (`PATCH /users/:id`). Đổi role thì mọi token của user đó bị thu hồi. Admin không tự hạ quyền mình được. | e2e `roleGate` (23 kiểm tra) |
| Role `admin` / `user` | `adminGate` chặn trước khi route: quản lý tài khoản và mọi `/data-studio/*` chỉ dành cho admin, trừ việc **đọc** dashboard. | e2e `roleGate` |
| Quyền sở hữu | Session, project, file, skill đều kiểm tra chủ sở hữu. Đường dẫn được dựng từ id đã qua kiểm tra, không bao giờ lấy từ input. | e2e `ownership`, `crossUserIsolation` (8 hướng tấn công, 0 lộ) |
| Runtime | Gateway truyền flow, model, cwd, user và **role của chủ session** ở mỗi lần kết nối, kèm secret sinh mới mỗi lần boot. Runtime từ chối kết nối thiếu secret. Subagent dùng role của agent gốc. | e2e `roleReachesRuntime` |
| Tool guard | Mọi tool có đường dẫn đi ra ngoài workspace của session (kể cả qua symlink, kể cả từ subagent) đều bị từ chối. | e2e `crossUserIsolation`, `subagentIsolation` |
| Sandbox bash/python | bubblewrap: root rỗng, chỉ thấy workspace của mình; env lọc theo allow-list; **không có mạng** (`--unshare-net`); **không còn capability nào** (`--cap-drop ALL`). | e2e `sandboxNoNetwork`: 12 lần thử tới Redis, MariaDB, runtime, LLM, internet đều bị chặn; `CapEff=0` |
| Dữ liệu Data Studio | Dremio OSS không có policy, nên quyền được thực thi trong code của mình. Mỗi bảng/cột có cờ `allowed_roles` (thiếu cờ thì chỉ admin thấy); cột `is_pii` không bao giờ hiện với `user`. Lọc ở tầng crud, rồi chặn ở `sql_validator` (xử lý alias, `SELECT *`, đoạn SQL thô), rồi kiểm lại bảng ngay trước khi gửi Dremio. | `tests/role_authz_test.py` (Mongo thật), LLM thật (mục 4.2) |
| Chịu lỗi | Mọi route bất đồng bộ đi qua `handle()`. Một dependency hỏng (ví dụ Mongo) chỉ làm request đó nhận `500`, gateway không bị sập. | e2e chạy với Mongo cố tình không kết nối được |

### 3.2 So với nền tảng chat agent lớn (ví dụ Claude)

- **Ngang mức:** xác thực, quyền sở hữu session/file, cô lập dữ liệu giữa các user ở tầng ứng dụng.
- **Kém hơn:** độ mạnh của sandbox chạy code. Ở đây là namespace của Linux (bubblewrap), dùng chung kernel với
  host, chưa phải VM hay gVisor riêng cho từng session. Đã cắt mạng và bỏ capability, nhưng một lỗ hổng kernel
  vẫn có thể thoát ra được. Nếu cần mức đó, xem `docs/microvm-isolation-strategy.md`.

### 3.3 Còn thiếu: phải làm trước khi cho user thật dùng

1. **Bắt buộc mật khẩu cho Redis và MongoDB.** Hiện tại có thể deploy với Redis và Mongo không mật khẩu.
   Sandbox đã cắt mạng, nhưng gateway nên từ chối khởi động trên production nếu URL thiếu credential.
2. **Token không đặt trên URL WebSocket.** `?token=` sẽ nằm trong log của nginx. Nên đổi sang ticket dùng một lần,
   và thu hẹp CORS (hiện là `*`).
3. **Audit log khi admin mở session của người khác.** Admin hiện mở được mọi session (theo thiết kế) mà không để lại
   dấu vết.

### 3.4 Nên làm (chưa chặn release)

- Giới hạn CPU/RAM cho từng sandbox (`prlimit` hoặc cgroup). Hiện một turn nặng ảnh hưởng mọi session cùng shard
  (runtime vẫn tự restart và resume từ log).
- Tài khoản Dremio mà `analyze_data` dùng nên là **read-only**: thêm một lớp phòng thủ nếu chốt chặn SQL có lỗ.
- Phân quyền theo hàng (row-level) và dashboard riêng theo user: đã chốt là **ngoài phạm vi** đợt này.
- Các việc kỹ thuật còn treo: log của subagent chưa flush đủ, subagent có thể chưa được dispose, race khi dispose
  session lúc idle.

## 4. Tính năng còn giữ nguyên không

### 4.1 E2e (stack hai container, 18/18 pass)

| Test | Kiểm tra gì |
|---|---|
| `health` | readyz của mọi shard; nginx phục vụ SPA và `/chat/<id>` |
| `chatAndList` | Chat một turn, session hiện trong danh sách |
| `flowsDiffer` | Ba flow có bộ tool khác nhau (default 27 tool, data-studio chỉ `analyze_data`) |
| `ownership`, `crossUserIsolation`, `subagentIsolation` | Cô lập giữa các user, kể cả subagent |
| `pythonAndFiles` | Tool python (kernel giữ state theo hội thoại), upload/download file |
| `skillsPerUser` | User A tạo skill riêng, A thấy, B không thấy; 14 skill built-in vẫn còn |
| `modelsAndValidation` | Allow-list model, flow/project không hợp lệ bị từ chối |
| `idleDisposeAndResume`, `restartResumes`, `gracefulStopMidTurn` | Session idle được giải phóng và resume; restart container không mất lịch sử |
| `roleGate`, `roleReachesRuntime` | Phân quyền role |
| `sandboxNoNetwork`, `tokensHashedInRedis` | Hai bản vá bảo mật mới |
| `unicodeText` | Tiêu đề session và tên project tiếng Việt + emoji ghi và đọc đúng; email dài hơn 255 ký tự trả về 400 |
| `purge` | Xóa session thì xóa luôn workspace và log |

### 4.2 LLM thật (stack local 8080, Dremio thật)

| Kịch bản | Kết quả |
|---|---|
| User hỏi số workflow khi bảng còn chỉ admin thấy | Không thấy bảng |
| Admin bật `workflows` cho user, user hỏi lại | **77**, khớp Dremio |
| Cột `created_by` bị đánh dấu PII, user hỏi cột đó | Không lấy được (SQL thực tế chỉ chạy trên `id`) |
| Admin hỏi `workflow_nodes` (bảng chỉ admin) | **851**, khớp Dremio; user hỏi cùng câu thì không thấy bảng |

Hai việc cần lưu ý từ đợt test này:
- Ở kịch bản PII, LLM chính lại ghi giá trị cột `id` thành "giá trị `created_by`". Dữ liệu không bị lộ, nhưng
  câu trả lời sai nhãn. Nên sửa prompt để báo thẳng là cột không có.
- Catalog Mongo vẫn còn `agents_db.*`, nhưng nguồn này không còn trong Dremio. Cần sync lại.

### 4.3 Thay đổi hành vi so với trước

- Người dùng không tự đăng ký được; admin tạo tài khoản ở Settings → Users.
- Sau một lần sync Dremio, mọi bảng mới đều **chỉ admin thấy**; admin phải bật cho user ở Data Studio → Data sources.
- Code chạy trong sandbox **không còn truy cập mạng**: không `pip install`, không `curl` được. Thư viện cài sẵn
  trong image vẫn dùng được; `web_search` vẫn hoạt động vì nó chạy ngoài sandbox.
- Khi deploy bản này, mọi người phải đăng nhập lại một lần (token cũ dạng thô không còn khớp).
- UI mới (tab Users, công tắc cho phép user, dashboard chỉ xem) mới qua typecheck và build, **chưa thử trên trình
  duyệt**.

## 5. Mở rộng theo kiểu plugin: thêm tool, skill

### 5.1 Thử nghiệm thật

Trong một worktree tạm, mình thêm đúng như một dev sẽ thêm:
- Package mới `@fox-harness/dsh-tool-probe-echo` (tool `probe_echo`), khai báo trong preset của flow `default`.
- Skill built-in mới `packages/skills/probe-skill/SKILL.md`.

Sau đó build image, dựng stack e2e và chạy:

| Kiểm tra | Kết quả |
|---|---|
| `GET /skills` liệt kê skill mới | PASS |
| Flow default: model được cung cấp `probe_echo` và `probe-skill` | PASS |
| Flow default: gọi tool, nhận kết quả, tool thấy đúng `cwd` của session đó | PASS |
| Flow default: tool cũ vẫn còn (27 → 28) | PASS |
| Flow data-studio và data-analysis: **không** thấy `probe_echo` (gắn theo preset) | PASS |
| Toàn bộ 18 e2e trên image có plugin mới | 18/18 PASS |

Worktree và image thử nghiệm đã xóa; repo không bị thay đổi.

### 5.2 Cách thêm (đã kiểm chứng)

**Tool cho một flow** (khuyến nghị):
1. Tạo package `packages/tool/<tên>` theo mẫu `packages/tool/create-skill`. Package export `name`, `inject`,
   `apply(ctx)` và gọi `ctx.tools.register(defineTool({...}))`. Lưu ý: `defineTool` bắt buộc khai báo `output`
   (schema + render) nếu tool trả về giá trị.
2. Thêm một dòng vào `packages/profile-template/presets/<flow>/agent.cordis.yml`.
3. Thêm package vào `dependencies` trong `package.json` ở root và vào `references` trong `tsconfig.json`; chạy
   `pnpm install` để cập nhật lockfile.
4. Build lại image backend và deploy. Session đang mở sẽ resume từ log sau khi restart.

**Tool global** (mọi flow): khai báo bundle trong `packages/profile-template/runtime/template/profile.package.json`.
Lưu ý: mask của flow `data-analysis` là **deny-list**, nên một tool global mới sẽ hiện ở cả `default` lẫn
`data-analysis`. Chỉ `data-studio` ẩn hết tool global. Muốn ẩn ở `data-analysis` thì thêm tên tool vào
`FLOW_TOOL_MASK` trong `packages/transport/src/flows.ts`.

**Skill:**
- Built-in cho mọi user: thư mục `packages/skills/<tên>/SKILL.md` (frontmatter có `name` và `description`).
- Riêng flow data-analysis: `packages/flow/data-analysis/skills/`.
- Riêng từng user: user tự tạo ở tab Skills, hoặc agent gọi tool `create_skill`. Skill lưu trên S3 và được ghi vào
  `.dsh/skills` của workspace mỗi lần kết nối; user khác không thấy.

**Ràng buộc bảo mật khi viết tool mới:**
- Tool chạy **trong process runtime** dùng chung, không nằm trong sandbox. Tool guard chỉ kiểm tra tham số dạng
  đường dẫn mà nó nhận ra.
- Một tool tự đọc hoặc ghi file, gọi mạng hay truy cập DB phải tự giới hạn theo `exec.agent.session.header.cwd`
  và theo role. Ví dụ: `analyze_data` đọc role bằng cách đi ngược `parentSession` về agent gốc.
- Không bao giờ lấy user, role hay đường dẫn từ tham số mà model truyền vào.

## 6. Checklist trước khi lên production

- [x] Hai container, build và deploy bằng compose
- [x] Self-test sandbox lúc boot (bwrap, thư mục dữ liệu, mạng bị cắt)
- [x] Phân quyền admin/user ở gateway, runtime và Data Studio
- [x] Cô lập workspace giữa các user, kể cả subagent
- [x] Sandbox: không mạng, không capability, env sạch
- [x] Token trong Redis đã được hash
- [x] Chat, resume, skill, python, file, project vẫn chạy (18/18 e2e)
- [x] Thêm tool/skill theo kiểu plugin vẫn chạy (đã thử thật)
- [ ] Push `fix/subagent-workspace-guard` và `feat/role-based-authz`, merge vào `dev`
- [ ] Bắt buộc mật khẩu cho Redis và Mongo trên production
- [ ] Bỏ token khỏi URL WebSocket, thu hẹp CORS
- [ ] Audit log khi admin mở session của người khác
- [ ] Thử UI mới trên trình duyệt
- [ ] Hạ tầng cấp `SYS_ADMIN` + `NET_ADMIN` cho container backend
- [x] Schema MariaDB đầy đủ, khai báo `utf8mb4`
- [ ] Sync lại catalog Dremio; admin bật các bảng cho user

## 7. Database (`infra/migrations/001_init.sql`)

4 bảng: `discovery_users`, `discovery_sessions`, `discovery_projects`, `discovery_custom_skills`. Không có foreign key.

| Kiểm tra | Kết quả |
|---|---|
| Mọi câu SQL trong code (gateway, `create-admin.mjs`) chỉ dùng cột có trong schema | Đạt |
| Kích thước cột khớp với kiểm tra trong code (title 255, tên project 120, tên skill 64, mô tả 280, hash mật khẩu 161 = salt 32 + `:` + 128) | Đạt; riêng email trước đây không có kiểm tra độ dài, **đã thêm** (>255 ký tự trả về 400) |
| Index khớp với truy vấn (session theo chủ sở hữu + `updated_at`, theo project; project theo chủ sở hữu; skill theo chủ sở hữu + tên) | Đạt |
| Không có foreign key: xóa project thì code xóa các session của nó trước; không có đường xóa user | Đạt, không phát sinh dữ liệu mồ côi |
| Chạy được trên DB sạch | Đạt (stack e2e tạo DB từ file mỗi lần) |
| **Charset** | **Lỗi, đã sửa.** File chưa khai báo charset nên bảng lấy theo mặc định của server. Trên server `latin1`, ghi tiêu đề tiếng Việt hoặc emoji lỗi `ERROR 1366`. Giờ mỗi bảng khai báo `utf8mb4` / `utf8mb4_unicode_ci`, và DB của stack e2e cố tình chạy với mặc định `latin1` để luôn kiểm chứng điều này. |

DB nào đã tạo bảng từ bản cũ trên một server không phải `utf8mb4` thì chạy các lệnh `alter table ... convert to
character set utf8mb4` trong `infra/migrations/README.md`. Stack local hiện tại đã là `utf8mb4` nên không cần.
Schema MongoDB của Data Studio có thêm trường `allowed_roles` nhưng không cần migration: thiếu trường này nghĩa
là chỉ admin thấy.

## 8. Chạy lại để kiểm chứng

```bash
docker build -f infra/docker/backend/Dockerfile -t fox-harness-backend:dev .
docker build -f infra/docker/web/Dockerfile -t fox-harness-web:dev .
sh scripts/e2e-up.sh                           # tự khởi động mock LLM (cổng 4999); web ở :18080
node scripts/e2e-backend.mjs                   # 18 test
sh scripts/e2e-down.sh
cd packages/tool/data-studio-agent/python && MONGODB_URL=mongodb://127.0.0.1:27017 uv run python tests/role_authz_test.py
```
