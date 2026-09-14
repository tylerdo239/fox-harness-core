# Chat log + attachment lên object storage (S3) — chiến lược, không phải code chạy được

> **Đã build thật, khác case** (2026-09-14): `custom_skills.content`
> (`services/gateway/src/db.ts`) đã thật sự chuyển lên S3 —
> `services/gateway/src/object-storage.ts`, `@aws-sdk/client-s3` trực
> tiếp, KHÔNG qua interface `dsh` (`SessionPersistence`/`AttachmentStore`)
> nào cả. Đơn giản hơn nhiều so với 2 case doc này bàn (chat log, ảnh) —
> không event-sourced, không torn-tail, không content-addressed, chỉ 1 key
> ổn định theo `(owner_id, name)`, ghi đè khi sửa. Local dev dùng MinIO
> (`infra/docker/docker-compose.dev.yml`); code không khoá cứng AWS —
> production đổi `.env` là đủ. Xem migration comment trong
> `infra/migrations/001_init.sql` (cột `content_key`) để biết chi tiết.

Roadmap §1.2 đã ghi từ đầu dự án: `Stores: Postgres · Redis · Log store
(object storage)` — mục này chưa từng được build, chỉ dừng ở phần local-disk
(xem `docs/agent-core-architecture-roadmap.md`). Trigger cho doc này
(2026-09-09): thảo luận về giới hạn thật của thiết kế 1-host-1-đĩa (không
backup, không multi-node — xem `docs/code-rules.md`'s mục liên quan cùng
ngày), user hỏi "nếu muốn lưu log chat lên S3 luôn và có sẵn cổng lưu ảnh/
file thì sao" — quyết định: **chưa cần làm ngay, chỉ ghi lại đường đi thật
để không mất context khi cần**.

## Hiện trạng thật (đã build) — không phải giả định

- **Chat log**: `@deepseek-ai/dsh-session-persistence-jsonl`, ghi ra
  `dshHomePath('sessions')` — đĩa cục bộ của host chạy container đó
  (`docs/reference/dsh-web-profile-dump-config.yml:72-75`). Xem
  `docs/code-rules.md`'s mục về nơi lưu lịch sử chat (2026-09-09) — đường
  thật đã xác nhận: `data/dsh-home/<sessionId>/sessions/--repo--/<sessionId>/session.jsonl.zstd`.
- **Ảnh đính kèm**: `@deepseek-ai/dsh-attachment-local` — cũng đĩa cục bộ,
  chưa từng verify đường dẫn thật trong dự án này (chưa có tính năng upload
  ảnh nào ở FE dùng tới nó tính tới nay).
- Cả 2 đều KHÔNG có bản S3 chính thức từ `@deepseek-ai/*` (xác nhận thật
  qua `npm view`/`npm search` 2026-09-09 — 404, không tồn tại trên
  registry). Chỉ có: `dsh-session-persistence-jsonl`, `dsh-session-persistence-sqlite`
  (chat log) và `dsh-attachment-local` (ảnh) — không có biến thể object
  storage nào sẵn.

## 2 interface trừu tượng thật — đây LÀ điểm swap, không phải phát minh mới

Cả 2 đều là Cordis `Service` abstract class thật (đọc trực tiếp `.d.ts` đã
cài, không đoán), nghĩa là dự án này chỉ cần viết 1 package implement đúng
class đó và insert vào `cordis.patch.yml` thay cho bản `-local`/`-jsonl` —
đúng mô hình adapter đã làm cho `dsh-llm-openai-compat`/
`dsh-tool-duckduckgo-web-search`, KHÔNG cần sửa `packages/core`/
`agent-driver` gì cả.

### `SessionPersistence` (`@deepseek-ai/dsh-session-persistence`)

Phức tạp hơn "ghi JSON lên S3" nhiều — đây là 1 event-sourced append-only
log thật, với các ràng buộc phải giữ đúng:

- `append(id, events)` — batch phải append-only, `seq` đầu tiên PHẢI khớp
  next-seq đã lưu (không cho ghi đè/ghi nhảy cóc).
- `load(id)` — phải tự phục hồi 1 "torn tail" (turn cuối bị cắt ngang do
  crash) bằng cách đóng nó lại với synthetic tool-error, KHÔNG được ghi đè
  phần đã commit.
- `listSnapshots()` — cần trả về "opaque revision" đổi mỗi khi log đổi, để
  caller biết khi nào cần đọc lại — với S3 không có counter tự nhiên như
  SQLite, cần tự thiết kế (ETag của object, hoặc version id nếu bật S3
  Versioning, là ứng viên tự nhiên nhất).
- `readFrom(id, fromSeq)` — đọc suffix từ 1 seq cụ thể; S3 không seek được
  theo offset thật rẻ như SQLite nên vẫn phải tải + parse toàn bộ object
  rồi cắt, giống hệt cách JSONL hiện tại đã làm (không phải điểm yếu MỚI do
  S3, chỉ là không cải thiện được đặc tính này).

**Đánh đổi thật cần cân nhắc:** mỗi `append()` (chạy MỖI event trong turn,
tần suất cao khi model đang stream) giờ là 1 network call tới S3 thay vì
ghi đĩa cục bộ — cần viết-gộp-theo-batch (buffer + flush theo interval hoặc
theo kích thước) để không tạo hàng nghìn `PutObject` nhỏ mỗi turn dài, kèm
retry/backoff thật cho lỗi mạng tạm thời (S3 SDK có sẵn, không cần tự viết).

### `AttachmentStore` (`@deepseek-ai/dsh-attachment`)

**Chỉ dành cho ẢNH** (`image/png|jpeg|webp|gif`), KHÔNG phải "file bất kỳ"
— nếu ý định thật là lưu file tổng quát (PDF, docx, ...) thì interface này
KHÔNG áp dụng, cần 1 cơ chế khác hoàn toàn (dsh không có sẵn "file đính kèm
tổng quát" nào khác đã cài trong dự án này — cần khảo sát riêng nếu tới
lúc cần thật, ngoài phạm vi doc này).

- Content-addressed: `saveImage()` trả về `ImageAttachmentRef` có
  `attachmentId` (opaque, "never a filesystem path or bearer URL") —
  backend S3 tự map `attachmentId` → S3 key, không lộ path/URL thật ra
  ngoài.
- `readImage()` phải verify bytes đọc về khớp đúng reference đã lưu (hash
  check) trước khi trả — không phải đọc thẳng-trả-thẳng.
- Batch validate-trước-khi-ghi-bất-kỳ-cái-nào (`validateImageBatch`) — 1
  ảnh lỗi trong batch thì không ảnh nào được ghi.

## Khi nào việc này thật sự cần (không phải "nên làm cho chắc")

Nối lại đúng kết luận đã thảo luận cùng ngày (`docs/code-rules.md`): thiết
kế local-disk hiện tại **chưa phải vấn đề** khi prod còn 1 VM duy nhất.
Object storage trở thành THẬT SỰ CẦN khi 1 trong các case sau xảy ra, không
phải trước đó:

1. Cần ≥2 host chạy `services/orchestrator` (vượt sức chứa 1 VM) — object
   storage là store dùng chung duy nhất mọi node đọc/ghi được, local disk
   thì không.
2. Cần backup/HA thật cho nội dung chat (hiện tại: mất đĩa VM = mất log
   vĩnh viễn, không có bản sao nào).
3. Có tính năng upload ảnh thật ở FE cần dùng tới `dsh-attachment` (hiện
   tại dự án CHƯA có tính năng này ở bất kỳ đâu — `AttachmentStore` đang
   không được dùng tới dù đã cài sẵn trong dependency tree qua `dsh-base`).

## Việc cần làm khi tới lúc (khung sườn, chưa phải kế hoạch chi tiết)

1. Viết `@fox-harness/dsh-session-persistence-s3` — implement đủ 9 method
   abstract của `SessionPersistence` (xem danh sách ở trên), dùng
   `@aws-sdk/client-s3` (hoặc SDK tương thích S3 API nếu dùng MinIO/dịch vụ
   khác không phải AWS thật — object storage API là chuẩn de-facto, không
   khoá cứng vào AWS).
2. Viết `@fox-harness/dsh-attachment-s3` — implement `AttachmentStore`,
   content-addressed key scheme (vd `sha256(bytes)` làm S3 key, tự dedup
   miễn phí).
3. Thêm cả 2 vào `packages/profile-template/template/cordis.patch.yml`
   thay cho `session-persistence-jsonl`/`attachment-local` (chỉ cần đổi
   `disabled: true/false` + entry mới, đúng cơ chế cordis.patch.yml đã có
   sẵn — không đụng `materialize.ts`/`packages/core` gì cả).
4. Thêm config mới: `S3_BUCKET`/`S3_REGION`/credentials (qua
   `workerEnvPassthrough`, `services/orchestrator/src/config.ts`, đúng cách
   `OPENAI_API_KEY` đã forward vào container hiện tại).
5. Verify thật: 1 session thật ghi log qua S3, kill -9 container giữa
   chừng, rehydrate — xác nhận `load()`'s torn-tail recovery hoạt động
   đúng qua S3 (không chỉ qua đĩa cục bộ như Phase 3 đã test) — đây là
   test quan trọng nhất, vì torn-tail recovery là invariant §0.4 cả dự án
   dựa vào.
6. Benchmark latency `append()` thật khi model đang stream nhanh — xác
   nhận buffer/batch-write đủ để không làm turn bị chậm thấy rõ so với ghi
   đĩa cục bộ hiện tại.

## Phạm vi doc này (nhắc lại)

Chỉ ghi lại đường đi kỹ thuật thật đã xác nhận (interface, gap, đánh đổi) —
KHÔNG code, KHÔNG chọn nhà cung cấp S3 cụ thể, KHÔNG cam kết thời điểm làm.
Dùng lại khi có nhu cầu thật (1 trong 3 case ở mục "khi nào cần" xảy ra).
