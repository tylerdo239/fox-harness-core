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
2. **Chạy baseline TRƯỚC khi bump**, trong `api/`:
   - `node scripts/agent-loop-parity.mjs`: cùng kịch bản chạy qua vòng lặp gốc `dsh-agent-loop` và qua
     `agent-driver`, so từng request gửi cho LLM (system prompt, danh sách tool, từng message). Phải ra
     `agent-driver matches dsh-agent-loop`.
   - e2e: `cd scripts && pnpm install`, rồi `scripts/e2e-up.sh` + `node scripts/e2e-backend.mjs`, đủ 19/19.
   Nếu baseline đã fail sẵn thì không biết lỗi nào do bump gây ra.
3. Sửa version trong `api/package.json` và mọi `api/packages/**/package.json` có khai package đó, chạy
   `pnpm install` trong `api/`.
4. `pnpm run build` trong `api/`. Bump thường vỡ ở đây trước (lệch type), rẻ hơn phát hiện lúc chạy.
5. Chạy lại `agent-loop-parity.mjs`. Có `DIFF` nghĩa là vòng lặp gốc đã đổi hành vi mà `agent-driver` chưa
   theo; sửa driver cho tới khi khớp, **không** bỏ qua.
6. Build lại image backend và chạy lại e2e 19/19, rồi thử LLM thật trên stack local (3 flow).
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
