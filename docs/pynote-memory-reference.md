# Bộ nhớ dài hạn của pynote-be: cấu phần và logic (2026-10-23)

Tài liệu tham khảo, đọc từ `examples/pynote-be` (bản sao, không thuộc repo này). Mọi đường dẫn bên dưới tính
từ `examples/pynote-be/`. Mục đích: hiểu pynote làm memory thế nào trước khi quyết định có đưa vào fox-harness hay không.

## 1. Tóm tắt

- **Là gì:** bộ nhớ dài hạn cho agent, nhớ **về người dùng** (vai trò, quy ước lâu dài) và **về từng cuộc chat** (số liệu,
  quyết định, việc dở, mục tiêu), dùng lại ở các lượt sau và các chat sau.
- **Mô hình:** _Event–Entity_ theo bài báo **VikingMem** (VLDB 2026), viết lại độc lập (không chép OpenViking, vì
  OpenViking là AGPL-3.0).
  - **Event:** một mẩu ký ức rời rạc có thời điểm ("ngân sách 500 triệu", "chốt phương án B"), trích từ hội thoại.
  - **Entity:** trạng thái hiện hành gộp từ nhiều event bằng toán tử, ví dụ giá trị mới nhất của "ngân sách", có lịch
    sử các giá trị cũ.
- **Công nghệ:** thư viện Python `libs/pynote-memory` (khoảng 3.000 dòng). SQLite lưu event, entity và chỉ mục toàn văn;
  **Mem0 chỉ làm chỉ mục vector** (Qdrant cục bộ, `infer=False`), không dùng phần trích xuất của Mem0.
- **Cách gắn vào agent:** core Node (`packages/bundle-core/src/memory.ts`, `memory-store.ts`) chạy
  `python -m pynote_memory.server` làm tiến trình con, nói chuyện qua stdio, mỗi dòng một JSON.
  - **Đầu lượt:** lấy khối "Bộ nhớ" chèn vào lượt chat (chờ tối đa 4 s).
  - **Cuối lượt:** gửi lời người dùng và câu trả lời cuối để trích ký ức, chạy nền.
- **Vì sao bỏ pipeline gốc của Mem0** (đo trong `libs/pynote-memory/bench`):
  - Mem0 chỉ biết thêm, không thay: giá trị cũ "800 triệu" vẫn xếp trên giá trị đã sửa "500 triệu".
  - Rò số liệu của chat này sang chat khác qua lớp người dùng.
  - Tốn khoảng 8 lần token đầu vào.
  - **LOCOMO** (10 hội thoại, 1.540 câu): pynote-memory 78,2%, Mem0 82,2%, nhưng pynote rẻ hơn khoảng 8 lần.
  - **Kịch bản UAV tiếng Việt 50 lượt:** pynote giữ đúng 5/5 dữ kiện, không rò; Mem0 3/5 và có rò.

## 2. Sơ đồ tổng thể

```
                 core Node (bundle-core)                              tiến trình con Python (pynote_memory.server)
 ┌──────────────────────────────────────────────┐   stdio JSON    ┌──────────────────────────────────────────────────┐
 │ memory.ts                                    │  ───────────▶   │ MemoryBase (memory.py)                           │
 │  agent/pre-step (bước 1 của lượt) ─ recall ──┼─ context ──────▶│  ├ Extractor (extractor.py) ── LLM               │
 │  session/event turn/end ── remember (nền) ───┼─ remember ─────▶│ ├ EventStore = EventCatalog (SQLite+FTS5)        │
 │  routes /memories /memory-* /session-memory  │                 │  │              + Mem0DenseIndex (Qdrant)        │
 │ memory-store.ts                              │  ◀───────────   │  ├ EntityStore (SQLite, lịch sử, vector)         │
 │  hàng đợi theo user, configure, maintain 6h  │  result + calls │  ├ Retriever (dense+BM25+đồ thị từ khoá, rerank) │
 │  ghi llm_calls cho mỗi lần gọi model         │                 │  └ lifecycle (nén, hết hạn, merge, khử trùng)    │
 └──────────────────────────────────────────────┘                 └──────────────────────────────────────────────────┘
                                                        dữ liệu: $DSH_HOME/cordis/memory/pynote/
```

## 3. Cấu phần (libs/pynote-memory/pynote_memory)

| File                                      | Vai trò                                                                                                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema.py`, `schemas/pynote.yaml`        | Sơ đồ Event–Entity (loại event, phạm vi, trọng số; entity, khoá, toán tử). Kiểm tra lúc nạp: một entity phạm vi `user` không được nuôi bằng event phạm vi `session` |
| `extractor.py`                            | Prompt trích xuất **một lần gọi LLM** làm cả 4 việc: lọc, phân đoạn, trích event, bản vá + quên. Kiểm tra đầu ra; chốt chặn phạm vi bằng code                       |
| `operators.py`, `patch.py`                | Toán tử gộp entity (SET, IMMUTABLE, SUM, COUNT, MAX, MIN, AVG, APPEND, LLM_MERGE) bằng code; bản vá văn bản SEARCH/REPLACE                                          |
| `catalog.py`                              | Bảng `events` (SQLite) là nguồn sự thật; FTS5 bỏ dấu cho tìm từ khoá (BM25); đồ thị từ khoá; số lần truy xuất                                                       |
| `event_store.py`                          | Catalog + chỉ mục dense trên Mem0 (`infer=False`)                                                                                                                   |
| `entity_store.py`                         | Bảng `entities` + `entity_history`, vector entity; phát lại lịch sử khi xoá một chat; gộp entity                                                                    |
| `embedder.py`                             | Embedding dùng chung, có cache, tự thêm tiền tố `query:` / `passage:` cho họ e5                                                                                     |
| `retriever.py`, `ranking.py`, `rerank.py` | Truy xuất nhiều nhánh, công thức điểm, rerank (`none` / `llm` / `http`)                                                                                             |
| `lifecycle.py`                            | TIME_COMPRESS (nén dòng thời gian), hết hạn có củng cố, LLM_MERGE, khử trùng bằng LLM, gộp khoá cùng nghĩa                                                          |
| `memory.py`                               | `MemoryBase`: `ingest`, `ingest_batch`, `context`, `maintain`, `consolidate`, `forget_session`, `memories` / `edit` / `forget` / `clear`                            |
| `settings.py`                             | Dựng bản thật từ biến môi trường                                                                                                                                    |
| `server.py`                               | Cầu nối stdio; khoá kho chung, **nhả khoá trong lúc chờ LLM**                                                                                                       |

## 4. Mô hình dữ liệu (`schemas/pynote.yaml`)

### 4.1 Hai phạm vi

- **`session`:** chỉ thuộc một cuộc chat (số liệu, quyết định, việc dở, mục tiêu).
- **`user`:** đúng với người dùng ở **mọi** cuộc chat. Chỉ nhận điều người dùng nói rõ là lâu dài ("từ nay", "luôn luôn"),
  hoặc vai trò, công việc của chính họ. **Không bao giờ** nhận số liệu dự án.

Phạm vi do **sơ đồ** quyết định, không để LLM đoán. Đây là cách sửa lỗi "số liệu dự án lọt lên lớp dùng chung" đo được
trên Mem0.

### 4.2 Loại event

| Event        | Phạm vi | Trọng số | Thuộc tính                     | Ý nghĩa                                                                              |
| ------------ | ------- | -------- | ------------------------------ | ------------------------------------------------------------------------------------ |
| `fact`       | session | 0,8      | `key`_, `value`_, `note`       | Dữ kiện / con số; sửa số → event mới cùng `key`                                      |
| `decision`   | session | 0,9      | `topic`_, `decision`_          | Điều đã chốt, kèm lý do; yêu cầu sửa sản phẩm (màu, cột, giọng văn) cũng là decision |
| `task`       | session | 0,6      | `task`_, `status`_ (open/done) | Việc giao, việc dở                                                                   |
| `goal`       | session | 0,7      | `summary`\*                    | Mục tiêu, phạm vi của cuộc chat                                                      |
| `profile`    | user    | 0,5      | `aspect`_, `value`_            | Vai trò, đơn vị, khu vực của người dùng                                              |
| `preference` | user    | 0,7      | `aspect`_, `value`_            | Quy ước lâu dài (đơn vị tiền, làm tròn, ngôn ngữ, định dạng)                         |

(\* bắt buộc)

### 4.3 Entity: `entity := OP(event.field) GROUP BY scope, key`

| Entity           | Phạm vi | Khoá               | Thuộc tính ← toán tử(event.field)                         |
| ---------------- | ------- | ------------------ | --------------------------------------------------------- |
| `ChatFact`       | session | `key`              | `value` ← SET(fact.value), `note` ← SET(fact.note)        |
| `ChatDecision`   | session | `topic`            | `decision` ← SET(decision.decision)                       |
| `ChatTask`       | session | `task`             | `status` ← SET(task.status)                               |
| `ChatBrief`      | session | (một cái mỗi chat) | `summary` ← LLM_MERGE(goal.summary), cập nhật bằng bản vá |
| `UserProfile`    | user    | `aspect`           | `value` ← SET(profile.value)                              |
| `UserPreference` | user    | `aspect`           | `value` ← SET(preference.value)                           |

- **SET:** giá trị mới nhất thắng ("ngân sách 800 → 500"). Lịch sử giữ giá trị cũ để hiển thị "(trước: …)".
- **Toán tử thống kê** (SUM, AVG…) chạy bằng code, vì model nhỏ hay tính sai.
- **Khoá được chuẩn hoá** (`fold`: chữ thường, bỏ dấu). Cách viết gốc giữ ở thuộc tính ẩn `_label` để hiển thị.

## 5. Ghi: `ingest` sau mỗi lượt

Core gửi `remember {user_id, session_id, messages, at}`. `messages` gồm các tin người dùng trong lượt và câu trả lời
cuối của trợ lý, mỗi tin cắt ở 3.000 ký tự. Thư viện làm lần lượt:

1. **Prefetch:** lấy các entity đơn của chat (`ChatBrief`) cộng top-K = 12 entity gần nghĩa nhất với nội dung lượt
   (ANN trên vector entity). Danh sách này được đưa vào prompt dưới dạng "trạng thái đã biết", để model dùng đúng khoá
   đã có và không ghi lại điều không đổi.
2. **Trích một lần gọi LLM** (`extractor.py`). Phần cố định (luật + sơ đồ) đứng đầu prompt để máy chủ dùng lại prefix
   cache; phần thay đổi (trạng thái, hội thoại) đứng sau.
   - **A. Lọc:** bỏ chào hỏi, cảm ơn, câu đệm, kiến thức chung.
   - **B. Phân đoạn theo chủ đề** bằng chỉ số tin (`"2-3,7"`). Một đoạn được gồm tin không liền nhau.
   - **C. Trích event:** chỉ từ tin mới; mỗi chi tiết một event; giữ nguyên số và đơn vị; thời gian tương đối được
     quy đổi kèm ngày tuyệt đối; kèm `keywords` (2–5) và `importance` (0–1).
   - **D. Bản vá** văn bản (`search` / `replace`) cho `ChatBrief`, và yêu cầu **quên**.
3. **Kiểm tra đầu ra bằng code:**
   - Loại event lạ hoặc thiếu thuộc tính bắt buộc → bỏ, ghi vào `dropped`.
   - Tin mới không thuộc đoạn nào → đếm là `noise_messages`.
   - Mỗi event giữ `topic`, `ranges` và `source` (đoạn hội thoại gốc, tối đa 1.500 ký tự).
4. **Chốt chặn phạm vi** (`_guard_scope`):
   - `preference` chỉ được ở lớp user khi lời người dùng có dấu hiệu lâu dài và không có "chỉ chat này".
   - `profile` không được mang con số.
   - Không đạt → hạ xuống `decision` phạm vi session, không mất thông tin.
5. **Khử trùng hai tầng:**
   - Event có khoá trùng giá trị hiện hành → trùng.
   - Cùng khoá, khác giá trị → là cập nhật, không phải trùng.
   - Event không khoá: cosine ≥ 0,97 → trùng; từ 0,85 đến 0,97 → hỏi LLM **một lần cho cả lượt**.
6. **Lưu event** vào SQLite + FTS5 + Mem0 (nếu sơ đồ có `ttl_days` thì đặt hạn), rồi **chạy toán tử** lên các entity mà
   loại event đó nuôi.
7. **Bản vá** cho `ChatBrief`:
   - Khớp chính xác và duy nhất, hoặc khớp gần đúng có bỏ dấu với ngưỡng 0,8.
   - Không định vị được → **LLM_MERGE** (gộp văn bản cũ và mới bằng LLM).
   - Văn bản dài hơn 1.200 ký tự → LLM rút gọn.
8. **Quên:** xoá entity được yêu cầu và **các event đã nuôi nó**, để event cũ không quay lại qua truy xuất.
9. **Đánh chỉ mục lại** vector của các entity vừa đổi.

Nếu JSON đầu ra hỏng (thường do lô quá dài bị cắt), thư viện chia đôi đoạn hội thoại rồi trích lại từng nửa. Ngoài ra có
`ingest_batch` để nhập lịch sử dài: lô 20 tin, mỗi lô mang 4 tin của lô trước làm ngữ cảnh.

## 6. Đọc: `context` đầu mỗi lượt

Core gọi `context {user_id, session_id, query}` ở **bước 1 của mỗi lượt**. Nếu câu hỏi ngắn hơn 40 ký tự (ví dụ "tiếp
tục"), câu trước đó được ghép thêm làm truy vấn. Core chờ tối đa **4 s**; quá hạn thì lượt chạy không có bộ nhớ.

1. **Entity lớp user:** xếp theo độ liên quan với truy vấn, lấy tối đa 12.
2. **Entity của chat:** các entity đơn (`ChatBrief`) luôn có mặt; entity có khoá xếp theo liên quan, tối đa 30.
3. **Event liên quan** (`retriever.py`), các nhánh xếp hạng riêng rồi mới gộp:
   - **Nhánh chính (hybrid):** dense (Mem0, top 20) cộng sparse (BM25 trên FTS5 bỏ dấu, top 20).
     - Dense chuẩn hoá min–max, vì cosine của e5 có nền cao, khoảng 0,8 cho mọi thứ.
     - Sparse chia cho điểm cao nhất.
     - `S_origin = 0,6·dense + 0,4·sparse`.
     - Lấy tối đa **8** event.
   - **Nhánh đồ thị từ khoá:** truy vấn → từ khoá gần nhất (cosine ≥ 0,8; vector từ khoá là trung bình vector các event
     chứa nó) → các event gắn từ khoá đó. Lấy tối đa **3**. Nhánh này bắt các câu hỏi gián tiếp mà dense bỏ sót.
   - **Rerank** (tuỳ chọn): trộn 50/50 với điểm truy xuất.
   - **Ghi nhận truy xuất** (`hits`, `last_access`) để vòng đời "củng cố" những gì còn được nhắc lại.
4. **Điểm cuối:** `final = (1 − 0,2 − 0,15)·S_origin + 0,2·S_time + 0,15·S_busi`.
   - `S_time = 1` trong ngày đầu, sau đó giảm theo hàm mũ với chu kỳ bán rã 30 ngày.
   - `S_busi = trọng số loại event × importance`.
   - Bỏ event có điểm dưới 0,25.
5. **Lắp khối văn bản trong hạn mức 1.600 token** (ví dụ minh hoạ bên dưới; định dạng đúng theo code, nội dung tự đặt):
   - 70% hạn mức dành cho entity, theo thứ tự liên quan.
   - Phần còn lại dành cho event, và bỏ những event mà entity đang hiển thị đã đại diện.

```
## Bộ nhớ (hệ thống, không phải người dùng)
Dùng khi phù hợp. Giá trị trong "Dữ kiện hiện hành" là giá trị MỚI NHẤT; "trước:" là giá trị đã bị thay. Yêu cầu mới của người dùng luôn thắng bộ nhớ.

### Về người dùng (mọi cuộc chat)
- đơn vị tiền: triệu đồng
### Mục tiêu cuộc chat
Lập phương án mua drone giám sát rừng cho 3 xã...
### Dữ kiện hiện hành
- [2026-10-21] ngân sách dự án: 500 triệu đồng (trước: 800 triệu đồng [2026-10-20])
### Đã chốt
- phân bổ ngân sách: cắt hạng mục camera nhiệt vì vượt ngân sách
### Việc
- báo cáo hoàn vốn: open
### Ghi nhận liên quan
- [2026-10-20] Người dùng cho biết mỗi xã cần 2 drone.
```

Core thêm câu: _"Không nhắc lại bộ nhớ với người dùng. Người dùng xem và xoá được bộ nhớ trong Cài đặt → Bộ nhớ."_

**Cách chèn trong thực tế** khác với README của thư viện:

- README nói đặt khối này vào system prompt.
- Core thì chèn như **một tin nhắn plugin** (`source: plugin`, ẩn trên giao diện) qua waterfall `agent/pre-step`, cùng
  chỗ dsh-agent-instructions chèn context. Lý do: tin này là session event, nên mọi thứ model đã thấy đều dựng lại được
  từ log (bất biến của repo).
- Khối chỉ được gửi lại khi nội dung khác lần trước trong cùng chat.

## 7. Vòng đời (`maintain`, `consolidate`)

Core gọi `maintain` sau một lượt `remember` thành công, **tối đa 6 giờ một lần cho mỗi người dùng**. `maintain` của server
chạy `MemoryBase.maintain` rồi `consolidate(user_id)`.

- **TIME_COMPRESS** ("gộp lười"):
  - Event được gom theo dòng thời gian `(phạm vi, chat, chủ đề)`.
  - Chỉ nén timeline **đã ngừng hoạt động** (không có event mới trong 3 ngày), với event cũ hơn 7 ngày và có ít nhất 3
    event.
  - Mỗi tuần (hoặc mỗi tháng) thành một event tóm tắt cấp 1.
  - Event chi tiết nhận TTL 30 ngày.
- **Hết hạn có củng cố:** event chi tiết hết TTL bị xoá, trừ khi được truy xuất trong 14 ngày gần nhất; khi đó được hoãn
  thêm một TTL.
- **Gộp khoá cùng nghĩa** (`consolidate`): một lần gọi LLM nhóm các khoá như "ngân sách" / "ngân sách dự án" (tối đa 100
  entity mỗi loại). Entity mới nhất giữ lại, các entity khác gộp vào.
  - Server gọi hàm này không kèm `session_id`, nên thực tế **chỉ gộp entity lớp user**.
  - Entity của chat (`ChatFact`…) chỉ được gộp khi gọi kèm `session_id`; hiện core không gọi như vậy.

## 8. Người dùng tự quản lý, và xoá

| Việc                                | Thư viện                                                                                         | Route core (đăng nhập, quyền user)                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| Xem mọi ký ức (mỗi entity một dòng) | `memories(user)`                                                                                 | `GET /memories` (trả cả `orgEnabled`, `ready`)        |
| Sửa một ký ức                       | `edit(user, id, text)`: lời người dùng thành giá trị hiện hành; xoá các event đã nuôi giá trị cũ | `POST /memory-update {id, text}`                      |
| Xoá một ký ức                       | `forget(user, id)`: xoá entity và event nuôi nó                                                  | `POST /memory-delete {id}`                            |
| Xoá theo lớp hoặc theo chat         | `clear(user, scope?, session_id?)`                                                               | `POST /memory-clear {layer?: user\|chat, sessionId?}` |
| Bật/tắt bộ nhớ cho một chat         | (core: `off-chats.json`)                                                                         | `GET/POST /session-memory` (chỉ chủ chat)             |
| Xoá một chat                        | core gọi `clear(layer: chat, sessionId)`                                                         | tự động (`onSessionForgotten`)                        |

- Xoá một chat chỉ xoá **phạm vi session** của chat đó. Điều người dùng dặn lâu dài trong chat ấy vẫn được giữ.
- Thư viện còn có `forget_session`: xoá mọi đóng góp của một chat **kể cả vào lớp user**, rồi phát lại lịch sử entity.
  Core hiện không dùng hàm này.

**Bộ nhớ tắt khi:**

- admin tắt cho cả tổ chức (org policy `memory`);
- người dùng tắt cho chat đó;
- lượt chạy là automation (workspace tự động);
- agent là subagent.

## 9. Tích hợp và vận hành (core Node)

- **Một tiến trình Python** cho mỗi core.
  - Gói cài riêng ở `/opt/pynote-memory` trong image (`deploy/core.Dockerfile`, phiên bản khoá ở `requirements.lock`),
    tách khỏi python của agent.
  - Chạy cục bộ thì dùng `.venv` của thư viện.
- **`configure`** gửi model LLM và embedding của tổ chức.
  - Được gọi lại khi super admin đổi model. Dữ liệu trên đĩa giữ nguyên.
  - Gọi thử embedding một lần để lỗi cấu hình lộ ra ngay.
  - Hỏng thì thử lại sau 10 phút.
- **Đồng thời:**
  - Mỗi yêu cầu chạy trên một luồng. Mọi truy cập kho đi qua một khoá chung, nhưng **nhả khoá trong lúc chờ LLM**, nên
    lượt trích của người này không chặn bước recall (chờ tối đa 4 s) của người khác.
  - Thứ tự ghi của từng người dùng do core giữ: **mỗi người một hàng đợi** promise.
- **Timeout:** recall 4 s; mỗi yêu cầu 120 s; `remember` / `maintain` 10 phút.
- **Chi phí:**
  - Mỗi lần gọi model của thư viện (`purpose`: trích, merge, khử trùng, tóm tắt, gộp khoá) được trả về kèm kết quả.
  - Core ghi các lần gọi đó vào `llm_calls` dưới cuộc chat tương ứng, nên hiện lên báo cáo usage.
- **Dữ liệu:** `$DSH_HOME/cordis/memory/pynote/`.
  - SQLite gồm `events`, `events_fts`, `keywords`, `keyword_links`, `entities`, `entity_history`.
  - Qdrant cục bộ của Mem0.
  - `off-chats.json`.
- **Biến môi trường** (`settings.py`):
  - LLM: `PYNOTE_MEMORY_LLM_BASE_URL` / `_API_KEY` / `_MODEL` / `_EXTRA_BODY`.
  - Embedding: `PYNOTE_MEMORY_EMBED_*` (mặc định `multilingual-e5-large`, 1024 chiều).
  - Rerank: `PYNOTE_MEMORY_RERANK` (`none` / `llm` / `http`).
  - Khác: `PYNOTE_MEMORY_LANGUAGE`, `PYNOTE_MEMORY_SCHEMA`, `PYNOTE_MEMORY_DIR`.
  - Core: `PYNOTE_MEMORY_LIB`, `PYNOTE_MEMORY_PYTHON`, `MEMORY_EMBED_MODEL`, `MEMORY_EMBED_DIMS`.

**Lưu trữ chi tiết:**

| Bảng (SQLite)               | Cột chính                                                                                                                                                                                               | Ghi chú                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `events`                    | id, dense_id, user_id, session_id, scope, type, content, props, importance, topic, ranges, source, keywords, level (0 chi tiết / 1 tóm tắt), created_at, expires_at, hits, last_access, compressed_into | nguồn sự thật của event                                         |
| `events_fts`                | text, event_id                                                                                                                                                                                          | FTS5 `unicode61 remove_diacritics 2` (tìm không dấu)            |
| `keywords`, `keyword_links` | (user, từ khoá) → vector trung bình; từ khoá ↔ event                                                                                                                                                    | đồ thị từ khoá                                                  |
| `entities`                  | id, schema, scope, user_id, session_id, key, state (JSON), text, vector, created_at, updated_at                                                                                                         | unique (schema, user, session, key)                             |
| `entity_history`            | entity_id, prop, op, value, event_id, source_session, at                                                                                                                                                | mỗi lần đổi giá trị; dùng cho "(trước: …)", sửa, quên, phát lại |

## 10. Số lần gọi LLM mỗi lượt

| Lúc                            | Gọi                                                                         | Ghi chú                        |
| ------------------------------ | --------------------------------------------------------------------------- | ------------------------------ |
| Đầu lượt (`context`)           | 0 LLM (chỉ embedding; nếu bật rerank `llm` thì thêm 1)                      | chờ tối đa 4 s                 |
| Cuối lượt (`remember`)         | 1 lần trích; +1 nếu có event gần trùng; +1–2 nếu cần LLM_MERGE              | chạy nền, người dùng không chờ |
| Mỗi 6 giờ / người (`maintain`) | 1 lần cho mỗi timeline cần nén; 1 lần gộp khoá cho mỗi loại entity lớp user | chạy nền                       |

## 11. Kiểm thử và đo

- **Test:** 45 test offline (README ghi 44) (`tests/test_core.py`, `test_paper.py`, `test_product.py`), không cần mạng. Có test giữ phần
  đầu prompt ổn định để không mất prefix cache.
- **Bench:**
  - `bench/locomo.py`: LOCOMO, LLM chấm.
  - `bench/uav.py`: kịch bản tiếng Việt 50 lượt, chấm bằng code: nhớ đúng số liệu, không rò sang chat khác.
  - `bench/diagnose.py`: so từng câu giữa hai bản. Chấm lại cùng một kho làm khoảng 5% câu đổi kết quả, nên đừng chỉ so
    tổng điểm.

## 12. Điểm đáng chú ý

- **Phạm vi do sơ đồ và code quyết định**, không để LLM đoán; có chốt chặn hạ cấp. Đây là phần chống rò rỉ giữa các chat.
- **Entity với SET và lịch sử** giải quyết đúng bài toán "giá trị đã sửa": model thấy giá trị mới nhất kèm "(trước: …)".
- **Không cắt ngắn lịch sử chat để chèn bộ nhớ.** Bộ nhớ là một khối riêng có hạn mức token, chèn mỗi lượt, và chỉ gửi
  lại khi thay đổi.
- **Chi phí ghi thấp:** một lần gọi trích mỗi lượt, phần cố định của prompt trúng prefix cache.
- **Chưa làm:** rerank ColBERT thật (cần model trả vector theo token).
- **Phụ thuộc thêm:** Mem0 + Qdrant cục bộ (thực chất chỉ để tìm vector) và một tiến trình Python sống lâu.
- **Cho fox-harness:**
  - fox-harness hiện **chưa có bộ nhớ dài hạn**. Mỗi chat chỉ có session log của chính nó, và `history(n)` của python
    tool.
  - Nếu đưa vào, các chỗ nối tương ứng:
    - recall ở `agent/pre-step` (giống `flow-data-analysis` đang chèn dataset card);
    - remember ở `session/event` `turn/end` (giống `usage-recorder.ts`);
    - kho dữ liệu đặt trong `dataDir` và đi theo cơ chế archive S3;
    - các lần gọi model ghi qua `fox/usage` để hiện trên dashboard;
    - route quản lý ký ức đặt dưới gateway.

## 13. Nếu làm ở fox-harness với hạ tầng công ty: chỉ có MariaDB và Qdrant

pynote lưu mọi thứ trong **file cục bộ**: 3 file SQLite, một Qdrant chạy nhúng, và `off-chats.json`. Cách đó không hợp
với fox-harness:

- Pod của fox-harness không có đĩa dùng chung giữa các bản sao.
- Công ty chỉ cấp **MariaDB và Qdrant (server)**.

Có thể chuyển tương ứng như sau:

| pynote (file)                                             | Chuyển sang                                                                                | Ghi chú                                                                                           |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `events.db` → bảng `events`                               | MariaDB `discovery_memory_events`                                                          | nguồn sự thật của event (nội dung, thuộc tính JSON, phạm vi, chủ đề, ngày, hạn, số lần truy xuất) |
| `entities.db` → `entities`, `entity_history`              | MariaDB `discovery_memory_entities`, `discovery_memory_entity_history`                     | unique (schema, user_id, session_id, key); state JSON                                             |
| `events.db` → `keywords`, `keyword_links`                 | MariaDB `discovery_memory_keyword_links` + vector từ khoá trên Qdrant                      |                                                                                                   |
| `off-chats.json`                                          | MariaDB (cột trên `discovery_sessions` hoặc bảng riêng)                                    |                                                                                                   |
| `qdrant/` (nhúng, qua Mem0)                               | **Qdrant server**, collection `memory_events`, gọi trực tiếp bằng `qdrant-client`          | bỏ Mem0 hẳn, vì pynote chỉ dùng Mem0 làm lớp vector; `mem0-history.db` cũng không cần nữa         |
| Vector entity (BLOB trong SQLite, tính cosine bằng numpy) | Qdrant collection `memory_entities`                                                        | lọc theo payload `user_id` / `session_id` / `scope`, khỏi phải nạp hết vector ra RAM              |
| Vector từ khoá (BLOB)                                     | Qdrant collection `memory_keywords`                                                        | vector trung bình cập nhật bằng upsert                                                            |
| FTS5 bỏ dấu (nhánh BM25)                                  | **Qdrant sparse vector** (cùng collection `memory_events`, `modifier: idf`, Qdrant ≥ 1.10) | xem lý do bên dưới                                                                                |

**Vì sao nhánh từ khoá nên chuyển sang Qdrant mà không dùng FULLTEXT của MariaDB:**

- FULLTEXT của InnoDB bỏ từ ngắn hơn `innodb_ft_min_token_size` (mặc định 3). Rất nhiều âm tiết tiếng Việt chỉ có 2 ký
  tự ("xã", "số", "bộ"), nên bị bỏ.
- Muốn đổi tham số này phải sửa cấu hình server MariaDB và dựng lại index, mà DB của công ty có thể không cho đổi.
- Qdrant hỗ trợ sparse vector với IDF, tức chấm điểm kiểu BM25. Code tự bỏ dấu và tách từ (giống `fold` của pynote), rồi
  gửi một vector thưa cho mỗi event.
- Dense và sparse nằm chung một collection, nên **một truy vấn hybrid** (Query API, prefetch dense + sparse rồi gộp) thay
  được cả nhánh chính của pynote.
- Phương án dự phòng nếu Qdrant cũ hơn 1.10: thêm cột văn bản đã bỏ dấu trong MariaDB và tìm bằng `LIKE` (chậm hơn, không
  có điểm BM25).

**Những gì cần sửa so với pynote:**

- Viết lại `catalog.py`, `entity_store.py` (SQLite → MariaDB) và `event_store.py` (Mem0 → `qdrant-client`).
  - Phần prompt, toán tử, xếp hạng và vòng đời giữ nguyên.
  - Hoặc viết lại bằng TypeScript trong gateway / agent-core, khỏi phải chạy tiến trình Python riêng.
- **Bỏ khoá kho chung một tiến trình** của `server.py`.
  - Khoá đó chỉ cần vì SQLite và Qdrant nhúng chỉ cho một tiến trình mở.
  - Thay vào đó: MariaDB dùng transaction và `insert … on duplicate key update`; Qdrant dùng upsert theo id.
  - Thứ tự ghi của mỗi người dùng vẫn phải giữ: một hàng đợi theo user, như core của pynote đang làm.
- **Phân quyền:** lọc theo `user_id` ở mọi truy vấn Qdrant (payload index trên `user_id`, `session_id`, `scope`), như
  `workspace-guard` đang làm cho file.
- **Xoá chat / xoá người dùng:** xoá cả dòng MariaDB lẫn điểm Qdrant (delete by filter `session_id`).
- **Đếm chi phí:** các lần gọi LLM và embedding của bộ nhớ ghi vào `discovery_usage_steps` với `purpose` `memory-*`, để
  hiện trên dashboard `/admin/usage`.
