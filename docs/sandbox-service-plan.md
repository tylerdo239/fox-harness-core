# Plan: service chạy code riêng — pod không quyền, không giữ dữ liệu

> **Trạng thái 2026-10-07:** chưa làm. Để deploy thử nội bộ trên pod không quyền, đã chọn tạm `FOX_SANDBOX_MODE=none`
> (chạy code của model trong backend, **không cô lập**, rủi ro đã chấp nhận) — xem `docs/deploy.md`. Plan dưới đây là
> hướng khi cần an toàn hơn.

## 1. Quyết định

| Nội dung          | Chốt                                                                                                                                                           |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ràng buộc hạ tầng | System chỉ cấp **1 pod thường**: non-root, không capability, không namespace, không đổi uid                                                                    |
| Hướng             | Code do model viết (tool `bash`, tool `python`, `pandas_exec` của Data Studio) chạy trong **service riêng `sandbox/`** trên pod đó                             |
| Không giữ dữ liệu | Pod sandbox **không gắn kho file** của user. Backend (đã kiểm quyền) chỉ đưa vào **file của đúng phiên đang chạy**, lấy kết quả về rồi ghi vào workspace       |
| Không vách ngăn   | Các job chạy chung một user Linux trong pod. **Rủi ro chấp nhận**: code *cố ý* của một job có thể đọc file/process của job khác **đang chạy cùng lúc** (mục 5) |
| Giữ nguyên        | Core agent, các flow, tool đọc/ghi file trong runtime (`workspace-guard`), phân quyền của backend                                                              |

Lý do: namespace (bwrap) bị cấm; Landlock/WebAssembly để sau. Chạy code trong pod riêng không bí mật, không kho file đã loại
phần rủi ro lớn nhất (lộ key, DB, toàn bộ file của mọi user).

## 2. Kiến trúc

```
pod backend (non-root, KHÔNG còn SYS_ADMIN/NET_ADMIN)                    pod sandbox (thường, không quyền)
┌──────────────────────────────────────────────────────┐                ┌──────────────────────────────────────┐
│ gateway + runtime agent + Data Studio (giữ bí mật)    │                │ sandbox-server (Node)                │
│                                                      │  WebSocket     │  xác thực token · hạn mức · giới hạn │
│  bash ─ dsh-sandbox-local ─┐                         │  + token       │  /work/<phiên>/  (bản sao file phiên)│
│  python ─ kernel.ts ───────┼─ fox-sandbox-exec ──────┼───────────────▶│   └─ process lệnh (prlimit, timeout) │
│  pandas_exec ──────────────┘  (client, đồng bộ file)  │                │  không bí mật · không kho file       │
│        ▲ ghi kết quả vào workspace (đã kiểm đường dẫn)│                └──────────────────────────────────────┘
│  /data/users/<id>/<phiên>  (chỉ backend thấy)         │                   NetworkPolicy: chỉ backend vào, không ra
└──────────────────────────────────────────────────────┘
```

**Agent nối vào:** `dsh-sandbox-local` cho thay runner (`runnerCommand`). Client `fox-sandbox-exec` nhận đúng tham số
kiểu bwrap như `api/docker/fox-confine.sh` (chế độ ghi, workspace, lệnh), chạy **trong pod backend** nên đọc được
workspace của phiên, đồng bộ file sang service, stream stdin/stdout/stderr, chuyển tín hiệu, trả đúng mã thoát. Backend
chỉ đổi biến `FOX_CONFINE_RUNNER`; tool `bash`, cấu hình dsh giữ nguyên.

## 3. Luồng theo từng chỗ

| Chỗ                             | Luồng                                                                                                                                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tool `bash` (mỗi lệnh)          | client đẩy file workspace **đã đổi** lên `/work/<phiên>` → chạy lệnh → service trả danh sách file mới/đổi/xoá → client ghi vào workspace                                                                     |
| Tool `python` (kernel giữ biến) | Kernel sống trong service suốt phiên (1 kết nối). `kernel.ts` gọi `fox-sandbox-exec --sync` **trước mỗi cell** (đẩy file mới, vd file user vừa upload) và **sau mỗi cell** (kéo file output: biểu đồ, Excel) |
| `pandas_exec`                   | Không file: dữ liệu bảng gửi qua stdin, kết quả qua stdout; process Data Studio không còn `exec` code của model                                                                                              |
| Hết phiên                       | Kernel rảnh quá hạn → đóng; service xoá `/work/<phiên>`                                                                                                                                                      |

## 4. Đồng bộ file

| Quy tắc                     | Chi tiết                                                                                                                                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Đẩy lên (backend → sandbox) | So danh sách (đường dẫn, kích thước, thời gian sửa); chỉ gửi file mới/đổi; file đã xoá ở workspace thì xoá ở sandbox                                                                                    |
| Kéo về (sandbox → backend)  | Service trả file mới/đổi/xoá trong `/work/<phiên>` sau lệnh/cell                                                                                                                                        |
| Kiểm khi ghi vào workspace  | Client coi dữ liệu từ sandbox là **không tin cậy**: chỉ đường dẫn tương đối, không `..`, không tuyệt đối, **bỏ symlink và file đặc biệt**, giới hạn số file và dung lượng; ghi qua file tạm rồi đổi tên |
| Giới hạn                    | Workspace một phiên ≤ X MB (vd 500 MB); một file ≤ Y MB; vượt → lệnh bị từ chối với thông báo rõ                                                                                                        |
| Thư mục trong sandbox       | `/work/<id ngẫu nhiên>/` cho mỗi phiên; không chứa gì ngoài bản sao file của phiên đó                                                                                                                   |

## 5. Bảo vệ có được và rủi ro chấp nhận

| Mối nguy                                                       | Kết quả                                                                                                                                            |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Đọc key LLM, mật khẩu Dremio/Mongo, token                      | ✓ Chặn: pod sandbox không có bí mật                                                                                                                |
| Chạm Redis, MariaDB, Mongo, backend, internet                  | ✓ Chặn bằng NetworkPolicy (bắt buộc)                                                                                                               |
| Đọc file của user khác **trong kho**                           | ✓ Chặn: kho không có trong pod sandbox                                                                                                             |
| Ghi bậy vào workspace qua kết quả trả về (symlink, `..`)       | ✓ Chặn: client kiểm trước khi ghi                                                                                                                  |
| Một job làm sập/chậm job khác                                  | ◐ Giảm bằng giới hạn (mục 6)                                                                                                                       |
| **Code cố ý đọc file/process của job khác đang chạy cùng lúc** | ✗ **Chấp nhận** — cần người dùng chủ động dò, đúng lúc có job khác; chỉ thấy file của phiên đó. Phiên `python` sống lâu → thời gian có mặt dài hơn |

Biện pháp rẻ để nâng rào (không chặn hẳn): tên thư mục phiên ngẫu nhiên; không đưa dữ liệu qua tham số dòng lệnh; xoá thư
mục ngay khi phiên kết thúc; audit log mọi lệnh. Khi system cho phép: Landlock (kernel) hoặc "mỗi lúc một job" sẽ khép
phần này mà không đổi kiến trúc.

## 6. Giới hạn tài nguyên (không cần quyền)

| Giới hạn                      | Cách                                                                                                       |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Bộ nhớ, CPU, file, số file mở | `prlimit` (giảm giới hạn của chính mình — không cần quyền) cho mỗi lệnh                                    |
| Thời gian                     | Lệnh `bash`: timeout; cell `python`: timeout cell (như hiện tại); quá hạn → giết cả nhóm process           |
| Số lệnh đồng thời             | Trần cho cả pod và cho mỗi user; vượt → 503, client đợi và thử lại (khi lệnh chưa chạy)                    |
| Fork bomb                     | `RLIMIT_NPROC` dùng chung cho cả pod (cùng uid) + giới hạn `pids` của pod (xin system) + giết nhóm process |
| Dung lượng                    | Hạn mức `/work` mỗi phiên; giới hạn `ephemeral-storage` của pod                                            |

## 7. Thành phần

| Phần                        | Việc                                                                                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sandbox/server/`           | `/v1/exec` (WebSocket: chạy lệnh, đồng bộ file), `/healthz`, `/readyz`, `/metrics`; token; hạn mức; giới hạn; dọn phiên; audit log; drain khi tắt |
| `sandbox/client/`           | `fox-sandbox-exec` (1 file JS, không thư viện): runner kiểu bwrap + đồng bộ file + `--sync`                                                       |
| `sandbox/Dockerfile`        | Node + Python (cùng bộ thư viện với tool `python` hiện tại) + script của tool `python`; chạy non-root                                             |
| `sandbox/k8s/`              | Deployment (Pod Security restricted, `readOnlyRootFilesystem`, `emptyDir` cho `/work`), Service, NetworkPolicy, Secret mẫu, PDB                   |
| Backend                     | Bỏ `cap_add`; client trong image; `FOX_CONFINE_RUNNER` → client; gateway kiểm `readyz` của sandbox lúc khởi động                                  |
| `python-repl/src/kernel.ts` | Gọi `--sync` trước/sau mỗi cell                                                                                                                   |
| `pandas_exec.py`            | Có runner → chạy trong sandbox (stdin/stdout); bộ lọc cũ giữ làm lớp 2                                                                            |
| Bỏ                          | Phụ thuộc `bwrap`/`fox-confine.sh` ở prod (giữ cho dev nếu muốn)                                                                                  |

## 8. Vận hành

| Hạng mục     | Cách                                                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Readiness    | Tự kiểm: chạy được lệnh, `prlimit` có tác dụng, không có biến môi trường bí mật, `/work` ghi được                        |
| Log          | JSON, mỗi lệnh một dòng audit: user, phiên, lệnh gì, thời gian, mã thoát, lý do bị giết — không ghi nội dung             |
| Metrics      | Lệnh đang chạy (tổng/theo user), thời gian, lỗi, bị giết do giới hạn, từ chối, dung lượng `/work`                        |
| Tắt/cập nhật | Ngừng nhận lệnh mới, chờ lệnh đang chạy tới hạn, giết phần còn lại; kernel `python` mất biến (như process chết hiện nay) |
| Token        | k8s Secret; nhận 2 token trong lúc xoay                                                                                  |
| Rollback     | Đổi `FOX_CONFINE_RUNNER` về cách cũ, hoặc rollback image                                                                 |

## 9. Kiểm thử

| Nhóm         | Nội dung                                                                                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| e2e hiện có  | `pythonAndFiles` (gồm ngắt cell, file output), `crossUserIsolation` (đọc kho của người khác qua tool → không có), chat thường dùng `bash` — chạy qua service |
| Đồng bộ file | Upload rồi phân tích; tạo/sửa/xoá file trong lệnh → workspace khớp; output có symlink, `..`, file khổng lồ → bị bỏ                                           |
| Bí mật, mạng | Trong sandbox: `env`, đọc `/proc/1/environ`, kết nối Redis/Mongo/internet → không có gì / bị chặn                                                            |
| Tài nguyên   | Ăn RAM, fork bomb, CPU vô hạn, ghi đầy đĩa, treo → bị giết, service và phiên khác vẫn chạy                                                                   |
| Độ bền       | Giết pod giữa lệnh; rolling update; mất kết nối; đầy (503 + thử lại)                                                                                         |
| Data Studio  | Câu hỏi thật có bước Transform; phép thử lách `pandas_exec` không đọc được bí mật                                                                            |
| Tải          | N user song song; độ trễ thêm mỗi lệnh (gồm đồng bộ file); RAM mỗi kernel → chốt `resources`                                                                 |

## 10. Các bước

| Bước | Việc                                                                               | Xong khi                                                        |
| ---- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 1    | Server + client chạy lệnh `bash` (chưa đồng bộ file); compose có service `sandbox` | Lệnh chạy qua service; backend không còn `cap_add`              |
| 2    | Đồng bộ file + `--sync` cho kernel `python`                                        | e2e `pythonAndFiles` + nhóm "Đồng bộ file" pass                 |
| 3    | `pandas_exec` qua service; giới hạn, hạn mức, audit, metrics, readiness, drain     | Nhóm "Bí mật, mạng", "Tài nguyên", "Độ bền", "Data Studio" pass |
| 4    | Image, manifest k8s, Secret; deploy staging                                        | Toàn bộ mục 9 pass trên staging                                 |
| 5    | Đo tải, chốt `resources`/trần đồng thời; runbook; lên prod                         | Chạy prod, có dashboard                                         |

## 11. Cần từ system

| #   | Cần                                                                       | Ghi chú                                                             |
| --- | ------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 1   | 1 Deployment (1 pod) thường cho sandbox, ~4 vCPU / 8 GB (chốt sau khi đo) | Không capability, không PVC dùng chung                              |
| 2   | **NetworkPolicy**: sandbox chỉ nhận từ backend, không egress              | **Bắt buộc** — đây là lớp chặn mạng duy nhất khi không có namespace |
| 3   | Secret cho token backend ↔ sandbox                                        |                                                                     |
| 4   | `emptyDir` / `ephemeral-storage` cho `/work`; giới hạn `pids` nếu có      |                                                                     |
| 5   | Thu log stdout, scrape `/metrics`                                         |                                                                     |

Nếu system **không** có NetworkPolicy: code trong sandbox gọi được các dịch vụ nội bộ → mọi dịch vụ (Redis, MariaDB,
Mongo, Meili, Dremio) phải bật xác thực và không tin theo IP.
