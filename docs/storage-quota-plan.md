# Chống tràn bucket S3 (2026-10-15)

Bucket staging được cấp **12 GB** và **không có quyền lifecycle**, nên S3 không tự xoá gì. Gateway tự giữ cho bucket
không đầy.

Đo trên local (2026-10-15):
- Log chat khoảng 7.5 KB mỗi chat, tức 12 GB chứa khoảng 1.6 triệu chat.
- File upload (CSV) mới là thứ làm đầy bucket: một CSV 19 MB chiếm 98% `files/`.

Vì vậy mọi giới hạn dưới đây chỉ tính **file** (upload và file chat sinh ra), không tính log chat.

## Ba lớp

| Lớp                    | Cách                                                                                                                          | Cấu hình                                                    |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Quota mỗi user         | Trước mỗi upload: tổng file của user (mọi chat và dự án của họ) + cỡ file sắp lên > quota → **507 `storage_quota`**, không ghi byte nào | `USER_FILE_QUOTA_BYTES` (mặc định 200 MB, 0 = tắt)          |
| Chặn khi bucket đầy    | Đo bucket mỗi `STORAGE_SCAN_INTERVAL_MS` (1 lượt `ListObjectsV2` cả bucket); giữa 2 lần đo cộng thêm những gì đã đẩy lên. Từ `STORAGE_BLOCK_PERCENT` mọi upload → **507 `storage_full`** | `S3_BUCKET_CAPACITY_BYTES` (0 = không đo), `STORAGE_WARN_PERCENT` 80, `STORAGE_BLOCK_PERCENT` 95, `STORAGE_SCAN_INTERVAL_MS` 1 giờ |
| Dọn file không dùng    | Xoá mọi file của chat/dự án không ai dùng quá N ngày. **Đoạn chat vẫn còn**, chỉ mất file. Chạy theo lịch, hoặc admin bấm      | `FILE_RETENTION_DAYS` (0 = không tự dọn); admin: `POST /admin/storage/cleanup` |

**"Không dùng"** được tính theo mốc gần nhất trong hai mốc sau:
- tin nhắn cuối của chat (`updated_at`; với dự án là chat mới nhất của dự án);
- file mới nhất trong thư mục.

File ẩn (`.fox/`, `.dsh/`) không tính vào mốc này, vì chúng được ghi lại mỗi lần upload hoặc mỗi lần mở chat.

Chat **đang mở** thì bỏ qua.

## User

- **Cài đặt > Dung lượng** cho xem:
  - thanh "đã dùng / quota";
  - danh sách file theo chat/dự án, thư mục lớn nhất đứng trước;
  - nút xoá từng file, và nút "Xoá tất cả file" của một chat/dự án (đoạn chat vẫn còn).
- Từ 80% quota: báo "sắp hết". Khi đầy: báo bắt buộc phải xoá file cũ.
- Upload bị chặn (đính kèm trong chat, hoặc upload vào dự án): thẻ file hiện "Hết dung lượng", kèm toast có nút **Quản lý dung lượng** mở thẳng tab này. Thử lại không có tác dụng cho tới khi xoá bớt file.

## Admin

Tab Dung lượng cho admin có thêm:
- dung lượng bucket (lần đo gần nhất);
- dung lượng từng user;
- mục **Dọn file không dùng**: nhập số ngày → **Xem trước** (`dryRun`, chưa xoá gì) → **Xoá**.

Gọi trực tiếp bằng API (token admin):

```bash
# xem trước: những gì sẽ bị xoá
curl -s -X POST "$API/admin/storage/cleanup" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"olderThanDays": 90, "dryRun": true}'
# xoá thật (thêm "userId": 12 để chỉ dọn của một user)
curl -s -X POST "$API/admin/storage/cleanup" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"olderThanDays": 90}'
# bucket và dung lượng từng user
curl -s "$API/admin/storage" -H "authorization: Bearer $TOKEN"
```

Kết quả trả về có dạng `{dirs, files, bytes, skippedLive, items[...100 đầu]}`. Sau một lần xoá thật, bucket được đo
lại ngay, nên lệnh chặn upload được gỡ luôn, không phải chờ lần đo sau.

## API

| Route                                   | Ai          | Làm gì                                                                 |
| --------------------------------------- | ----------- | ---------------------------------------------------------------------- |
| `GET /storage`                          | user        | `{usedBytes, quotaBytes, warnPercent, bucketFull, dirs[{kind,id,title,bytes,modified,files[]}]}` |
| `DELETE /storage/(sessions\|projects)/:id` | chủ / admin | Xoá mọi file nhìn thấy của chat (không thuộc dự án) hoặc của dự án; giữ `.dsh/`, `.fox/`, nên chat đang mở vẫn chạy |
| `DELETE /…/files/<path>` (đã có)        | chủ / admin | Thư mục đã rời đĩa (chỉ còn trên S3) thì xoá thẳng trên S3, không tải cả thư mục về |
| `GET /admin/storage`                    | admin       | `{bucket, quotaBytes, fileRetentionDays, users[]}`                     |
| `POST /admin/storage/cleanup`           | admin       | `{olderThanDays ≥ 1, userId?, dryRun?}`                                |

Web nginx (`app/nginx.conf.template`) chuyển thêm `/storage` và `/admin` sang backend.

## Cách tính

- Dung lượng một thư mục:
  - thư mục còn trên đĩa: cộng cỡ các file trên đĩa (bỏ qua `.dsh/` và file tạm);
  - thư mục đã rời đĩa: cộng các cỡ Redis đã ghi khi đẩy lên (`fh:workspace-archive:<dirKey>`).

  Cả hai cách đều không cần gọi S3.
- Danh sách chat và dự án của user lấy từ MariaDB, không lấy từ đĩa, vì thư mục đã rời đĩa thì không còn trên đĩa để tìm.
- Xoá file luôn dừng lượt quét archive trong lúc xoá. Nếu không, lượt quét có thể đẩy lại đúng file đang bị xoá.
- Mỗi file dùng một `DeleteObject`, nên không cần `s3:ListBucketVersions`. Bucket **bật versioning** thì `DeleteObject` chỉ đặt delete marker, bản cũ vẫn chiếm chỗ: phải kiểm tra versioning đang **tắt** (`aws s3api get-bucket-versioning`).
- Đo bucket cần `s3:ListBucket`. Đo lỗi thì log `storage_scan_failed`, và upload **không bị chặn** theo bucket cho tới khi đo được; quota user vẫn chạy.

## Log

| Sự kiện               | Mức              | Khi nào                                                                  |
| --------------------- | ---------------- | ------------------------------------------------------------------------ |
| `storage_usage`       | info, warn, error | Mỗi lần đo: `bucketBytes objects capacityBytes percent`. Mức warn từ 80%, error từ 95% (lúc này upload đã bị chặn) |
| `storage_scan_failed` | error            | Không đo được bucket                                                     |
| `upload_refused`      | warn             | Upload bị chặn: `code incoming usedBytes quotaBytes`                     |
| `storage_cleanup`     | info / error     | Mỗi lần dọn: `by` (`schedule` hoặc `admin:<id>`), `olderThanDays dryRun dirs files bytes skippedLive` |
| `storage_dir_cleared` | info             | User xoá hết file của một chat/dự án                                     |
| `workspace_delete`    | info             | Xoá một file (`bytes`; `fromS3Only` khi thư mục đã rời đĩa)              |

Nên đặt cảnh báo cho `storage_usage` ở mức `warn` hoặc `error`.

## Staging (12 GB)

```
S3_BUCKET_CAPACITY_BYTES=12884901888
USER_FILE_QUOTA_BYTES=209715200      # 200 MB; 12 GB / 200 MB ≈ 60 user dùng hết quota cùng lúc
# FILE_RETENTION_DAYS=180            # bật khi storage_usage bắt đầu báo warn
```

## Mã nguồn

| File                                                    | Nội dung                                                           |
| ------------------------------------------------------- | ------------------------------------------------------------------ |
| `api/services/gateway/src/runtime/storage.ts`           | quota, `GET /storage`, tổng quan admin, dọn file, lịch chạy         |
| `api/services/gateway/src/runtime/bucket-usage.ts`      | đo bucket, ước lượng giữa 2 lần đo, ngưỡng chặn                     |
| `api/services/gateway/src/runtime/workspace-archive.ts` | `dirUsage`, `clearWorkspace`, `deleteEvictedFile`, dừng lượt quét  |
| `api/services/gateway/src/index.ts`                     | kiểm tra trước upload, các route                                    |
| `app/src/components/features/settings/StorageTab.tsx`   | tab Dung lượng (user + admin)                                       |
| `app/src/components/features/settings/storageApi.ts`    | API, toast "Quản lý dung lượng"                                     |

## Kiểm thử (2026-10-15)

e2e `storageQuota` (PASS, 24 check, quota 2 MB):
1. Upload 1.5 MB → 201. Upload thêm 1 MB → 507 `storage_quota`.
2. `GET /storage` liệt kê file đó. Xoá file → upload lại được.
3. Xoá hết file một chat được; người khác thử xoá → 404.
4. Chat lùi về 40 ngày trước:
   - user gọi lệnh dọn → 403;
   - dry run báo `1 1 1000` và không xoá gì;
   - dọn thật: file hết trên đĩa và trên S3, chat vẫn còn.
5. Thư mục đã rời đĩa: vẫn được liệt kê; xoá một file chỉ xoá trên S3, không tải thư mục về.
6. `GET /admin/storage` có số đo bucket.

Toàn bộ suite: 26/27 PASS. `gatewayLimits` chập chờn: chạy lại 3 lần thì lần 1 lỗi, 2 lần sau qua. Phần đó là body
JSON 2 MB nhận 502 thay vì 413 qua nginx, không liên quan tới thay đổi này.

## Chưa làm

- Nén gzip file chữ (CSV, JSON…) trước khi đẩy lên. Theo số đo thì giảm được 5–12 lần.
- Quota tính theo cỡ trên đĩa, chưa theo cỡ sau nén.
- File python tạo ra không bị chặn khi vượt quota. Chúng vẫn được tính vào quota, nên lần upload sau sẽ bị chặn.
