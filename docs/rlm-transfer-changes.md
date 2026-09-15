# Nhật ký thực thi — phân tích dữ liệu (RLM) trên fox

Theo `docs/rlm-transfer-plan.md`. Nhánh `feat/data-analysis` (tách từ `dev`
`f4cd118`). **Chưa commit** phần thực thi.

Ký hiệu: **[mới]** file tạo mới · **[sửa]** file có sẵn bị sửa · **[xoá]** file bị xoá.

## Chuẩn bị

| Việc | Kết quả |
|---|---|
| Tạo nhánh `feat/data-analysis` từ `dev`, chép commit kế hoạch | `24c3971` |
| `pnpm install --frozen-lockfile`, `pnpm run build` | ✅ |

## Giai đoạn 0

### 0.0 — Hành vi trước khi sửa (worker trên máy + LLM giả)

Script: scratchpad `skilltest/err-test.sh`, `err-llm.mjs`, `err-client.mjs`.

| Kiểu lỗi | Số lần gọi model | `finish` | Câu trả lời | `turn/end` |
|---|---|---|---|---|
| 429 hai lần rồi thành công | **1** | `{kind:"error", code:"REQUEST_FAILED", status:429}` | rỗng | **`completed`** |
| 500 mãi | **1** | `code:"REQUEST_FAILED", status:500` | rỗng | **`completed`** |
| Vượt ngữ cảnh (400) | **1** | `code:"REQUEST_FAILED", status:400` | rỗng | **`completed`** |

Kết luận: lỗi model bị nuốt — không thử lại, không nén, lượt chat ghi "hoàn thành"
với câu trả lời rỗng. Log worker không có dòng nào về retry/compaction/error.

### 0.1 + 0.2 — `request/header`, `agent/request-error`, mã lỗi đúng

| File | Loại | Sửa gì |
|---|---|---|
| `packages/agent-driver/src/agent.ts` | [sửa] | Tách hàm `callModel`: dựng request (đánh dấu `markAgentLoopRequest` + `sessionId`), ghi `request/header`/`request/context` (hàm `logRequestHeader`, cùng luật `dsh-agent-loop` `buildRequest`), đọc `assembler.finish`; lỗi → waterfall `agent/request-error` → `retry` thì gọi lại, không thì ném `LlmError`. `turn/end` lỗi ghi `error.failure` (mã thật) thay vì luôn `UNKNOWN`. Chú thích "scope cuts" bỏ 2 mục đã làm |
| `packages/agent-driver/README.md` | [sửa] | Mục "Deliberate scope cuts": gạch 2 mục đã làm |
| `packages/llm/openai-compat/src/adapter.ts` | [sửa] | Hàm `httpErrorCode` (cùng cách `dsh-llm-deepseek`): 401/403 `AUTH`, hết hạn mức `QUOTA`, 429 `RATE_LIMIT`, 400 vượt ngữ cảnh `CONTEXT_WINDOW_EXCEEDED`, 5xx `SERVER`, còn lại giữ `REQUEST_FAILED`. `fetch` lỗi mạng → `TRANSPORT` |
| `packages/llm/openai-compat/src/sse.ts` | [sửa] | Hết thời gian chờ stream → `LlmError` mã `TIMEOUT`; stream đứt trước `[DONE]` → `TRANSPORT` |

Kết quả sau khi sửa (cùng bộ thử 0.0, thêm kiểu `ok`):

| Kiểu | Kết quả |
|---|---|
| Bình thường | ✅ `request/header` `reason=initial` (26 tool, system 7306 ký tự), `request/context`; `session/title-llm-request` → `session/title` nguồn `provider` ("Tiêu đề do LLM đặt") |
| 429 hai lần | ✅ `finish` mã `RATE_LIMIT` → 2 × `llm/retry` (chờ ~0,5 s, ~1 s) → lần 3 thành công, câu trả lời "OK lần gọi 3", `turn/end completed` |
| 500 mãi | ✅ 5 lần thử lại (~15 s tổng) → `turn/end {kind:"error", code:"SERVER"}` |
| Vượt ngữ cảnh | ✅ mã `CONTEXT_WINDOW_EXCEEDED` → `compaction/start` chạy ngay. Nén báo "summary is not smaller than the shadowed content" vì hội thoại thử chỉ có 1 câu (không có gì để nén) → `turn/end` lỗi. Cơ chế đúng; nén thành công cần hội thoại dài |

Thử hồi quy (scratchpad `skilltest/regress-test.sh`): lượt có gọi tool, tắt worker, bật lại cùng thư mục, nối lại hội thoại.

| Kiểm tra | Kết quả |
|---|---|
| Lượt gọi `web_search` (key Serper giả → tool lỗi) | ✅ vòng lặp vẫn sang bước 2, trả lời, `turn/end completed` |
| Nối lại sau khi bật lại worker | ✅ `request/header reason=resume`, trả lời bình thường |
| Phát hiện (có từ trước, không do lần sửa này) | ⚠️ lượt đầu sau khi mở lại đánh số `turn: 1`, trùng lượt cũ — driver đếm lượt từ 0 mỗi lần tạo agent, bản gốc đọc `turn/start` cuối trong nhật ký. Ghi vào giai đoạn 5 |

Giao diện: `turn/end` lỗi trước chỉ hiện "lượt 1 kết thúc: error".

| File | Loại | Sửa gì |
|---|---|---|
| `apps/web/src/components/features/conversation/Conversation.tsx` | [sửa] | `turn/end` có `reason.kind === "error"` → hiện "Không gọi được model ({code}): {message}" |
| `apps/web/src/i18n/translations.ts` | [sửa] | Thêm `conversation.modelError` (vi/en) |

## Giai đoạn 1 — Chạy thử và sửa khung flow

### Sửa code

| File | Loại | Sửa gì |
|---|---|---|
| `apps/web/src/components/features/sidebar/Sidebar.tsx` | [sửa] | Bỏ `disabled={newSessionDisabled}` ở nút "Phân tích dữ liệu" (trước đây bị khoá đúng lúc đang ở chat trống) |
| `services/gateway/src/db.ts` | [sửa] | `listSessionsForOwner` trả thêm `flow` (gateway đã `...row` nên `GET /sessions/mine` tự có) |
| `apps/web/src/components/features/sidebar/HistoryChat.tsx`, `apps/web/public/style.css` | [sửa] | Dòng hội thoại có `flow === "data-analysis"` hiện biểu tượng biểu đồ (`.fh-history-chat-row-flow`) |
| `apps/web/src/icons.tsx` | [sửa] | Chú thích bỏ tên package đã không còn (`dsh-agent-driver-data-analysis`) |
| `README.md`, `docs/core-overview.md`, `packages/tool/serper-web-search/{README.md,cordis.patch.yml}`, `packages/profile-template/data-analysis/template/cordis.patch.yml`, `services/orchestrator/src/materialize.ts` | [sửa] | Đường dẫn cũ `packages/profile-template/template/…` → `packages/profile-template/<flow>/template/…` |

### Triển khai

| Việc | Kết quả |
|---|---|
| `pnpm run build` | ✅ |
| Build image worker | ✅ 1.4 GB, có `packages/flow/data-analysis`, `profile-template/{default,data-analysis}`, `entrypoint.sh` đọc `DSH_PROFILE_NAME` |
| Bộ fox bị tắt lúc 16:06 giờ VN | Nguyên nhân: **máy khởi động lại** (`uptime -s` = 16:06:50, Docker bật 16:07:04). Container fox có `Restart=no` nên nằm im. User đồng ý bật lại |
| Bật lại | `docker start` Redis + MariaDB (không tạo lại, dữ liệu giữ nguyên); xoá `fh:warmpool` cũ; `data/fox-run.sh start all` |
| Migration `003_add_flow_column.sql` | ✅ chạy trên MariaDB máy phát triển; 12 hội thoại cũ nhận `flow = default`. Từ `dev` 584b34e file này bị gộp vào `infra/migrations/001_init.sql`; DB máy phát triển được tạo lại từ file đó (không chuyển dữ liệu) |

### Thử thật

Script scratchpad `skilltest/flow-e2e.mjs` (qua gateway, Qwen thật, tài khoản `flow-test@fox.local`):

| Kiểm tra | Kết quả |
|---|---|
| A. Chat mới `?flow=data-analysis` | ✅ Redis `flow: data-analysis`; container `DSH_PROFILE_NAME=fox-harness-data-analysis`; log có dòng đánh dấu `fox-harness-flow-data-analysis/pre-step`; thư mục `profiles/fox-harness-data-analysis` |
| B. Chat thường mới | ✅ `flow: default`, `DSH_PROFILE_NAME=fox-harness`, không có dòng đánh dấu, lấy container dựng sẵn |
| C. `GET /sessions/mine` | ✅ có `flow` cho từng dòng |
| D. Xoá container chat dữ liệu rồi mở lại | ✅ container mới vẫn `fox-harness-data-analysis`, có dòng đánh dấu, trả lời bình thường |

Script `skilltest/flow-cdp.mjs` (Chrome thật), ảnh `skilltest/shots-flow/`:

| Kiểm tra | Kết quả |
|---|---|
| Nút "Phân tích dữ liệu" khi đang ở chat trống | ✅ `disabled: false` (nút "Trò chuyện mới" vẫn khoá như cũ) |
| Bấm → gửi tin | ✅ chat mới có `flow: data-analysis`, trả lời bình thường, tên tự đặt "Phân tích dữ liệu: chào" |
| Thanh bên | ✅ 2 chat dữ liệu có biểu tượng biểu đồ, chat thường không có |

## Giai đoạn 2 — Tool `python` và thư mục làm việc

### Sửa code

| File | Loại | Sửa gì |
|---|---|---|
| `packages/tool/python-repl/` (`package.json`, `tsconfig.json`, `cordis.patch.yml`, `README.md`, `src/index.ts`, `src/kernel.ts`, `python/runner.py`) | [mới] | Tool `python(code)`. Một tiến trình IPython cho mỗi container (= mỗi hội thoại), khởi động ở lần gọi đầu trong thư mục làm việc của hội thoại, nói chuyện bằng từng dòng JSON. Giới hạn 120 s/lần gọi (quá giờ hoặc bị huỷ → dừng tiến trình, báo biến đã mất). Output cắt sau 20 000 ký tự. Ô lỗi → tool báo lỗi kèm traceback. Biểu đồ matplotlib lưu `generated/figure-*.png`, trả đường dẫn. File `.python-session` trong thư mục làm việc để báo "session was restarted" sau khi container ngủ. Tiến trình Python chỉ nhận `PATH`, `HOME`, `LANG`, `MPLBACKEND` — không có API key. `input()` bị chặn |
| `packages/profile-template/data-analysis/template/profile.package.json`, `package.json`, `tsconfig.json`, `pnpm-lock.yaml` | [sửa] | Thêm `@fox-harness/dsh-tool-python-repl` — **chỉ** vào profile dữ liệu |
| `services/orchestrator/src/config.ts` | [sửa] | `config.flows[...].cwd`: `default` → `undefined` (giữ `/repo`), `data-analysis` → `/data/workspace` |
| `services/orchestrator/src/docker.ts` | [sửa] | `spawnWorker(..., sessionCwd)`: tạo sẵn thư mục trên máy chủ (chủ sở hữu là user chạy orchestrator, để giai đoạn 4 ghi file tải lên được) và truyền `FOX_SESSION_CWD` vào container |
| `services/orchestrator/src/ensure.ts` | [sửa] | Truyền `cwd` của flow ở cả nhánh tạo mới và nhánh mở lại |
| `packages/transport/src/server.ts` | [sửa] | Tạo agent với `meta.cwd = FOX_SESSION_CWD ?? process.cwd()` |
| `infra/docker/worker/Dockerfile` | [sửa] | venv `/opt/fox-py` + `ipython pandas numpy matplotlib`, `ENV FOX_PYTHON` |

### Thử trên máy (worker + LLM giả + profile dữ liệu)

Script scratchpad `skilltest/python-test.sh`, `py-llm.mjs`; Python thử: venv scratchpad (IPython 8.39, pandas 2.3.3, matplotlib 3.10.9).

| Lượt | Kết quả |
|---|---|
| Request đầu tiên của model | ✅ danh sách tool có `python` |
| 1. Đọc `sales.csv`, tính trung bình | ✅ `rows 4`, `mean amount 143.75` |
| 2. Dùng lại `df`, vẽ biểu đồ | ✅ `df vẫn còn: (4, 2)`; `Saved figures: generated/figure-….png`, file có thật |
| 3. `1/0` | ✅ `tool/result isError=true`, traceback `ZeroDivisionError` |
| 4. Biến môi trường trong Python | ✅ không có biến nào chứa `KEY` (worker có `OPENAI_API_KEY`, `SERPER_API_KEY`); `cwd` đúng thư mục làm việc |
| 5. Tắt worker, bật lại, dùng lại `df` | ✅ "Note: the Python session was restarted…" rồi `NameError` |

### Triển khai và thử thật (Qwen)

| Việc | Kết quả |
|---|---|
| Build image | ✅ 1.85 GB (trước 1.4 GB); `FOX_PYTHON=/opt/fox-py/bin/python`, pandas 3.0.5 |
| Thay container dựng sẵn, khởi động lại orchestrator | ✅ |

Script scratchpad `skilltest/flow-py-e2e.mjs`: chat dữ liệu, đặt `sales.csv` (6 tháng) vào `data/dsh-home/<id>/workspace/`.

| Kiểm tra | Kết quả |
|---|---|
| Container | ✅ `DSH_PROFILE_NAME=fox-harness-data-analysis`, `FOX_SESSION_CWD=/data/workspace`, `FOX_PYTHON=/opt/fox-py/bin/python` |
| Lượt 1: "tính doanh thu trung bình và vẽ biểu đồ" | ✅ model đọc file bằng `read`, rồi gọi `python`: "Doanh thu trung bình: 165.83", lưu `revenue_chart.png` và `generated/figure-….png` |
| Lượt 2: "tháng nào cao nhất, dùng lại dữ liệu" | ✅ gọi `python`, "tháng 6, 240". ⚠️ model **đọc lại CSV** thay vì dùng lại `df` — prompt giai đoạn 3 sẽ dặn dùng lại biến |
| Thư mục làm việc | ✅ `.python-session`, `sales.csv`, `revenue_chart.png`, `generated/figure-….png` |

## Giai đoạn 3 — Hàm dữ liệu, prompt, 9 skill

### Sửa code

| File | Loại | Sửa gì |
|---|---|---|
| `packages/tool/python-repl/python/helpers.py` | [mới] | Nạp sẵn vào IPython: `list_datasets()` (file `.csv/.tsv/.xlsx/.xls/.parquet` trong thư mục làm việc, bỏ `generated/` và file ẩn), `load_dataset(name=None)` (đường dẫn đúng, một phần tên, hoặc file mới nhất; CSV tự dò dấu phân cách; có cache theo thời điểm sửa file), `profile_dataset(name=None)` (kích thước, kiểu, ô trống, bản ghi trùng, thống kê số, vài dòng đầu — có giới hạn độ dài), `save_artifact(path, content)` (ghi vào `generated/`, nhận text/bytes/JSON/figure/ảnh, xoá file hỏng). Chuyển từ `rlm_agent/tools.py`, **bỏ** `index.json` của chức năng tải lên và thư mục nháp theo hội thoại |
| `packages/tool/python-repl/python/runner.py`, `src/index.ts`, `README.md` | [sửa] | Runner nạp `helpers.py` vào không gian biến của IPython; mô tả tool và README nêu 4 hàm |
| `packages/flow/data-analysis/src/index.ts` | [sửa] | Bỏ dòng log đánh dấu của khung (tác giả ghi "thay marker bằng hành vi thật là việc tiếp theo"). Thêm mục system prompt `fox:data-analysis` (order 30): dùng `python` cho mọi phép tính, `list_datasets`/`profile_dataset` trước khi phân tích, **dùng lại biến đã có**, chỉ kết luận từ dữ liệu đã chạy, kiểm tra tương xứng, in ít, lưu file bằng `save_artifact`, lỗi thì đổi cách, sự kiện thực tế cần `web_search`, nạp skill phù hợp, câu trả lời nêu kết quả trước rồi giả định/giới hạn. Ý lấy từ `evidence-policy.md`, `turn-policy.md` của agent-core; bỏ `repl-protocol.md`, `completion.md` |
| `packages/flow/data-analysis/package.json`, `pnpm-lock.yaml` | [sửa] | devDependency `@deepseek-ai/dsh-system-prompt` thay `@deepseek-ai/dsh-agent` (không còn dùng) |
| `packages/profile-template/data-analysis/template/cordis.patch.yml` | [sửa] | Persona "chế độ Phân tích dữ liệu" thay tiền tố `[data-analysis flow]`; thêm dòng `skill-filesystem` `customSkillDirs: [/repo/packages/flow/data-analysis/skills]` |
| `packages/flow/data-analysis/skills/` (9 skill, 64 file, ~500 KB) | [mới] | Chép từ `agent-core/bundles/skills`: data-profiling, data-scientist, data-visualization, deliverable-export, ml-modeling, pandas-expert, product-analytics, statistical-analysis, time-series-analysis. Bỏ dòng `drivers: rlm` và `argument-hint:` (đã kiểm: skill không nhắc hàm riêng nào của RLM). `data-scientist`: mô tả có `: ` → đặt trong ngoặc kép (nếu không, YAML hỏng và dsh **lặng lẽ bỏ skill**, không ghi log) |
| `infra/docker/worker/Dockerfile` | [sửa] | Thêm `scipy scikit-learn seaborn openpyxl pyarrow` (đúng thư viện script trong skill import: `sklearn` 63 lần, `seaborn`, `joblib`). **Không** thêm `statsmodels`, `duckdb` như kế hoạch dự tính — không skill nào dùng |

### Thử trên máy (worker + LLM giả, profile dữ liệu và profile thường)

Script scratchpad `skilltest/gd3-test.sh`, `gd3-llm.mjs`.

| Kiểm tra | Profile dữ liệu | Profile thường |
|---|---|---|
| `profile_dataset('sales.csv')` | ✅ shape, dtypes, missing, duplicated, numeric summary, head | — |
| `load_dataset('sales')` + `save_artifact('chart.png', fig)` | ✅ trả `generated/chart.png`, file có thật | — |
| `list_datasets()` | ✅ `[{'name': 'sales.csv', …}]` (không liệt kê `generated/`, `.python-session`) | — |
| Mục system prompt "Data analysis workspace" | ✅ có | ✅ không có |
| Persona | ✅ "chế độ Phân tích dữ liệu", không còn `[data-analysis flow]` | ✅ persona thường |
| 9 skill dữ liệu trong danh mục | ⚠️ lần 1: **8/9** — thiếu `data-scientist` (YAML hỏng vì `: ` trong mô tả). Sau khi đặt mô tả vào ngoặc kép: ✅ **9/9** | ✅ 0/9 |
| Tool `python` | ✅ có | ✅ không có |

### Triển khai

| Việc | Kết quả |
|---|---|
| Build image | ✅ 2.34 GB; scikit-learn 1.9.1, pandas 3.0.5; 9 skill trong `/repo/packages/flow/data-analysis/skills` |
| Thay container dựng sẵn, khởi động lại orchestrator | ✅ |

### Benchmark (bộ fox thật, Qwen thật)

Script scratchpad `skilltest/bench-e2e.mjs`: 7 câu DABench của agent-core
(`benchmarks/rlm/cases-ds.json`, dữ liệu `fixtures/dabench/`). Mỗi câu: chat dữ
liệu mới, chép file vào `workspace/`, gửi nguyên câu hỏi, chấm theo đúng tiêu chí
của `run.py` (`numeric_answers` có sai số, `answer_regex`, `answer_any`,
`answer_not`, `forbidden_tools`).

| Câu | Kết quả | Tool đã gọi |
|---|---|---|
| mean_temperature_683 | ✅ `29.14` | list_datasets, bash, read, python |
| missing_values_715 | ✅ `95.12` | list_datasets, python |
| normality_19 | ✅ `No` | python ×3 |
| correlation_587 | ✅ `0.639` | skill, list_datasets, bash, read, python ×2 |
| feature_engineering_354 | ✅ `2.6` | skill ×2, list_datasets, glob, python, bash ×3, python ×2 |
| outliers_254 | ✅ Kuwait, Saudi Arabia | list_datasets, python |
| regression_mse_671 | ✅ `0.653` | skill ×2, list_datasets, bash, read, bash, python ×2 |
| **Tổng** | **7/7** trong 71 s (RLM agent-core `ds-baseline.json`: 7/7) | |

⚠️ 5/7 câu model gọi **tool tên `list_datasets`** (không tồn tại — đó là hàm Python
trong tool `python`), bị báo lỗi rồi tự đổi cách. Sửa câu chữ prompt:
"Inside the `python` tool (they are Python functions, not tools): run
`list_datasets()` …" (`packages/flow/data-analysis/src/index.ts`).

Chạy lại sau khi sửa câu chữ (cùng 7 câu, `skilltest/bench-run2.log`):

| Câu | Kết quả | Tool đã gọi |
|---|---|---|
| mean_temperature_683 | ✅ | python ×3 |
| missing_values_715 | ✅ | python |
| normality_19 | ❌ trả lời "Tôi sẽ kiểm tra… Trước hết, hãy đọc dữ liệu…" rồi dừng lượt, không có đáp án | read |
| correlation_587 | ✅ | skill, python ×4 |
| feature_engineering_354 | ✅ | skill, python ×3 |
| outliers_254 | ✅ | python ×3 |
| regression_mse_671 | ❌ câu trả lời cuối **rỗng** | skill, python ×3 |
| **Tổng** | **5/7** | |

✅ Không còn lần gọi nhầm tool `list_datasets`.

**Nguyên nhân 2 câu sai** (nối lại hội thoại, đọc snapshot — script
`skilltest/inspect-sessions.mjs`): bước cuối của Qwen trả về **chỉ khối suy nghĩ**,
không có chữ, và kết thúc `stop`:

```
regression_mse_671  step 4: finish {"kind":"stop"}  blocks=["reasoning:1027"]  text=""
normality_19        step 2: finish {"kind":"stop"}  blocks=["reasoning:977"]   text=""
```

`regression_mse_671` đã tính đúng ở bước 3 (hệ số khớp lần chạy 1) nhưng không nói
ra. `normality_19` trông như "dừng sớm" chỉ vì script chấm lấy câu chữ gần nhất
("Tôi sẽ kiểm tra…" ở bước 1). Không liên quan phần sửa driver (không có
`llm/retry`, không lỗi). Giao diện fox ẩn hẳn phần suy nghĩ nên người dùng **không
thấy gì**. Ghi vào giai đoạn 5 của kế hoạch.

## Giai đoạn 4 — Tải file lên, xem file kết quả

### Sửa code

| File | Loại | Sửa gì |
|---|---|---|
| `packages/contracts/src/index.ts` | [sửa] | `WorkspaceFile { path, sizeBytes, modified }`, `WorkspaceFilesResponse` |
| `services/orchestrator/src/workspace-files.ts` | [mới] | `workspaceDirFor` (chỉ flow có `cwd`), `resolveInside` (chặn thoát thư mục và đường ẩn), `listWorkspaceFiles` (đệ quy, bỏ file ẩn, mới nhất trước), `saveUpload` (ghi luồng qua file ẩn `.<tên>.part`, quá giới hạn thì huỷ và xoá), `contentTypeFor` (chỉ ảnh/CSV/text/JSON/PDF/XLSX có kiểu thật; HTML, SVG… tải về dạng tệp để không chạy được trong trang) |
| `services/orchestrator/src/config.ts` | [sửa] | `maxUploadBytes` (`MAX_UPLOAD_BYTES`, mặc định 70 MiB như agent-core) |
| `services/orchestrator/src/index.ts` | [sửa] | Route nội bộ `GET /sessions/:id/files`, `PUT /sessions/:id/files/<tên>` (tên trần, không bắt đầu bằng dấu chấm), `GET /sessions/:id/files/<đường dẫn>`; hàm `sendJson` |
| `services/gateway/src/orchestrator-client.ts` | [sửa] | `workspaceFiles(...)`: trả nguyên `Response` để thân file đi dạng luồng, không đọc hết vào bộ nhớ, không đặt hạn giờ |
| `services/gateway/src/index.ts` | [sửa] | `GET /sessions/:id/files`, `POST /sessions/:id/files?name=<tên>` (thân là file thô), `GET /sessions/:id/files/<đường dẫn>` — chỉ chủ hội thoại hoặc admin, hội thoại không có thư mục làm việc → 404 |
| `apps/web/src/components/features/conversation/workspaceApi.ts` | [mới] | Gọi 3 API trên |
| `apps/web/src/components/features/conversation/WorkspacePanel.tsx` | [mới] | Trong ô soạn tin của chat dữ liệu: nút "Tải file lên" (nhiều file, chặn >70 MB phía trình duyệt), "Tệp (N)" mở danh sách, bấm ảnh → xem trước, file khác → tải về. Làm mới khi đổi hội thoại và sau mỗi `turn/end` (bỏ qua các frame cũ được phát lại lúc đăng ký). Chat không có thư mục làm việc → không hiện gì |
| `apps/web/src/components/features/conversation/Conversation.tsx` | [sửa] | Gắn `<WorkspacePanel />` đầu `#send-form` |
| `apps/web/src/icons.tsx`, `apps/web/src/i18n/translations.ts`, `apps/web/public/style.css` | [sửa] | Icon `Paperclip`, `Folder`; khoá `workspace.*` (vi/en); CSS thanh tệp, danh sách, lớp xem trước ảnh |

### Triển khai

| Việc | Kết quả |
|---|---|
| Build, build image (prompt đã sửa chữ `list_datasets`) | ✅ |
| Khởi động lại orchestrator + gateway, thay container dựng sẵn | ✅ |

### Thử thật

Script scratchpad `skilltest/files-e2e.mjs` (qua gateway, Qwen thật; tài khoản thứ hai `flow-test2@fox.local` để thử quyền):

| Kiểm tra | Kết quả |
|---|---|
| Chat dữ liệu mới: danh sách tệp | ✅ `200`, `[]` |
| Tải lên `sales.csv` | ✅ `201`; có trong danh sách, đúng kích thước |
| Nhờ model vẽ biểu đồ bằng `save_artifact` | ✅ gọi `python` ×2, lưu `generated/doanh-thu.png` |
| Tải PNG về | ✅ `200`, `image/png`, 44 809 byte, đúng chữ ký PNG |
| Tải CSV về | ✅ đúng nội dung |
| `…/files/..%2F..%2Fprofiles%2F…` và `…/files/../../profiles/…` | ✅ `404` |
| `…/files/.python-session` | ✅ `404` |
| Tải lên tên `.env`, tên `../thoat.csv` | ✅ `400` |
| Tài khoản khác xem tệp | ✅ `404` |
| Chat thường xem tệp | ✅ `404` |

Script `skilltest/files-cdp.mjs` (Chrome thật), ảnh `skilltest/shots-files/`:

| Kiểm tra | Kết quả |
|---|---|
| Chat thường | ✅ không có thanh tệp |
| Chat dữ liệu | ✅ "Tải file lên" / "Tệp (0)" |
| Tải file qua ô chọn file của trình duyệt | ✅ danh sách hiện `doanh-thu-quy.csv` |
| Nhờ vẽ biểu đồ → danh sách tự làm mới sau lượt | ✅ `generated/figure-….png`, `bieu-do.png`, `doanh-thu-quy.csv` |
| Bấm ảnh → xem trước | ✅ ảnh 1087×646 hiện trên lớp phủ |

⚠️ Một biểu đồ ra **2 file**: model lưu bằng `save_artifact`/`savefig`, runner vẫn tự
lưu thêm `generated/figure-….png` vì hình chưa đóng. Sửa: `save_artifact` đóng
figure sau khi lưu (`packages/tool/python-repl/python/helpers.py`). Khi model tự gọi
`fig.savefig(...)` mà không đóng hình thì vẫn có bản tự lưu — chấp nhận.

⚠️ Ảnh `02-after-turn.png`: ô "Lỗi khi dùng save_artifact" — model gọi `save_artifact`
như **tool** (câu hỏi thử ghi thẳng `save_artifact("bieu-do.png", fig)`), bị báo lỗi,
rồi tự lưu bằng `savefig`. Cùng loại với việc gọi nhầm tool `list_datasets` ở
benchmark. Kết quả vẫn đúng; ghi nhận, xem lại sau khi benchmark chạy lại với
prompt đã sửa.

---

## Nén ngữ cảnh hoạt động được (2026-09-14)

**Lỗi thật:** chat thường `13592166…` tăng 9 024 → 31 272 token qua 8 lượt rồi
`turn/end` `CONTEXT_WINDOW_EXCEEDED`. Hai nguyên nhân:

1. Adapter openai-compat không khai báo `contextWindow` (dùng `resolveModel` mặc định
   của `dsh-llm`) → `compaction-basic` nén sớm ném "no context capacity" và bỏ qua
   (`dsh-compaction-basic/lib/index.js:880`, `:790`) → không bao giờ nén trước khi tràn.
2. Khi đã tràn, bản tóm tắt gửi lại gần như cả hội thoại (`summarizeWithLlm`) → cũng
   400 → `compaction/end` lỗi. Proxy tính cả `max_tokens` vào giới hạn 32 000
   ("requested 1 output tokens … total of at least 32001").

### Sửa code

| File | Loại | Nội dung |
|---|---|---|
| `packages/llm/openai-compat/src/adapter.ts` | [sửa] | `resolveModel` trả `context.contextWindow` từ `OPENAI_CONTEXT_WINDOW` |
| `services/orchestrator/src/config.ts` | [sửa] | `workerEnvPassthrough` thêm `OPENAI_CONTEXT_WINDOW` |
| `packages/profile-template/{default,data-analysis}/template/cordis.patch.yml` | [sửa] | Dòng `compaction-basic`: `thresholdRatio: 0.7`, `maxTokens: 4096` |
| `.env.example` | [sửa] | Ghi chú `OPENAI_CONTEXT_WINDOW` |

### Chọn ngưỡng (worker trên máy + LLM giả giới hạn 32 000, tính cả `max_tokens`)

Script `overflow/ctx-test.sh`. LLM giả đếm ký tự/4; lời gọi đầu 9 581 (thật 9 024) ở
chat thường, 11 047 (thật 10 471) ở chat dữ liệu.

| Cấu hình | Mỗi lượt +2 500 token | Mỗi lượt +6 000 token |
|---|---|---|
| Không `contextWindow` (trước khi sửa) | — | ❌ cả hai profile lỗi lượt 5; tóm tắt `34 653+8 192 → 400` |
| 0.8 / 8 192 (mặc định) | ✅ | ❌ profile dữ liệu: tóm tắt `23 825+8 192 → 400` |
| **0.7 / 4 096** | ✅ nén mỗi 3 lượt | ✅ tóm tắt lớn nhất `22 359+4 096` |
| 0.6 / 4 096 | ✅ profile dữ liệu nén gần như mỗi lượt | ✅ |

### Benchmark nhiều lượt (bộ fox thật, Qwen thật, profile dữ liệu, ngưỡng 0.7)

Script `skilltest/bench-multiturn.mjs`, bộ câu `agent-core/benchmarks/rlm/cases-multiturn.json`
(10 kịch bản × 3 lượt) và `cases-memory.json` (10 kịch bản, 25 lượt):

| Bộ | Kịch bản | Lượt | TB giây/lượt | Đỉnh token | agent-core |
|---|---|---|---|---|---|
| Nhiều lượt dữ liệu | 2/10 | 19/30 | 2.8 | 14 840 | 8/10 |
| Trí nhớ | 9/10 | 24/25 | 1.1 | 11 140 | — |

Đọc lại nhật ký các lượt trượt (`skilltest/rescore.mjs`): 12 lượt trượt → 7 lượt câu
trả lời đúng nằm trong `reasoning` (giao diện ẩn, lịch sử gửi model bỏ `reasoning`),
3 lượt lời gọi tool viết trong `reasoning` nên không chạy, 1 kịch bản tính ROI theo
trung bình từng dòng (s04), 1 kịch bản thiếu `torch` (s07). Token model viết ra: trung
vị 182/lượt.

Trí nhớ qua nén và mở lại (`skilltest/bench-longmem.mjs`): nhớ mã và con số lượt 1 sau
khi nén ✅, sau khi xoá container ✅; nhiều lần nén báo "summarization produced no text
summary content" (bản tóm tắt cũng chỉ có `reasoning`).

⚠️ Xoá chat (`DELETE /sessions/:id`) làm orchestrator sập (`EACCES` trên thư mục
`sessions/` của root, không `try/catch`) — ghi vào giai đoạn 5.

Hướng sửa (tắt thinking, bớt tool, lỗi xoá chat, `torch`): `rlm-transfer-plan.md` giai đoạn 5.

---

## Giai đoạn 5 — tắt thinking, xoá chat, tên hội thoại, workspace theo project (2026-09-14)

User chọn làm các mục ①②④⑤ trong bản trình bày giai đoạn 5; mục "bớt tool thừa" để bàn sau.

### Sửa code

| Mục | File | Nội dung |
|---|---|---|
| ① Tắt thinking | `packages/llm/openai-compat/src/adapter.ts` | `OPENAI_EXTRA_BODY` (JSON object) trộn vào mọi request; dùng `{"chat_template_kwargs":{"enable_thinking":false}}` cho Qwen trên vLLM |
| | `services/orchestrator/src/config.ts`, `.env.example`, `packages/llm/openai-compat/README.md` | Chuyển biến vào container; ghi chú `OPENAI_CONTEXT_WINDOW`, `OPENAI_EXTRA_BODY` |
| ② Xoá chat không sập | `services/orchestrator/src/docker.ts` | `removeDirContentsAsRoot()`: container tạm chạy `find -mindepth 1 -delete` trên thư mục |
| | `services/orchestrator/src/archive.ts` | `removeTree()`: `rm`, gặp `EACCES`/`EPERM` thì xoá bằng container tạm rồi `rm` lại; `purgeSession` dùng nó |
| | `services/orchestrator/src/index.ts` | Route `DELETE /sessions/:id` có `try/catch` → `500` thay vì sập tiến trình |
| ④ Tên do LLM đặt | `infra/migrations/002_projects_title_source.sql`, `docs/schema/*` | Cột `sessions.title_source` (`user`/`fallback`/`provider`) |
| | `services/gateway/src/db.ts`, `index.ts` | `renameSession(id, title, source)`: `user` luôn thắng và đẩy `updated_at`; tự động chỉ ghi khi chưa có tên hoặc thay `fallback` bằng `provider`; `PATCH` nhận `source` |
| | `apps/web/src/components/features/sidebar/HistoryChat.tsx` | Gửi tên kèm nguồn, bỏ điều kiện "đã có tên thì bỏ qua" |
| ⑤ Project | `infra/migrations/002_projects_title_source.sql`, `docs/schema/*` | Bảng `projects`; cột `sessions.project_id` + index |
| | `packages/contracts/src/index.ts` | `EnsureSessionRequest.projectId` |
| | `services/orchestrator/src/{config,redis,ensure,docker,workspace-files,index}.ts` | `projectsDir` (`data/projects`); `SessionRecord.projectId`; chat project gắn thêm bind `data/projects/<id>:/data/workspace` và `FOX_OUTPUT_DIR=generated/<sessionId>` (cả khi mở lại); `projectDirFor()` kiểm UUID; route `…/projects/:id/files` và `DELETE /projects/:id` |
| | `packages/tool/python-repl/{python/runner.py,python/helpers.py,src/kernel.ts}` | Hình tự lưu và `save_artifact()` ghi vào `FOX_OUTPUT_DIR` (mặc định `generated`) |
| | `services/gateway/src/{db,index,orchestrator-client}.ts` | Hàm DB project; route `GET/POST /projects`, `PATCH/DELETE /projects/:id`, `GET /projects/:id/sessions`, `…/projects/:id/files`; WebSocket `&project=` (kiểm chủ, ép flow dữ liệu); xoá project = purge từng chat + xoá thư mục + xoá dòng; `/sessions/mine` trả `projectId`, `projectName` |
| | `apps/web/src/components/features/projects/{projectsApi.ts,ProjectsDialog.tsx}` [mới] | Hộp thoại Dự án: tạo, đổi tên, xoá, danh sách chat, "Chat mới", tệp dữ liệu |
| | `apps/web/src/{App.tsx,components/features/sidebar/Sidebar.tsx,components/features/conversation/{WorkspacePanel.tsx,workspaceApi.ts},i18n/translations.ts}`, `apps/web/public/style.css` | Mục "Dự án" ở thanh bên; `startNewSession(flow, projectId)`; `WorkspacePanel` nhận `base`; dòng chat thuộc project có biểu tượng thư mục và tooltip tên project |

Khác thiết kế 9.1: giao diện là hộp thoại (cùng khung hộp thoại Kỹ năng) thay vì trang
riêng; `projectId` nằm ở `services/orchestrator/src/redis.ts` (kiểu `SessionRecord` ở đó,
không ở `packages/contracts`).

### Triển khai

| Việc | Kết quả |
|---|---|
| DB máy phát triển: `create table projects`, `alter table sessions add title_source, project_id`, index | ✅ không xoá dữ liệu |
| `pnpm run build`, build image, khởi động lại orchestrator + gateway, thay container dựng sẵn | ✅ |
| `OPENAI_EXTRA_BODY` | ⚠️ đang truyền tạm qua môi trường khi bật orchestrator — cần thêm vào `.env`, nếu không lần khởi động lại sau thinking bật lại |

### Thử thật (bộ fox, Qwen)

| Script | Kết quả |
|---|---|
| `skilltest/t-title-purge.mjs` | ✅ lượt chat chỉ có khối `text`; sự kiện tên `fallback` "Giải thích ngắn gọn khác" rồi `provider` "Giải thích khác nhau giữa TCP và UDP"; DB `… \| provider`; `fallback` không đè `provider`; người dùng đổi tên → `user`; `provider` không đè `user` |
| Xoá chat lấy từ nhóm dựng sẵn (`_pool/…`, `sessions/` của root) | ✅ `204`, thư mục mất, `GET /models` `200`, log `purge_ok` |
| `skilltest/t-project.mjs` (18 mục) | ✅ tải file vào project trước khi có chat; chat A tính đúng `total=163302.73`, hình ở `generated/<A>/revenue.png`; chat B cùng project thấy file; chat C project khác không thấy; user khác `404`/`403`; Redis có `projectId`; xoá container A rồi mở lại vẫn thấy file; xoá project → chat và thư mục mất, orchestrator sống |
| `skilltest/projects-cdp.mjs` (Chrome thật, ảnh `shots-projects/`) | ✅ tạo dự án, tải file trong hộp thoại, "Chat mới" → thanh tệp "Tệp (1)", trả lời đúng; dòng thanh bên có biểu tượng thư mục, tooltip "Dự án: …", tên do LLM đặt; hộp thoại liệt kê chat; xoá dự án từ hộp thoại |
| `skilltest/flow-e2e.mjs` | ✅ chat thường, chat dữ liệu, mở lại sau khi xoá container như cũ |

⚠️ Kịch bản s07 (cần `torch`): model gọi `bash` cài `torch` 6 lần (`pip`, `pip3`, `apt-get`,
`/opt/fox-py/bin/python -m pip`), mỗi lần chờ tới hết giới hạn → lượt kéo dài tới 300 s.
Thuộc mục "bớt tool thừa" (chưa làm).

### Benchmark nhiều lượt sau khi tắt thinking (`skilltest/bench-multiturn.mjs`)

| Bộ | Trước (thinking bật) | Sau (thinking tắt) | agent-core |
|---|---|---|---|
| Nhiều lượt dữ liệu | 2/10 kịch bản, 19/30 lượt | **8/10, 28/30** | 8/10 |
| Trí nhớ | 9/10, 24/25 | **10/10, 25/25** | — |
| Lượt kết thúc chỉ bằng `reasoning` | 11 | **0** | — |
| Trung vị giây/lượt (dữ liệu) | 2.5 | 2.3 | — |

2 lượt còn trượt: s07 lượt 1 (thiếu `torch`, 245 s, 13 bước — xem ⚠️ trên); s08 lượt 3 trả
lời "Có. Vì p-value = 0.00054 < 0.05…" — đúng nội dung nhưng tiếng Việt, bài chấm tìm chữ `yes`.

---

## Bớt tool thừa ở profile dữ liệu (2026-09-14)

`packages/profile-template/data-analysis/template/cordis.patch.yml`: 14 dòng `disabled: true`
(`tool-workflow`, `workflow-worker-thread`, `tool-ralph`, `tool-subagent`, `tool-subagent-fork`,
`tool-subagent-control`, `tool-subagent-list-agents`, `tool-subagent-report`, `tool-goal`,
`plan-mode`, `tool-todo`, `tool-jobs`, `tool-str-replace-editor`, `tool-bash`). Chat thường không đổi.

| Kiểm tra | Kết quả |
|---|---|
| Chạy thử khô (worker trên máy, LLM giả) | 27 → 10 tool, mô tả tool ≈ 7.3k → 1.9k token, system ≈ 2.2k → 1.6k, không lỗi khởi động |
| Stack thật: `request/header` chat dữ liệu mới | 10 tool; `inputTokens` câu đầu 10 471 → 4 813. Chat thường vẫn 26 tool, 9 035 |
| Benchmark nhiều lượt | 8/10 → 7/10 kịch bản (28/30 → 26/30 lượt); trí nhớ 10/10; trung vị giây/lượt 2.3 → 1.6; trung vị token đỉnh 11 427 → 5 660 |

Lượt trượt mới: s02 lượt 3 trả lời "172" mà không gọi `python` (lần trước gọi và ra 27);
s07 lượt 3 trả lời đúng ý bằng tiếng Việt, bài chấm tìm `linear`/`separab`. s07 lượt 1 vẫn dài
(264 s): không còn `bash`, model thử cài `torch` qua `python` — gốc là image thiếu `torch`.

---

## Giao diện dự án giống agent-core (2026-09-14)

User: chỉ một mục "Phân tích dữ liệu", bấm vào ra trang dự án như agent-core, thao tác file,
tải nguồn vào dự án. Thay hộp thoại "Dự án" làm trước đó.

| File | Loại | Nội dung |
|---|---|---|
| `apps/web/src/components/features/projects/ProjectHub.tsx` | [mới] | Theo `agent-core/packages/ui-projects/src/ProjectHub.tsx`: danh sách (tìm, tạo, bảng Tên / Đã sửa đổi); trang dự án (quay lại, đổi tên, xoá, ô "Đoạn chat mới trong …", tab Đoạn chat / Nguồn / Output: vùng tải lên có thanh tiến độ, tải về, xem trước ảnh, "Đưa vào dự án"); `ProjectChatBar` — nút quay về dự án phía trên chat thuộc dự án |
| `apps/web/src/components/features/projects/ProjectsDialog.tsx` | [xoá] | Thay bằng `ProjectHub` |
| `apps/web/src/components/features/projects/projectsApi.ts` | [sửa] | `uploadProjectFile` (XHR để có tiến độ), `promoteProjectOutput` |
| `apps/web/src/App.tsx` | [sửa] | `projectView` thay khung chat ở cột giữa; chat mở từ ô soạn của dự án gửi câu đầu ngay khi có khung `session` |
| `apps/web/src/components/features/sidebar/{Sidebar,HistoryChat}.tsx` | [sửa] | Bỏ mục "Dự án"; "Phân tích dữ liệu" mở trang dự án (có trạng thái đang chọn); lịch sử ẩn chat thuộc dự án (như agent-core) |
| `apps/web/src/components/features/conversation/{WorkspacePanel.tsx,workspaceApi.ts}` | [sửa] | Bỏ `base`/`defaultOpen` của bản hộp thoại; `formatSize` dùng chung |
| `apps/web/src/{icons.tsx,i18n/translations.ts}`, `apps/web/public/style.css` | [sửa] | Icon, chữ vi/en (lấy từ agent-core), CSS `.fh-hub-*` |
| `services/orchestrator/src/{workspace-files,index}.ts`, `services/gateway/src/{index,orchestrator-client}.ts`, `packages/contracts/src/index.ts` | [sửa] | `POST /projects/:id/promote {sessionId, path}`: chép `generated/<sessionId>/<path>` sang `outputs/` (gateway kiểm chat thuộc dự án; orchestrator có `try/catch`) |

Phân loại tệp trong thư mục dự án: `generated/<chat>/…` = kết quả của một chat, `outputs/…` =
output dùng chung, còn lại = nguồn. Hàng lọc "Tất cả / Do bạn tạo" của agent-core không làm
(fox chưa có chia sẻ dự án).

Thử `skilltest/hub-cdp.mjs` (Chrome thật, ảnh `shots-hub/`): ✅ không còn mục "Dự án" riêng;
"Phân tích dữ liệu" mở danh sách và sáng lên; tạo dự án → trang dự án; tab Nguồn tải
`ban-hang.csv` → "Nguồn 1"; ô soạn gửi câu đầu → chat mở, trả lời đúng, có thanh quay về dự án,
không có trong lịch sử thanh bên; quay lại → tab Đoạn chat có chat (tên do LLM đặt), tab Output
có kết quả của chat → "Đưa vào dự án" → nằm ở "Output dự án", xem trước ảnh; xoá dự án.

⚠️ Lần chụp đầu, hàng tệp/output và vùng tải lên bị ép chữ đè nhau, tab bị bo góc: luật chung
`button { height: 34px; border-radius: 12px }` trong `style.css` ghi đè các nút của trang dự án.
Sửa: các class `.fh-hub-*` đặt `height: auto` (hàng và tab thêm `border-radius: 0`); chụp lại ổn.

---

## Bộ đo agent-core còn lại, thư viện Python, giới hạn bước (2026-09-14)

### Bộ đo trước khi sửa (`skilltest/bench-multiturn.mjs`, thêm chấm `report_*`, `min_words`, `required_tools`, `require_profile_dataset`)

| Bộ | Fox | agent-core |
|---|---|---|
| `cases.json` (smoke) | 9/9 | 9/9 |
| `cases-repl.json` | 10/10 | 10/10 |
| `cases-skills.json` | 12/12 | 12/12 |
| `cases-ds-report.json` | 2/2 | 2/2 |
| `cases-tools.json` | 9/10 | 10/10 |
| `cases-production.json` | 20/25 | 25/25 |

Lượt trượt: `p22`, `tool_query_database_simple` cần tool `query_database` (fox không có); `p18`, `p23`
trả lời đúng ý bằng tiếng Việt, bài chấm tìm từ tiếng Anh; `p10`, `p15` không gọi `profile_dataset()`
trước dù đề yêu cầu (`p15` còn gọi `list_datasets` như tool).

⚠️ Lần chạy đầu dừng hai lần vì 502: ~35 worker cùng sống cạn `fs.inotify.max_user_instances = 128`
của máy (dùng chung cho mọi container chạy root), worker mới chết lúc khởi động
`EMFILE … watch '/data/profiles/fox-harness-data-analysis'`; orchestrator chờ 15 s rồi báo lỗi và
không dọn container chết. Script đo xoá container của từng chat thử sau mỗi kịch bản để chạy hết.
Chưa sửa ở fox (ghi vào giai đoạn 5).

### Sửa code

| File | Nội dung |
|---|---|
| `infra/docker/worker/Dockerfile` | Thêm `statsmodels duckdb pillow lightgbm xgboost-cpu` (image 2.36 → 2.57 GB); không thêm `torch`/`transformers` |
| `packages/flow/data-analysis/src/index.ts` | Prompt liệt kê thư viện có sẵn, "không tự cài, thiếu thì nói với người dùng". Config `maxSteps` (8) / `turnDeadlineMs` (600 000) như loop-rlm; hook `agent/pre-step`: quá giới hạn → chèn tin nhắn nguồn `plugin` "trả lời ngay, nói rõ chưa đầy đủ"; bước sau vẫn gọi tool → `reject` |
| `packages/flow/data-analysis/package.json` | devDependencies `dsh-agent`, `dsh-llm`, `schemastery` |

### Thử

| Thử | Kết quả |
|---|---|
| Worker trên máy, LLM giả luôn gọi tool, `maxSteps` 8 | Câu nhắc chèn ở bước 9; vẫn gọi tool → `turn/end blocked` |
| LLM giả nghe câu nhắc | Bước 9 trả lời "Kết quả chưa đầy đủ…", `completed` |
| `turnDeadlineMs` 3000, LLM chậm 0.7 s/lần | Câu nhắc ở bước 5 (~3.5 s), rồi `blocked` |
| Image mới: import `statsmodels duckdb PIL lightgbm xgboost` | ✅ |
| Bộ `skilltest/cases-fox-libs.json` (Qwen thật) | ✅ 4/4: OLS statsmodels `R² = 0.919` (tự tính 0.919); duckdb → West; LightGBM ra accuracy; câu cần `torch` → báo không có `torch` sau 6.6 s, không thử cài |
| `cases-multiturn.json` sau khi sửa | 7/10 → **9/10** kịch bản (26/30 → 29/30 lượt); tổng thời gian 324 s → **68 s**; bước nhiều nhất 8 → 4. s07 lượt 1 còn trượt vì không có `torch`, nhưng 264 s → 4.2 s |

Trên Qwen thật chưa lượt nào chạm giới hạn 8 bước, nên giới hạn chỉ được kiểm bằng LLM giả.

## Giai đoạn 6 — bộ nhớ cho task dài: thu gọn lượt cũ, sổ biến Python, tóm tắt kiểu RLM (2026-09-15)

Kế hoạch: `rlm-transfer-plan.md` mục 12 (A + B + D; lượt cũ lưu trong session, không thêm chỗ
lưu). Chưa commit.

### Sửa code

| File | Nội dung |
|---|---|
| `packages/flow/data-analysis/src/collapse.ts` (mới) | A: cuối mỗi lượt (`agent/turn-stopping`), mọi lượt cũ hơn 2 lượt gần nhất: vùng từ bước gọi tool đầu tiên (hoặc ghi chú plugin) tới kết quả tool cuối và các ghi chú ngay sau nó → một ghi chú `[Turn n: tool steps (python ×k) collapsed to save context. Variables assigned: … print(history(n)) …]`. Ghi `compaction/prune` rồi `user/message` `surfaceOp replace`, như `dsh-compaction-tool-result-pruner`. Lượt đếm theo thứ tự `turn/start` trong log |
| `packages/flow/data-analysis/src/compaction.ts` (mới) | D: class con `BasicCompactionEngine`, ghi đè `summarize()` — cùng một lời gọi như `summarizeWithLlm` gốc, lời dặn theo `_compact_history` của RLM (Requests / Results / Data decisions / Next step, chép số chính xác) |
| `packages/flow/data-analysis/src/index.ts` | Config `keepRecentTurns` (2); hook `agent/turn-stopping`; inject `tokenMeter`; prompt: dùng lại biến trong sổ, giữ dữ liệu đã làm sạch trong một biến, `history(n)` |
| `packages/flow/data-analysis/package.json`, `cordis.patch.yml` | Export `./compaction`; chèn dòng `fox-harness-compaction-data-analysis` (`thresholdRatio` 0.7, `maxTokens` 4096); devDependencies `dsh-compaction`, `dsh-compaction-basic`, `dsh-session`, `dsh-token-meter` |
| `packages/profile-template/data-analysis/template/cordis.patch.yml` | Dòng `compaction-basic` → `disabled: true` (profile mặc định không đổi) |
| `packages/tool/python-repl/python/runner.py` | Sau mỗi cell trả `variables` (`[tên, mô tả, có đổi]`); cầu nối `_fox_host`: ghi `{"host"}` ra stdout, đọc trả lời từ stdin (theo `host_tool_call`/`await_host_reply` của loop-rlm) |
| `packages/tool/python-repl/python/helpers.py` | `history(n)` |
| `packages/tool/python-repl/src/kernel.ts` | Sổ biến (mô tả + lượt gán gần nhất, tối đa 30 dòng); dòng `host` → hàm xử lý, trả `result`/`error` |
| `packages/tool/python-repl/src/index.ts` | B: `agent/pre-step` (sau `next()`) thêm sổ biến khi khác bản gần nhất còn trên surface — thuật toán `RuntimeContextProjection`; `history(n)` dựng lượt n từ `session.events`; mô tả tool |
| `packages/tool/python-repl/package.json`, `README.md`, `pnpm-lock.yaml` | devDependencies `dsh-agent`, `dsh-llm`, `dsh-session`; README tả sổ biến, cầu nối, `history(n)` |

### Thử — worker trên máy, LLM giả (`skilltest/mem-test.sh`)

| Ca | Kết quả |
|---|---|
| A: 8 lượt, tắt rồi bật worker sau lượt 6 | ✅ 12/12 — lượt 1–6 thu gọn (6 cặp `compaction/prune` + ghi chú); request cuối không còn kết quả tool của lượt 3–6; mọi request từ lượt 2 có sổ biến; sau khi mở lại sổ biến báo "The Python session restarted"; `history(1)` và `history(2)` (sau khi mở lại, worker mới đọc log) trả đủ câu hỏi, code, kết quả; log worker không lỗi |
| D: cửa sổ 16 000, kết quả 8 000 ký tự, 7 lượt, không thu gọn | ✅ 4/4 — nén 4 lần không lỗi; request tóm tắt mang lời dặn mới; checkpoint theo mục mới |

Lỗi tìm ra khi thử, đã sửa: sổ biến thêm ở bước trả lời nằm **sau** kết quả tool cuối nên không bị
thu gọn — request cuối còn 13 ghi chú và danh sách biến dài dần. Vùng thu gọn nay kéo tới các ghi chú
ngay sau kết quả tool cuối. Lần chạy đầu ca D không nén vì kết quả 20 000 ký tự bị pruner cắt còn
~5 000, ngữ cảnh tụt dưới ngưỡng; bài thử đổi sang kết quả 8 000 ký tự (dưới ngưỡng cắt 8 192).

### Stack thật + Qwen (image `3998aae3977b`)

**Chat 12 lượt `skilltest/cases-long-retail.json`** (trước: 2026-09-14, `long-results.json`):

| Chỉ số | Trước | Sau |
|---|---|---|
| Token đầu vào lượt 12 | 19 772 | **12 183** (−38%) |
| Token lượt 4 / 8 / 11 | 12 612 / 14 949 / 19 615 | 7 141 / 10 927 / 12 768 |
| Lần gọi `python` đọc lại CSV | 17/18 | **1/17** (chỉ lượt 1) |
| Dữ liệu các lượt | lượt 7–9 tính trên 619 dòng chưa lọc | mọi lượt dùng `sales_valid` 611 dòng |
| Tổng thời gian | 64.2 s | 46.1 s |
| Nén bằng LLM | 0 | 0 (8 lượt thu gọn, sổ biến thêm 14 lần) |

Đối chiếu pandas trên 611 dòng: danh mục dẫn đầu từng vùng (West: Clothing 15 364.42), doanh thu mỗi
đơn vị Clothing 49.47, p-value t-test theo từng dòng 0.4106 — khớp; báo cáo lượt 12 lặp đúng số các
lượt trước. Lần đo trước lượt 5 ghi "West: Grocery" — sai với cả dữ liệu gốc lẫn đã lọc. Model không
gọi `history()` lần nào. Lượt 1 chạm giới hạn 8 bước (lần trước cũng vậy).

Sổ biến cuối có cả biến vòng lặp và biến vẽ (`i`, `d`, `row`, `fig`, `ax`), ~30 dòng.

**`cases-multiturn.json`**: 9/10 kịch bản (như trước), 28/30 lượt (trước 29/30). Lượt trượt thêm
`s07#3` trả lời đúng ý bằng tiếng Việt ("ranh giới quyết định tuyến tính"), bài chấm tìm "linear".
Đọc lại file ở lượt 2–3: 18/19 → **2/17**. Token lượt 3 trung bình 6 631 → 7 247 (+9%: chat 3 lượt
chưa có gì để thu gọn, sổ biến thêm vài trăm token). Tổng thời gian 68.4 → 72.3 s (`s07` lượt 2 tự
làm bằng scikit-learn 10.8 s thay vì từ chối).

**Nhớ sau khi nén và mở lại (`skilltest/bench-longmem.mjs`)**: ✅ 4/4. Lượt 5 chạm ngưỡng, engine D
tóm tắt 4 lần — cả 4 bản giữ "KIWI-4821" và `total_revenue = 163302.73`. Hỏi lại mã và tổng sau khi
nén đúng; xoá container, mở lại chat: mã đúng, `doubled=326605.46` (tính lại vì biến Python đã mất).

**Chrome thật** (`skilltest/gd6-ui-cdp.mjs`): chat 12 lượt hiện đủ 12 câu hỏi và báo cáo; không hiện
ghi chú thu gọn hay sổ biến.

### Đo mạnh sau giai đoạn 6 (2026-09-15, Qwen thật)

**Toàn bộ bộ agent-core** (`benchmarks/rlm`, 88 kịch bản): 82/88.

| Bộ | Trước (2026-09-14) | Sau |
|---|---|---|
| `cases.json`, `cases-repl.json`, `cases-skills.json`, `cases-ds-report.json` | 9/9, 10/10, 12/12, 2/2 | như trước |
| `cases-tools.json` | 9/10 | 9/10 |
| `cases-production.json` | 20/25 | 21/25 |
| `cases-ds.json` (DABench) | — | 7/7 |
| `cases-deepanalyze-synth.json` | — | 2/3 |
| `cases-memory.json` | — | 10/10 |

6 kịch bản trượt, không cái nào do tính sai: `query_database` ×2 (fox không có tool này); `p14`, `p20`
tự viết code lập hồ sơ thay vì gọi `profile_dataset()`; `p18` ("không tồn tại") và
`synth_end_to_end_curriculum` trả lời đúng bằng tiếng Việt, bài chấm tìm chữ tiếng Anh.

**Bộ task dài tự dựng** (`skilltest/cases-hard-run.json`, đáp án tính bằng thư viện trong image —
`scratchpad/make_hard_cases.py`): 4/5 kịch bản, 50/52 lượt, không lần nào nén bằng LLM.

| Kịch bản | Kết quả | Ghi chú |
|---|---|---|
| H1 retail 18 lượt: làm sạch, 90th percentile, đổi yêu cầu "bỏ East" giữa chừng, hỏi lại số lượt 1–2 và 6 | ✅ 18/18 | Token đỉnh 9 892; 15 lần thu gọn; lượt hỏi lại trả lời không gọi tool |
| H2 mô hình tín dụng 12 lượt: split, logistic, ngưỡng F1, RF, CV; xoá container trước lượt 11 | ✅ 12/12 | Sau khi mở lại, train lại đúng cách, `p_new` khớp |
| H3 5 bộ dữ liệu 11 lượt; xoá container trước lượt 8 | ❌ 9/11 | Xem dưới |
| H4 quy tắc từ lượt 1 (3 chữ số, `ref: ORCA-77`) + 5 lượt in bảng lớn | ✅ 10/10 | Giữ quy tắc mọi lượt; token đỉnh 15 819 |
| H5 một lượt phân tích marketing đầy đủ | ✅ | Chạm giới hạn 8 bước, câu nhắc ở bước 9; báo cáo 460 từ, số khớp (CPA 9.54, R² 0.487) |

H3 lượt 8, ngay sau khi container bị xoá: sổ biến báo *"Reload data from the files"*; model viết code
mới tính CPA **theo từng dòng** (`df['spend_usd'] / df['conversions']`, `idxmin()`) và lấy dòng Social
đầu tiên (`.values[0]` → 303.02) — ra "Search 4.45" thay vì "Display 9.54" của lượt 3. Câu trả lời
lượt 3 vẫn còn nguyên văn trong ngữ cảnh lượt 8 (đã dựng lại surface từ log), model không dùng nó
và không gọi `history(3)`. Báo cáo lượt 11 lặp số sai. Hướng sửa (chưa làm): câu báo khởi động lại
dặn dùng lại kết quả đã nêu và dựng lại biến bằng đúng code cũ qua `history(n)`.

### Chỉnh prompt sau khi đo mạnh (2026-09-15)

| File | Nội dung |
|---|---|
| `packages/tool/python-repl/src/kernel.ts` | Câu báo khởi động lại (sổ biến và ghi chú đầu kết quả tool): kết quả đã nêu trong hội thoại vẫn đúng, dùng lại; dựng lại biến bằng đúng code cũ (`print(history(n))`) thay vì viết cách mới |
| `packages/flow/data-analysis/src/index.ts` | Thêm: trả lời theo ngôn ngữ tin nhắn mới nhất; không nêu tên file thì xem `list_datasets()` và dùng file đang có, chỉ hỏi khi nhiều file cùng hợp; lập hồ sơ thì gọi `profile_dataset()` trước kể cả khi đã nạp skill; nhắc tới kết quả cũ thì dùng số đã nêu, tính lại thì cùng định nghĩa và code; lưu file chỉ bằng `save_artifact()`, không `plt.savefig("x.png")` vào thư mục làm việc; báo cáo, model card viết đủ trong câu trả lời, chỉ lưu file khi người dùng yêu cầu |
| `packages/profile-template/data-analysis/template/cordis.patch.yml` | Persona viết bằng tiếng Anh (cùng ý) |

**Thí nghiệm ngôn ngữ** (worker trên máy, Qwen thật, mỗi câu một chat mới; 5 câu tiếng Anh từng bị trả
lời tiếng Việt, 2 câu tiếng Việt đối chứng):

| Persona | Câu tiếng Anh → tiếng Anh | Câu tiếng Việt → tiếng Việt |
|---|---|---|
| V0: tiếng Việt, "Luôn trả lời bằng ngôn ngữ mà người dùng đang sử dụng" | 0/5 | 2/2 |
| V1: V0, riêng câu về ngôn ngữ viết tiếng Anh | 1/5 | 2/2 |
| V2: cả persona tiếng Anh | 5/5 | 2/2 |

Lần đo sau khi đổi sang V2, `tool_typo_recovery` không gọi `web_search` và `stale_answer_regression` từ
chối ghi nhớ "zebra-77". Thử lại riêng (V2 so với V3 — persona tiếng Anh không gói gọn vào phân tích dữ
liệu): cả hai đều gọi `web_search`, đều ghi nhớ "zebra-77", đều 4/5 câu tiếng Anh → tiếng Anh. Không
tái hiện được nên giữ V2.

H2 lượt 12 và H3 lượt 11 trượt vì báo cáo ngắn: model gọi `write` ghi `/data/workspace/model_card.md`
(ngoài `generated/`) rồi chỉ tóm tắt 86 từ trong chat — lý do thêm luật về báo cáo.

**Đo với các luật trên (image `70e3d679cbf0`)**: bộ agent-core 85/88 (lượt tiếng Anh bị trả lời tiếng
Việt 82/108 → 8/108), bộ nhiều lượt 30/30 — nhưng bộ task dài tụt còn 42/52. Ba lỗi, đã sửa:

| Lỗi | Bằng chứng | Sửa |
|---|---|---|
| H4 quên quy tắc (`ref: ORCA-77`, 3 chữ số) từ lượt 5, lượt 9 trả lời "không có quy tắc nào" | Lượt 4 lên 22 508 token (ngưỡng 22 400) → nén ở lượt 5; cả 4 bản tóm tắt chỉ chép `"the mean price_usd of house_prices.csv…"`, không có "ORCA-77" — lời dặn tóm tắt của D thiếu mục chỉ dẫn của người dùng mà bản gốc dsh có | `packages/flow/data-analysis/src/compaction.ts`: thêm mục `## Standing instructions` (quy tắc cho phần còn lại của hội thoại, chép nguyên văn, không bỏ) |
| H5 và `skill_cohort` bị chặn ở giới hạn bước, trả lời 8 từ | Bước 9: `[câu nhắc giới hạn bước] [sổ biến "…reuse them"]` → model gọi tool tiếp → `turn/end blocked`. Sổ biến nối vào cuối, sau ghi chú của plugin khác | `packages/tool/python-repl/src/index.ts`: sổ biến chèn ngay sau tin nhắn của bước (chỗ `RuntimeContextProjection` của dsh-agent-loop đặt snapshot), câu nhắc giới hạn bước là tin nhắn cuối |
| Chat 12 lượt đọc lại file 11/12 lần | Lượt 2 chạy lại `pd.read_csv` và làm sạch — theo luật "tính lại thì dùng đúng code cũ" | `packages/flow/data-analysis/src/index.ts`: dùng lại số đã nêu, chép đúng từng chữ số; chỉ tính lại khi biến đã mất |

LLM giả sau khi sửa (`skilltest/mem-test.sh`): A 11/11, D 4/4, **W 3/3** — ca mới: `maxSteps` 1, sổ biến
đổi đúng ở bước chạm giới hạn; câu nhắc giới hạn bước là tin nhắn cuối model đọc.

**Lần đo cuối (image `bce125835b70`)**, Qwen thật, so với các lần trước:

| Chỉ số | Sau giai đoạn 6 | Sửa prompt lần 1 | Luật + persona tiếng Anh | Cuối |
|---|---|---|---|---|
| Bộ agent-core (88) | 82 | 82 | 85 | 82 |
| Lượt tiếng Anh trả lời tiếng Việt (bộ agent-core) | 82/108 | 58/108 | 8/108 | 8/108 |
| Bộ task dài (52 lượt) | 50 | 50 | 42 | **51** |
| – H3 (mở lại chat giữa chừng) | 9/11 | 10/11 | 11/11 | 11/11 |
| – H4 (quy tắc qua nén) | 10/10 (không nén) | 10/10 (không nén) | 4/10 | **9/10** (nén 2 lần, giữ quy tắc) |
| – H5 (một lượt nặng) | ✅ | ✅ | ❌ blocked | ✅ |
| Chat 12 lượt: token lượt 12, đọc lại file | 12 183, 1/17 | 13 516, 1/11 | 12 773, 11/12 | **9 910, 1/14** |
| Bộ nhiều lượt (30 lượt) | 28 | 29 | 30 | **30** |

Còn lại, dao động giữa các lần chạy:
- Bộ agent-core 82–85: `query_database` ×2 (fox không có tool này); `skill_cohort` chạm giới hạn 8 bước;
  `p14`, `p20` không gọi `profile_dataset()`. Model gọi helper Python (`list_datasets`…) như một tool ở cả
  bốn lần đo (1, 6, 2, 4 lượt — cả trước khi có luật về file). `dabench_feature_engineering_354` hỏi
  `SibSp`/`Parch` mà `test_x.csv` không có hai cột này: lần trước model tự giả định nên trùng đáp án, lần
  cuối nói không tính được.
- H4 lượt 10 tính dự đoán giá bằng tay, không gọi Python → 472 272 thay vì 468 270.9.
- Ngôn ngữ: model chọn ở lượt đầu rồi giữ — chat 12 lượt lần cuối 11/12 lượt tiếng Việt (lần trước 0/12).

## URL riêng cho khu phân tích dữ liệu (2026-09-15)

Trước: chat dữ liệu dùng `/chat/<id>` như chat thường; trang dự án không có URL (tải lại là mất); 604 chat
dữ liệu không thuộc dự án (gần hết do benchmark) vẫn nằm trong danh sách chat chung. Chọn phương án A;
chat dữ liệu cũ không thuộc dự án chỉ ẩn khỏi danh sách chung, không xoá.

| URL | Màn hình |
|---|---|
| `/`, `/chat/<id>` | chat thường (giữ nguyên) |
| `/data` | danh sách dự án |
| `/data/<dự án>` | trang dự án |
| `/data/<dự án>/chat/<id>` | chat trong dự án |
| `/data/chat/<id>` | chat dữ liệu cũ không thuộc dự án |

| File | Nội dung |
|---|---|
| `apps/web/src/App.tsx` | `routeFromUrl()` đọc 6 dạng URL; `applyRoute()` dùng chung cho tải trang, đăng nhập, Back/Forward (trang dự án ↔ chat không mở lại kết nối); `openDataView()` ghi URL khi mở danh sách/dự án; chat mới trong dự án giữ URL trang dự án tới tin đầu rồi thay bằng URL chat; `reconcileChatPlace()` chuyển link `/chat/<id>` của chat dữ liệu (hoặc ngược lại) sang đúng URL bằng `replaceState`; mục "Phân tích dữ liệu" sáng cả khi đang trong chat dữ liệu |
| `apps/web/src/runtime.ts`, `components/features/projects/ProjectHub.tsx` | `switchSession(id, projectId?)`; tab Chats truyền dự án; `ProjectChatBar` báo `flow` và dự án của chat đang mở |
| `apps/web/src/components/features/sidebar/HistoryChat.tsx` | Danh sách chung bỏ mọi chat `flow = data-analysis`; bỏ biểu tượng dữ liệu trên dòng |

Server web không đổi: `scripts/serve-web.mjs` đã trả `index.html` cho mọi đường dẫn dạng route.

**Chrome thật** (`skilltest/routes-cdp.mjs`): 17/17 — danh sách chung chỉ có chat thường; `/data`; tạo dự
án → `/data/<dự án>`, tải lại vẫn ở đó; tin đầu → `/data/<dự án>/chat/<id>`, mục dữ liệu sáng, chat không
vào danh sách chung; tải lại chat; thanh quay về → trang dự án, Back → chat, Forward → trang dự án; link cũ
`/chat/<id>` → `/data/<dự án>/chat/<id>`; link cũ của chat không thuộc dự án → `/data/chat/<id>`; "Trò
chuyện mới" → `/`; xoá dự án → `/data`.
