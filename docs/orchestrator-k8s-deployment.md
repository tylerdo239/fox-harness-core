# Orchestrator trên Kubernetes — khả năng triển khai và phương án

> Trạng thái: phân tích từ code (`services/orchestrator/src/*`), **chưa thử deploy trên k8s thật**.
> Câu hỏi gốc: nếu deploy orchestrator vào một pod không có quyền hệ thống thì có chạy được không, đặc biệt là scale / spawn / kill session của từng user trong hệ thống multi-user?

## 1. Kết luận

Với thiết kế hiện tại, **orchestrator không chạy được trong pod thường không có quyền**. Nó điều khiển Docker daemon của host để mỗi session là một container; k8s không cung cấp Docker daemon đó cho pod. Có ba hướng: (A) chạy orchestrator + Docker trên VM, (B) viết lại tầng spawn để tạo Pod qua Kubernetes API, (C) Docker-in-Docker (không khuyến nghị).

## 2. Orchestrator đang làm gì

Mỗi session của user = một worker container (image `fox-harness-worker`):

| Thao tác | Hiện thực hiện tại | File |
|---|---|---|
| Spawn | `docker.createContainer` + `start`, publish cổng ngẫu nhiên (`HostPort: '0'`), chờ cổng reachable | `docker.ts` |
| Kill / hibernate | `stop({t:5})` rồi `remove({force:true})`; thư mục `/data` của session được giữ lại | `docker.ts` |
| Purge | Xóa thư mục session bằng container root tạm (`find /target -delete`) | `docker.ts` |
| Warm pool | Giữ sẵn container chưa gán session, claim khi có người dùng (có kiểm tra container còn sống) | `warmpool.ts`, `ensure.ts` |
| Affinity | Redis lưu session → container | `redis.ts` |
| Sweep / archive | Session idle quá hạn: `tar -czf` thư mục vào `archiveDir`, xóa container | `sweep.ts`, `archive.ts` |
| Giới hạn tài nguyên | `Memory`, `NanoCpus`, `PidsLimit` mỗi container | `docker.ts`, `config.ts` |

Mô hình cô lập: 1 container + 1 bind mount `/data` riêng cho mỗi session.

## 3. Vì sao pod thường không chạy được

1. **Docker socket.** `dockerode` gọi Docker Engine API. Pod phải mount `/var/run/docker.sock`; nhiều cluster dùng containerd (không có Docker) hoặc cấm mount socket (đồng nghĩa quyền root trên node).
2. **Bind mount phía host.** `Binds: [dshHomeDir:/data]` được Docker daemon phân giải trên *host*, không phải trong pod. Đường dẫn trong pod orchestrator không tồn tại trên host trừ khi mount cùng một hostPath ở cả hai.
3. **`CapAdd: ['SYS_ADMIN']`.** Cần cho `bwrap` (sandbox của tool bash) tạo PID namespace. Pod Security Admission mức baseline/restricted sẽ chặn.
4. **Địa chỉ worker.** Orchestrator nối tới `127.0.0.1:<HostPort>`; chỉ đúng khi cùng host với Docker daemon. Trên k8s worker có IP riêng.
5. **Trạng thái cục bộ.** Warm pool, `tar` archive trên đĩa local, bind mount trên đĩa node: không an toàn khi chạy nhiều replica orchestrator hoặc pod bị reschedule sang node khác.

## 4. Các phương án

### A. Giữ nguyên thiết kế, chạy orchestrator + Docker trên VM (ít việc nhất)
- Một VM (hoặc vài VM) chạy Docker, orchestrator và các worker; gateway, Redis, MariaDB có thể nằm ở k8s hoặc cùng VM.
- Scale = thêm VM; cần thêm cơ chế chọn VM (hiện một orchestrator quản một Docker daemon).
- Không cần sửa code. Cần: `WORKER_IMAGE` có trong registry mà VM kéo được, thư mục `dshHome` / `archiveDir` bền, biến môi trường Mongo/Redis/DB trỏ về dịch vụ của k8s.
- Hạn chế: không tận dụng được scheduler/autoscaler của k8s.

### B. Orchestrator tạo Pod qua Kubernetes API (hướng lâu dài)
Thay tầng `docker.ts` bằng client k8s (`@kubernetes/client-node`):

| Hiện tại | Bản k8s |
|---|---|
| `createContainer`/`start` | `createNamespacedPod` (label `fox-harness.role=worker`, `fox-harness.session=<id>`) |
| `stop`/`remove` | `deleteNamespacedPod` |
| bind mount `dshHomeDir` → `/data` | PVC (ReadWriteOnce) mỗi session, hoặc `emptyDir` + đẩy snapshot lên S3 khi hibernate |
| `127.0.0.1:HostPort` | `pod.status.podIP:4001` (hoặc Service headless) |
| `Memory/NanoCpus/PidsLimit` | `resources.limits`, `securityContext`, LimitRange/ResourceQuota của namespace |
| warm pool | Pod chờ sẵn gắn label `pool=warm`; claim = patch label |
| container sống? (`isRunning`) | đọc `pod.status.phase` + readiness probe |
| sweep/archive (`tar` local) | snapshot PVC hoặc tar lên S3 (gateway đã có S3) |

Yêu cầu hạ tầng:
- ServiceAccount cho orchestrator với Role (không phải ClusterRole) trong namespace worker: `pods` get/list/watch/create/delete/patch, `persistentvolumeclaims` nếu dùng PVC.
- NetworkPolicy: chỉ orchestrator/gateway được nối tới cổng 4001 của worker; worker chỉ ra được tới LLM, Dremio, Mongo cần thiết.
- Quyết định về `SYS_ADMIN` (xem mục 5).
- StorageClass cấp được PVC RWO, hoặc chấp nhận emptyDir + S3.

Orchestrator trở thành stateless hơn (trạng thái ở Redis + k8s API), nên có thể chạy nhiều replica nếu thêm khóa (Redis lock) cho claim warm pool và `ensure`.

Phạm vi sửa: `docker.ts` (viết lại), `ensure.ts`, `warmpool.ts`, `sweep.ts`, `archive.ts`, `config.ts`, kèm test và manifest. Ước lượng sơ bộ vài ngày đến khoảng một tuần, chưa tính xử lý sandbox.

### C. Docker-in-Docker / sidecar privileged (không khuyến nghị)
Chạy được nhanh nhưng đặt Docker daemon privileged trong pod, trong khi hệ thống chạy code do model sinh ra cho nhiều user. Rủi ro thoát container cao; thường bị team bảo mật từ chối.

## 5. Vấn đề riêng: sandbox `bwrap` cần SYS_ADMIN

Tool bash trong worker dùng `bwrap` để tự giới hạn, và việc này cần `CAP_SYS_ADMIN` cho worker (xem comment trong `docker.ts`). Trên k8s có các lựa chọn:
- Cho namespace worker mức Pod Security `privileged` hoặc ngoại lệ riêng, cô lập bằng NetworkPolicy và node pool riêng.
- Dùng runtime sandbox (gVisor, Kata) cho pod worker — cô lập ở tầng runtime, có thể bỏ `bwrap`.
- Đổi cách sandbox sang cơ chế không cần SYS_ADMIN (cần đánh giá lại tool bash; hiện hệ thống fail-closed `SANDBOX_UNAVAILABLE` nếu không có).

Phải được team hạ tầng/bảo mật đồng ý trước khi chọn hướng B.

## 6. Câu hỏi cần hỏi team hạ tầng trước khi chọn

1. Cluster dùng runtime nào (containerd/Docker)? Có VM riêng chạy Docker được không?
2. Có cho một namespace riêng chạy pod privileged / `SYS_ADMIN` không? Có gVisor/Kata không?
3. StorageClass nào cấp PVC RWO? Giới hạn dung lượng mỗi session?
4. Có cho tạo/xóa Pod bằng ServiceAccount trong namespace riêng không?
5. Egress từ worker: được phép tới những đâu (LLM gateway, Dremio, Mongo, Meilisearch)?
6. Registry nội bộ cho image `fox-harness-worker`?

## 7. Khuyến nghị

- **Ngắn hạn (staging):** hướng A — VM chạy Docker + orchestrator, các dịch vụ còn lại ở k8s.
- **Dài hạn (multi-user, autoscale):** hướng B, bắt đầu sau khi có câu trả lời mục 6, đặc biệt câu 2 (SYS_ADMIN) và câu 3 (lưu trữ).
- Tránh hướng C.

## 8. Việc cần làm nếu chọn B (checklist)

- [ ] Tách interface `WorkerRuntime` (spawn / remove / isRunning / address / listByLabel) khỏi `docker.ts`, giữ bản Docker làm mặc định để dev local không đổi.
- [ ] Cài đặt `K8sWorkerRuntime` với `@kubernetes/client-node`.
- [ ] Lưu trữ `/data`: PVC hoặc emptyDir + snapshot S3; viết lại hibernate/restore/purge.
- [ ] Warm pool dựa trên label + khóa Redis chống claim trùng.
- [ ] RBAC, NetworkPolicy, ResourceQuota, LimitRange, manifest Deployment cho orchestrator (`infra/deploy/`).
- [ ] Quyết định sandbox (mục 5).
- [ ] Test e2e trên cluster staging: spawn, kill, hibernate/restore, sweep, nhiều user song song, orchestrator restart giữa chừng.
