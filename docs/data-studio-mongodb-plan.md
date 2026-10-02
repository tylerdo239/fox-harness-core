# Kế hoạch liên kết Data Studio với MongoDB

> **Trạng thái (2026-09-29):** đã triển khai trong code (gateway, orchestrator, tool TS, frontend, lớp
> Python, compose/env) và qua hai smoke test trên MongoDB thật (mục 13). **Chưa kiểm chứng:** build ảnh worker
> Docker, chạy đủ luồng `analyze_data` với LLM/Dremio/Meilisearch thật, và chạy trên staging.
> Nguồn tham khảo: `examples/bot-data-studio-api-main` (bản Mongo) và `examples/example-data-studio-agent` (bản SQLite).

## 0. Tóm tắt

- **Hiện trạng:** semantic layer của Data Studio (data source, entity, cột, quan hệ, metric, glossary,
  hội thoại/chart, dashboard) nằm trong **một file SQLite** (`semantic_layer.db`) dùng chung cho
  gateway (Node, `better-sqlite3`) và mọi worker container (Python, SQLModel) qua bind mount
  `data/data-studio-shared`. Không có DB server nào cho phần này.
- **Điều chỉnh về nguồn tham khảo:** `examples/example-data-studio-agent` **không có Mongo** (vẫn là
  SQLite/SQLModel, chính là bản đã vendor vào repo). Phần đã chuyển sang MongoDB là
  **`examples/bot-data-studio-api-main`** (`bot-data-studio-api`, GitLab FPT). Kế hoạch dưới đây bám theo bản đó.
- **Hướng đề xuất:** chuyển toàn bộ lưu trữ Data Studio sang MongoDB theo đúng thiết kế của
  `bot-data-studio-api` (mỗi bảng → một collection, `_id` là `uuid4` chuỗi, timestamp UTC, không
  transaction), nhưng phải xử lý thêm ba điểm mà bản đó không có: **gateway Node cũng đọc/ghi
  semantic layer**, **worker chạy trong container**, và **đang có dữ liệu curate tay** cần mang sang.
- **Cách làm tiết kiệm nhất:** phần Python gần như đã có sẵn ở bot (khoảng 20 file đã port). Fox chủ yếu
  là *đồng bộ* các file đó vào `packages/tool/data-studio-agent/python`, rồi viết lại lớp Node và đổi kiểu id ở frontend.
- **Nên làm một lượt, không dừng giữa chừng:** chính plan của bot cảnh báo rằng dừng ở giữa
  (sync/reindex đã ghi Mongo nhưng pipeline vẫn đọc SQL) làm `/ask` hỏng hoàn toàn (mục 2.3).

## 1. Hiện trạng trong repo này

### 1.1 Ai đọc/ghi semantic layer

| Thành phần | Truy cập | Ghi chú |
|---|---|---|
| `services/gateway/src/data-studio-db.ts` (~700 dòng, 33 hàm export) | `better-sqlite3` mở thẳng file, WAL | CRUD data source, entity, cột, glossary, relationship, metric, dashboard, widget. Có bảng ánh xạ enum tên↔giá trị vì SQLAlchemy lưu **tên** enum (`COUNT`) chứ không phải giá trị (`count`). |
| `services/gateway/src/data-studio-bridge.ts` → `bridge/admin_runner.py` | Python, mỗi request một process | `browse`, `sync` (kèm reindex Meilisearch). |
| `bridge/runner.py` (một process/container) | SQLModel, `DATABASE_URL=sqlite:////data-studio-shared/semantic_layer.db` | Đọc semantic layer trong pipeline; ghi chuỗi Conversation→Message→QueryResult→Chart tối thiểu để chart ghim được vào dashboard. |
| Orchestrator (`docker.ts`) | Bind mount `data-studio-shared` vào **mọi** container, ép `DATABASE_URL` | Tạo thư mục bằng process host để host sở hữu file. |

### 1.2 Vì sao SQLite dùng chung không còn phù hợp

1. **Nhiều tiến trình ghi vào một file qua ranh giới host/container.** Gateway (host) và N worker
   (container) cùng mở một file, gateway bật WAL. WAL cần shared memory; qua bind mount của Docker Desktop
   điều này không được đảm bảo. *Chưa kiểm chứng trong repo này*, nhưng đây là rủi ro tiêu chuẩn và sẽ tăng khi lên nhiều node.
2. **Không mở rộng ngang.** Bind mount một thư mục host chỉ có nghĩa trên một máy. Trong `README.md`
   phần Deployment đã ghi chưa có hướng staging/prod; file SQLite chung sẽ chặn hướng nhiều VM.
3. **Đã gặp lỗi lệch enum** giữa Node và Python (comment ở đầu `data-studio-db.ts`). Hai ngôn ngữ ghi cùng một schema mà không có hợp đồng dữ liệu chung.
4. **Dữ liệu tăng không kiểm soát.** DB đang chạy có 199 dòng `charts_chat` (mỗi câu trả lời có chart tạo một chuỗi 4 bản ghi) và không có dọn dẹp.
5. **Không có phân quyền ở tầng DB.** Worker (chạy code do model điều khiển gián tiếp) có quyền ghi toàn bộ file, kể cả glossary/relationship.
6. **Id số nguyên tự tăng** gắn với một file duy nhất; không hợp khi đồng bộ hoặc dùng chung với `bot-data-studio-api`.

## 2. `bot-data-studio-api` đã làm gì

Nguồn: `examples/bot-data-studio-api-main/docs/superpowers/specs/2026-09-17-mysql-to-pymongo-design.md`
và 5 plan (1, 2a, 2b, 2c, 2d), cộng code thật trong `src/`.

### 2.1 Thiết kế đã chốt (bản gốc chuyển từ SQLModel/MySQL sang PyMongo)

| Quyết định | Nội dung |
|---|---|
| Chế độ | Chia pha, Mongo chạy song song lớp SQL, chuyển từng route, xoá lớp cũ ở cuối (cutover). |
| Dữ liệu cũ | **Không mang sang.** Bắt đầu mới, xoá SQLite dev khi cutover. |
| Quan hệ | Tham chiếu bằng id, mỗi bảng một collection (không nhúng), giữ nguyên hình dạng FK. |
| Id | `uuid4()` dạng chuỗi làm `_id` (không `ObjectId`, không bộ đếm). |
| Timestamp | Mọi document có `created_at`/`updated_at` (UTC). |
| Cascade/transaction | **Không có transaction.** 4 chuỗi cascade (`Dashboard→Widget`, `Conversation→Message→QueryResult→Chart`) thành xoá con trước, cha sau, ghi tuần tự, best-effort. |
| Khởi động | Bỏ `create_db_and_tables()`, thay bằng `check_mongo_connection()` ở `lifespan`. |
| Client | `pymongo.MongoClient` **đồng bộ**, một singleton. |

### 2.2 Code thực tế (đã đọc)

- `src/database/mongodb.py`: bọc `AttrDict`/`AttrCursor`/`AttrCollection`/`AttrDatabase` để document hỗ trợ cả
  `doc["field"]` lẫn `doc.field`, và `.id` là bí danh của `_id`. Lý do: toàn bộ pipeline vốn viết theo đối tượng SQLModel (`.field`).
  Giới hạn: chỉ lớp trên cùng được bọc; subdocument vẫn là `dict` thường.
- `src/crud_mongo/*.py` (10 file, mỗi file là hàm thuần trên dict): `data_source`, `entity`, `entity_column`,
  `relationship` (kèm column pair), `business_glossary`, `metric`, `verified_query`, `conversation`
  (kèm message/query_result/chart), `dashboard` (kèm widget), `_shared` (`new_id`, `utcnow`).
- `src/settings.py`: `mongodb_url` nhận biến `MongoDBWrite` do Vault chèn vào (`AliasChoices("MongoDBWrite", "mongodb_url")`), và `mongodb_database_name` mặc định `bot_data_studio`.
- `src/utils/vault_config.py`: đọc `/vault/secrets/configuration.<env>.json` khi chạy trên hạ tầng FPT.
- `docker-compose.yml`: `mongo:7`, bind `127.0.0.1:27017`, healthcheck `mongosh ping`, **không** replica set.
- Pipeline đã port: `schema_linking`, `sql_validator`, `query_execution`, `profiling`, `dremio_sync`,
  `embedding_index`, `pipeline_v2/{state,step6_joins,templates,step8_generate}`,
  `pipeline_v3/{resolve,agents,orchestrator,run_slice,persistence}`. Mọi id `int` thành `str`.
- Các file v1/v2 không còn dùng bị **xoá hẳn** ở plan 2d (plan cutover), nên cây code của bot gọn hơn bản vendor của fox.

### 2.3 Điểm rút ra từ các plan (bài học dùng lại)

1. **Không được triển khai nửa chừng.** Plan 2a ghi rõ: sau 2a, sync/reindex ghi vào Mongo với id chuỗi nhưng `schema_linking` vẫn resolve trên MySQL với id số, nên `/ask` không thấy dữ liệu mới. Plan 2b ghi: sau 2b, `/ask`, `/ask_v2`, `/ask_v3` **hỏng hoàn toàn** cho tới khi 2c vào. Kết luận: trong fox, lớp Python + Node + frontend phải lên cùng một release.
2. **Profiling phải đi cùng lõi truy vấn** vì `grounding` gọi `profile_entity` giữa chừng.
3. **Ghi nhiều document là tuần tự, không nguyên tử.** Thất bại giữa chừng để lại dữ liệu dở; bot chấp nhận.
4. **Không có index nào ngoài `_id`** (không thấy `create_index` trong `src/`). Ổn với dữ liệu nhỏ, cần bổ sung nếu lớn.
5. **Không có bộ test.** Bot không có test suite để giữ lại hoặc port.
6. **Không có script mang dữ liệu.** Chỉ có `scripts/migrate_*` nhỏ cho SQLite cũ. Fox cần tự viết (mục 7).

## 3. Các quyết định cần chốt trước khi làm

| # | Câu hỏi | Lựa chọn | Đề xuất |
|---|---|---|---|
| D1 | Fox dùng **cùng database** với `bot-data-studio-api` hay database riêng? | (a) dùng chung `bot_data_studio`; (b) cùng cluster nhưng database riêng, ví dụ `fox_data_studio`. | **(b)** lúc đầu. Tránh hai app cùng sửa một semantic layer khi hai bên chưa thống nhất schema. Chuyển sang (a) sau nếu muốn một nguồn sự thật, khi đó chỉ đổi `mongodb_database_name` và chạy reindex Meili. |
| D2 | Gateway Node truy cập Mongo thế nào? | (a) driver `mongodb` của Node, viết lại `data-studio-db.ts`; (b) mọi CRUD gọi qua bridge Python; (c) dựng một service Python nhỏ có API. | **(a).** (b) tốn một process Python cho mỗi thao tác chỉnh sửa; (c) thêm service mới. Rủi ro của (a) là hai ngôn ngữ cùng ghi một schema, nên bắt buộc có hợp đồng dữ liệu (mục 4.3). |
| D3 | Có mang dữ liệu SQLite hiện tại sang không? | Bot chọn "không". Fox đang có 9 entity, 125 cột, 1 metric, 1 glossary đã curate tay. | **Có**, bằng script một lần (mục 7). Dữ liệu nhỏ nên rẻ, mà curate lại role/grain/synonym rất tốn công. |
| D4 | Client Python đồng bộ hay bất đồng bộ? | (a) `MongoClient` đồng bộ như bot; (b) async. | **(a)** trước để giảm rủi ro và bám bot. Pipeline đã chặn event loop khi gọi Dremio/Meili (đồng bộ), nên không tệ hơn. Cân nhắc async sau. |
| D5 | Tên collection | Bot: `conversations`, `messages`, `query_results`, `charts`, `dashboards`, `dashboard_widgets`. Fox hiện: `*_chat`. | Dùng **tên của bot** để có thể dùng chung DB (D1) sau này. Script di trú lo phần đổi tên. |
| D6 | Nơi giữ thông tin đăng nhập Mongo | Dev: `.env`. Prod FPT: Vault (`MongoDBWrite`). | Cùng cơ chế: nhận cả `MONGODB_URL` lẫn `MongoDBWrite`. Không đưa URI có mật khẩu vào git. |
| D7 | Có siết phân quyền ghi semantic layer trong cùng đợt này không? | Hiện mọi user đăng nhập ghi được. | **Có** (mục 8). Việc di trú chạm đúng các route này nên chi phí thêm nhỏ. |

## 4. Kiến trúc đích

```
Browser ── HTTPS/WS ──> gateway (Node)
                          ├─ mongodb driver ──────────────┐   CRUD semantic layer (admin UI)
                          └─ spawn admin_runner.py ───────┤   browse / sync / reindex / profile
                                                          ▼
worker container (Python runner.py) ── pymongo ──────> MongoDB
   đọc semantic layer, ghi conversations/charts          ▲
Meilisearch (id = uuid chuỗi) <── reindex ───────────────┘
Dremio: giữ nguyên (dữ liệu nghiệp vụ, không đổi)
```

Thay đổi so với hiện tại: bỏ bind mount `data-studio-shared` và biến `DATABASE_URL=sqlite:///...`; thêm `MONGODB_URL` vào danh sách biến chuyển vào container (nhớ `rewriteLoopbackForContainer` đổi `127.0.0.1` thành `host.docker.internal`, đúng bài học đã ghi trong `docker.ts`).

### 4.1 Mô hình dữ liệu (theo bot, cộng index đề xuất)

Mọi document: `_id: string(uuid4)`, `created_at`, `updated_at` (UTC). Enum lưu **giá trị** (`"count"`, `"1:N"`), nên hết lỗi lệch tên/giá trị.

| Collection | Trường chính | Index đề xuất |
|---|---|---|
| `data_sources` | name, source_type, dremio_path, status, last_synced_at, is_exposed_to_agent | unique `name` |
| `entities` | data_source_id, physical_path, physical_name, entity_type, display_name, description, synonyms[], grain_description, is_exposed, is_pii, is_deprecated, row_count_est, last_profiled_at, embed_text | unique `(data_source_id, physical_name)`; `(data_source_id, is_deprecated)`; `(is_exposed, is_deprecated)` |
| `entity_columns` | entity_id, physical_name, data_type, ordinal, display_name, role, semantic_type, default_aggregation, value_glossary{}, is_exposed, is_pii, is_default_select, is_deprecated, sample_values[], min/max, null_ratio, distinct_count | unique `(entity_id, physical_name)`; `(entity_id, is_deprecated, ordinal)` |
| `relationships` | from_entity_id, to_entity_id, cardinality, join_type_default, is_curated | `from_entity_id`; `to_entity_id` |
| `relationship_column_pairs` | relationship_id, from_column_id, to_column_id, seq | `(relationship_id, seq)` |
| `metrics` | name, description, synonyms[], base_entity_id, aggregation, measure_column_id, grain, unit, is_verified | `name` |
| `business_glossary` | term, synonyms[], definition_text, sql_expressions[], related_entity_ids[] | `term` |
| `verified_queries` | nl_question, sql, is_verified, embed_text | `is_verified` |
| `conversations` | title | `updated_at` giảm dần |
| `messages` | conversation_id, seq, role, content, question, answer_markdown, is_decomposed, follow_up_questions_json | unique `(conversation_id, seq)` |
| `query_results` | message_id, seq, sub_id, sub_question, sql, row_count, rows_json, display_columns_json | `(message_id, seq)` |
| `charts` | query_result_id, type, title, x, y_json, value_field, recommended, rows_json, transform_code, các `*_override*`, is_pinned | `query_result_id` |
| `dashboards` | title, description, appearance_json | `updated_at` giảm dần |
| `dashboard_widgets` | dashboard_id, seq, kind, chart_id, x/y/w/h, title_override, note, text, config_json | `(dashboard_id, seq)` |

Lưu ý: bản ghi `charts`/`query_results` chứa `rows_json` (tối đa vài trăm dòng). Giới hạn document 16 MB là đủ, nhưng nên có TTL hoặc job dọn cho `conversations` tạo từ `analyze_data` (mục 6, pha 5). `query_log`, `business_process` có model nhưng chưa thấy pipeline v3 dùng; bỏ qua ở đợt đầu.

### 4.2 Bốn nguyên tắc truy cập dữ liệu

1. **Một nơi định nghĩa schema thật:** file mô tả collection nằm trong repo (mục 4.3), cả Python và Node đọc theo đó.
2. **Không dùng transaction**, giữ đúng quyết định của bot. Thứ tự xoá: con trước, cha sau; ghi chuỗi Conversation→Message→QueryResult→Chart tuần tự.
3. **Id luôn là chuỗi** từ tầng DB tới frontend.
4. **Tạo index lúc khởi động, idempotent** (`create_index` chạy lại vô hại) ở cả gateway lẫn `admin_runner.py`, để môi trường mới không cần bước tay.

### 4.3 Hợp đồng dữ liệu giữa Node và Python

Vì D2(a) khiến hai ngôn ngữ ghi cùng schema, cần:
- `docs/schema/data-studio-collections.md` (hoặc JSON Schema) liệt kê collection, trường, kiểu, enum giá trị, index. Đây là nguồn tham chiếu duy nhất.
- Bộ **fixture JSON** dùng chung: Python và Node cùng đọc/ghi các fixture đó trong test để phát hiện lệch.
- Kiểu TS cho từng collection sinh tay từ tài liệu trên (không import từ package `dsh-*`, đúng ranh giới `services/*` chỉ dùng `contracts`). Nếu cần dùng chung kiểu giữa gateway và web, đặt trong `packages/contracts`.

## 5. Thay đổi theo lớp

### 5.1 Python: `packages/tool/data-studio-agent/python`

Cách làm: **đồng bộ từ `examples/bot-data-studio-api-main/src` vào**, không tự viết lại. Bản vendor hiện tại là bản `example-data-studio-agent` (SQLModel) cộng hai thay đổi riêng của fox.

| Việc | File | Ghi chú |
|---|---|---|
| Thêm | `src/database/mongodb.py`, `src/crud_mongo/*` | Lấy nguyên từ bot. Thêm `ensure_indexes()`. |
| Thay bằng bản Mongo của bot | `services/{schema_linking,sql_validator,query_execution,profiling,dremio_sync,embedding_index}.py`, `pipeline_v2/{state,step6_joins,templates,step8_generate}.py`, `pipeline_v3/{resolve,agents,orchestrator,run_slice,persistence}.py` | Mỗi file bot đã đổi `Session` thành `AttrDatabase` và `int` thành `str`. |
| Giữ thay đổi riêng của fox | `pipeline_v3/orchestrator.py` | Fox chỉ thêm hàm `_trace()` (đẩy log trực tiếp ra stderr). Khi lấy bản bot phải **áp lại** thay đổi này; bản bot và bản example khác nhau khoảng 217 dòng nên không nên chép đè. |
| Sửa | `bridge/runner.py`, `bridge/admin_runner.py` | Thay `Session(engine)` bằng `get_mongo_db()`. `_persist_chart` dùng `crud_mongo.conversation`. Thêm op `profile` và `reindex` vào `admin_runner` (xem 5.2). Thay `create_db_and_tables()` bằng `check_mongo_connection()` + `ensure_indexes()`. |
| Sửa | `src/settings.py` | Thêm `mongodb_url` (alias `MongoDBWrite`) và `mongodb_database_name`; bỏ `database_url`. Không kéo phần auth/JWT của bot vào (fox có gateway lo). |
| Xoá khi cutover | `database/engine.py`, `database/models/*` (chỉ giữ `enums.py`), `pipeline_v2/{combine_results,decompose_*,derive,enrich_*,orchestrator,persistence,step0..5,7,9}.py`, `services/{clarify,decompose,grounding,join_path,pipeline,pipeline_events,pipeline_types,plan}.py` | Bot đã xoá nhóm này ở plan 2d. Pipeline v3 của fox không gọi chúng (đã xác nhận: `run_step7` chỉ nằm trong v2). |
| Dependency | `pyproject.toml` | Thêm `pymongo>=4.9`; bỏ `sqlmodel` khi cutover. Chạy lại `uv lock` và rebuild ảnh worker. `chromadb` vẫn còn vì một type annotation (đã ghi trong tài liệu hiện có). |

### 5.2 Nhân tiện: đường profiling còn thiếu

Trong fox hiện không có đường nào chạy `profile_entity` (nó chỉ được `grounding.py` của pipeline v1 gọi). Entity mới sync không có `sample_values`, `row_count_est`, min/max, nên `column_values`, `_find_category_column`, kiểm tra fan-out không hoạt động (DB đang chạy có dữ liệu do nạp bằng cách khác). Bot đã có route profiling. Đề xuất thêm op `profile` vào `admin_runner.py` và một nút trong màn Data Sources, cùng đợt.

### 5.3 Gateway Node: `services/gateway`

- Thêm dependency `mongodb`; bỏ `better-sqlite3` khi cutover (đồng thời bỏ mục tương ứng trong `pnpm-workspace.yaml` `allowBuilds`).
- Viết lại `data-studio-db.ts` (33 hàm) sang collection Mongo. Hàm đồng bộ (`better-sqlite3`) thành hàm `async`, kéo theo đổi các route trong `index.ts` từ gọi thẳng sang `await`.
- Bỏ toàn bộ bảng ánh xạ enum tên↔giá trị (không còn cần).
- Các hàm ghép nhiều bảng phải viết lại thành nhiều truy vấn: `listRelationships` (kèm column pair), `listBrowseEntities`, `listWidgets`, `deleteDashboard` (xoá widget trước), `createMetric` (kiểm tra entity/cột).
- Regex id trong route đổi từ `(\d+)` sang UUID; `Number(...)` bỏ; kiểm tra `typeof body.chart_id !== 'number'` đổi sang chuỗi.
- `config.ts`: thêm `mongodbUrl`, `mongodbDatabaseName`; bỏ `dataStudioSharedDir`.
- `data-studio-bridge.ts`: bỏ dòng tự dựng `DATABASE_URL`, truyền `MONGODB_URL` (và `MongoDBWrite` nếu có).

### 5.4 Orchestrator: `services/orchestrator`

- `config.ts`: thêm `MONGODB_URL` và `MONGODB_DATABASE_NAME` vào `workerEnvPassthrough`; bỏ `dataStudioSharedDir`.
- `docker.ts`: bỏ `mkdir` và bind `data-studio-shared`, bỏ `DATABASE_URL=sqlite:///...`. Giữ `rewriteLoopbackForContainer` áp dụng cho `MONGODB_URL` (Mongo dev chạy trên host).
- Trên Linux Docker Engine (không phải Docker Desktop) cần `--add-host=host.docker.internal:host-gateway`; `docker.ts` đã ghi chú, cần bật khi triển khai.

### 5.5 Tool TS: `packages/tool/data-studio-agent/src`

- `index.ts`: `chart_id` trong schema output từ `integer` thành `string`; `presentationMeta` cập nhật tương ứng.
- `kernel.ts`: `AnalyzeReply.chart_id?: string | null`, thêm `MONGODB_URL`/`MongoDBWrite` vào `FORWARDED_ENV`, bỏ `DATABASE_URL`.

### 5.6 Frontend: `apps/web`

- Các màn `DataStudioDataSources`, `Glossary`, `Metrics`, `Relationships`, `Dashboards` và `PinToDashboardButton` trong `Conversation.tsx` dùng `id: number` cho entity/cột/metric/relationship/dashboard/widget. Đổi sang `string` (kể cả state form kiểu `number | ""`).
- Không đổi hành vi hiển thị, chỉ đổi kiểu và cách so sánh id.

### 5.7 Hạ tầng

- `infra/docker/docker-compose.dev.yml`: thêm service `mongo` (`mongo:7`, `127.0.0.1:27017`, healthcheck `mongosh ping`, volume `fox-harness-mongo-data`), giống bot. Không replica set (chưa cần transaction).
- `.env.example`: thêm `MONGODB_URL`, `MONGODB_DATABASE_NAME`; xoá ghi chú `DATABASE_URL` của SQLite.
- Dockerfile worker: không đổi nhiều; cần build lại vì `uv.lock` đổi.
- `README.md`, `docs/core-overview.md`, `packages/tool/data-studio-agent/README.md`: cập nhật mô tả "semantic layer dùng chung SQLite".

## 6. Lộ trình theo pha

Mỗi pha có tiêu chí nghiệm thu; pha 1-4 nằm trên một nhánh và chỉ gộp khi qua pha 4 (bài học mục 2.3).

| Pha | Việc | Nghiệm thu |
|---|---|---|
| **0. Chốt** | Chốt D1-D7. Cấp Mongo dev (compose) và, nếu dùng cluster FPT, tạo database + hai user (mục 8). | Có URI chạy được; quyết định ghi vào tài liệu này. |
| **1. Lớp Python** | Đồng bộ code từ bot theo bảng 5.1; áp lại `_trace()`; thêm `ensure_indexes()`; viết `admin_runner` op `profile`. Cờ `DATA_STUDIO_STORE=sqlite|mongo` cho phép chạy song song trong nhánh. | Chạy `sync` → `reindex` → `analyze_data` với một câu hỏi thật, ra SQL và câu trả lời như bản SQLite. |
| **2. Gateway Node** | Viết lại `data-studio-db.ts`, đổi route sang `async`, regex id, bỏ ánh xạ enum. | Mọi thao tác admin hiện có (5 màn) chạy trên Mongo; tạo/sửa/xoá dashboard và widget đúng cascade. |
| **3. Tool + Frontend + Orchestrator** | Đổi `chart_id` thành chuỗi, kiểu id ở 5 màn, biến môi trường, bỏ bind mount. | "Ghim vào dashboard" từ khung chat hoạt động end-to-end. |
| **4. Di trú dữ liệu + reindex** | Chạy script (mục 7), rồi `reindex` Meilisearch (xoá index cũ vì id đã đổi sang chuỗi). | Số lượng bản ghi khớp trước/sau; một bộ câu hỏi mẫu cho kết quả giống bản SQLite. |
| **5. Cutover + dọn dẹp** | Xoá lớp SQLModel và các file v1/v2 chết, bỏ `better-sqlite3`, bỏ bind mount, xoá `data/data-studio-shared`, cập nhật tài liệu. Thêm job dọn `conversations` cũ. | `pnpm run build` sạch, ảnh worker build được, không còn tham chiếu `sqlite`/`sqlmodel`/`data-studio-shared`. |

**Rollback:** đến hết pha 4, file SQLite vẫn nguyên (script di trú chỉ đọc), nên quay lại bằng cách trả cờ về `sqlite`. Sau pha 5 chỉ rollback được bằng `git revert` cộng khôi phục file SQLite đã sao lưu; vì vậy sao lưu file này trước pha 5.

## 7. Script di trú SQLite → MongoDB

Chạy một lần, đọc SQLite (chỉ đọc), ghi Mongo. Yêu cầu:

1. **Bản đồ id:** với mỗi bảng, đọc theo thứ tự phụ thuộc (`data_sources` → `entities` → `entity_columns` → `relationships` → `relationship_column_pairs` → `metrics` → `business_glossary` → `dashboards_chat`/`conversations_chat`/...), sinh `uuid4` mới cho từng dòng, giữ `map[bảng][id_cũ] = uuid`. Mọi FK và mọi mảng id (`related_entity_ids`, `measure_column_id`, `base_entity_id`, `chart_id`) phải qua bản đồ; **id không tìm thấy phải báo lỗi**, không bỏ qua im lặng.
2. **Enum:** SQLite lưu **tên** enum (`CONNECTED`, `TABLE`, `COUNT`); Mongo lưu **giá trị** (`connected`, `table`, `count`). Dùng bảng ngược của `enums.py` (`data-studio-db.ts` đã có sẵn bảng này để tham khảo).
3. **Trường JSON** (`synonyms`, `sample_values`, `value_glossary`, `sql_expressions`, `rows_json`, `y_json`...): parse chuỗi JSON thành mảng/đối tượng gốc; không lưu chuỗi lồng chuỗi.
4. **Đổi tên collection** `*_chat` → tên của bot (D5).
5. **Timestamp:** giữ `created_at` nếu có, ngược lại đặt lúc chạy; luôn đặt `updated_at`.
6. **Idempotent:** khoá theo `(collection, id_cũ)` lưu trong collection tạm `_migration_map` để chạy lại không nhân đôi.
7. **Báo cáo:** in số dòng đọc/ghi từng bảng và các dòng bị bỏ; dừng nếu lệch.
8. **Sau khi ghi:** gọi `reindex` để Meilisearch chứa id mới.
9. **Dọn `charts_chat`:** cho phép cờ `--skip-conversations` vì 199 dòng đó chủ yếu là dữ liệu thử; nhưng phải giữ mọi chart đang được `dashboard_widgets` tham chiếu.

## 8. Bảo mật và phân quyền (làm cùng đợt)

- **Hai user Mongo:** `fox_ds_worker` (đọc các collection semantic layer; đọc/ghi `conversations`, `messages`, `query_results`, `charts`) dùng cho container; `fox_ds_admin` (đọc/ghi tất cả) dùng cho gateway và `admin_runner`. Worker bị lộ hoặc bị điều khiển không sửa được glossary/relationship.
- **Thông tin đăng nhập:** không đưa vào git, không đưa vào ảnh Docker; truyền qua env (dev) hoặc Vault (prod, `MongoDBWrite`).
- **Mạng:** Mongo chỉ nghe nội bộ (dev: `127.0.0.1`); prod cần TLS và không mở ra ngoài (cùng yêu cầu topology như Redis/orchestrator ở phần Security posture của `README.md`).
- **Phân quyền ghi semantic layer (D7):** hiện mọi user đăng nhập ghi được. Đề xuất chỉ role `admin` ghi `/data-studio/*` (đọc thì mọi user). Đặc biệt `business_glossary.sql_expressions`: pipeline chèn thẳng vào WHERE dưới dạng SQL thô và validator bỏ qua các đoạn đó, nên chỉ admin được ghi và nên kiểm tra nội dung (chỉ cho biểu thức trên các cột thuộc entity liên quan) trước khi lưu. Chi tiết nguy cơ nằm ở phân tích pipeline trước đó; đây là chỗ hợp lý để đóng nó.
- **Không log URI Mongo** kể cả khi lỗi kết nối (bot in `logger.error(f"...{e}")`; kiểm tra thông điệp lỗi không chứa mật khẩu).

## 9. Kiểm thử và xác minh

Bot không có test; fox nên có tối thiểu:

1. **Contract test Node↔Python:** cùng fixture JSON (mục 4.3) được Node ghi rồi Python đọc và ngược lại; so sánh enum, kiểu id, mảng.
2. **Test `crud_mongo`** chạy trên Mongo thật (compose), không mock: cascade xoá, unique index, `next_message_seq`, `best_label_column` (điều kiện `role $nin ["key", null]`).
3. **So sánh bản SQLite và bản Mongo** trên cùng bộ câu hỏi mẫu (đếm, ranking, share, threshold, multi-part): SQL sinh ra và số dòng phải giống. Đây là kiểm tra hồi quy chính vì pipeline nhạy với thứ tự cột/id.
4. **Kiểm tra id chuỗi ở mọi chỗ so sánh:** các đoạn như `used_cols` (`c.id in used_cols`), `state.target_entity_ids`, `sorted(...)` theo id không được giả định số.
5. **Kiểm tra đồng thời:** nhiều worker cùng ghi `conversations`, gateway cùng lúc sửa glossary.
6. **Smoke test container:** worker trong Docker Desktop kết nối được Mongo trên host qua `host.docker.internal`.
7. **Kiểm tra cutover:** `grep` không còn `sqlite`, `sqlmodel`, `better-sqlite3`, `data-studio-shared`, `DATABASE_URL` liên quan Data Studio.

## 10. Rủi ro

| Rủi ro | Mức | Giảm thiểu |
|---|---|---|
| Lệch schema giữa Node và Python (lặp lại lỗi enum đã gặp) | Cao | Hợp đồng dữ liệu + fixture chung + enum lưu giá trị (mục 4.3). |
| Triển khai nửa chừng làm `analyze_data` hỏng | Cao | Một nhánh, gộp sau pha 4; cờ `DATA_STUDIO_STORE` trong nhánh. |
| Áp bản bot làm mất chỉnh sửa riêng của fox (`_trace`) | Trung bình | Diff từng file trước khi thay; hiện chỉ `orchestrator.py` khác. |
| Nhiều truy vấn nhỏ (N+1) chậm hơn SQLite cục bộ: `_entity_by_table`, `_exact_name_entity_ids`, `NameResolver.from_retrieval`, vòng lặp cột theo entity | Thấp-Trung bình | Dữ liệu nhỏ, thời gian LLM (hàng trăm giây) lấn át; nếu cần, cache theo lượt chạy và dùng `$in` gom truy vấn. |
| Ghi nhiều document không nguyên tử để lại chuỗi conversation dở | Thấp | Chấp nhận như bot; job dọn bản ghi mồ côi. |
| Mất dữ liệu curate tay | Trung bình | Script di trú chỉ đọc, sao lưu file SQLite, đối chiếu số lượng. |
| Index Meilisearch cũ chứa id số | Trung bình | Xoá và reindex ở pha 4. |
| Bot và fox lệch nhau về sau (hai bản vendor) | Trung bình | Ghi nguồn gốc và commit tham chiếu của bản bot vào README của package; xem `docs/upstream-upgrade-policy.md`. |
| PyMongo đồng bộ chặn event loop | Thấp | Đã như Dremio/Meili; cân nhắc `AsyncMongoClient` sau. |

## 11. Ước lượng (thô, một người quen codebase)

| Pha | Ước lượng |
|---|---|
| 0 | 0,5 ngày |
| 1 (Python) | 2-3 ngày |
| 2 (Gateway) | 2-3 ngày |
| 3 (Tool/FE/Orchestrator) | 1-1,5 ngày |
| 4 (Di trú + reindex + so sánh) | 1-2 ngày |
| 5 (Cutover + dọn + tài liệu) | 1 ngày |
| **Tổng** | **khoảng 8-11 ngày** |

Đây là ước lượng chưa kiểm chứng; phần biến động lớn nhất là pha 2 (viết lại 33 hàm, gồm các hàm ghép nhiều bảng) và bước so sánh hồi quy ở pha 4.

## 12. Ngoài phạm vi

- Transaction nhiều document (cần replica set; bot cũng từ chối).
- Thay đổi hợp đồng API bên ngoài của gateway (chỉ đổi kiểu id).
- Đổi Dremio, Meilisearch, embedding, hoặc logic pipeline.
- Chuyển các bảng MariaDB của gateway (`discovery_users`, `discovery_sessions`, `discovery_projects`, `discovery_custom_skills`) sang Mongo. Đây là hệ thống lưu trữ khác, không thuộc kế hoạch này.
- Dùng chung DB thật sự với `bot-data-studio-api` (D1-a); để sau khi hai bên thống nhất schema.

## 13. Đã triển khai và cách kiểm thử local

### 13.1 Đã làm (Node/TS/FE/hạ tầng)

| Phần | Thay đổi |
|---|---|
| Gateway | `src/mongo.ts` mới (client, `ensureIndexes`, `checkMongoConnection`); `data-studio-db.ts` viết lại sang Mongo (bất đồng bộ, id chuỗi, enum lưu giá trị); `index.ts` đổi sang `await`, id route `([^/]+)`, kiểm tra kiểu chuỗi, gọi kiểm tra kết nối + tạo index lúc khởi động (không chặn boot); `config.ts` thay `dataStudioSharedDir` bằng `mongodbUrl`/`mongodbDatabaseName`; `data-studio-bridge.ts` truyền `MONGODB_URL`/`MONGODB_DATABASE_NAME`; bỏ `better-sqlite3`, thêm `mongodb`. |
| Orchestrator | Bỏ bind mount `data-studio-shared` và `DATABASE_URL`; thêm `MONGODB_URL`, `MongoDBWrite`, `MONGODB_DATABASE_NAME` vào danh sách biến chuyển vào container (loopback tự đổi sang `host.docker.internal`). |
| Tool TS | `chart_id` thành chuỗi; `kernel.ts` chuyển tiếp biến Mongo thay `DATABASE_URL`. |
| Frontend | Id của 5 màn Data Studio và nút "ghim dashboard" đổi `number` thành `string`. |
| Hạ tầng | Service `mongo` trong `docker-compose.dev.yml`; `.env.example` có `MONGODB_URL`/`MONGODB_DATABASE_NAME`. |
| Kiểm thử | `scripts/smoke-data-studio-mongo.mjs` (mục 13.3). |

Quyết định đã áp dụng (mặc định của mục 3, chưa được bạn xác nhận): dùng tên collection của bot (D5); Node dùng driver `mongodb` trực tiếp (D2); tên database mặc định `bot_data_studio` (trùng mặc định của bot) và đổi bằng `MONGODB_DATABASE_NAME` hoặc tên DB trong URI (D1); script di trú SQLite→Mongo (D3) đã có (mục 13.2b) để mang dữ liệu local; staging đã có dữ liệu trong Mongo nên không cần chạy ở đó.

**Lưu ý hợp đồng dữ liệu phía gateway:** JSON trả về frontend giữ nguyên hình dạng cũ (boolean là 0/1, các trường mảng là chuỗi JSON) để không phải sửa logic frontend; chỉ id đổi kiểu. Trong Mongo mọi thứ lưu dạng gốc (boolean, mảng).

### 13.2 Lớp Python (đã làm)

- Chép các file đã port từ bot (17 file + `crud_mongo/` + `database/mongodb.py`); hàm `_trace()` của fox được áp lại trong `pipeline_v3/orchestrator.py` (diff còn lại so với bản bot chỉ là `_trace`).
- `settings.py`: `mongodb_url` (alias `MongoDBWrite`) và `mongodb_database_name`; bỏ `database_url`.
- `database/mongodb.py`: thêm `ensure_indexes()` (khớp `ensureIndexes()` bên gateway).
- `bridge/runner.py`: dùng `get_mongo_db()`, ghi chuỗi conversation → message → query_result → chart bằng `crud_mongo`; `chart_id` là chuỗi. `bridge/admin_runner.py`: thêm op `reindex` và `profile` (profiling trước đây không có đường chạy nào).
- `pyproject.toml`/`uv.lock`: thêm `pymongo`, bỏ `sqlmodel`.
- Xoá 43 file không còn dùng (SQLModel, pipeline v1/v2 chỉ v2-step, services v1); `git rm`, khôi phục được từ git.
- Chưa làm: nút gọi op `profile` trên giao diện (gateway chưa có route cho op này); phân quyền ghi `/data-studio/*` (mục 8); cập nhật `docs/core-overview.md` và `docs/data-studio-agent-transfer-plan.md`.
- `apps/web/public/main.js` là bản build được commit; build lại đã đổi file này.

### 13.2b Di trú dữ liệu SQLite → MongoDB (đã có script)

`packages/tool/data-studio-agent/python/scripts/migrate_sqlite_to_mongo.py` — đọc file SQLite **chỉ đọc**, ghi Mongo. Idempotent (id là `uuid5` cố định theo `<bảng>:<id cũ>`, chạy lại chỉ ghi đè cùng document), đổi tên enum sang giá trị (`ONE_TO_MANY` → `1:N`), JSON/boolean/datetime sang kiểu gốc, đổi tên `*_chat` sang collection của bot, kiểm tra tham chiếu treo **trước** khi ghi, và từ chối target không phải localhost nếu thiếu `--allow-remote`.

```bash
cd packages/tool/data-studio-agent/python
uv run python scripts/migrate_sqlite_to_mongo.py --dry-run     # xem trước, không ghi
uv run python scripts/migrate_sqlite_to_mongo.py               # ghi thật
uv run python scripts/migrate_sqlite_to_mongo.py --skip-conversations   # bỏ lịch sử chat, giữ chart đã ghim
```

Không di trú: `query_log` (không module Mongo nào dùng) và `business_process` (rỗng). **Sau khi chạy phải reindex Meilisearch** (op `reindex` của admin bridge, hoặc nút đồng bộ ở Data Sources) vì chỉ mục cũ còn id số.

Đã chạy trên Mongo local (2026-09-29): 2 data source, 9 entity, 125 cột, 16 quan hệ (+16 cặp cột), 1 metric, 1 glossary, 78 hội thoại, 161 tin nhắn, 90 query result, 199 chart, 1 dashboard, 3 widget; số lượng khớp SQLite, chạy lần hai không nhân đôi, gateway (Node) và pipeline (Python) đều đọc và dựng được SQL từ dữ liệu đã di trú.

### 13.2c Giao diện chart và dashboard (clone từ UI gốc)

Đối chiếu `examples/example-data-studio-agent/ui` (chart-view, dashboards list / `[id]` / `[id]/edit`) và `bot-data-studio-api/src/apis/routes/dashboard.py`, chat.py:

| Flow gốc | Trong fox |
|---|---|
| Đổi kiểu biểu đồ ("Recommended visualizations") | `DataStudioAnswer.tsx`: thẻ chọn bar / pie / line / scatter / bảng, biểu đồ đề xuất đứng đầu; bảng dữ liệu là một chart thật (có `chart_id`, ghim và đổi nhãn được). |
| Edit fields (tên, trục X, chuỗi Y, nhãn) và Edit colors | `ChartDialogs.tsx`; lưu bằng `PATCH /data-studio/charts/:id` (`title_override`, `x_override`, `y_override`, `color_overrides`, `label_overrides`); rỗng (`''`, `[]`) là xoá override. Áp dụng ngay và lưu lại sau reload. |
| Thêm vào dashboard (chọn có sẵn hoặc tạo mới) | `AddToDashboardDialog`; `POST /data-studio/dashboards/:id/charts` (đặt widget 2 cột, đánh dấu `is_pinned`). |
| Danh sách dashboard | `GET /data-studio/dashboards` (kèm `widget_count` chỉ đếm chart còn tồn tại, `updated_at`), tạo, xoá (xác nhận ngay trên thẻ). |
| Báo cáo dashboard (theme, mật độ, kiểu thẻ, header) | `DataStudioDashboards.tsx` chế độ report; lưới 12 cột; 4 header, 4 theme, 3 mật độ, 3 kiểu thẻ. |
| Builder (kéo thả, resize, layout preset, text widget) | chế độ builder; "Xuất bản" gọi `PUT /data-studio/dashboards/:id/widgets` (cập nhật widget cũ, tạo mới, xoá widget không còn trong danh sách) rồi `PATCH` tiêu đề + appearance. |
| Lưu PDF | **Khác bản gốc:** bản gốc dựng PDF phía server (WeasyPrint, ảnh PNG do trình duyệt render). Fox in báo cáo bằng trình duyệt (`window.print()`, chọn "Save as PDF") với CSS in ẩn phần giao diện app; biểu đồ là SVG nên vẫn sắc nét. Chưa kiểm tra bản in trên trình duyệt thật. |

Các trường hợp được xử lý: chart cũ chưa có `rows_json` riêng dùng lại hàng của query result; widget có chart đã bị xoá tự biến mất khỏi báo cáo; animation của recharts tắt để bản in không bị vẽ dở.

**Chưa clone:** panel theo dõi từng bước pipeline khi đang chạy; chỉnh sửa chart ngay trong màn báo cáo dashboard; thẻ chọn cột hiển thị theo tiểu câu hỏi của câu hỏi tách nhiều phần; các màn Data Sources / Glossary / Metrics / Relationships chỉ có bản admin cũ (chưa đối chiếu lại với dialog của bản gốc).

### 13.3 Chạy thử local

Cần:

1. **Node 22.23.2** (`.nvmrc`). Máy này mặc định Node 21.7.1 nên `pnpm` từ chối chạy; dùng `nvm use` hoặc đặt `PATH` tới `~/.nvm/versions/node/v22.23.2/bin`.
2. **MongoDB**: `docker compose -f infra/docker/docker-compose.dev.yml up -d mongo` (không cần tài khoản, không cần replica set).
3. Biến môi trường (chỉ cần khi khác mặc định): `MONGODB_URL` (mặc định `mongodb://127.0.0.1:27017`), `MONGODB_DATABASE_NAME`.

Kiểm tra nhanh phần gateway (không cần Redis, MariaDB, MinIO, Dremio hay Meilisearch), dùng database tạm rồi tự xoá:

```bash
node --experimental-strip-types scripts/smoke-data-studio-mongo.mjs
```

Kết quả kỳ vọng: 9 dòng `ok`, cuối cùng `PASS — 9 checks`. Script không đụng vào `MONGODB_DATABASE_NAME`.

Kiểm tra lớp Python (cũng không cần LLM/Dremio/Meilisearch; dùng bản giả cho các dịch vụ đó):

```bash
cd packages/tool/data-studio-agent/python && uv sync && uv run python tests/smoke_mongo.py
```

Kết quả kỳ vọng: 10 dòng `ok`, cuối cùng `PASS — 10 checks` (sync, profiling, reindex, loader ứng viên, NameResolver, planning join, SQL + validator chặn cột PII, ghi chart).

Chạy đủ luồng: bật Redis, MariaDB, MinIO, Mongo, Meilisearch và Dremio bằng compose; `uv sync` trong thư mục Python; build lại ảnh worker (`docker build -f infra/docker/worker/Dockerfile -t fox-harness-worker:dev .`); khởi động orchestrator, gateway và web; vào màn Data Sources bấm đồng bộ Dremio (tự reindex Meilisearch), rồi hỏi một câu trong Data Studio. Cần thêm khoá `OPENAI_*` và `EMBEDDING_*` thật cho bước hỏi.

### 13.4 Triển khai staging

- Đặt `MONGODB_URL` (hoặc để Vault chèn `MongoDBWrite`) và `MONGODB_DATABASE_NAME` **giống** database mà staging đang dùng. Hai biến này phải có ở cả gateway lẫn orchestrator (orchestrator chuyển tiếp vào worker).
- Gateway khởi động sẽ tạo index; nếu dữ liệu staging vi phạm một unique index thì chỉ ghi log và bỏ qua index đó, không dừng gateway. Xem log dòng `ensureIndexes: skipped an index`.
- Sau khi triển khai: `POST /data-studio/dremio/sync` (hoặc bấm nút đồng bộ) để Meilisearch có id dạng chuỗi nếu chỉ mục cũ dùng id số; nếu chỉ mục Meilisearch của staging đã được bot ghi bằng uuid chuỗi thì không cần.
- Session Data Studio cũ đã lưu `chartId` số trong log sự kiện sẽ không hiện nút ghim dashboard (chỉ ảnh hưởng lịch sử cũ).
- Phải xây lại ảnh worker (`docker build -f infra/docker/worker/Dockerfile -t fox-harness-worker:dev .`) vì `uv.lock` và mã Python đổi; bước này chưa được chạy thử.

## Phụ lục A: Đối chiếu nguồn

| Chủ đề | Nguồn đã đọc |
|---|---|
| Thiết kế Mongo | `examples/bot-data-studio-api-main/docs/superpowers/specs/2026-09-17-mysql-to-pymongo-design.md` |
| Các plan | `.../plans/2026-09-17-...-plan1-...`, `2026-09-18-...-plan2a..2d-...` (đã đọc mục lục, mục tiêu, phần "out of scope" và cảnh báo tích hợp; chưa đọc từng bước chi tiết) |
| Kết nối, wrapper | `.../src/database/mongodb.py`, `.../src/settings.py`, `.../src/apis/deps.py`, `.../src/app.py` |
| CRUD | `.../src/crud_mongo/*.py` |
| Vault | `.../src/utils/vault_config.py` (chỉ đọc phần đầu) |
| Compose | `.../docker-compose.yml` |
| Hiện trạng fox | `services/gateway/src/data-studio-db.ts`, `data-studio-bridge.ts`, `services/orchestrator/src/{config,docker}.ts`, `packages/tool/data-studio-agent/{src,python/bridge}` |
| So khác biệt | `diff` cây `python/src` của fox với `example-data-studio-agent/src` và `bot-data-studio-api-main/src` |

Chưa đọc kỹ: nội dung từng bước trong 5 plan, `src/apis/routes/*` của bot (chỉ kiểm tra tên route và cách dùng `MongoDep`), `ui/` của hai dự án mẫu, và `.env` của hai dự án mẫu (không mở vì có thể chứa thông tin đăng nhập).
