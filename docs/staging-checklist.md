# Checklist đẩy lên staging (`api/` và `app/`)

Ngày 2026-10-14. Gom từ `docs/deploy.md`, `docs/deploy-security-checklist.md`, `api/.env.example`, hai Dockerfile và
`docs/data-studio-dremio-staging-fix-plan.md`. Đi lần lượt từ trên xuống, đánh dấu `[x]` khi xong.

Thứ tự:

1. [Trước khi build](#1-trước-khi-build)
2. [Hạ tầng phải có sẵn](#2-hạ-tầng-phải-có-sẵn)
3. [Mạng](#3-mạng)
4. [Image `api/` (backend)](#4-image-api-backend)
5. [Image `app/` (web)](#5-image-app-web)
6. [Ingress / proxy phía trước](#6-ingress--proxy-phía-trước)
7. [Sau khi lên: khởi tạo](#7-sau-khi-lên-khởi-tạo)
8. [Smoke test chức năng](#8-smoke-test-chức-năng)
9. [Data Studio trên staging](#9-data-studio-trên-staging)
10. [Vận hành](#10-vận-hành)
11. [Đã biết, chưa sửa](#11-đã-biết-chưa-sửa)

---

## 1. Trước khi build

- [ ] Chọn **một commit** và build cả hai image từ cùng commit đó; tag image theo commit (vd. `git rev-parse --short HEAD`).
- [ ] Nhánh đã merge đủ những gì định đưa lên (kiểm tra `git log main..<nhánh>`).
- [ ] Test chạy xanh ở local: `sh scripts/e2e-up.sh && node scripts/e2e-backend.mjs`. Nếu staging chạy
      `FOX_SANDBOX_MODE=none` thì chạy thêm `E2E_SANDBOX_MODE=none sh scripts/e2e-up.sh`.
- [ ] Build được cả hai image:
      ```bash
      docker build -t fox-harness-backend:<tag> ./api
      docker build -t fox-harness-web:<tag>     ./app
      ```
- [ ] Không có file `.env` nào lọt vào image (`.env` đã gitignore; kiểm tra `.dockerignore` nếu có).

## 2. Hạ tầng phải có sẵn

| Thành phần | Cần kiểm tra |
|---|---|
| **MariaDB 10.11** | [ ] Có database `discovery-agent` và user riêng. [ ] Đã chạy `api/migrations/001_init.sql` **một lần**. [ ] Các bảng `discovery_*` là `utf8mb4` (nếu DB cũ: xem `api/migrations/README.md`). |
| **Redis** | [ ] Có mật khẩu. Không cần backup (chỉ giữ token đăng nhập và rate limit). |
| **S3 / bucket** | [ ] Bucket tồn tại sẵn (gateway chỉ tự tạo khi `HeadBucket` lỗi, trên S3 công ty thường không được quyền tạo). [ ] User S3 có quyền **bắt buộc**: `s3:ListBucket` (cho `HeadBucket` và liệt kê), `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject`, `s3:ListBucketVersions` (xoá log và file khi xoá chat/project); bucket bật versioning thì thêm `s3:DeleteObjectVersion`. Không cần quyền lifecycle (gateway không đặt rule nào từ 2026-10-14). S3 giữ log chat (`sessions/`), file upload và file python sinh ra (`files/`), xem `docs/workspace-archive-plan.md`. [ ] Đặt `S3_ENDPOINT` (trừ khi đúng là AWS). [ ] MinIO hoặc S3 kiểu path: `S3_FORCE_PATH_STYLE=true`. |
| **LLM** | [ ] Endpoint OpenAI-compatible `/chat/completions`, hỗ trợ tool-calling. Không có fallback sang api.openai.com. |
| **Embedding** | [ ] Endpoint `/embeddings` (Data Studio dùng). |
| **MongoDB** | [ ] Có DB cho Data Studio (`MONGODB_DATABASE_NAME`, mặc định `bot_data_studio`). Nếu URI có tên DB thì tên trong URI thắng. |
| **Meilisearch** | [ ] Container riêng có volume `/meili_data`, `MEILI_ENV=production`, `MEILI_MASTER_KEY` ≥ 16 byte, `MEILI_NO_ANALYTICS=true`. |
| **Dremio** | [ ] Hệ thống bên ngoài: làm hết bước 0 trong `docs/data-studio-dremio-staging-fix-plan.md` (tài khoản, quyền, TLS, proxy). |
| **Volume `/data`** | [ ] PVC cho backend (RWO đủ cho 1 replica). [ ] Có lịch backup: đây là bản làm việc của hội thoại, workspace, project. Log và file cũng có trên S3 (trừ file > 100 MB), nhưng thay đổi trong 2 phút gần nhất chỉ nằm ở đây. |

## 3. Mạng

- [ ] web → backend: cổng 4000 trong mạng nội bộ.
- [ ] backend → MariaDB, Redis, S3, MongoDB, Meilisearch, Dremio.
- [ ] backend → Internet (hoặc qua proxy): endpoint LLM, endpoint embedding, `https://google.serper.dev` (web search).
- [ ] Cổng 4000 của backend **không** mở ra ngoài; ra ngoài chỉ qua web/ingress.
- [ ] Web container không gọi ra ngoài, không cần egress.
- [ ] Nếu backend phải đi qua proxy để tới Dremio hoặc dùng CA nội bộ: hiện code **chưa hỗ trợ**, xem bước 1, 2 trong
      `docs/data-studio-dremio-staging-fix-plan.md`.

## 4. Image `api/` (backend)

### Biến môi trường bắt buộc

Thiếu là gateway không khởi động:

- [ ] `DATABASE_URL` (vd. `mariadb://user:pass@host:3306/discovery-agent`)
- [ ] `REDIS_URL` (có mật khẩu)
- [ ] `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` (+ `S3_ENDPOINT`, `S3_REGION`, `S3_FORCE_PATH_STYLE`)
- [ ] `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL_ID`

### Biến cho Data Studio

- [ ] `MONGODB_URL` (hoặc `MongoDBWrite` từ Vault), `MONGODB_DATABASE_NAME`
- [ ] `EMBEDDING_API_KEY`, `EMBEDDING_BASE_URL`, `EMBEDDING_MODEL_ID`
- [ ] `DREMIO_URL`, `DREMIO_USERNAME`, `DREMIO_PASSWORD`
- [ ] `MEILISEARCH_URL`, `MEILISEARCH_MASTER_KEY` (trùng với key của container Meilisearch)
- [ ] `DATA_STUDIO_PIPELINE`: để trống (v3) hay `v4`, chốt trước.

### Biến khác nên chốt

- [ ] `SERPER_API_KEY` (web search; thiếu thì tool search lỗi).
- [ ] `TRUST_PROXY=<số proxy phía trước>`: chỉ đặt khi ingress đã ghi đè đúng `X-Forwarded-For` (mục 6).
- [ ] `ALLOWED_ORIGINS`: để trống nếu app và API cùng domain (mặc định là vậy).
- [ ] `FOX_RUNTIME_COUNT`, `MAX_CONCURRENT_SESSIONS`, `MAX_SESSIONS_PER_USER`, `SESSION_TOKEN_BUDGET`, `FOX_DS_WORKERS`.
- [ ] `S3_SSE` nếu yêu cầu mã hoá phía server.
- [ ] Bucket có dung lượng cố định (12 GB): `S3_BUCKET_CAPACITY_BYTES=12884901888`, `USER_FILE_QUOTA_BYTES` (mặc
      định 200 MB), tuỳ chọn `FILE_RETENTION_DAYS` (xem `docs/storage-quota-plan.md`). Kiểm tra bucket **không bật
      versioning** (`aws s3api get-bucket-versioning`): bật thì file đã xoá vẫn chiếm chỗ.
- [ ] Secret lấy từ secret manager, không ghi thẳng vào manifest.

### Sandbox (chọn một)

- [ ] **strict** (mặc định): container có `cap_add: SYS_ADMIN, NET_ADMIN`. Image đặt `NODE_ENV=production`, nên
      không có sandbox chạy được thì gateway **từ chối khởi động**.
- [ ] **none** (pod k8s không cho cấp capability): `FOX_SANDBOX_MODE=none`. Model chạy bash/python **không cách ly**
      (đọc được file của mọi user). Chỉ dùng cho test nội bộ, cần người chịu trách nhiệm đồng ý. Log phải có dòng
      `sandbox_disabled` mỗi lần khởi động. Mẫu `securityContext` "restricted": `docs/deploy.md`.

### Deployment

- [ ] `replicas: 1`, `strategy: Recreate` (chưa hỗ trợ nhiều replica).
- [ ] Mount PVC ở `/data`. Nếu `readOnlyRootFilesystem: true` thì mount thêm `/tmp` (emptyDir) và `HOME=/tmp`.
- [ ] `terminationGracePeriodSeconds` ≥ 40 (gateway cần thời gian ghi log session khi nhận SIGTERM).
- [ ] Memory đủ cho runtime + kernel Python (mỗi kernel pandas vài trăm MB; Data Studio thêm `FOX_DS_WORKERS` process).
- [ ] Probe: liveness `GET /healthz`, readiness `GET /readyz` (image đã có `HEALTHCHECK` dùng `/readyz`).
      **Lưu ý:** `/readyz` chỉ báo gateway và runtime sẵn sàng, không kiểm tra Mongo, Meilisearch, Dremio hay LLM,
      nên xanh vẫn chưa chắc Data Studio chạy.

## 5. Image `app/` (web)

- [ ] `BACKEND_URL` = địa chỉ nội bộ của backend, có `http(s)://` (vd. `http://fox-backend:4000`). Thiếu hoặc sai
      dạng thì container từ chối khởi động. Đổi giá trị chỉ cần restart, không cần build lại.
- [ ] Không secret, không volume.
- [ ] Mở trang chủ, `/docs/` (hướng dẫn sử dụng) và `/healthz` qua domain staging đều trả về.

## 6. Ingress / proxy phía trước

Chi tiết từng dòng ở `docs/deploy-security-checklist.md`.

- [ ] TLS: chỉ HTTPS/WSS, HTTP chuyển hướng sang HTTPS.
- [ ] Header: HSTS, `frame-ancestors 'none'`, CSP (thử trên staging trước), `X-Content-Type-Options: nosniff`,
      `Referrer-Policy: same-origin`.
- [ ] `X-Forwarded-For` bị **ghi đè** bằng IP thật của client, rồi mới đặt `TRUST_PROXY` cho backend.
- [ ] WebSocket: bật Upgrade cho `/sessions/*`, timeout đọc/ghi ≥ 1 giờ (một lượt trả lời có thể chạy vài phút).
- [ ] Body tối đa ~80 MB (upload dữ liệu), tắt buffer request nếu được.
- [ ] Access log không ghi query string.
- [ ] (Tuỳ chọn) rate limit theo IP cho `/auth/login`.

## 7. Sau khi lên: khởi tạo

- [ ] Log backend không có lỗi khi khởi động; có dòng `runtime_started` và `runtimes_ready`.
- [ ] `GET /readyz` qua domain staging trả `200` và mọi shard `up`.
- [ ] Tạo admin đầu tiên **trong container**, không qua HTTP:
      `docker exec <backend> node scripts/create-admin.mjs <email> <password>` (k8s: `kubectl exec`).
- [ ] Đăng nhập admin, tạo thêm 1 tài khoản role `user` trong Settings → Users để test.
- [ ] Nếu chuyển dữ liệu Mongo cũ (trước 2026-10-07) sang: backup Mongo, chạy
      `node scripts/backfill-dashboard-owners.mjs --dry-run` rồi chạy thật (gán `owner_id` cho dashboard/chart cũ).

## 8. Smoke test chức năng

Dùng cả tài khoản admin và tài khoản `user`.

- [ ] Đăng nhập, đăng xuất, sai mật khẩu nhiều lần bị chặn tạm.
- [ ] Chat mới: trả lời stream được tới hết, không bị cắt giữa chừng (kiểm tra timeout WebSocket ở ingress).
- [ ] Reload trang giữa lúc đang trả lời: mở lại hội thoại vẫn thấy nội dung.
- [ ] Đính kèm file (nút kẹp giấy, kéo thả, dán), file ~ vài chục MB tải lên được.
- [ ] Tool web search trả kết quả (kiểm tra `SERPER_API_KEY` và egress).
- [ ] Chạy python trong flow phân tích dữ liệu (kiểm tra sandbox; nếu `strict`, model code không ra được Internet).
- [ ] Skill / custom skill: tạo, sửa, dùng được (kiểm tra S3).
- [ ] Project: tạo, đổi tên, chuyển hội thoại vào project.
- [ ] Chọn model (nếu có `OPENAI_ALLOWED_MODELS`).
- [ ] Copy link chat của user A sang trình duyệt user B → 403.
- [ ] Admin đổi role của user → tab của user đó bị đăng xuất ở request kế.
- [ ] Restart pod backend: hội thoại cũ vẫn còn (kiểm tra PVC `/data`).
- [ ] Upload 1 file và chạy python sinh 1 file trong chat data-analysis; sau ~2 phút log có `workspace_archive uploaded=…`, và trên bucket có `files/users/<userId>/<sessionId>/…`.
- [ ] Xoá chat đó: hết object dưới `files/users/<userId>/<sessionId>/` và `sessions/<userId>/<sessionId>/`.
- [ ] Log khởi động có `storage_usage bucketBytes=… percent=…` (không có `storage_scan_failed`).
- [ ] Cài đặt > Dung lượng: thấy file của mình, xoá được; admin thấy bucket và dung lượng từng user.
- [ ] Upload vượt quota → báo "hết dung lượng" kèm nút "Quản lý dung lượng"; xoá file cũ rồi upload lại được.
- [ ] Admin: Dọn file không dùng → "Xem trước" ra số, chưa xoá gì.

## 9. Data Studio trên staging

- [ ] Từ pod backend gọi thử Dremio:
      `curl -s -X POST "$DREMIO_URL/apiv2/login" -H 'Content-Type: application/json' -d '{"userName":"...","password":"..."}'`
      → phải có `token`.
- [ ] Admin: thêm data source, bấm **Sync Dremio** → danh sách bảng/cột hiện ra; sync xong tự reindex Meilisearch không lỗi.
- [ ] Mongo staging trống thì semantic layer (mô tả bảng, cột, quan hệ, metric, glossary) phải nhập lại hoặc chuyển từ local.
- [ ] Admin hỏi một câu đã biết đáp án → ra số đúng, có SQL, có chart.
- [ ] Bảng chưa mở cho role `user`: user hỏi thì bị từ chối, không ra số.
- [ ] Admin bật "Cho phép role user" cho một bảng → user hỏi lại ra số đúng, cột PII vẫn bị chặn.
- [ ] Lưu chart vào dashboard; user chỉ thấy dashboard của chính mình.
- [ ] In dashboard ra PDF bằng trình duyệt.
- [ ] Câu hỏi chạy lâu (vài phút) không bị ingress cắt.

## 10. Vận hành

- [ ] Backup: PVC `/data`, MariaDB, MongoDB. Thử khôi phục ít nhất một lần.
- [ ] Log: gom log container (mỗi dòng một JSON có `level`; dòng của runtime có `component=runtime` và `shard`; `LOG_FORMAT=text` nếu cần đọc bằng mắt).
- [ ] Theo dõi: `/readyz`, memory của pod backend, số session đang stream.
- [ ] Ghi lại tag image đang chạy và cách rollback về tag trước.

## 11. Đã biết, chưa sửa

Không chặn việc lên staging, nhưng cần biết khi test:

- Hạ quyền một user không đóng WebSocket đang mở; agent đang chạy giữ role cũ tới khi ngắt (`docs/multi-user-authz.md`, mức cao).
- Admin mở được session của mọi user (có chủ ý), chưa có log riêng.
- Dremio: chưa hỗ trợ proxy, CA nội bộ, PAT; token không tự làm mới khi hết hạn (`docs/data-studio-dremio-staging-fix-plan.md`).
- Data Studio: review chart bằng ảnh tự bỏ qua sau 12s khi không có frontend; PDF chỉ qua chức năng in của trình duyệt.
- `FOX_SANDBOX_MODE=none` nghĩa là không cách ly giữa các user khi model chạy code.
