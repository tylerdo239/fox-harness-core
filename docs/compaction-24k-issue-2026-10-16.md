# Tràn context khi model viết output dài (cửa sổ 24k) — 16/10/2026

Flow data-analysis, model Qwen 3.5 35B, `OPENAI_CONTEXT_WINDOW=24000`. Sửa một phần trong commit `cd7ee26`;
phần còn mở ở cuối.

## Triệu chứng

Giao một task nặng (phân tích xong rồi viết báo cáo dài): model làm xong phần phân tích, đến lúc viết báo
cáo thì tràn context, dù đã có compact.

## Tái hiện

Một chat, 4 lượt: viết báo cáo ≥2000 từ về `sales.csv` trong canvas → báo cáo khác về `orders.xlsx` →
báo cáo so sánh → tóm tắt. Token đọc từ `usage` thật trong log phiên
(`/data/dsh-home/sessions/<cwd>/<session>/session.jsonl.zstd`).

Trước khi sửa, bước 3.1: prompt **18,4k** + output **8,0k** = **26,4k > 24k**. Không lỗi chỉ vì server vLLM
thật cho phép hơn 24k; với server đúng 24k, request bị từ chối hoặc báo cáo bị cắt giữa chừng.

## Nguyên nhân

Tràn = prompt cao **và** một lần sinh output rất dài, cùng lúc. Riêng prompt chưa lần nào vượt 24k.

1. **Output một lần quá dài.** Báo cáo nằm trong tham số `canvas_write(content=…)` (hoặc một cell python),
   nên model sinh cả báo cáo trong một bước: 8–13,5k token (tiếng Việt ~2,7 ký tự/token).
2. **Compact chỉ chạy trước mỗi bước** (ngưỡng 0,7 × 24k = 16,8k). Prompt 16,5k không kích hoạt compact,
   chỉ còn 7,5k cho output. Đang sinh thì không ai chen vào được.
3. **Phần cố định lớn:** system prompt + mô tả tool + danh mục skill = **7,45k** token. Sau mỗi lần compact
   prompt vẫn ~12–13k, nên hạ ngưỡng thì compact chạy ở mọi bước và model quên tiến độ (làm lại việc cũ).
4. **Báo cáo cũ nằm lại trong context** dưới dạng tham số tool call. Compact luôn giữ phần mới nhất nên không
   nén được nó ("summary is not smaller than the shadowed content"), và khi tràn thật thì chính request tóm
   tắt cũng vượt cửa sổ.
5. **Tóm tắt bịa yêu cầu:** một checkpoint ghi "user's 'kiểm tra lại giúp tôi' request" — câu ví dụ trong
   mô tả skill `kiem-tra-truoc-khi-gui`. Model rà lại báo cáo tới khi chạm giới hạn 25 bước.
6. Bộ đếm token ước lượng phần mới thêm theo 4 ký tự/token (`dsh-token-meter`), tiếng Việt thực tế ~2,7.

## Đã sửa (`cd7ee26`)

| Thay đổi | Chỗ |
|---|---|
| Phần cố định 7,45k → 5,56k token: ẩn hướng dẫn của tool bị ẩn (bash, jobs, goal, workflow, ralph); mô tả `canvas_write` 4.200 → 1.000 ký tự; mô tả 14 skill 5.132 → 1.768 ký tự | `agent-core/src/transport/flows.ts`, `tool/canvas`, `*/skills/*/SKILL.md` |
| Ẩn `edit` khỏi data-analysis (model sửa thẳng file canvas, panel không có phiên bản mới) | `flows.ts` |
| Hướng dẫn viết báo cáo dài từng phần trong python, `save_artifact()`, rồi `canvas_write` với `path` | mô tả `canvas_write`, prompt data-analysis, skill `report-writing` |
| Ngưỡng compact 0,7 → 0,6 (chừa ~9,6k cho output, bù đếm thiếu) | `profile-template/runtime/template/cordis.patch.yml` |
| `fitMessages()`: cắt khối dài (giữ đầu + cuối) trước khi gửi đi tóm tắt, để request tóm tắt luôn vừa cửa sổ | `flow/data-analysis/src/compaction.ts` |
| Checkpoint: "Requests" chỉ lấy từ tin nhắn thật của người dùng; không chép system prompt | `compaction.ts` |

Thử rồi bỏ: thu gọn ngay mọi bước có tham số > 4.000 ký tự. Nó thu gọn cả cell python, model không thấy
code để sửa lỗi nên viết lại nhiều lần (45–68 bước/kịch bản thay vì ~20).

Kết quả sau sửa: 21 bước, không lượt nào chạm giới hạn, model vẫn nạp đúng skill. Bench 52 bài × 3:
107/134 lượt hợp lệ, ngang các báo cáo trước (smoke 12/12, full 8/8, hard 30/31, dabx 52/60, dabstep 3/21).

## Còn mở

- **Vẫn tràn:** model làm theo phần "dùng `path`" nhưng vẫn hay viết cả báo cáo trong **một** cell python
  (20–35k ký tự, ~10k token), nên đỉnh vẫn ~27k. Hướng sửa: chặn cứng ở harness — lời gọi
  `python`/`write`/`canvas_write` có tham số > ~8.000 ký tự bị từ chối kèm hướng dẫn chia nhỏ.
- Compact vẫn gọi model rồi thất bại "summary is not smaller" 6–12 lần/kịch bản khi chỉ còn checkpoint cũ
  để nén — nên bỏ qua thay vì gọi.
- Chưa biết `max-model-len` thật của server vLLM. Nếu server lớn hơn 24k thì đặt 24k ở harness chỉ làm
  compact chạy dày hơn.
- Bench chạy liên tục bị gateway chặn ("at most 20 messages per minute"); cần giãn nhịp trong
  `scripts/bench/run.mjs`.
