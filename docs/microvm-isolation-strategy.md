# Siết isolation xuống microVM — chiến lược, không phải code chạy được

Phase 6 checklist item 5 (`docs/agent-core-architecture-roadmap.md`).
**Quyết định phạm vi (2026-09-07, theo yêu cầu user):** mục này CHỈ viết
thiết kế/migration plan thật kỹ, KHÔNG code chạy được lần này — Firecracker
cần bare-metal Linux + `/dev/kvm`, máy dev đang dùng (Docker Desktop trên
macOS) không có, và cố gắng gán nó vào Docker Desktop là canh bạc effort
không xứng đáng cho một máy sẽ không bao giờ chạy production thật. 4 mục còn
lại của Phase 6 (quota, telemetry, upgrade strategy, log retention) đã có
code + test thật — xem `docs/code-rules.md`'s Phase 6 entry.

## Vì sao mục này tồn tại (nhắc lại, không đoán)

Quyết định Phase 0 đã chốt (`docs/code-rules.md`, [[fox-harness-phase0-decisions]]
trong memory): **plugin của user chạy code tùy ý**, in-process, full quyền
trên `ctx`. Hệ quả bắt buộc: mỗi user một container/microVM riêng — điều này
roadmap tự gọi là *"rủi ro lớn nhất của cả dự án"*.

## Hiện trạng thật (đã build, Phase 3) — không phải giả định

Đọc thẳng `services/orchestrator/src/docker.ts` hiện tại:

- **1 `runc` container Docker chuẩn / session**, tạo mới hoàn toàn mỗi lần
  spawn/rehydrate — không bao giờ tái dùng container cũ (đúng nguyên tắc
  "state chỉ từ log", đã verify ở Phase 3).
- **Không có gì khác được siết**: `HostConfig` hiện tại KHÔNG đặt
  `Memory`/`CpuShares`/resource limit nào, KHÔNG có `User` (chạy như root
  trong container, theo default của image — `infra/docker/worker/Dockerfile`
  không có dòng `USER`), KHÔNG có `SecurityOpt` tuỳ chỉnh (seccomp/apparmor
  = default Docker). Đây là baseline THẬT đang chạy hôm nay, không phải ước
  lượng.
- Điều này đã đủ cho rủi ro "plugin A đọc/ghi state của plugin B" (mỗi
  session process riêng biệt hoàn toàn) nhưng KHÔNG đủ cho rủi ro "plugin
  thoát khỏi container qua lỗ hổng kernel" — `runc` container chia sẻ chung
  kernel host với mọi container khác trên máy. Đây chính là khoảng trống
  microVM/gVisor thật sự đóng lại, không phải một rủi ro tưởng tượng.

**Việc rẻ, không phải microVM, đáng làm SỚM hơn** (ghi nhận, không tự làm
lần này — ngoài phạm vi câu hỏi Phase 6 mục 5, nhưng liên quan trực tiếp và
rẻ hơn hẳn): thêm `USER node` vào Dockerfile (chạy non-root) và
`HostConfig.Memory`/`NanoCpus` (chặn 1 plugin ăn hết RAM/CPU của host) vào
`docker.ts`'s `spawnWorker()`. Cả hai không cần hạ tầng gì mới, chạy được
ngay trên máy dev này — khác hẳn phần microVM bên dưới.

## Hai lựa chọn thật, đánh giá bằng chi phí migration thật

### A. Firecracker (AWS) — true hardware-virtualized microVM

- VMM tối giản dùng KVM, boot guest kernel Linux thật trong ~125ms. Đây là
  công nghệ AWS Lambda/Fargate dùng thật cho multi-tenant.
- **Yêu cầu hạ tầng**: host Linux bare-metal (hoặc VM có nested virtualization
  bật) với quyền truy cập `/dev/kvm`, build pipeline riêng cho rootfs +
  kernel image guest, thiết lập network qua TAP device, và một control layer
  (`firecracker-containerd` hoặc tự viết jailer/API call) — **không có API
  tương thích Docker Engine**, nghĩa là `dockerode` hiện tại trong
  `docker.ts` không dùng lại được nguyên si.
- **Chi phí migration**: thay TOÀN BỘ tầng container runtime — từ
  `dockerode` + Docker Engine sang `firecracker-containerd` (ít nhất) hoặc
  raw Firecracker API + jailer (nhiều nhất). `spawnWorker`/`removeWorker`/
  `waitUntilReachable` trong `docker.ts` phải viết lại gần như từ đầu.
  Đây là việc lớn hơn hẳn 1 lần đổi runtime.

### B. gVisor (Google, `runsc`) — user-space syscall interception

- Một OCI-compatible container runtime (drop-in `--runtime=runsc` cho
  Docker/containerd) — chặn syscall ở user-space bằng 1 "guest kernel" viết
  bằng Go, không boot kernel Linux thật.
- Hai platform: `ptrace` (không cần KVM, overhead syscall cao hơn) và `kvm`
  (nhanh hơn, cần hardware virt). Google dùng thật cho GKE Sandbox, Cloud
  Run.
- **Chi phí migration**: THẤP so với A, vì vẫn là OCI runtime sau
  `dockerode`/Docker Engine API — `services/orchestrator/src/docker.ts` chỉ
  cần thêm 1 field `Runtime: 'runsc'` vào `HostConfig` khi `createContainer`
  (Docker Engine đã hỗ trợ chọn runtime per-container natively, không cần
  đổi code gọi Docker Engine API nào khác). Toàn bộ model spawn/hibernate/
  rehydrate/warm-pool hiện có GIỮ NGUYÊN.

### Khuyến nghị: gVisor trước, Firecracker chỉ khi gVisor không đủ

Chi phí migration của B thấp hơn A một bậc rõ rệt, mà vẫn đóng đúng khoảng
trống thật (syscall interception, không chia sẻ kernel thật với host) —
không cân xứng để nhảy thẳng lên chi phí thay toàn bộ runtime (A) khi chưa
chứng minh được B không đủ. Chỉ leo lên Firecracker khi có bằng chứng thật
gVisor không đủ (một lỗ hổng escape thật được tìm thấy, hoặc yêu cầu compliance
đòi hardware-enforced isolation) — không phải vì Firecracker "nghe an toàn
hơn" trên giấy.

## Rủi ro kỹ thuật cụ thể cần test TRƯỚC khi đổi default runtime

**`node-pty` — một điểm nghi ngờ THẬT, không phải suy đoán chung chung.**
Dự án này đã từng gặp thật 1 lỗi tương thích native-module nghiêm trọng với
`node-pty` (Alpine/musl không có prebuild hoạt động, phải đổi hẳn base image
sang Debian — `docs/code-rules.md` §17 bug #3). `node-pty` dùng nhiều
syscall liên quan pty/ioctl khá đặc thù; gVisor's syscall interception (đặc
biệt platform `ptrace`) có lịch sử thật về việc KHÔNG hỗ trợ đầy đủ mọi
syscall/ioctl một chương trình Linux thông thường mong đợi. Đây là rủi ro
tương thích CỤ THỂ, không phải rủi ro chung "container khác có thể có bug" —
phải test thật `node-pty` (và mọi tool dùng subprocess/pty khác trong
`dsh-base`) chạy dưới `runsc` trước khi coi đây là xong.

## Kế hoạch migration cụ thể (khi có máy Linux thật để làm)

1. Cài `runsc` trên Docker host thật (không phải Docker Desktop macOS — cần
   Linux thật, bare-metal hoặc VM có `/dev/kvm` nếu dùng platform `kvm`).
2. Đăng ký runtime trong Docker daemon (`/etc/docker/daemon.json`):
   ```json
   { "runtimes": { "runsc": { "path": "/usr/local/bin/runsc" } } }
   ```
3. Thêm 1 field config mới `WORKER_RUNTIME` (`services/orchestrator/src/config.ts`,
   mặc định `""` = giữ nguyên `runc`, không đổi hành vi hiện tại cho ai chưa
   cấu hình) và truyền vào `HostConfig.Runtime` trong `docker.ts`'s
   `spawnWorker()` khi được set — đây là TOÀN BỘ thay đổi code cần cho
   phương án B, cực nhỏ so với phương án A.
4. **Test tương thích trước khi đổi default**: build lại
   `fox-harness-worker:dev`, chạy với `WORKER_RUNTIME=runsc`, xác nhận
   `node-pty`/subprocess/bash tool vẫn hoạt động thật (không chỉ boot được —
   phải chạy thật 1 lệnh qua sandbox tool, xem rủi ro ở trên).
5. Benchmark cold-start latency `runsc` so với `runc` — gVisor cộng thêm
   overhead boot; cảnh báo cho warm-pool (`services/orchestrator/src/warmpool.ts`)
   nếu overhead đủ lớn để đổi giả định "warm pool che cold start".
6. Rollout dần: canary theo % session mới trước, không cutover cứng toàn bộ
   fleet cùng lúc — dùng đúng cơ chế `profileVariant`-style lever đã có tiền
   lệ ở Phase 4 làm mẫu thiết kế (không phải tái dùng field đó, chỉ tái dùng
   Ý TƯỞNG "gate bằng 1 field test-only trước khi làm default").
7. Chỉ sau khi (4)-(6) xanh hết mới đổi `WORKER_RUNTIME` mặc định thật.

## Khi nào leo lên Firecracker thật

Chỉ khi (a) gVisor's syscall interception bị chứng minh không đủ bằng 1
lỗ hổng escape thật, hoặc (b) yêu cầu compliance đòi hardware-enforced
isolation không thể thoả bằng user-space interception. Tại thời điểm đó,
đường đi thực tế nhất là `firecracker-containerd` (vẫn tương thích
containerd/OCI ở một mức, ít việc viết lại hơn raw Firecracker + jailer tự
chế) — không phải viết control plane Firecracker riêng từ đầu.
