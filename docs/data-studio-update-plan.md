# Plan: đưa bản cập nhật mới của Data Studio (reference) vào hệ thống

Nguồn: `examples/bot-data-studio-api-main` (BE, Python/FastAPI) và `examples/bot-data-studio-web-main` (FE,
Next.js), tải về ngày 2026-10-06. So với phần đã port trước đây:
- **BE:** `api/packages/tool/data-studio-agent/python` (pipeline) + `api/services/gateway` (API admin viết lại bằng
  TypeScript, đọc/ghi Mongo trực tiếp).
- **FE:** `app/src/components/features/data-studio/*`, `conversation/DataStudioAnswer.tsx`, `ChartView.tsx`,
  `ChartDialogs.tsx`.

Toàn bộ phân tích dưới đây đã kiểm trực tiếp trên code và trên Mongo đang chạy, không sửa gì.

## 0. Tóm tắt

| Câu hỏi | Trả lời |
|---|---|
| Reference thay đổi gì lớn? | (1) **Pipeline v4**: agent không tự viết SQL mà điền một "đặc tả truy vấn" có kiểu, rồi một bộ dịch sinh SQL. Đang **thử nghiệm**: chat của reference vẫn chạy **v3**. (2) **Hồ sơ dữ liệu**: người làm dữ liệu khai thủ công ý nghĩa bảng, cột, giá trị, metric, thuật ngữ, có duyệt, gợi ý AI, xuất/nhập. V4 dựa hoàn toàn vào hồ sơ này. (3) Các cải tiến nhỏ: chặn SQL ghi (`sql_safety`), đồng bộ Dremio tốt hơn (SPACE, thư mục lồng nhau), xóa mềm, sửa lỗi Meilisearch. |
| Schema Mongo có đổi không? | **Có, nhưng gần như chỉ thêm.** Không phải chuyển đổi dữ liệu cũ. **Bắt buộc đổi 1 index** (`entities`); thêm 2 collection mới khi làm hồ sơ dữ liệu. Chi tiết ở mục 2. |
| Hai script migrate trong reference có cần chạy? | **Không.** Cả hai chỉ sửa **SQLite** (`data/semantic_layer.db`), không đụng Mongo. Dữ liệu Mongo hiện tại đã đúng dạng mà chúng hướng tới. |
| Rủi ro lớn nhất? | **V4 và hồ sơ dữ liệu bỏ qua phân quyền theo role** (đọc Mongo trực tiếp, chạy SQL không qua bộ kiểm). Reference không có khái niệm role, chỉ có một tài khoản đăng nhập. |
| Đề xuất | Làm theo giai đoạn. **GĐ1** lấy các cải tiến nhỏ an toàn ngay. **GĐ2** các tính năng UI nhanh. **GĐ3** hồ sơ dữ liệu. **GĐ4** v4 sau cờ bật/tắt, sau khi đã có hồ sơ dữ liệu và đã bổ sung phân quyền. |

## 1. Những gì mới trong reference

### 1.1 BE

| Hạng mục | Mô tả | Kích thước | Phụ thuộc |
|---|---|---|---|
| `pipeline_v4/` | Tách câu hỏi (1–3 câu con, chạy song song) → tìm bảng trong hồ sơ (Meilisearch, index mới `v4_*`) → agent điền `QuerySpec` → `compiler.py` sinh SQL (join tìm bằng BFS, múi giờ, tổng hợp 2 tầng…) → `EXPLAIN` rồi chạy → trình bày, chart, câu hỏi gợi ý. Lỗi được trả về đúng agent phụ trách để sửa (tối đa 2 vòng). Tự ghi `conversations/messages/query_results/charts`. | khoảng 7.000 dòng | LLM, embedding, Meili, Dremio, Mongo (async); thêm gói `rich` |
| `data_profile/` | Hồ sơ dữ liệu: subdoc `profile` trên bảng/cột/quan hệ, duyệt (`profile_review`), checklist độ đầy đủ, gợi ý AI theo từng trường, chạy thử metric/segment trên Dremio, xuất/nhập JSON, xuất Word, index Meili `v4_*`. | khoảng 4.500 dòng | Mongo, Meili, embedding; LLM (gợi ý); Dremio (chạy thử); `python-docx` (xuất Word) |
| `services/sql_safety.py` | Chặn mọi câu SQL có lệnh ghi/DDL và nhiều câu lệnh trong một lần; quét cả đoạn SQL thô. | nhỏ | sqlglot, không cần mạng |
| `services/dremio_client.py` | Bỏ qua proxy công ty (mặc định), mã hoá URL, liệt kê SOURCE và SPACE, đọc kết quả theo trang, **hủy job khi quá thời gian**, trả thêm thông tin cột. | nhỏ | — |
| `services/dremio_sync.py` | Đồng bộ cả **SPACE** (view), duyệt thư mục lồng nhau, bỏ qua schema hệ thống của Oracle, khớp bảng theo `physical_path`, chọn từng dataset để import, khôi phục nguồn đã xóa mềm. **Gắn chặt với `data_profile`** (đánh dấu cần duyệt lại, đánh dấu index cũ). | vừa | — |
| `services/meili_store.py` | **Sửa lỗi** `delete()` (bản của mình gửi `{"filter": null}`, không xóa được gì). | 1 dòng | — |
| Xóa mềm | `relationships`, `relationship_column_pairs`, `data_sources` có `deleted_at`; nguồn, metric, thuật ngữ có `disabled_at`. | nhỏ | — |
| `services/data_source_deletion.py` | Xóa mềm một nguồn dữ liệu và đánh dấu bỏ dùng các bảng/cột của nó. | nhỏ | Mongo |
| `services/dashboard_pdf.py` | Xuất dashboard ra PDF ở server (WeasyPrint). | nhỏ | thư viện hệ thống pango/cairo; **rủi ro SSRF** (HTML do client gửi lên) |
| `security.py`, `utils/vault_config.py`, `apis/routes/auth.py` | Đăng nhập một tài khoản (JWT cookie), đọc secret từ Vault | — | **Không dùng.** Mình có gateway và phân quyền riêng. `security.py` còn trùng tên với `src/security/` của mình. |
| `settings.py` | Thêm `dremio_use_env_proxy`, `dremio_sync_container_types` (nên lấy); `auth_*` **bắt buộc**, JWT, SQLite (**không lấy**, nếu lấy thì worker không khởi động được) | — | — |

Phiên bản các gói dùng chung không đổi (`agno` 2.9.0 ở cả hai bên).

### 1.2 FE

| Màn hình / tính năng | Bên mình | Cần làm |
|---|---|---|
| **Hồ sơ dữ liệu** của bảng: loại bảng, độ tin cậy, khóa, cột thời gian, múi giờ, bộ lọc mặc định, lưu ý. Hồ sơ cột: danh mục giá trị, đơn vị, cộng được không, trường JSON. Hồ sơ quan hệ: tỉ lệ khớp, nhân bản. Checklist, gợi ý AI, "đánh dấu đã duyệt", index lại. | Không có | **Lớn** (khoảng 4.500 dòng ở reference) |
| Danh sách bảng có trạng thái hồ sơ (chưa duyệt / cần duyệt / đã duyệt / Dremio đã đổi), xuất Word cho DE, index lại, xuất/nhập JSON | Danh sách bảng + công tắc "Cho phép role user" | Vừa |
| Metric kiểu mới: aggregate/ratio, bộ lọc có kiểu, cột thời gian, hướng tốt, chạy thử trên Dremio, bật/tắt, xuất/nhập | Metric đơn giản (1 phép tổng hợp trên 1 cột) | Lớn (mô hình dữ liệu khác hẳn) |
| Thuật ngữ kiểu mới: segment (kèm bộ lọc) / gắn metric, chạy thử, bật/tắt | Thuật ngữ, từ đồng nghĩa, định nghĩa, `sql_expressions` | Vừa–lớn |
| Quan hệ kèm hồ sơ (tỉ lệ khớp), xuất/nhập | Form cơ bản | Vừa |
| **SQL console**: soạn, format, giới hạn số dòng, chạy, bảng kết quả | Không có | Vừa. **Chỉ admin**: SQL tự do sẽ đi vòng qua phân quyền bảng/cột. |
| **Xóa nguồn dữ liệu**; chọn từng dataset khi import từ Dremio | Không có; import theo cả nguồn | Nhỏ |
| **13 loại chart** | 7 loại | Thêm 6: `stacked_area`, `bar_horizontal`, `stacked_bar`, `combo`, `donut`, `treemap` (recharts đã hỗ trợ). Nhỏ–vừa. |
| Chat v4: xem tiến trình từng bước và từng agent, câu hỏi con chạy song song, thời gian, nút dừng, phát lại câu trả lời đã lưu | Câu trả lời (văn bản, SQL, chart, gợi ý) | Vừa–lớn; chỉ có ý nghĩa khi dùng v4 |
| Xuất PDF dashboard ở server | Dùng chức năng in của trình duyệt | Không bắt buộc |

**Không cần thêm thư viện FE.** recharts, highlight.js và sql-formatter đã có. Tailwind/Radix của reference phải viết
lại theo CSS và component sẵn có của mình.

## 2. Schema Mongo: thay đổi gì

**Kết luận: có thay đổi, gần như hoàn toàn là thêm.** Dữ liệu hiện có không phải chuyển đổi. Kiểm trên DB đang chạy:
chưa document nào có `deleted_at`, `disabled_at`, `profile`; thiếu trường thì `{field: null}` vẫn khớp, nên không
phải điền bổ sung.

| Collection | Thay đổi | Loại |
|---|---|---|
| `entities` | Thêm `profile`, `profile_review`, `search_index` (tuỳ chọn). Sync khớp theo **`physical_path`** thay vì `physical_name`. View từ SPACE có `entity_type="vds"`. | thêm; **phải đổi index** |
| `entity_columns` | Thêm `profile` (danh mục giá trị, đơn vị, trường JSON…). Trường JSON là "cột ảo" chỉ dựng trong bộ nhớ, không lưu. | thêm |
| `relationships`, `relationship_column_pairs` | Thêm `deleted_at`, `profile` (tỉ lệ khớp, nhân bản). **Xóa thành xóa mềm.** | thêm; **đổi hành vi** |
| `data_sources` | Thêm `deleted_at`, `disabled_at`; `source_type` có thể là `space`. | thêm |
| `conversations` | Thêm `deleted_at`. | thêm |
| `messages` | V4 ghi thêm `status`, `standalone_question`, `parts_json`, `timings_json`, `events_json`, `chart_ids_json`. | thêm |
| `query_results` | Thêm `spec_json`. | thêm |
| `charts`, `dashboards`, `dashboard_widgets`, `verified_queries` | Không đổi (`rows_json`, `transform_code` đã có sẵn trong dữ liệu). | — |
| `metrics`, `business_glossary` | Không đổi; v3 vẫn dùng. **V4 không đọc hai collection này.** | — |
| **`profile_metrics`** (mới) | Metric kiểu mới: `kind` aggregate/ratio, `entity_id`, `aggregation`, `column_id`, bộ lọc có kiểu, cột thời gian, tử số/mẫu số, đơn vị, `good_direction`, câu hỏi mẫu, `deleted_at`, `disabled_at`… | **collection mới** |
| **`profile_glossary`** (mới) | Thuật ngữ kiểu mới: `kind` segment/metric/definition, bộ lọc, `metric_id`, `related_entity_ids`, `deleted_at`, `disabled_at`… | **collection mới** |
| enum `SemanticType` | Thêm giá trị `number`. Danh sách chọn trên UI của mình chưa có. | thêm |

**Index:**
- **Bắt buộc:** reference đồng bộ thư mục lồng nhau, nên cùng một tên bảng có thể xuất hiện ở hai schema. Index
  unique `{data_source_id, physical_name}` của mình sẽ làm sync dừng giữa chừng (DuplicateKeyError). Đổi thành unique
  `{data_source_id, physical_path}`. Dữ liệu hiện tại không bị trùng `physical_path`, nên đổi được an toàn.
- **Nên thêm** khi làm hồ sơ dữ liệu: `profile_metrics {name}`, `profile_glossary {term}`.
- Reference không có `ensure_indexes`. Danh sách index là của mình, phải sửa đồng thời ở hai nơi (Python
  `database/mongodb.py` và gateway `mongo.ts`).

**Các bước khi áp dụng:**
1. `mongodump` backup.
2. Dừng backend.
3. Tạo index unique `{data_source_id, physical_path}`, rồi xóa index cũ theo `physical_name`.
4. (GĐ3) Thêm index cho `profile_*`.
5. Gateway đọc `relationships`, `relationship_column_pairs`, `data_sources` phải lọc `deleted_at: null`.
6. Không chạy hai script SQLite.
7. Sync Dremio lại, kiểm tra số bảng và log không có lỗi trùng khóa.

**Chuyển metric và thuật ngữ cũ sang kiểu mới:** không có công cụ tự chuyển, vì hai dạng khác nhau (bộ lọc có kiểu
thay cho đoạn SQL). Hiện chỉ có 1 metric và 1 thuật ngữ, nên khai lại bằng tay trên màn hồ sơ dữ liệu.

## 3. Những thứ của mình phải giữ khi port

Reference **không có role**. Port nguyên văn sẽ làm mất các phần sau:

| Thứ phải giữ | Ở đâu | Nguy cơ khi port |
|---|---|---|
| Lọc catalog theo `allowed_roles` và `is_pii` | `crud_mongo/*` (`_q`, `_visible`) | Hàm mới ở crud (`get_by_physical_path`…) phải bọc `_q`. **V4 (`catalog.load_catalog`) đọc Mongo trực tiếp, bỏ qua lọc.** |
| Kiểm SQL theo role trước khi gửi Dremio | `sql_validator.py`, `query_execution.py` | **V4 chạy SQL qua `AsyncDremio`, không qua bộ kiểm.** `metric_sql.py` chỉ kiểm "chỉ đọc". |
| Gán `allowed_roles: ['admin']` cho bảng/cột mới | `entity.create`, `entity_column.create` | Hàm `create` của reference không gán; thiếu thì mặc định là chỉ admin (vẫn an toàn). |
| Tác vụ quản trị chạy với quyền admin | bọc `as_role(ADMIN)` | Phải bọc thêm cho `sync_dremio_datasets`, `list_source_datasets` và mọi thao tác hồ sơ dữ liệu. |
| Không tự gọi `api.openai.com` | `llm_client.py`, `embedding_client.py` | **V4 `make_model` và `data_profile/suggest.py` (3 chỗ) không chặn**: thiếu `OPENAI_BASE_URL` thì SDK tự gọi OpenAI. Phải thêm chặn. |
| Tắt telemetry Agno | `bridge/runner.py`, `admin_runner.py` | V4 tự truyền `telemetry=False`; vẫn giữ biến ép ở runner. |
| Sửa lỗi alias trong `sql_validator` | `sql_validator.py` | Reference vẫn còn lỗi alias. **Không ghi đè file này**: chỉ thêm `check_read_only_sql`/`find_write_violation`. |
| Gửi trace trực tiếp của v3 | `pipeline_v3/orchestrator.py` (`_trace`) | Giữ nguyên; v3 của reference không đổi gì khác. |
| API admin viết bằng TypeScript ở gateway | `data-studio-db.ts`, `index.ts` | Gateway đang **xóa cứng** quan hệ, phải đổi theo xóa mềm, nếu không UI sẽ hiện quan hệ đã xóa. |
| Công tắc "Cho phép role user" | `DataStudioDataSources.tsx` | Phải đưa vào màn hồ sơ dữ liệu mới. |

## 4. Kế hoạch theo giai đoạn

### GĐ1. Cải tiến nhỏ, an toàn: nên làm ngay (BE)
1. Thêm `sql_safety.py`, gọi trong `sql_validator` **bên cạnh** các kiểm tra theo role của mình (không ghi đè file).
2. `dremio_client.py`: bỏ proxy công ty, liệt kê SPACE, đọc theo trang, **hủy job khi quá thời gian**.
3. `meili_store.py`: sửa `delete()`.
4. Xóa mềm cho quan hệ và nguồn ở cả Python lẫn gateway (đọc lọc `deleted_at: null`; xóa thì đặt `deleted_at`).
5. `dremio_sync.py`: SPACE, thư mục lồng nhau, bỏ schema hệ thống, khớp theo `physical_path`, **đổi index**. Phần
   gọi sang `data_profile` để trống cho tới GĐ3. Giữ `as_role(ADMIN)`.
6. `SemanticType.number` (BE + danh sách chọn trên UI). `settings.py`: chỉ lấy hai trường Dremio.
- **Kiểm chứng:** `role_authz_test.py`, `smoke_mongo.py`, sync Dremio thật (đếm bảng, kiểm log trùng khóa),
  e2e 19/19, LLM thật Data Studio.

### GĐ2. Tính năng UI nhanh
1. 6 loại chart mới.
2. Xóa nguồn dữ liệu (xóa mềm, chỉ admin).
3. Chọn từng dataset khi import từ Dremio (`GET` danh sách dataset, `POST` sync kèm `datasets`).
4. Bật/tắt nguồn cho agent (`disabled_at`).
5. **SQL console, chỉ admin:** đi qua `sql_safety` + giới hạn dòng + ghi log ai chạy câu gì.
- **Kiểm chứng:** e2e mở rộng (user gọi các route mới phải bị `403`), bấm thử UI.

### GĐ3. Hồ sơ dữ liệu (BE + FE, lớn)
- **Cách làm đề xuất:** chạy code `data_profile/*` của reference trong Python qua bridge admin (thêm các thao tác
  vào `admin_runner.py`), thay vì viết lại khoảng 4.500 dòng sang TypeScript. Gateway chỉ thêm các route
  `/data-studio/profile/*` (chỉ admin) chuyển yêu cầu sang Python. Như vậy giữ được logic gốc (checklist, gợi ý, xuất/nhập,
  index) và dễ cập nhật theo reference sau này.
- **Cần làm thêm:**
  - collection `profile_metrics`/`profile_glossary` + index;
  - chặn fallback OpenAI trong `suggest.py`;
  - bọc `as_role(ADMIN)`;
  - thêm gói `python-docx` (xuất Word);
  - index Meili `v4_*`;
  - bridge admin hiện **khởi động một process cho mỗi lần gọi** (khoảng 1–2 giây). Màn hồ sơ gọi nhiều lần, nên cần
    một worker admin chạy liên tục.
- **FE:** màn hồ sơ bảng, cột, quan hệ; metric và thuật ngữ kiểu mới; checklist, duyệt, gợi ý AI; xuất/nhập JSON;
  xuất Word. Giữ công tắc "Cho phép role user".
- **Kiểm chứng:** test Python của reference (`tests/`), e2e cho route mới, nhập thử hồ sơ cho một nguồn thật.

### GĐ4. Pipeline v4 sau cờ bật/tắt (chỉ khi đã có hồ sơ dữ liệu)
1. Thêm lọc role vào `catalog.load_catalog` (bảng, cột, quan hệ, `profile_*` theo `allowed_roles` và `is_pii`).
2. Kiểm SQL do `compiler.py` sinh ra bằng `sql_validator` theo role trước `AsyncDremio`.
3. Chặn fallback OpenAI trong `make_model`; gói `rich`.
4. Tool `analyze_data` chọn v3 hay v4 theo cờ (ví dụ `DATA_STUDIO_PIPELINE=v3|v4`, mặc định v3), giữ nguyên giao
   thức với agent.
5. (Tuỳ chọn) FE hiển thị tiến trình từng bước, nếu v4 phát sự kiện qua kênh trace hiện có.
6. **Đánh giá v3 và v4 trên cùng bộ câu hỏi có đáp án** (như bài 77 / 851 đã dùng), rồi mới đổi mặc định.

### Không port
- Đăng nhập/JWT/Vault của reference.
- App FastAPI và các route chat (chat đi qua tool của agent).
- Hai script SQLite.
- PDF ở server (giữ in bằng trình duyệt; nếu cần thì phải chặn tải URL trong WeasyPrint vì rủi ro SSRF).

## 5. Cần bạn quyết định
1. **Thứ tự:** đồng ý GĐ1 → GĐ2 → GĐ3 → GĐ4? Hay chỉ làm GĐ1 + GĐ2 trước rồi xem lại?
2. **Hồ sơ dữ liệu (GĐ3):** chạy code Python của reference qua bridge (đề xuất), hay viết lại sang TypeScript ở gateway?
3. **SQL console:** có cần không? Nếu có, chỉ admin (đề xuất), kèm ghi log từng câu chạy?
4. **V4:** có đưa vào không, hay chờ reference chuyển mặc định sang v4 rồi mới làm?
5. **PDF dashboard ở server:** giữ in bằng trình duyệt như hiện tại (đề xuất)?
