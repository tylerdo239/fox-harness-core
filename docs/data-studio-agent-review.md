# Rà soát `example-data-studio-agent` — kiến trúc & cấu phần

Đọc trực tiếp source tại `example-data-studio-agent/` (không phải phần của
`fox-harness-core`, chỉ là thư mục tham khảo nằm cạnh). Mục đích tài liệu
này: mô tả CHÍNH XÁC hệ thống này được làm bằng gì và hoạt động ra sao, làm
cơ sở cho 1 kế hoạch chuyển thành "flow plugin" sau này — **chưa phải kế
hoạch chuyển đổi**, chỉ là bản đọc hiểu.

## 1. Nó làm gì

Agent phân tích dữ liệu bằng ngôn ngữ tự nhiên (tiếng Việt hoặc Anh) —
hỏi 1 câu, agent tự lên kế hoạch SQL trên kho dữ liệu liên kết qua Dremio,
chạy SQL đó thật, rồi trả lời kèm biểu đồ. Không phải Python REPL tự do
kiểu notebook (khác hẳn `packages/tool/python-repl` của fox) — đây là
**text-to-SQL có kiểm soát chặt**, pandas chỉ dùng cho hậu xử lý sau khi có
kết quả SQL sạch (rank/%/threshold), không phải công cụ chính.

2 service (`example-data-studio-agent/README.md`):
- **Backend**: FastAPI + pipeline text-to-SQL dạng agent-loop
  (`src/pipeline_v3/`), 1 "semantic layer" (metadata đã curate: nguồn dữ
  liệu, entity, cột, quan hệ, metric, thuật ngữ nghiệp vụ) lưu SQLite,
  retrieval hybrid qua Meilisearch, export PDF qua WeasyPrint.
- **UI**: Next.js 16 / React 19 — chat + các trang quản trị semantic layer.

## 2. Kiến trúc tổng

```
UI (Next :3000) ──/api/*──► Backend (FastAPI :8000)
                                 │
              ┌──────────────────┼───────────────────┐
              ▼                  ▼                    ▼
        SQLite (semantic    Meilisearch          Dremio (SQL liên kết
         layer: nguồn,      (retrieval hybrid    thật: MySQL, Postgres,
         entity, metric...)  cho câu hỏi NL)      S3, NAS...)
```

UI không bao giờ gọi thẳng backend từ browser — Next rewrite `/api/*` sang
`BACKEND_URL` (`ui/next.config.ts`), không có CORS ở production. Dremio và
Meilisearch là phụ thuộc ngoài, **không** đóng gói kèm — phải tự cấp.

**Điểm khác biệt lớn nhất với fox-harness-core**: dữ liệu thật KHÔNG nằm
trong tool-call sandbox của model — Dremio là data plane thật, SQLite chỉ
lưu metadata mô tả dữ liệu ("semantic layer"), không lưu dữ liệu thật. Model
không bao giờ chạm dữ liệu thô — chỉ chạm SQL nó tự lên kế hoạch, chạy qua
1 chokepoint duy nhất (`DremioClient.run_sql_with_meta()`).

## 3. Pipeline agent-loop (v3) — cấu phần trung tâm

Tài liệu gốc: `docs/agent-loop-architecture.md` (thiết kế ban đầu, "vertical
slice" 7 agent đầu) + `docs/pipeline_v3_flow.md` (**bản mới hơn, mô tả đúng
trạng thái implement hiện tại** — 12 bước, có thêm `chart_vision.py`,
`pandas_exec.py`, `resolve.py` không có trong bản vertical-slice — nên coi
`pipeline_v3_flow.md` là nguồn đúng nhất).

### Ràng buộc thiết kế cốt lõi

Model nền là **model yếu, chạy local** (`gpt-4.1-mini` qua OpenAILike/Agno)
— **không thể vừa gọi tool vừa xuất structured output trong cùng 1 lần
gọi** (giới hạn thật của model, không phải Agno). Toàn bộ kiến trúc xoay
quanh việc "trói" model yếu bằng tool có kiểu, không tin nó tự suy luận tự
do.

**Giải pháp: mỗi agent = 2 lần gọi model (Worker → Parser)**
(`src/pipeline_v3/base.py::WorkerParserAgent`):
- **Worker**: bật tool, xuất markdown tự do (lý luận + trace hiện cho user).
- **Parser**: tắt tool, bật `output_schema` (`use_json_mode=True`) — đọc
  markdown của Worker, xuất JSON có kiểu.
- Chỉ JSON của Parser đi tiếp sang agent kế — model KHÔNG BAO GIỜ tự đọc lại
  markdown của agent trước (tránh lỗi lan qua "khớp nối" giữa các agent).
- Dùng thẳng Agno's `parser_model`/`parser_model_prompt` có sẵn, không tự
  viết cơ chế 2-lần-gọi từ đầu.

### `Ticket`/`PipelineState` — object trạng thái chia sẻ

1 Pydantic object tích luỹ qua từng agent, mỗi agent chỉ ghi vào đúng phần
của mình (`intake`, `retrieval`, `grain`, `metrics`, `dimensions`,
`filters`, `joins`, `sql`, `result`, `transform`, `insight`) + `trace_md`
(gộp markdown mọi agent — hiện cho UI xem lý luận đầy đủ).

### 12 bước (đúng theo `docs/pipeline_v3_flow.md`, entrypoint
`src/pipeline_v3/orchestrator.py::run_pipeline_v3`)

| # | Bước | Loại | File/hàm | Việc |
|---|---|---|---|---|
| 0 | Decompose | LLM | `build_decompose_agent` | Câu hỏi có 2+ thứ khác nhau cần đếm? Tách sub-question. |
| 1 | Intake | LLM | `build_intake_agent` | Nhận diện ngôn ngữ, intent, cờ grouping/ranking/share/threshold. |
| 1b | Rank | LLM | `build_rank_agent` | Agent riêng chỉ để bắt "top N"/"nhất" (Intake hay bỏ sót). |
| 2 | Retrieval | **code** | `retrieve_candidates` | Hybrid search Meilisearch theo từng cụm từ đã nhận diện. |
| 2.5 | Clarify | LLM | `build_clarify_agent` | Chỉ hỏi lại khi thật sự mơ hồ — có guard chặn hỏi lại vu vơ. |
| 3 | Grain | LLM | `build_grain_agent` | Chọn "1 dòng = …" — bảng chủ thể, KHÔNG phải bảng bị đếm. |
| 4 | Metric | LLM | `build_metric_agent` | Chọn aggregate thô; %/rank/tổng là DẪN XUẤT, tính sau. |
| 5 | Slice (dimensions) | LLM | `build_slice_agent` | Cột GROUP BY; chặn group theo bảng đang bị đếm. |
| 6 | Filter | LLM | `build_filter_agent` | WHERE + time range, giá trị được "ground" qua `sample_values` thật. |
| 7+8 | Compile+Execute | **code** | `_compile_execute_with_grain_check` | Model KHÔNG viết SQL — tool build AST (SQLGlot), chạy thật, tự kiểm tra grain (nếu mọi dòng ra giống hệt nhau → tự replan). |
| 9 | Transform | LLM (code exec) | `build_transform_agent` + `pandas_exec.py` | pandas trong sandbox hạn chế, chỉ cho rank/%/threshold — việc SQL không diễn đạt được. |
| 10 | Insight | LLM | `build_insight_agent` | Viết câu trả lời, chỉ được trích số THẬT có trong kết quả (`cite_number` guard). |
| 11 | Chart | LLM + vision | `_run_chart`, `chart_vision.py` | Đề xuất biểu đồ → FE render → screenshot → model vision tự chấm lỗi hiển thị → sửa nếu cần. |
| 12 | Follow-ups | LLM | `build_followups_agent` | Gợi ý câu hỏi tiếp theo, chỉ dựa trên phần schema CHƯA dùng tới. |

### Cơ chế tự sửa (back-edge) — điểm khác biệt so với `pipeline_v2` cũ

`pipeline_v2` là FSM 1 lần/bước — kế hoạch sai thì trôi luôn xuống dưới,
không có đường quay lại. v3 thêm 2 "back-edge" thật:
1. **Grain check** (`Execute` agent): nếu mọi giá trị measure giống hệt
   nhau (group sai bảng) → tự xoá kế hoạch, replan lại `Slice` với gợi ý
   sửa, **rồi ép cứng bằng code** (`_force_grain_only_dims`) — vừa
   re-prompt vừa chặn bằng code, vì model yếu lặp lại lỗi cũ nếu chỉ nhắc
   lại bằng lời.
2. **Compile fix_hint**: validate AST thất bại → trả lý do cụ thể ("grain
   not grouped", "fan-out unsafe") → quay lại đúng agent gây lỗi
   (Slice/Join/Metric), có giới hạn số lần replan toàn cục (tránh loop vô
   hạn).

### Các quy tắc "an toàn model yếu" xuyên suốt

1. Model không bao giờ tự viết SQL — chỉ điền tool có kiểu, tool mới dựng
   AST.
2. Mọi tool là Agno `Function(strict=True, parameters=…)` — validate theo
   JSON-Schema, model không thể truyền sai hình dạng.
3. Tool trả về gợi ý `next_suggested_tools` — model chọn tiếp theo trong 1
   danh sách hẹp, không phải không gian mở ("lập kế hoạch theo affordance").
4. Mọi agent có `tool_call_limit` (Agno có sẵn) + giới hạn retry mỗi tool —
   vượt trần thì chuyển sang `clarify`/`decline`, không loop vô hạn.
5. Tham chiếu bảng/cột theo TÊN, không theo id số (`resolve.py::NameResolver`)
   — model dễ đoán bừa id số nhưng ít bịa tên hơn khi tên nằm sẵn trong danh
   sách candidate.
6. Không đưa ví dụ schema cụ thể vào prompt — chỉ pattern A/B/X chung
   (pipeline phải chạy được với bất kỳ schema nào, không học vẹt 1 bộ dữ
   liệu).

### Chạy song song khi câu hỏi bị tách (decomposed)

Mỗi sub-question chạy `asyncio.gather` song song, mỗi sub có DB Session
riêng (SQLModel Session không an toàn khi dùng chung giữa các task đồng
thời) + contextvar riêng (`_SUB_ID`) để gắn đúng sub vào đúng sự kiện SSE.
Insight chỉ chạy **1 lần duy nhất** trên dữ liệu đã gộp — không viết
insight riêng cho từng sub rồi ghép lại.

## 4. Semantic layer — nơi lưu "biết gì về dữ liệu"

Tài liệu gốc: `docs/semantic-layer-schema.md`. Model SQLModel, SQLite
(`src/database/models/`). Vai trò:

```
DataSource ──1:N──► Entity ──1:N──► EntityColumn
                      │                  ▲
                      └──► Relationship ─┴─► RelationshipColumnPair
Metric ─────► base_entity + measure_column
BusinessGlossaryTerm ─► term → sql_expression (dùng lại verbatim)
VerifiedQuery ───────► câu hỏi → SQL (mẫu cho retrieval)
```

3 nhóm field trên hầu hết model (đánh dấu ngay trong code):
- **`[sync]`** — lấy tự động từ Dremio lúc sync, không sửa tay.
- **`[curate]`** — con người (hoặc chính agent) gán nghĩa: mô tả, tên gợi
  nhớ, PII, có expose cho agent hay không.
- **`[profile]`** — thống kê từ lúc profiling (distinct count, mẫu giá
  trị, min/max).

**`EntityColumn.role`** (`dimension | measure | key`) và
**`semantic_type`** là xương sống của việc lập kế hoạch: `role=key` → dùng
làm JOIN key/phát hiện filter theo id chưa được ground; `role=dimension` →
cột GROUP BY hợp lệ; `role=measure` + `default_aggregation` → biết
aggregate gì, bằng cách nào.

**Quản trị (governance) — 1 quy tắc duy nhất**: chỉ dòng nào
`is_exposed && !is_deprecated && !is_pii` mới được đánh index/retrieve —
gate áp dụng lúc index, nên bất cứ thứ gì pipeline nhận được từ retrieval
đã an toàn để đưa cho model, không cần check lại ở downstream.

`metadata-review.md` (ở root repo tham khảo, không phải doc kiến trúc) là
**1 ví dụ thật đã chạy** — bản rà soát metadata do agent tự đề xuất cho 1
schema thật (workflow builder bán hàng), minh hoạ đúng quy trình
sync → profiling → curate ở trên, không phải tài liệu kiến trúc.

## 5. Tích hợp Dremio

Tài liệu gốc: `docs/dremio-integration-flow.md`. `DremioClient`
(`src/services/dremio_client.py`) — REST client mỏng qua `httpx`, 1
instance/request (không giữ session dài hạn), login lazy + cache token
trong instance đó.

- **Chạy SQL là job-based, không đồng bộ**: `POST /api/v3/sql` → nhận
  `job_id` → poll `GET /api/v3/job/{id}` mỗi 0.5s tới khi xong → lấy kết
  quả. `run_sql_with_meta()` là **chokepoint duy nhất** — sync metadata,
  profiling, và chat đều đi qua đúng 1 hàm này.
- **Sync** (`src/services/dremio_sync.py`): match theo TÊN (đổi tên bảng
  trong Dremio = tạo Entity mới, cái cũ bị đánh `is_deprecated`, không xoá
  cứng).
- **Profiling** (`src/services/profiling.py`): 1 câu SQL aggregate (COUNT,
  COUNT DISTINCT, MIN, MAX mọi cột) mỗi entity + 1 câu `SELECT DISTINCT ...
  LIMIT 20` lấy mẫu (bỏ qua cột `is_pii`).
- **Chat-time**: SQL agent tự lên kế hoạch chạy THẲNG vào Dremio (không
  phải SQLite semantic layer), rồi so với thống kê đã profiling để phát
  hiện bất thường (`src/services/query_execution.py`).

## 6. Lưu trữ hội thoại

`src/database/models/conversation.py` — SQLite, 4 bảng lồng nhau:
`Conversation` → `Message` (1 lượt, user hoặc assistant) → `QueryResult`
(1 SQL đã chạy — 1 câu hỏi đơn giản có 1, câu hỏi bị tách có nhiều, mỗi
sub-question 1 cái) → `Chart` (mỗi query_result có thể nhiều chart, gắn cờ
`is_pinned` để đưa vào dashboard). `QueryResult` **lưu nguyên `rows_json`**
— mở lại hội thoại cũ hiện đúng y hệt lúc trả lời, không chạy lại SQL.

Khác hẳn cách fox-harness-core lưu — dsh dùng session log JSONL
event-sourced (`@deepseek-ai/dsh-session-persistence-jsonl`), còn hệ thống
này lưu quan hệ SQL bình thường qua SQLModel, không có khái niệm log
append-only/replay.

## 7. Auth

`src/apis/routes/auth.py` — **1 user duy nhất cho cả app**
(`AUTH_USERNAME`/`AUTH_PASSWORD` trong `.env`, hash lúc khởi động), JWT ký
vào cookie `httpOnly`. Không có multi-user/role gì — khác hẳn
fox-harness-core (nhiều user thật, bảng `users`, JWT theo user).

## 8. Streaming & giao diện

- **SSE** qua contextvar sink (`_SINK`, `_emit()` trong
  `pipeline_v3/orchestrator.py`) — tự gắn `sub_id`/`step_id` vào mọi sự
  kiện để UI biết sự kiện thuộc sub-question/bước nào ngay cả khi nhiều sub
  chạy song song cùng tên agent. Loại sự kiện: `agent_started/done`,
  `tool_started/done`, `agent_delta`, `answer_delta`, `result`, `answer`,
  `decomposed`, `sub_started`, `sub_data_ready`, `sub_done`, `chart_review`,
  `charts`, `follow_ups`, `clarification`, `saved`, `error`, `done`.
- Route thật: `src/apis/routes/chat.py` — `POST /ask` (v1/`pipeline`),
  `/ask_v2`, `/ask_v3` (agent-loop hiện tại), đều
  `response_class=EventSourceResponse`.
- **UI** (`ui/src/components/chat/`): `pipeline-trace.tsx` (hiện trace
  markdown từng agent — đúng cái `trace_md` gộp lại), `result-view.tsx`/
  `v2-result-view.tsx` (bảng kết quả), `chart-view.tsx` (vẽ chart),
  `sql-block.tsx` (hiện SQL đã compile). Route Next: `chat-v3` riêng khỏi
  `chat` (v1/v2) — 2 pipeline chạy song song trên UI trong giai đoạn
  shadow+diff, không thay hẳn route cũ ngay.
- Ngoài chat còn có trang quản trị semantic layer thật: `data-sources`,
  `glossary`, `metrics`, `dashboards` — không chỉ là 1 chat UI đơn thuần.

## 9. `pipeline_v2` — pipeline cũ, vẫn còn sống làm "máy móc bên trong"

`docs/pipeline-v2-steps.md`/`pipeline-v2-capabilities.md`: FSM 10 bước
(0-9), 1 lần/bước, không có back-edge — đây chính là hạn chế mà v3 sinh ra
để sửa (câu "số workflow của mỗi agent" ra kết quả không ổn định giữa các
lần chạy trên v2). v3 **không viết lại từ đầu** — dùng lại nguyên các phần
tất định (deterministic) của v2 làm tool-internals cho các agent mới:

- Retrieval hybrid + exact-name boost → tool của Retrieval agent.
- BFS join tree + `JoinStrategy` (NONE/DIRECT_OK/PRE_AGG/SPLIT_CTE)
  (`src/services/join_path.py`) → tool của Join agent.
- SQLGlot AST builder (`src/pipeline_v2/templates.py`) → `compile_sql`.
- Guard soft-delete/ungrounded-id/governance → tool Filter+Compile.
- Guard grain (`_drop_measured_entity_grouping`, `grain_self_group_check`)
  → tool Slice agent.

## 10. Quan sát nhanh — đối chiếu với "flow" pattern hiện có của fox-harness-core

Chỉ ghi nhận để chuẩn bị cho buổi lên kế hoạch chuyển đổi sau, **chưa phải
đề xuất**:

- **Turn/step loop**: data-studio-agent dùng **Agno's `Agent` runner**
  (Worker→Parser 2-lần-gọi mỗi agent, 12 agent nối tiếp/song song có
  back-edge) — khác hẳn cơ chế `FoxHarnessAgent`
  (`packages/agent-driver/src/agent.ts`, 1 turn/step loop tự viết theo
  đúng event taxonomy của dsh). Đây không phải "1 flow hook nhẹ" như
  `packages/flow/data-analysis` hiện có (chỉ nghe `agent/pre-step`) — đây
  là **1 orchestrator nhiều-agent hoàn chỉnh, tự quản lý vòng lặp riêng của
  nó**, gần với việc cần 1 loop/driver thật sự khác (nấc 2 theo
  `docs/agent-core-architecture-roadmap.md` §0.2) hơn là 1 plugin hook đơn
  giản.
- **Thực thi code**: pandas ở đây chỉ là bước hậu xử lý bị khoá chặt
  (`pandas_exec.py`, sandbox hạn chế, chỉ chạy SAU khi có SQL kết quả sạch,
  không import/file/network) — khác triết lý với
  `packages/tool/python-repl` của fox (REPL mở, mục đích chung).
- **Nguồn dữ liệu thật**: đây là hệ thống nói chuyện với **Dremio** (kho dữ
  liệu doanh nghiệp liên kết) — fox hiện chưa có khái niệm "nguồn dữ liệu
  ngoài" nào cả, chỉ có sandbox file cục bộ trong container + web search.
  Đây là phụ thuộc ngoài LỚN cần cấp hạ tầng riêng (Dremio + Meilisearch)
  nếu chuyển nguyên khối.
- **Semantic layer + governance**: hoàn toàn không có khái niệm tương ứng
  bên fox — đây là 1 lớp curation/metadata riêng, có UI quản trị riêng
  (`data-sources`, `glossary`, `metrics`), không map vào bất kỳ khái niệm
  nào hiện có (skill, project, session).
- **Session/lưu trữ**: model quan hệ SQL bình thường (SQLModel/SQLite) —
  không dùng session log event-sourced như dsh. `rows_json` lưu snapshot
  cứng để mở lại y hệt, khác cách dsh derive lại từ log mỗi lần.
- **Auth**: 1-user, không có khái niệm nhiều tài khoản — fox đã có users
  thật + JWT theo user, phần này chắc chắn phải bỏ khi chuyển, không mang
  theo.
- **UI framework**: Next.js/React 19 riêng biệt, không phải component
  trong `apps/web` — toàn bộ `ui/` là 1 app khác, không tự nhiên "dán vào"
  `apps/web/src/components/features/conversation/`, cần thiết kế lại UI
  React cho khớp app hiện có nếu muốn 1 trải nghiệm chat thống nhất.
