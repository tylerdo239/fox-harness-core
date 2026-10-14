# Data Studio: chạy local và nối Dremio bên ngoài (staging)

Ghi chú ngày 2026-10-14, viết từ việc đọc code (chưa thử với Dremio staging thật). Đọc theo thứ tự:

1. [Local đang chạy những gì](#1-local-đang-chạy-những-gì)
2. [Phần Python bên trong backend](#2-phần-python-bên-trong-backend)
3. [Biến môi trường và dịch vụ bên ngoài](#3-biến-môi-trường-và-dịch-vụ-bên-ngoài)
4. [Chạy tối thiểu ở local](#4-chạy-tối-thiểu-ở-local)
5. [Lên staging: nối Dremio của hệ thống khác](#5-lên-staging-nối-dremio-của-hệ-thống-khác)
6. [Những chỗ code hiện tại sẽ lỗi](#6-những-chỗ-code-hiện-tại-sẽ-lỗi)
7. [Kiểm tra khi có thông tin staging](#7-kiểm-tra-khi-có-thông-tin-staging)

## 1. Local đang chạy những gì

`docker-compose.yml` ở thư mục gốc repo chỉ dùng cho local dev. Compose project `fox-harness` gồm 8 container:

```
Browser :8080 → web (nginx) → backend :4000 (gateway, Node)
                                 ├─ spawn Python subprocess (venv uv, Python ≥3.12)
                                 │    ├─ LLM (OPENAI_*) + Embedding (EMBEDDING_*)   ← bên ngoài
                                 │    ├─ Dremio :9047  → MySQL (dummy-mysql)       ← dữ liệu thật
                                 │    ├─ Meilisearch :7700                          ← tìm bảng/cột
                                 │    └─ MongoDB :27017                             ← semantic layer
                                 └─ MariaDB, Redis, MinIO                           ← hạ tầng chung của fox
```

| Container | Vai trò với Data Studio |
|---|---|
| **web** (`app/`, nginx) | Giao diện Data Studio. Gọi URL `/data-studio` trực tiếp sẽ rơi vào proxy, phải vào qua sidebar. |
| **backend** (`api/`, gateway) | Chạy API admin CRUD (`api/services/gateway/src/data-studio-db.ts`, đọc ghi thẳng Mongo) và tool `analyze_data`. Hai việc này gọi sang Python. |
| **mongo:7** | Semantic layer: data sources, entities, columns, relationships, metrics, glossary. Lưu luôn lịch sử chat, charts, dashboards. DB `bot_data_studio`. |
| **meilisearch v1.11** | Index tìm bảng/cột (kết hợp keyword và vector, `MEILISEARCH_SEMANTIC_RATIO=0.15`). Được dựng lại khi admin bấm "Sync Dremio". |
| **dremio-oss** | Engine chạy SQL và là nguồn để sync metadata. Bản OSS không có phân quyền theo dòng/cột, nên role được kiểm tra trong `api/`. |
| **mysql:8.4** (alias `dummy-mysql`) | Database mẫu nằm sau Dremio (`workflows_db`, …). Cần cờ `--mysql-native-password=ON`, nếu không Dremio không kết nối được. |
| **mariadb, redis, minio** | Hạ tầng chung của fox (user, session, rate limit, skills). Data Studio không dùng riêng nhưng thiếu thì backend không khởi động. |

Hai container `deploy-core-1` (cordis-core) và `cordis-n8n` có thể đang chạy cùng máy nhưng thuộc project khác
(`local-agent-core`), Data Studio không dùng.

## 2. Phần Python bên trong backend

- Code ở `api/packages/tool/data-studio-agent/python`. Đây là pipeline vendored từ bản reference (Agno, SQLGlot,
  pandas, pymongo; chromadb chỉ cần cho import). Phía Node chỉ là cầu nối subprocess, không chứa logic.
- Có 2 kiểu chạy:
  - `bridge/runner.py`: chạy `analyze_data`. Process được giữ sống và gom thành pool
    (`api/packages/tool/data-studio-agent/src/pool.ts`): mặc định 2 worker (`FOX_DS_WORKERS`), quá 120s trong
    hàng đợi thì báo bận (`FOX_DS_QUEUE_TIMEOUT_MS`), worker rảnh 10 phút thì tắt (`FOX_DS_IDLE_MS`).
  - `bridge/admin_runner.py`: mỗi request admin (import/sync Dremio, reindex) spawn 1 process riêng
    (`api/services/gateway/src/data-studio-bridge.ts`).
- Venv do `uv sync --locked` tạo. Trong image Docker là `/repo/packages/tool/data-studio-agent/python/.venv`
  (đặt qua `FOX_PYTHON_DATA_STUDIO` trong `api/Dockerfile`). Khi chạy `pnpm dev` trực tiếp thì dùng `.venv` local.
- Pipeline mặc định là **v3**. Đặt `DATA_STUDIO_PIPELINE=v4` để bật v4.
- Hạn chế:
  - Review chart bằng ảnh: pipeline chờ frontend chụp ảnh chart để review. Khi chạy qua tool không có frontend,
    mỗi chart chờ 12s rồi dùng bản chưa review.
  - PDF dashboard: dùng chức năng in của trình duyệt, backend không render PDF.

## 3. Biến môi trường và dịch vụ bên ngoài

Khai báo trong `api/.env` (mẫu ở `api/.env.example`):

- `OPENAI_*`: LLM cho các agent SQL/chat. Bắt buộc phải hỗ trợ tool-calling.
- `EMBEDDING_*`: embedding cho Meilisearch.
- `DREMIO_URL`, `DREMIO_USERNAME`, `DREMIO_PASSWORD`.
- `MEILISEARCH_*`, `MONGODB_URL` / `MongoDBWrite`, `MONGODB_DATABASE_NAME`.

Trong compose, service `backend` tự ghi đè các URL (`DREMIO_URL`, `MONGODB_URL`, `MEILISEARCH_URL`, …) sang tên
service. Gateway chỉ truyền cho subprocess Python những biến có trong danh sách `FORWARDED_ENV`
(`kernel.ts`, `data-studio-bridge.ts`) và `runtimeEnvPassthrough` (`api/services/gateway/src/config.ts`).

## 4. Chạy tối thiểu ở local

```bash
docker compose up -d mariadb redis minio mongo meilisearch dremio mysql
cd api && pnpm dev     # gateway :4000
cd app && pnpm dev     # :5173
```

Bỏ `mysql` thì Dremio không có dữ liệu để sync. Bỏ `mariadb`, `redis`, `minio` thì gateway không lên được.

## 5. Lên staging: nối Dremio của hệ thống khác

**Kết luận:** kết nối được mà không cần sửa code, miễn Dremio staging dùng username/password và đi bằng HTTP hoặc
HTTPS có cert công khai (xem các ngoại lệ ở mục 6). Code không phụ thuộc vào việc Dremio là container local, chỉ
gọi REST API qua 3 biến `DREMIO_URL`, `DREMIO_USERNAME`, `DREMIO_PASSWORD`.

### Code gọi Dremio thế nào

Có hai client: `src/services/dremio_client.py` cho v3, sync và profiling, và `src/pipeline_v4/dremio.py` cho v4
(cùng thư mục `api/packages/tool/data-studio-agent/python`). Cả hai chỉ dùng:

| Mục đích | API |
|---|---|
| Đăng nhập | `POST /apiv2/login` với `{userName, password}`, gửi token qua header `Authorization: _dremio<token>` |
| Sync metadata | `GET /api/v3/catalog`, `/catalog/{id}`, `/catalog/by-path/...` (các mục loại SOURCE và SPACE) |
| Chạy SQL | `POST /api/v3/sql`, poll `/api/v3/job/{id}`, đọc `/results` theo trang 500 dòng, `/cancel` khi quá thời gian |

Đây là API chuẩn có ở cả Dremio OSS lẫn Enterprise. Code không tạo source, space hay reflection gì cả, chỉ đọc.
Đường dẫn bảng lấy từ kết quả sync nên không bị gắn cứng vào `workflows_db` hay `dummy-mysql`. MySQL phía sau là
việc của hệ thống bên ngoài.

### Cần hỏi bên quản lý Dremio

1. **Kiểu đăng nhập:** cần một service account dùng được username/password. Tài khoản LDAP vẫn đi qua
   `/apiv2/login` bình thường. Nếu họ chỉ cấp Personal Access Token (`Bearer`), hoặc là **Dremio Cloud**
   (URL `api.dremio.cloud`, chỉ nhận PAT), thì code hiện tại **không chạy**.
2. **Quyền của service account:** cần quyền xem catalog các source/space muốn sync, quyền `SELECT` trên các
   dataset đó, và quyền chạy job. Mọi người dùng đều query bằng chung tài khoản này; phân quyền theo role nằm
   trong `api/`, không dựa vào Dremio.
3. **Mạng:** pod hoặc container backend ở staging phải gọi được tới host:port của Dremio (firewall, whitelist IP).
4. **TLS và proxy:** Dremio dùng HTTP hay HTTPS, cert do CA nào ký, có phải đi qua proxy không (ảnh hưởng mục 6).

## 6. Những chỗ code hiện tại sẽ lỗi

| Trường hợp | Vì sao lỗi | Cách sửa (chưa làm) |
|---|---|---|
| HTTPS với cert do CA nội bộ ký | Client tạo `httpx` với `trust_env=False`, nên chỉ tin bộ CA public (certifi); `SSL_CERT_FILE` bị bỏ qua và không có biến nào để trỏ tới CA riêng. Lỗi `CERTIFICATE_VERIFY_FAILED`. | Thêm biến CA bundle (vd. `DREMIO_CA_BUNDLE`) truyền vào `verify=` của cả hai client, và forward biến đó. |
| Phải đi qua proxy | Settings có `DREMIO_USE_ENV_PROXY`, nhưng biến này **không được truyền** vào subprocess Python (thiếu trong `FORWARDED_ENV` của `kernel.ts`, `data-studio-bridge.ts` và trong `config.ts`), và `HTTP(S)_PROXY` cũng không được truyền. | Thêm `DREMIO_USE_ENV_PROXY`, `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` vào 3 danh sách đó. |
| Chỉ có Personal Access Token / Dremio Cloud | Code chỉ đăng nhập bằng `/apiv2/login`. | Thêm biến `DREMIO_PAT`; khi có thì gửi `Authorization: Bearer <PAT>` và bỏ bước login. Dremio Cloud còn khác đường dẫn API (`/v0/projects/{id}/...`). |
| Token hết hạn | Token được cache mãi và không đăng nhập lại khi nhận 401. Dremio mặc định cho token sống 30 giờ. Worker trong pool tự tắt sau 10 phút rảnh nên ít khi gặp, nhưng nếu dùng liên tục trên 30 giờ thì `analyze_data` trả 401 cho tới khi worker khởi động lại. | Khi gặp 401 thì xoá token, đăng nhập lại và thử lại 1 lần. |

## 7. Kiểm tra khi có thông tin staging

Chạy từ chính máy hoặc pod sẽ chạy backend:

```bash
curl -s -X POST "$DREMIO_URL/apiv2/login" -H 'Content-Type: application/json' \
  -d '{"userName":"...","password":"..."}'
```

- Nhận được `token`: phần đăng nhập và mạng ổn. Vào admin UI bấm "Sync Dremio" để kiểm tra luôn catalog và quyền.
- Lỗi cert, timeout, 403/503 từ proxy, hoặc chỉ có PAT: đối chiếu với bảng ở mục 6.
