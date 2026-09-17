# Chuyển `example-data-studio-agent` vào fox-harness-core

> **v4 — bản đã triển khai.** Lịch sử rút gọn: v1 "custom loop + flow
> riêng" → v2 "1 dsh tool gọi HTTP sang 1 service Python riêng" → v3 "1 dsh
> tool spawn Python làm subprocess, vẫn để code ở `services/data-studio-agent/`"
> → **v4 (bản này): chuyển hẳn code Python vào trong
> `packages/tool/data-studio-agent/python/`**, đúng layout
> `packages/tool/python-repl` đã có sẵn (code Python nằm NGAY TRONG package
> dùng nó, không phải 1 thư mục cấp cao riêng). Lý do đổi lần cuối (user:
> "sao vẫn để services/data-studio-agent... bỏ 1 folder python trong tool"):
> sau khi xoá lớp FastAPI/HTTP ở v3, thư mục đó không còn là "1 service"
> theo đúng quy ước của repo (`services/` = thứ triển khai độc lập, có
> lifecycle riêng — `services/gateway`/`services/orchestrator`) nữa — để nó
> ở `services/` là sai tên.

## Trạng thái

Đã triển khai xong Phase 1 + 2 (hạ tầng + tool + FE), đã dọn code dư thừa
(xoá hẳn lớp FastAPI/HTTP/auth chưa từng dùng) và đã chuyển vị trí thư mục
Python vào đúng package. Xem "Còn lại" cuối file cho phần chưa làm
(Phase 3 — semantic layer admin UI).

## Kiến trúc

```
model (turn của session)
   │  gọi tool "analyze_data"
   ▼
packages/tool/data-studio-agent/src/{index,kernel}.ts (Cordis plugin, TypeScript)
   │  spawn subprocess 1 lần/container, JSON-lines qua stdin/stdout
   ▼
packages/tool/data-studio-agent/python/bridge/runner.py (cầu nối, ~90 dòng)
   │  gọi trực tiếp, KHÔNG qua HTTP
   ▼
packages/tool/data-studio-agent/python/src/pipeline_v3/orchestrator.py::run_pipeline_v3
   │  logic nghiệp vụ thật — vendor từ example-data-studio-agent
   ▼
Dremio (data warehouse) + Meilisearch (retrieval) + LLM/embedding endpoint
```

Không có FastAPI/uvicorn, không có container/service HTTP riêng, không có
auth — subprocess chỉ nói chuyện với đúng 1 tiến trình cha (worker Node) qua
1 pipe riêng tư, không bao giờ ra mạng. Toàn bộ nằm trong 1 package
(`packages/tool/data-studio-agent/`) — TS wrapper (`src/`) và Python vendor
(`python/`) sống cạnh nhau, không tách sang thư mục cấp cao khác.

## Cấu phần đã thêm/sửa

### 1. `packages/tool/data-studio-agent/python/` — vendor logic Python (giữ nguyên nghiệp vụ)

Copy từ `example-data-studio-agent` (giữ `pipeline_v2` làm tool-internals
của `pipeline_v3`, giữ `settings.py`/`database/`/`services/*` nguyên vẹn).
2 thay đổi thật đối với logic:

- **`bridge/runner.py`** (MỚI) — JSON-lines: đọc `{"question"}` mỗi dòng từ
  stdin, gọi `run_pipeline_v3(session, llm, emb, vs, dremio, question,
  on_event)` trực tiếp, in ra 1 dòng JSON:
  `{"ok", "answer", "sql", "columns", "rows", "row_count", "trace_md",
  "chart", "truncated"}` hoặc `{"ok": false, "error"}`.
  - `run_pipeline_v3` **không nhận conversation_id/history** — stateless
    theo từng câu hỏi. Session log của fox tự mang ngữ cảnh nhiều lượt.
  - **Giới hạn đã biết**: vòng review chart bằng vision của pipeline chờ FE
    render + chụp ảnh gửi lại; không có FE nào gắn vào subprocess này nên
    mỗi chart timeout sau 12s rồi dùng chart chưa review (có giới hạn,
    không treo — trade-off chấp nhận được cho bản đầu).
- **Đã XOÁ hẳn lớp FastAPI/HTTP/auth** (không chỉ tắt) — xác nhận bằng grep
  import trước khi xoá rằng không nhánh nào trong `pipeline_v3`/
  `pipeline_v2`/`bridge/runner.py` cần tới: `src/apis/` (toàn bộ — routes +
  `deps.py`), `src/app.py`, `main.py`, `Dockerfile`/`.dockerignore` gốc của
  service (build image thật là `infra/docker/worker/Dockerfile`),
  `src/security.py` (JWT/bcrypt, chỉ `apis/` dùng),
  `src/services/dashboard_pdf.py` (weasyprint, chỉ route admin dashboard
  dùng). `settings.py` bỏ theo các field auth/JWT/cookie không còn ai đọc.
- **`pyproject.toml`/`uv.lock`** — bỏ theo: `fastapi`, `uvicorn[standard]`,
  `python-jose`, `python-multipart`, `bcrypt`, `weasyprint` (kéo theo
  `pillow`/`cryptography`/`fonttools`/... — ~80MB image, ~22 gói). Giữ lại
  `chromadb` dù không dùng ở runtime (`orchestrator.py`'s `vs: VectorStore`
  type annotation vẫn import module đó ở module-level — không sửa file
  pipeline chỉ để bỏ 1 type annotation).

### 2. Vị trí: `packages/tool/data-studio-agent/python/`, không phải `services/`

Chuyển nguyên từ `services/data-studio-agent/` (v3) sang trong package —
đúng layout `packages/tool/python-repl/python/` đã có sẵn cho chính vấn đề
này (script Python phục vụ 1 tool cụ thể sống NGAY TRONG package đó).
Không đổi gì về logic, chỉ đổi đường dẫn — mọi tham chiếu
(`kernel.ts`'s fallback path, `infra/docker/worker/Dockerfile`,
`services/orchestrator/src/config.ts`'s comment,
`infra/docker/docker-compose.dev.yml`'s comment) đã cập nhật theo.
`.gitignore`/`.dockerignore` thêm `.venv/`/`__pycache__/` (thiếu từ đầu —
không có thì `git add`/`docker build` sẽ kéo theo cả venv).

### 3. `infra/docker/worker/Dockerfile` — venv Python riêng cho tool này

```dockerfile
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
RUN cd packages/tool/data-studio-agent/python && uv sync --locked
ENV FOX_PYTHON_DATA_STUDIO=/repo/packages/tool/data-studio-agent/python/.venv/bin/python
ENV DATA_STUDIO_AGENT_DIR=/repo/packages/tool/data-studio-agent/python
```

Venv **riêng**, tách khỏi `/opt/fox-py` (venv có sẵn của `python-repl`) — lý
do thật, đã xác nhận: `pyproject.toml` của gói này pin Python ≥3.12, trong
khi apt của `node:22-slim` (Debian bookworm) chỉ có Python 3.11
(`apt-cache madison python3.12` không ra gì). `uv` tự tải CPython 3.12 độc
lập với apt, nên `uv sync` trong đúng thư mục vendor luôn ra đúng interpreter.

### 4. `packages/tool/data-studio-agent/src/` — plugin TS, KHÔNG chứa logic nghiệp vụ

Bản sao cấu trúc `packages/tool/python-repl` (`kernel.ts` + `index.ts` +
`cordis.patch.yml` `insert:` thuần):

- `src/kernel.ts`: `DataStudioKernel` — spawn `FOX_PYTHON_DATA_STUDIO` chạy
  `../python/bridge/runner.py` (đường dẫn tương đối NGAY TRONG package sau
  khi chuyển, dùng làm fallback dev; ảnh Docker thật dùng
  `DATA_STUDIO_AGENT_DIR` env), 1 tiến trình/worker container, tái dùng qua
  các lượt. Khác `PythonKernel` (môi trường tối giản cho code người dùng
  viết): tiến trình này chạy script CỦA MÌNH nên được forward credential
  thật (`OPENAI_*`/`EMBEDDING_*`/`DREMIO_*`/`MEILISEARCH_*`/`DATABASE_URL`).
- `src/index.ts`: đăng ký tool `analyze_data` — 1 tham số `question`, output
  `{answer, sql?, columns, rows, row_count, chart?, truncated}`,
  `presentationMeta` chiếu ra `{sql, columns, rows, rowCount, chart,
  truncated}` cho UI (đúng pattern `web_search`'s `meta.sources` đã dùng).
- Thêm vào **bundle mặc định** (`packages/profile-template/default`) — có
  sẵn cho mọi session, không cần flow/profile riêng.

### 5. Semantic layer dùng chung — bind mount cố định, không phải per-session

Config semantic layer (data source/entity/metric/glossary) là sqlite
**dùng chung cho MỌI session**, khác `/data` (per-session). Mỗi worker
container — dù thuộc session nào — đều mount CÙNG 1 thư mục host vào CÙNG 1
đường dẫn cố định:

- `services/orchestrator/src/config.ts`: `dataStudioSharedDir` (mặc định
  `<repo>/data/data-studio-shared`).
- `services/orchestrator/src/docker.ts`'s `spawnWorker`: bind mount
  `${dataStudioSharedDir}:/data-studio-shared` **vô điều kiện** (mọi
  container, không chỉ khi có sessionCwd), set
  `DATABASE_URL=sqlite:////data-studio-shared/semantic_layer.db`.

### 6. `workerEnvPassthrough` (config.ts) — thêm credential cho bridge

`EMBEDDING_API_KEY/BASE_URL/MODEL_ID`, `DREMIO_URL/USERNAME/PASSWORD`,
`MEILISEARCH_URL/MASTER_KEY/SEMANTIC_RATIO`, `DATA_STUDIO_V3_DEBUG` (tắt
debug-dump mặc định-bật của pipeline nếu muốn) — forward từ `.env` gốc vào
container. LLM dùng chung `OPENAI_*` đã có sẵn (không cần key riêng).

### 7. FE (`apps/web`) — `DataStudioResultPill`

- `Conversation.tsx`: 1 `LogEntry` kind mới `"data-studio"` (1 pill/lần gọi
  — khác `"search"` không gộp nhiều lần gọi vào 1 pill, vì tool này chậm và
  mô hình chỉ nên gọi 1 lần/câu hỏi rõ ràng). Bắt `tool/call` +
  `tool/result` cho tên tool `analyze_data`, parse `presentationMeta` qua
  `parseDataStudioMeta()` (cùng kiểu "không tin dữ liệu trên wire" như
  `parseWebSearchMeta()` có sẵn).
- `ChartView.tsx` (MỚI) — dùng `recharts` (`^3.10.1`), map `chart.type` từ
  pipeline (`bar`/`line`/`area`/`pie`, mặc định `bar`) sang component
  tương ứng.
- i18n: `conversation.dataStudio{Running,Done,Failed,Truncated}`.

## Cây thư mục (thực tế sau khi dọn + chuyển vị trí)

```
fox-harness-core/
├── docs/data-studio-agent-transfer-plan.md      [file này]
│
├── infra/docker/
│   ├── docker-compose.dev.yml                    dremio + meilisearch (data infra, KHÔNG phải "service riêng")
│   └── worker/Dockerfile                         + venv uv riêng cho data-studio-agent
│
├── services/
│   ├── gateway/, orchestrator/                   KHÔNG có data-studio-agent nữa — đã chuyển vào packages/tool
│   └── orchestrator/src/{config,docker}.ts       dataStudioSharedDir + passthrough + bind mount
│
├── packages/
│   ├── profile-template/default/.../profile.package.json   + bundle mới
│   └── tool/data-studio-agent/
│       ├── src/{index,kernel}.ts                 plugin TS — KHÔNG chứa logic nghiệp vụ
│       ├── package.json, tsconfig.json, cordis.patch.yml
│       └── python/                               vendor Python (MỚI VỊ TRÍ — trước ở services/)
│           ├── bridge/runner.py                  cầu nối JSON-lines
│           ├── src/pipeline_v3/, pipeline_v2/, services/, database/, settings.py
│           ├── pyproject.toml, uv.lock            đã dọn (bỏ fastapi/uvicorn/jose/weasyprint/bcrypt)
│           └── .env.example                       chỉ để chạy bridge/runner.py thủ công, không có app HTTP nào nữa
│
├── apps/web/src/
│   ├── components/features/conversation/
│   │   ├── Conversation.tsx                      + LogEntry "data-studio", handlers
│   │   └── ChartView.tsx                          MỚI (recharts)
│   ├── package.json                              + recharts
│   └── i18n/translations.ts                       + 4 key mới
│
├── .env / .env.example (root)                     + EMBEDDING_*/DREMIO_*/MEILISEARCH_*/DATA_STUDIO_V3_DEBUG
├── .gitignore / .dockerignore                      + .venv/, __pycache__/
├── package.json (root)                            + dep tool mới
└── tsconfig.json (root)                           + reference
```

## Không mang theo (đã XOÁ khỏi bản vendor, không chỉ bỏ qua)

- Auth 1-user (`AUTH_USERNAME`/`AUTH_PASSWORD`, JWT cookie) + toàn bộ
  FastAPI/uvicorn/routes (`src/apis/`, `src/app.py`, `main.py`) +
  `src/security.py` + `src/services/dashboard_pdf.py` (weasyprint) — xác
  nhận không nhánh nào trong `pipeline_v3`/`pipeline_v2`/`bridge/runner.py`
  import tới trước khi xoá.
- `Dockerfile`/`.dockerignore` gốc của service (build image thật là
  `infra/docker/worker/Dockerfile`, không phải file này).
- UI Next.js gốc (`ui/`) — chưa từng copy sang.
- `pipeline_v2`/route `/ask`/`/ask_v2` — chỉ `pipeline_v3` được gọi; `v2`
  sống tiếp bên trong `v3` làm tool-internals (tự nhiên đi theo khi vendor
  nguyên `src/`).

## Còn lại (Phase 3 — chưa làm)

Semantic layer admin UI (quản lý data source/entity/metric/glossary) — vì
không còn service HTTP nào chạy sẵn, hướng khả thi nhất là: mỗi thao tác
admin cũng là 1 lệnh gọi subprocess riêng (script CLI Python ngắn thao tác
trực tiếp lên cùng file sqlite dùng chung), gọi từ 1 route mới trong
`services/gateway` (không phải worker — đây là thao tác admin, không gắn
với 1 session/model call cụ thể). Chưa thiết kế chi tiết — cần quay lại khi
bắt đầu Phase 3.

## Xác minh đã làm

- `bridge/runner.py`: chạy thật bằng `uv run` với 1 câu hỏi thật (LLM trỏ
  vào endpoint giả) — trả lỗi có cấu trúc thay vì crash. Chạy lại y hệt sau
  khi (a) dọn dependency, (b) chuyển vị trí thư mục — cả 2 lần đều pass.
- `apt-cache madison python3.12` trên `node:22-slim` thật — xác nhận không
  có gói, buộc phải dùng `uv` thay vì apt.
- `fox-harness-worker:dev` build thật 2 lần (trước/sau khi dọn dependency):
  2.66GB → 2.58GB. Chạy container thật, `docker run --entrypoint bash` vào
  trong, xác nhận `FOX_PYTHON_DATA_STUDIO`/`DATA_STUDIO_AGENT_DIR` đúng và
  bridge chạy được ngay trong container.
- Toàn bộ workspace: `tsc -b tsconfig.json` sạch, `node scripts/build-web.mjs`
  (esbuild bundle, bao gồm `recharts`) chạy thành công — kiểm tra lại sau
  mỗi lần sửa (dọn dependency, đổi đường dẫn).

## Xác minh còn phải làm (cần hạ tầng thật)

1. Rebuild `fox-harness-worker:dev` 1 lần cuối sau khi chuyển vị trí thư
   mục (đã sync/test được `uv sync` cục bộ ở vị trí mới, nhưng CHƯA rebuild
   lại image thật với đường dẫn Dockerfile mới).
2. Chat thật, hỏi 1 câu cần dữ liệu doanh nghiệp → model tự gọi `analyze_data`
   → pill "Đang phân tích dữ liệu…" → "Đã phân tích dữ liệu" → mở ra đủ
   answer/SQL/bảng/chart.
3. Hỏi câu không liên quan dữ liệu → xác nhận model KHÔNG gọi tool này.
4. Dremio + Meilisearch thật (cần tạo tài khoản admin Dremio qua UI lần đầu,
   nạp dữ liệu semantic layer thật — hiện là DB trống).
