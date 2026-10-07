# Lưu session log lên S3 (2026-10-07)

## Quyết định

| #   | Câu hỏi              | Chốt                                                                                          |
| --- | -------------------- | --------------------------------------------------------------------------------------------- |
| 1   | Giữ bao lâu          | 12 tháng kể từ lần ghi cuối (quy tắc vòng đời S3 trên prefix `sessions/`)                      |
| 2   | Audit hay quyền xoá  | **Quyền xoá**: không Object Lock; xoá hội thoại → xoá mọi bản (cả mọi phiên bản) trên S3      |
| 3   | Mã hoá, quyền        | Mã hoá phía server (`S3_SSE`), bucket riêng tư, chỉ backend có key                           |
| 4   | Bucket               | Dùng chung bucket với skill, prefix `sessions/`                                               |

## Thiết kế

Đĩa (`/data/dsh-home/sessions/...`) vẫn là bản làm việc của dsh; S3 là bản lưu trữ.

| Việc                 | Cách                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Đẩy lên              | Gateway quét định kỳ (`SESSION_ARCHIVE_INTERVAL_MS`, mặc định 2 phút) và khi tắt: file đổi (thời gian sửa/kích thước) và đã đứng yên vài giây → `PutObject` |
| Khoá                 | `sessions/<ownerId>/<sessionId>/<thư mục dsh>/<file>` — xoá cả phiên = xoá một prefix                                     |
| Đã đẩy gì            | Redis hash `fh:session-archive` (mất Redis → đẩy lại một lần, không hại)                                                  |
| Dọn đĩa              | File không đổi quá `SESSION_LOCAL_RETENTION_DAYS` (mặc định 30) **và** đã có bản trên S3 → xoá khỏi đĩa                     |
| Mở lại               | WebSocket mở lại một hội thoại mà đĩa không còn log → tải từ S3 về trước khi runtime đọc                                  |
| Xoá (purge)          | Như cũ + xoá mọi object và mọi phiên bản dưới prefix của phiên                                                            |
| Giữ 12 tháng         | Lúc khởi động, gateway thêm (không ghi đè rule khác) rule vòng đời `fox-session-retention`: hết hạn 365 ngày sau lần ghi cuối; phiên bản cũ hết hạn sau 1 ngày. Không có quyền → log cảnh báo, đội vận hành đặt tay |
| Mã hoá               | `S3_SSE=AES256` (hoặc `aws:kms`) áp cho object session; để trống ở dev (MinIO không có KMS)                                |
| Tắt tính năng        | `SESSION_ARCHIVE=0`                                                                                                       |

Phiên hết hạn trên S3 sau 12 tháng mà đĩa cũng không còn → mở lại báo không tìm thấy hội thoại.

## Mã nguồn

| File                                                  | Nội dung                                                                    |
| ----------------------------------------------------- | --------------------------------------------------------------------------- |
| `api/services/gateway/src/runtime/session-archive.ts` | quét/đẩy, dọn đĩa, tải về khi mở lại, xoá, khởi động/tắt                    |
| `api/services/gateway/src/object-storage.ts`          | put/list/get, xoá mọi phiên bản dưới prefix, thêm rule vòng đời             |
| `api/services/gateway/src/redis.ts`                   | dấu đã đẩy (`fh:session-archive`)                                           |
| `api/services/gateway/src/index.ts`                   | bật khi khởi động, quét lần cuối khi tắt, tải về trước khi mở lại WebSocket |
| `api/services/gateway/src/runtime/sessions.ts`        | purge xoá luôn bản trên S3                                                  |

## Kiểm thử (2026-10-07)

- e2e `sessionArchive` (PASS): chat → object có trên S3 → rule `fox-session-retention` (`sessions/`, 365 ngày) có trên
  bucket → xoá log khỏi đĩa → mở lại đủ lịch sử (turn 1, 2) → purge → không còn object/phiên bản nào.
- Dọn đĩa: lùi mtime log về 40 ngày trước → lần quét sau xoá khỏi đĩa (`evictedFromDisk: 1`).
- Toàn bộ 23 e2e pass (`E2E_SANDBOX_MODE=none`).
