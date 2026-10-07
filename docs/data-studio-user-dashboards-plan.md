# Dashboard riêng cho từng user trong Data Studio (2026-10-07)

## Hiện trạng

| Thành phần                | Trước                                                                                   |
| ------------------------- | --------------------------------------------------------------------------------------- |
| `dashboards`              | Không có chủ sở hữu; toàn hệ thống dùng chung                                           |
| `charts`, `conversations` | Sinh ra mỗi câu trả lời của `analyze_data`; không ghi ai hỏi, chat nào                  |
| Quyền                     | Tạo/sửa/xoá dashboard, ghim, sửa chart: chỉ admin. User xem được **mọi** dashboard (A7) |
| `available-charts`        | 300 chart mới nhất của mọi người                                                        |

## Quyết định

| #   | Câu hỏi                       | Chọn                                                                            |
| --- | ----------------------------- | ------------------------------------------------------------------------------- |
| 1   | Admin xem dashboard của user? | Không — riêng tư hoàn toàn, admin cũng chỉ thấy của mình                        |
| 2   | Chia sẻ dashboard?            | Chưa làm (dính A7: chart có thể chứa dữ liệu người được chia sẻ không được hỏi) |
| 3   | Dữ liệu cũ không có chủ       | Gán cho admin đầu tiên (script, sao lưu trước)                                  |

## Thay đổi

| Phần    | Việc                                                                                                                    |
| ------- | ----------------------------------------------------------------------------------------------------------------------- |
| Tool    | `analyze_data` truyền `user_id`, `session_id` của chủ session xuống `runner.py` (cùng đường với `role`)                 |
| Python  | `runner.py` ghi `owner_id`, `session_id` vào `conversations` và `charts` vừa tạo (v3 và v4)                             |
| Gateway | Mọi hàm dashboard/chart nhận `ownerId`; route kiểm chủ sở hữu (người khác → 404); cổng admin mở nhóm route này cho user |
| FE      | User tạo/sửa/xoá dashboard, ghim chart từ chat, sửa trường/màu chart; danh sách chỉ dashboard của mình                  |
| Dữ liệu | Script `api/scripts/backfill-dashboard-owners.mjs`                                                                      |

Route sau thay đổi:

| Route                                               | Quy tắc                                         |
| --------------------------------------------------- | ----------------------------------------------- |
| `GET /data-studio/dashboards`                       | Dashboard của người gọi                         |
| `POST /data-studio/dashboards`                      | Mọi user đã đăng nhập; `owner_id` = người gọi   |
| `GET/PATCH/DELETE /data-studio/dashboards/:id`      | Chủ sở hữu; khác → 404                          |
| `POST/PUT /data-studio/dashboards/:id/widgets`      | Chủ dashboard; chart trong widget phải của mình |
| `POST /data-studio/dashboards/:id/charts`           | Chủ dashboard và chủ chart                      |
| `GET /data-studio/dashboards/meta/available-charts` | Chart của người gọi                             |
| `PATCH /data-studio/charts/:id`                     | Chủ chart                                       |

## DB (chỉ MongoDB `bot_data_studio`)

| Collection      | Thêm                                    | Index mới                       |
| --------------- | --------------------------------------- | ------------------------------- |
| `dashboards`    | `owner_id` (int)                        | `{owner_id: 1, updated_at: -1}` |
| `charts`        | `owner_id` (int), `session_id` (string) | `{owner_id: 1, created_at: -1}` |
| `conversations` | `owner_id` (int), `session_id` (string) | —                               |

`dashboard_widgets`, `messages`, `query_results` không đổi. MariaDB, Redis, Meilisearch không đổi.

## Kiểm thử

- e2e (thêm Mongo vào stack e2e): user B không thấy/sửa/xoá dashboard của A, không ghim vào đó, không ghim chart của A,
  không sửa chart của A (404); user tạo, ghim chart của mình, đổi bố cục được; `available-charts` chỉ chart của mình.
- 8080: hỏi một câu → ghim chart vào dashboard mới → đăng nhập user khác không thấy.

## Lưu ý

Chart lưu số liệu tại lúc trả lời; tắt quyền một bảng sau đó không xoá số liệu đã ghim (ngoài phạm vi).

## Kết quả (2026-10-07)

- e2e 21/21; bài mới `dashboardOwnership` 15 check (gồm cả trường hợp widget mang `id` giả để chèn chart của người khác → 404).
- 8080: hỏi trong Data Studio → chart và hội thoại mới có `owner_id` + `session_id` của người hỏi; ghim từ chat vào dashboard
  mới trên UI; user khác: danh sách rỗng, mở theo id → 404; user tạo dashboard riêng được.
- Dữ liệu cũ: `backfill-dashboard-owners.mjs` gán 1 dashboard, 243 chart, 98 hội thoại cho admin id 1; sao lưu ở
  `data/_backup/2026-10-07-before-user-dashboards/`.
- Lỗ A7 (user xem dashboard chứa dữ liệu admin) hết theo cách này: không còn dashboard dùng chung.
