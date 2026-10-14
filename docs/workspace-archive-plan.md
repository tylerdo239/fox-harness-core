# Lưu file làm việc lên S3 (2026-10-14)

Trước đây chỉ log chat được sao lên S3 (`docs/session-archive-plan.md`); file upload và file python/agent sinh ra
chỉ nằm trên đĩa `/data`. Từ 2026-10-14 chúng cũng lên S3, cùng một cách như log chat.

## Quyết định

| #   | Câu hỏi                 | Chốt                                                                                                   |
| --- | ----------------------- | ------------------------------------------------------------------------------------------------------ |
| 1   | S3 là gì                | **Bản chính**: mọi file có trên S3; đĩa là bản làm việc (python, bash đọc file trên đĩa), có thể bị dọn |
| 2   | Thư mục nào             | Thư mục riêng của mỗi chat (`users/<userId>/<sessionId>`) **và** thư mục chung của project (`projects/<projectId>`) |
| 3   | Giữ bao lâu             | Cho tới khi user xoá chat/project. Không có rule vòng đời                                               |
| 4   | Bucket                  | Chung bucket với skill và log chat, prefix `files/`                                                     |

## Thiết kế

| Việc              | Cách                                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Đẩy lên           | Cùng lượt quét với log chat (`SESSION_ARCHIVE_INTERVAL_MS`, mặc định 2 phút, và khi tắt): file đổi (thời gian sửa/kích thước) và đã đứng yên 5 giây → `PutObject` |
| Khoá              | `files/<dirKey>/<đường dẫn trong thư mục>`, `dirKey` = `users/<userId>/<sessionId>` hoặc `projects/<projectId>`                        |
| Không đẩy         | `.dsh/` (skill, ghi lại từ S3 mỗi lần mở chat), `.python-session`, `__pycache__`, `.ipynb_checkpoints`, file tạm (`.<tên>.part`, `.<tên>.restore`, `sources.json.<pid>.<x>`) |
| Có đẩy            | Mọi file khác, kể cả `.fox/sources.json` (danh sách file là nguồn) và `generated/` (kết quả python)                                     |
| File quá lớn      | > `WORKSPACE_ARCHIVE_MAX_FILE_BYTES` (mặc định 100 MB; file được đọc vào RAM để đẩy) → chỉ ở đĩa, log `workspace_archive_too_large`, thư mục đó không bao giờ bị dọn |
| Xoá trên đĩa      | File đã đẩy mà không còn trên đĩa (user xoá, hoặc chat xoá) → `DeleteObject` trên S3                                                   |
| Đã đẩy gì         | Redis hash `fh:workspace-archive:<dirKey>` (đường dẫn → `mtime:size`)                                                                  |
| Dọn đĩa           | Thư mục mà file mới nhất không đổi quá `SESSION_LOCAL_RETENTION_DAYS` (mặc định 30) **và** mọi file đã có trên S3 → đánh dấu `fh:workspace-evicted` rồi xoá cả thư mục |
| Mở lại            | Mở WebSocket một chat cũ: thư mục bị đánh dấu dọn, hoặc rỗng → liệt kê `files/<dirKey>/` và tải về trước khi runtime dùng. API file (`/sessions/:id/files`, `/projects/:id/files`) và promote output cũng tải về nếu thư mục bị đánh dấu dọn |
| Xoá (purge)       | Xoá chat lẻ → xoá thư mục trên đĩa rồi mọi object và mọi phiên bản dưới `files/users/<userId>/<sessionId>/`. Xoá project → như vậy với `files/projects/<projectId>/`. Xoá một chat trong project không đụng thư mục chung (như trước) |
| Mã hoá            | `S3_SSE` như log chat                                                                                                                 |
| Tắt tính năng     | `SESSION_ARCHIVE=0` tắt cả log chat lẫn file làm việc                                                                                 |

Thứ tự khi dọn: đánh dấu trước, xoá sau. Gateway chết giữa chừng thì lần mở sau vẫn tải về. Khi đã đánh dấu, lượt
quét bỏ qua thư mục đó (mở chat ghi `.dsh/` vào lại, không được coi là "file đã bị xoá" để xoá trên S3).

Mất Redis: dấu đã đẩy mất → lượt quét sau đẩy lại một lần (không hại); dấu dọn mất → mở chat thấy thư mục rỗng vẫn
hỏi S3 và tải về.

## Quyền S3 cần

Như log chat: `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject`, `s3:ListBucket` (liệt kê để tải về, và
`HeadBucket` trước khi ghi), `s3:ListBucketVersions` (+ `s3:DeleteObjectVersion` nếu bật versioning) để xoá hẳn.

## Log

| Sự kiện                          | Khi nào                                                                  |
| -------------------------------- | ------------------------------------------------------------------------ |
| `workspace_archive`              | Lượt quét có đẩy / xoá / dọn: `uploaded dirs bytes ms deleted evictedFromDisk` |
| `workspace_archive_failed`       | Có file đẩy/xoá lỗi (1 dòng mỗi lượt, kèm file đầu tiên lỗi)             |
| `workspace_archive_too_large`    | Có file vượt `WORKSPACE_ARCHIVE_MAX_FILE_BYTES`                          |
| `workspace_restored`             | Tải thư mục về từ S3: `dir files bytes ms`                               |
| `workspace_restore_failed`       | Tải về lỗi khi mở chat (chat vẫn mở, thiếu file)                         |

## Mã nguồn

| File                                                    | Nội dung                                                         |
| ------------------------------------------------------- | ---------------------------------------------------------------- |
| `api/services/gateway/src/runtime/workspace-archive.ts` | quét/đẩy/xoá, dọn đĩa, tải về, xoá hẳn                           |
| `api/services/gateway/src/runtime/session-archive.ts`   | một bộ hẹn giờ chạy cả hai lượt quét                             |
| `api/services/gateway/src/object-storage.ts`            | `downloadArchiveObject` (ghi thẳng ra file), `deleteArchiveObject` |
| `api/services/gateway/src/redis.ts`                     | dấu đã đẩy, dấu đã dọn                                           |
| `api/services/gateway/src/index.ts`                     | tải về khi mở WebSocket, ở API file và promote                    |
| `api/services/gateway/src/runtime/sessions.ts`          | purge chat/project xoá luôn bản trên S3                          |

## Kiểm thử (2026-10-14)

- Chạy trực tiếp với MariaDB/Redis/MinIO local: đẩy 3 file (bỏ `.dsh/`, `.part`, `.python-session`) → user xoá 1
  file → S3 xoá theo → lùi thời gian 40 ngày → thư mục rời đĩa → mở lại tải về 2 file → lượt quét sau không đẩy lại
  → xoá hẳn → S3 trống, Redis sạch.
- e2e `workspaceArchive` (PASS, 8 check): chat data-analysis upload `sales.csv` + python ghi `generated/<session>/report.txt`
  → cả hai lên S3, `.dsh/` không lên → xoá thư mục khỏi đĩa → mở lại chat → tải được cả hai qua API file → purge →
  không còn object/phiên bản nào.

## Chưa làm / cần biết

- File > 100 MB không lên S3 (đẩy bằng một `PutObject`, đọc cả file vào RAM). Cần multipart upload nếu phải hỗ trợ.
- Mỗi lượt quét duyệt mọi thư mục làm việc và đọc Redis một lần mỗi thư mục; với rất nhiều chat thì lượt quét dài hơn
  (xem `ms` trong log).
- Chat đang mở mà thư mục của nó vừa bị dọn (không đổi 30 ngày) là trường hợp không chặn; lần mở kế tiếp tải về lại.
