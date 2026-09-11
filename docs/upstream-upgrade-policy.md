# Chiến lược nâng cấp upstream

Phase 6 checklist item 3 (`docs/agent-core-architecture-roadmap.md`). `dsh`
đang ở developer preview, upstream cảnh báo sẽ có breaking change — tài liệu
này là quy trình thật, không phải một lời hứa suông, để một lần bump version
không âm thầm phá vỡ 1 trong các seam dự án này đang dựa vào.

## Version hiện tại đã pin (không phải khuyến nghị — đã LÀM)

Mọi package `@deepseek-ai/*` trong repo đã pin CHÍNH XÁC (không `^`/`~`),
xác nhận thật bằng `grep`:

```
@deepseek-ai/dsh              0.1.1-rc.2
@deepseek-ai/dsh-agent        0.1.1-rc.2
@deepseek-ai/dsh-session*     0.1.1-rc.2
@deepseek-ai/dsh-system-prompt 0.1.1-rc.2
@deepseek-ai/dsh-llm          0.1.1-rc.2
@deepseek-ai/dsh-tools        0.1.1-rc.2
@deepseek-ai/dsh-launch-environment 0.1.1-rc.2
@deepseek-ai/dsh-credentials  0.1.1-rc.2
@deepseek-ai/cordis           4.0.2
@deepseek-ai/schemastery      3.18.2
```

`pnpm-lock.yaml` thêm 1 lớp khoá nữa (transitive deps cũng cố định). Một
`pnpm install` bình thường sẽ KHÔNG tự nâng version nào trong danh sách này —
chỉ nâng khi có người chủ động sửa `package.json` rồi chạy lại install.

## Quy trình bump 1 version

1. **Đọc changelog/release notes thật của package sắp bump** trước khi sửa
   bất cứ gì — không đoán từ số version. Developer preview có thể đổi API
   không theo semver.
2. **Chạy `scripts/upstream-smoke-test.mjs` TRƯỚC khi bump**, xác nhận cả 4
   check đều PASS trên version hiện tại (baseline — nếu nó đã fail sẵn thì
   không biết được lỗi nào là do bump gây ra).
3. Sửa version trong `package.json` (root + mọi `packages/*/package.json`
   có khai package đó), `pnpm install` lại.
4. `pnpm run typecheck` — bump nhiều khả năng vỡ ở đây trước tiên (type
   mismatch), rẻ hơn hẳn so với phát hiện lúc runtime.
5. Chạy lại `scripts/upstream-smoke-test.mjs`. Bất kỳ check nào FAIL mà
   trước đó PASS = breaking change thật cần xử lý trước khi merge, không
   phải bỏ qua.
6. Chạy thêm (không tự động, thủ công — script không cover, xem chú thích
   trong chính file smoke test):
   - `services/orchestrator/README.md`'s kill -9 + rehydrate test (cần
     Docker + Redis + MariaDB up) — seam containerization/hibernate không
     nằm trong smoke test vì cần hạ tầng nặng hơn 1 script nhanh nên có.
   - `services/plugin-registry/README.md`'s build pipeline (`pnpm add`
     thật) nếu bump động tới `dsh plugin`/bundle resolution.
7. Đọc lại `docs/code-rules.md` — mọi hành vi đã "verified against real
   source" ở đó là giả định đang neo vào ĐÚNG version hiện tại. Một section
   nào bị bump này chứng minh sai thì phải sửa ngay, không để tài liệu nói
   dối.
8. Commit bump + mọi sửa cần thiết CÙNG NHAU, message ghi rõ version cũ →
   mới và lý do bump (feature cần, security fix, hay chỉ theo kịp upstream).

## Vì sao không tự động hoá bump (CI cron, Renovate, ...)

Developer preview + breaking change cảnh báo trước (roadmap "Trạng thái
upstream") nghĩa là một bump tự động không người review có thể âm thầm đưa
vào 1 thay đổi hành vi seam nào đó mà smoke test không phủ hết (xem "NOT
covered" trong chính file script). Quy trình này CỐ Ý thủ công — chi phí
thấp hơn hẳn debug 1 breaking change đã lọt vào production.

## Danh sách seam đang phụ thuộc (để biết bump nào đáng lo)

Tham chiếu nhanh — không lặp lại chi tiết, xem đúng phần `docs/code-rules.md`
đã ghi khi verify từng cái:

| Seam | Gói | Chi tiết |
|---|---|---|
| Turn/step event contract | `dsh-agent` | §3 |
| Patch override-by-id vs. insert | `dsh-app-boot` (qua `dsh` CLI) | §4, §17 |
| Live-reload watch `cordis.patch.yml` | `cordis-plugin-hmr` | §17, §20 |
| `resolveBundleDir` 2-anchor resolution | `dsh-app-boot` | §17, §19 |
| Session checkpoint timing (lazy, next-request) | `dsh-session-checkpoint-policy` | §17 |
| Session persistence/resume API | `dsh-session-persistence`, `dsh-agent` | §17 |
| Self-registration client manifest (KHÔNG scan `dsh.client`) | thiết kế riêng dự án, không phải seam upstream | §18 |
| `dsh.client`/`dsh.bundle` package.json shape | `dsh-app-boot` | §0.2 |

Một bump chạm bất kỳ package nào ở cột "Gói" phía trên đáng được review kỹ
hơn mức "chạy smoke test rồi merge" — đọc lại đúng section liên quan trước.
