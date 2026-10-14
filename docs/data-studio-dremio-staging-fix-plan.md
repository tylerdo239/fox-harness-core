# Plan: sửa để Data Studio nối được Dremio bên ngoài (staging)

Ngày 2026-10-14. **Trạng thái: chưa làm gì, chỉ là plan.** Bối cảnh và lý do nằm ở
`docs/data-studio-dremio-staging.md` (mục 5, 6).

Đường dẫn bên dưới tính từ `api/`. `PY` = `packages/tool/data-studio-agent/python`.

## Danh sách cần sửa (theo thứ tự làm)

| # | Việc | Cần khi nào | Bắt buộc? |
|---|---|---|---|
| 0 | Hỏi bên quản lý Dremio staging | Luôn luôn, trước mọi thứ | Có |
| 1 | Truyền biến proxy vào subprocess Python | Staging phải đi qua proxy để tới Dremio | Tuỳ câu trả lời bước 0 |
| 2 | Cho phép trỏ CA bundle riêng | Dremio dùng HTTPS với cert do CA nội bộ ký | Tuỳ câu trả lời bước 0 |
| 3 | Đăng nhập lại khi token hết hạn (401) | Luôn nên làm, staging chạy lâu ngày | Nên làm |
| 4 | Hỗ trợ Personal Access Token | Bên Dremio chỉ cấp PAT, không cấp username/password | Tuỳ câu trả lời bước 0 |
| 5 | Cập nhật `.env.example` và `docs/deploy.md` | Sau khi làm xong các bước trên | Có |

---

## 0. Hỏi bên quản lý Dremio staging

Không sửa code. Cần có câu trả lời cho:

- [ ] URL Dremio (HTTP hay HTTPS, host, port). Là Dremio Software (OSS/Enterprise) hay **Dremio Cloud**?
- [ ] Kiểu tài khoản: username/password (local hoặc LDAP) hay chỉ Personal Access Token?
- [ ] Service account có quyền: xem catalog các source/space cần dùng, `SELECT` trên các dataset đó, chạy job.
- [ ] Nếu HTTPS: cert do CA nào ký? Xin file CA (PEM) nếu là CA nội bộ.
- [ ] Từ pod/máy staging có phải đi qua proxy mới tới được Dremio không?
- [ ] Mở firewall / whitelist IP của pod backend staging tới Dremio.
- [ ] Thời gian sống của token login (mặc định Dremio là 30 giờ).

Kết quả bước này quyết định có cần làm 1, 2, 4 hay không. Nếu Dremio Cloud thì bước 4 lớn hơn nhiều
(đường dẫn API khác, xem bước 4).

## 1. Truyền biến proxy vào subprocess Python

**Hiện trạng:** `PY/src/settings.py:25` có `dremio_use_env_proxy` (env `DREMIO_USE_ENV_PROXY`), hai client dùng nó
cho `httpx(trust_env=...)`. Nhưng gateway chỉ truyền cho Python các biến nằm trong danh sách cho phép, và cả 3 danh
sách đều thiếu `DREMIO_USE_ENV_PROXY`, `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`. Nên trên staging không bật được.

**Sửa:** thêm 4 biến trên vào:

- `packages/tool/data-studio-agent/src/kernel.ts:28` (`FORWARDED_ENV`, cho `analyze_data`)
- `services/gateway/src/data-studio-bridge.ts:36` (`FORWARDED_ENV`, cho admin sync/import)
- `services/gateway/src/config.ts:~177` (`runtimeEnvPassthrough`, gateway → runtime)

Lưu ý: `trust_env=True` bật cả proxy lẫn `SSL_CERT_FILE` của môi trường cho Dremio. Phải đặt `NO_PROXY` đúng
để không kéo Mongo/Meilisearch/LLM qua proxy ngoài ý muốn (các client đó không đọc `dremio_use_env_proxy`).

**Kiểm tra:** đặt `DREMIO_USE_ENV_PROXY=true` + `HTTPS_PROXY` trỏ tới một proxy test, bấm "Sync Dremio" và hỏi 1
câu qua `analyze_data`; log proxy phải thấy request tới Dremio.

## 2. Cho phép trỏ CA bundle riêng

**Hiện trạng:** cả hai client tạo `httpx` với `trust_env=False`, nên `verify` dùng mặc định là certifi (CA public).
Không có biến nào để chỉ CA nội bộ → lỗi `CERTIFICATE_VERIFY_FAILED`.

**Sửa:**

- `PY/src/settings.py`: thêm `dremio_ca_bundle: str | None = None` (env `DREMIO_CA_BUNDLE`, đường dẫn file PEM).
- `PY/src/services/dremio_client.py:24`: `httpx.Client(..., verify=settings.dremio_ca_bundle or True)`.
- `PY/src/pipeline_v4/dremio.py:36`: tương tự trong `_client()`.
- Thêm `DREMIO_CA_BUNDLE` vào 3 danh sách ở bước 1.
- Deploy: mount file CA vào pod backend (secret/configmap), đặt `DREMIO_CA_BUNDLE` trỏ tới nó.

Không thêm tuỳ chọn tắt verify (`verify=False`).

**Kiểm tra:** dựng một Dremio local sau reverse proxy HTTPS dùng cert tự ký; không đặt biến → lỗi cert; đặt
`DREMIO_CA_BUNDLE` → sync và query chạy được.

## 3. Đăng nhập lại khi token hết hạn

**Hiện trạng:**

- `PY/src/services/dremio_client.py:34-37`: token lấy 1 lần rồi cache mãi, gặp 401 thì `raise_for_status()` ném lỗi.
- `PY/bridge/runner.py:374` tạo `DremioClient` **một lần** cho cả đời worker → pipeline v3 bị ảnh hưởng nếu worker
  sống quá thời hạn token (worker chỉ tắt khi rảnh 10 phút, nên dùng liên tục > 30 giờ là gặp).
- `PY/src/pipeline_v4/dremio.py`: `AsyncDremio` được tạo mới mỗi câu hỏi (`PY/src/pipeline_v4/answer.py:132`), nên
  ít bị hơn, nhưng cùng một lỗi nếu một câu hỏi chạy đúng lúc token hết hạn.
- `PY/bridge/admin_runner.py` mỗi request 1 process → không bị.

**Sửa:** gom các lời gọi HTTP của mỗi client qua một hàm `_request()` chung: nếu nhận 401 thì xoá `_token`,
đăng nhập lại, thử lại đúng 1 lần. Áp dụng cho cả `dremio_client.py` và `pipeline_v4/dremio.py`.

**Kiểm tra:** với Dremio local, xoá token trong client (hoặc đặt token sai) rồi chạy query → phải tự login lại
và trả kết quả, không ném 401. Thêm test pytest dùng `httpx.MockTransport` trả 401 ở lần đầu.

## 4. Hỗ trợ Personal Access Token

Chỉ làm nếu bước 0 cho biết không có username/password.

**Hiện trạng:** chỉ có `POST /apiv2/login` + header `_dremio<token>`.

**Sửa (Dremio Software):**

- `PY/src/settings.py`: thêm `dremio_pat: str | None = None` (env `DREMIO_PAT`).
- Hai client: nếu có `dremio_pat` thì header là `Authorization: Bearer <PAT>` và bỏ bước login; bước 3 không áp dụng
  (PAT hết hạn thì phải thay PAT).
- Thêm `DREMIO_PAT` vào 3 danh sách ở bước 1.

**Nếu là Dremio Cloud:** ngoài PAT, đường dẫn API khác hẳn (`https://api.dremio.cloud/v0/projects/{project_id}/...`
thay cho `/api/v3/...`), cần thêm `DREMIO_PROJECT_ID` và đổi toàn bộ URL trong hai client. Việc này cần plan riêng
sau khi xác nhận.

**Kiểm tra:** tạo PAT trên Dremio local (Dremio Software hỗ trợ PAT), đặt `DREMIO_PAT`, bỏ username/password →
sync và query vẫn chạy.

## 5. Cập nhật `.env.example` và `docs/deploy.md`

- `api/.env.example` (đang có `DREMIO_URL/USERNAME/PASSWORD` ở dòng 21-23): thêm dạng comment các biến mới đã làm
  (`DREMIO_USE_ENV_PROXY`, `DREMIO_CA_BUNDLE`, `DREMIO_PAT`).
- `PY/.env.example`: như trên.
- `docs/deploy.md:43` (đang ghi `DREMIO_*`): ghi rõ các biến mới, cách mount CA, yêu cầu quyền của service account,
  và việc phải mở mạng tới Dremio.
- `docs/data-studio-dremio-staging.md` mục 6: đánh dấu mục nào đã sửa.

Không sửa `api/.env` (file của người dùng).
