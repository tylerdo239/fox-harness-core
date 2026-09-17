# Data Studio — semantic-layer admin UI (Phase 3)

> Kế hoạch cho 5 mục trong sidebar Data Studio hiện đang là placeholder
> "Chưa triển khai": **Dashboards, Data Sources, Glossary, Relationships,
> Metrics**. Làm theo từng mục, có kiểm thử thật ở mỗi mục trước khi qua
> mục tiếp (user: "lên plan cho từng mục và làm theo từng mục").

## Quyết định kiến trúc: gateway là backend thật, không phải HTTP service Python

User: "Adapt với core hiện tại qua gateway" — admin CRUD KHÔNG giống
`analyze_data` (1 câu hỏi = 1 lần gọi tool). Đây là nhiều thao tác
list/create/update/delete/search/phân trang gắn với UI tương tác — đúng
việc `services/gateway` (đã có sẵn REST cho sessions/skills/auth) nên làm,
không phải model gọi tool.

**2 loại thao tác, 2 cách xử lý khác nhau:**

1. **CRUD thuần** (đọc/ghi bảng cấu hình, KHÔNG gọi Dremio) — glossary,
   metrics, relationships, sửa curate-field của entity/column, dashboards —
   gateway (TypeScript) đọc/ghi TRỰC TIẾP file sqlite dùng chung
   (`data/data-studio-shared/semantic_layer.db`, path y hệt
   `services/orchestrator`'s `dataStudioSharedDir` đã có) bằng
   `better-sqlite3`. Không cần Python, không cần subprocess mỗi request.
2. **Cần gọi Dremio thật** (import/sync schema, profiling dữ liệu) — vẫn
   phải qua Python (`DremioClient`/`dremio_sync.py` đã có sẵn, không viết
   lại bằng TS) — gateway spawn 1 subprocess bridge MỚI
   (`packages/tool/data-studio-agent/python/bridge/admin_runner.py`, cùng
   protocol JSON-lines như `runner.py`) cho đúng 2 thao tác này, không phải
   toàn bộ CRUD.

**Rủi ro đã biết, chấp nhận được**: gateway ghi trực tiếp vào file sqlite
mà pipeline Python cũng đọc — cùng 1 host (dev/prod hiện tại chưa multi-host,
đã ghi rõ ở `docs/data-studio-agent-transfer-plan.md`), SQLite tự khoá ghi ở
mức file nên không corrupt, chỉ có thể có độ trễ ngắn nếu ghi/đọc trùng lúc
— chấp nhận được cho khối lượng dùng thật tế của tính năng admin (không
phải hệ nhiều người viết đồng thời liên tục).

## Schema thật (đã đọc `packages/tool/data-studio-agent/python/src/database/models/`)

| Bảng | Field chính |
|---|---|
| `data_sources` | name, source_type, dremio_path, status, is_exposed_to_agent |
| `entities` | data_source_id, physical_name, display_name, description, synonyms, is_exposed, is_pii, entity_type |
| `entity_columns` | entity_id, physical_name, display_name, description, role, semantic_type, default_aggregation, is_exposed, is_pii, is_default_select |
| `relationships` + `relationship_column_pairs` | from_entity_id, to_entity_id, cardinality, join_type_default, column_pairs[] |
| `business_glossary` | term, synonyms, definition_text, sql_expressions[], related_entity_ids[] |
| `metrics` | name, description, base_entity_id, aggregation, measure_column_id, default_filters[], time_column_id, grain, unit, canonical_sql |
| `dashboards_chat` + `dashboard_widgets_chat` | title, appearance_json; widgets: kind, chart_id, x/y/w/h |

## Đối chiếu UI gốc (`example-data-studio-agent/ui/src`)

Đã đọc `lib/api.ts` (endpoint thật) + `app/(app)/data-sources/**`:
- Data Sources: **không có form tạo tay** — chỉ tạo qua "Import from Dremio"
  (browse nguồn Dremio → chọn → sync tạo entities/columns). Trang chi tiết
  1 source → danh sách entity → trang chi tiết 1 entity → sửa curate-field
  của từng column.
- Relationships: trang riêng (`data-sources/relationships`) — browse
  entity, tạo/sửa/xoá quan hệ + cặp cột.
- Glossary/Metrics: CRUD phẳng, đơn giản.
- Dashboards: phức tạp nhất (kéo-thả widget, pin chart từ chat, xuất PDF) —
  để cuối.

## Phân kỳ (làm từng mục, test thật trước khi qua mục sau)

**Trạng thái: CẢ 5 MỤC ĐÃ XONG** (Data Sources + Import từ Dremio, Glossary,
Relationships, Metrics, Dashboards) — test thật qua `curl`/bridge cho từng
mục, kể cả gọi thật vào Dremio container đang chạy (403 thật, không phải
lỗi bridge) và rebuild lại `fox-harness-worker:dev` thật sau khi sửa
`bridge/runner.py`/`kernel.ts` (xác nhận `analyze_data` vẫn chạy đúng trong
container thật).

**Dashboards** (mục 5, cuối cùng): `bridge/runner.py` giờ lưu 1 chuỗi tối
thiểu `Conversation→Message→QueryResult→Chart` mỗi khi pipeline trả về
chart (bắt buộc — FK thật của schema, KHÔNG phải quay lại lưu lịch sử hội
thoại đầy đủ: không gì đọc lại chuỗi này để lấy ngữ cảnh, `handle()` vẫn
stateless theo từng câu hỏi), trả `chart_id` trong response. FE:
`DataStudioResultPill` có nút "Ghim vào dashboard" khi có `chart_id`; trang
Dashboards list + chi tiết (danh sách dọc, sắp xếp lên/xuống — không làm
lưới kéo-thả).

**Cấu phần Import từ Dremio** (mục 1, phần cuối):
`packages/tool/data-studio-agent/python/bridge/admin_runner.py` (MỚI) —
bridge JSON-lines RIÊNG cho 2 thao tác cần Python thật
(`list_available_dremio_sources`/`sync_dremio_metadata` có sẵn trong
`src/services/dremio_sync.py`, không viết lại) — khác `bridge/runner.py`
(persistent, 1 process/container): bridge này spawn MỚI mỗi lần gọi (thao
tác admin hiếm, không cần giữ ấm). `services/gateway/src/data-studio-bridge.ts`
(MỚI) spawn nó từ gateway (chạy trên host, không phải trong worker Docker
image) — `POST /data-studio/dremio/browse`, `POST /data-studio/dremio/sync`.
Bug thật bắt được khi test: fallback interpreter mặc định `python3` (khi
`FOX_PYTHON_DATA_STUDIO` không có, đúng trường hợp gateway chạy trên host)
âm thầm dùng python hệ thống (thiếu `sqlmodel`...) — sửa thành venv cục bộ
`<service_dir>/.venv/bin/python`; áp dụng sửa tương tự cho
`packages/tool/data-studio-agent/src/kernel.ts` (cùng lỗi tiềm ẩn, chưa lộ
ra vì trong Docker luôn có biến môi trường đó).

### 1. Data Sources — làm trước (mọi mục khác phụ thuộc entity/column của nó)
- `services/gateway`: `GET /data-studio/sources`, `GET /data-studio/sources/:id/entities`,
  `PATCH /data-studio/entities/:id`, `GET /data-studio/entities/:id/columns`,
  `PATCH /data-studio/columns/:id` — CRUD thuần, đọc/ghi sqlite trực tiếp.
- `POST /data-studio/dremio/browse` + `POST /data-studio/dremio/sync` — 2
  route CẦN Python (gọi Dremio thật) → spawn `admin_runner.py` mới.
- FE: trang danh sách nguồn + nút "Import từ Dremio" + trang chi tiết
  entity/column để sửa curate-field.

### 2. Glossary — CRUD phẳng, không phụ thuộc Dremio
- `GET/POST/PATCH/DELETE /data-studio/glossary` — sqlite trực tiếp.
- FE: bảng thuật ngữ + form thêm/sửa.

### 3. Relationships — phụ thuộc entity/column đã sync ở mục 1
- `GET/POST/PATCH/DELETE /data-studio/relationships` — sqlite trực tiếp.
- FE: chọn 2 entity + cặp cột + cardinality/join type.

### 4. Metrics — phụ thuộc entity/column
- `GET/POST/PATCH/DELETE /data-studio/metrics` — sqlite trực tiếp.
- FE: form định nghĩa metric (entity, cột đo, aggregation, filter mặc định).

### 5. Dashboards — để cuối (phức tạp nhất, gắn với chart đã pin từ chat)
- Cần thêm: chart pinning từ `DataStudioResultPill` (chưa có — pill hiện
  chỉ hiển thị, chưa có nút "pin vào dashboard").
- Thiết kế chi tiết để sau khi 4 mục trên xong.

## Giới hạn thật thứ 3 tìm thấy + đã tự sửa qua Dremio API

`sync_dremio_metadata` giả định **1 Dremio source = đúng 1 schema/database**
— tìm 1 folder con TRÙNG TÊN với `config.database` (hoặc trùng tên source
nếu không set), bỏ qua hoàn toàn nếu không khớp. Source "data studio" ban
đầu không set `database` nên sync ra 0 bảng dù data có thật. Dremio OSS
không có nút Edit lộ rõ trong UI cho field này — sửa trực tiếp qua REST API
(`DremioClient`'s `_headers()` tái dùng, `PUT /api/v3/catalog/{id}` để set
`config.database=agents_db` cho source có sẵn, `POST /api/v3/catalog` để
tạo thêm 1 source `workflows_db` trỏ cùng `dummy-mysql:3306`). Sync lại
sau đó: **9 bảng, 125 cột**, reindex đầy đủ.

## Dữ liệu dummy để test full flow

`docs/schema/mysql-dump-agents_db-workflows_db-20260908-103638.sql` — đã
load thật vào 1 container MySQL 8.4 riêng (`dummy-mysql`, port host `3308`,
user `root`/`dummy_root_pw`), nối chung network `docker_default` với
Dremio (Dremio phân giải được `dummy-mysql` qua DNS nội bộ, xác nhận
thật). 2 database: `agents_db` (53 agents, 521 conversations...),
`workflows_db` (77 workflows, 851 workflow_nodes...) — đủ lớn để test
`analyze_data` thật.

**Container này KHÔNG có trong `docker-compose.dev.yml`** (chạy tay bằng
`docker run`, chỉ để test — không phải hạ tầng chính thức của app).

**Lỗi thật gặp phải + đã fix**: Dremio báo "Could not connect... check your
JDBC connection information" khi thêm source — nguyên nhân là MySQL 8.4 mặc
định dùng `caching_sha2_password`, driver JDBC Dremio bundle chỉ hỗ trợ
`mysql_native_password` (plugin này bị TẮT mặc định ở MySQL 8.4, cần cờ
khởi động `--mysql-native-password=ON`). Đã tạo lại container với cờ đó +
`ALTER USER 'root'@'%' IDENTIFIED WITH mysql_native_password`.

**Lỗ hổng thật thứ 2 tìm thấy khi giải thích `MEILISEARCH_*` cho user**:
`sync_dremio_metadata` chỉ ghi sqlite (data_sources/entities/entity_columns)
— KHÔNG tự đẩy dữ liệu vào Meilisearch. App gốc có route
`/api/embeddings/reindex` (`embedding_index.py::reindex_all`) nhưng UI gốc
CŨNG chưa từng gọi nó — nghĩa là sync "thành công" nhưng mọi entity vẫn vô
hình với retrieval, `analyze_data` sẽ luôn báo không tìm thấy bảng dù data
có thật trong sqlite. Fix: `admin_runner.py`'s `op: "sync"` giờ LUÔN gọi
`reindex_all` ngay sau `sync_dremio_metadata` (1 hành động thay vì 2), trả
thêm `reindex_summary` — FE hiện luôn cả 2 dòng tóm tắt. Cũng phát hiện +
sửa kèm: `MEILISEARCH_*` chưa từng được forward vào subprocess admin bridge
(`data-studio-bridge.ts`'s `FORWARDED_ENV`) — trước đó âm thầm rơi về default
của `Settings` (tình cờ trùng giá trị `.env` nên chưa lộ ra).

## Không mang theo (nhất quán với transfer-plan.md)

- Auth 1-user, `/api/ask*` (SSE) cũ, embeddings/profiling admin routes nếu
  không thật sự cần cho MVP mỗi mục (profiling có thể làm placeholder ở
  entity detail cho tới khi cần thật).
- Verified queries, business processes, query log — bảng tồn tại trong
  schema nhưng không có mục sidebar nào cần tới ở phase này.
