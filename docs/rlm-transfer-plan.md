# Kế hoạch đưa phân tích dữ liệu (RLM) từ agent-core sang fox-harness-core

Lập ngày 2026-09-14. **Sửa lần 2 cùng ngày:** chuyển sang khung "flow" mà
tylerdo239 đã làm trên `dev` (`docs/data-analysis-flow-plan.md`, commit
`f4cd118`), bỏ hướng preset.

Nhánh làm việc: `feat/data-analysis` (tách từ `dev`). Nhật ký thực thi:
`docs/rlm-transfer-changes.md`.

**Trạng thái (2026-09-14):** giai đoạn 0–4 đã thực thi và thử thật trên bộ fox
(worker trên máy với LLM giả, rồi Qwen thật + Chrome thật; 7 câu DABench đạt 7/7).
Giai đoạn 5: đã làm nén ngữ cảnh, tắt thinking, lỗi xoá chat, tên do LLM đặt,
workspace theo project (bước 6.1–6.3); các mục còn lại chưa làm. Chưa commit.

**2026-09-15:** đã commit và đẩy `feat/data-analysis`. Giai đoạn 6 (mục 12 — bộ nhớ
cho task dài: thu gọn lượt cũ, sổ biến Python, tóm tắt kiểu RLM) **đã triển khai và thử cùng ngày** (LLM giả + Qwen thật,
kết quả ở 12.7 và `rlm-transfer-changes.md`), chưa commit.

---

## 1. Quyết định đã chốt

| Điểm | Chốt |
|---|---|
| Có chuyển nguyên `loop-rlm` không | **Không.** Giữ những gì RLM làm tốt, đưa sang dưới dạng **tool Python + prompt + skill** |
| Chat dữ liệu có phải loop mới không | **Không.** Dùng chung vòng lặp `packages/agent-driver` |
| Tách chat dữ liệu bằng gì | **Profile theo flow** (khung của tác giả): `?flow=data-analysis` → orchestrator dựng container với profile `fox-harness-data-analysis`. Không dùng preset, nên **không cần** scope riêng + `setup` cho từng agent |
| Làm gì trước | Mở rộng `packages/agent-driver`: ghi `request/header`, phát `agent/request-error` (kèm mã lỗi đúng ở adapter) |
| Điểm mới đề xuất trong lúc làm | Ghi vào giai đoạn 5, thực thi sau |

### Vì sao không chuyển nguyên loop-rlm (tóm tắt review)

| Vấn đề | Bằng chứng |
|---|---|
| **Hai bộ não:** RLM tự chạy vòng lặp, nén ngữ cảnh, bộ nhớ, hỏi người dùng, job nền, nạp skill trong Python — dsh đã có | `vendor/rlm/rlm/core/rlm.py:370`; dsh có `dsh-compaction-basic`, `dsh-tool-ask-user`, `dsh-tool-jobs`, `dsh-tool-skill` |
| **dsh chỉ cho một cài đặt vòng lặp** | `dsh-agent/lib/index.js:521` `"an agent factory is already registered"` |
| **Tách code bằng regex từ chữ** | `vendor/rlm/rlm/utils/parsing.py:39`; `completion.md`: "A response without a `repl` block is dropped" |
| **Nhật ký không khớp** | `dsh-session/lib/types/types.d.ts`: sự kiện lạ không đánh dấu → "MUST refuse to reconstruct the session" |
| **Chưa có số liệu RLM hơn vòng gọi tool thường** | `reports/rlm-benchmark/*.json`: 2–9 câu, chỉ chấm RLM |

---

## 2. Kiến trúc đích

```
Nút "Phân tích dữ liệu" ─ ?flow=data-analysis ─► gateway ─► orchestrator
                                                             │ profile fox-harness-data-analysis
                                                             │ thư mục làm việc /data/workspace
                                                             ▼
worker: dsh --profile fox-harness-data-analysis
  vòng lặp packages/agent-driver (chung với chat thường)
  + @fox-harness/dsh-flow-data-analysis  (prompt phân tích)
  + tool `python`  (kernel IPython sống suốt hội thoại)
  + 9 skill dữ liệu (thư mục skill riêng của profile)
File dữ liệu & kết quả ─► /data/workspace (gắn ra máy chủ, còn sau khi container ngủ)
```

Chat thường không truyền `flow` → như hiện nay.

---

## 3. Những điều đã kiểm định (đọc code)

| # | Điều | Nơi |
|---|---|---|
| 1 | Driver fox phát `agent/pre-step`, `agent/request`; **không** phát `agent/request-error`, **không** ghi `request/header` | `packages/agent-driver/src/agent.ts:187-191`, `:239-243`, `:38-40` |
| 2 | Driver fox **không xét `finish`** của stream; `ctx.llm` đổi mọi lỗi thành `finish` báo lỗi → khi model lỗi, lượt chat có thể kết thúc "completed" với câu trả lời rỗng | `agent.ts:172`, `:205`, `:254-283`, `:343`; `packages/llm/openai-compat/src/adapter.ts:31-33` |
| 3 | Adapter openai-compat gom **mọi** lỗi HTTP thành mã `REQUEST_FAILED`; `dsh-llm-retry` chỉ thử lại `EMPTY_RESPONSE`, `RATE_LIMIT`, `SERVER`, `TIMEOUT`, `TRANSPORT`; nén khi tràn cần `CONTEXT_WINDOW_EXCEEDED` | `adapter.ts:103`; README `dsh-llm-retry`; `dsh-llm/lib/types/error.d.ts:18`; `dsh-compaction-basic/lib/index.js:802-803` |
| 4 | dsh-base bật `llm-retry`, `compaction-basic`; 6 package nghe `request/header` (`session-title`, `token-meter`, …); hàm dựng header dùng lại được | `dsh-base/cordis.patch.yml:72`, `:284`; `dsh-session` xuất `canonicalHeader`, `headerEquals`; `dsh-llm` xuất `markAgentLoopRequest` |
| 5 | Khung flow: chỉ flow mặc định lấy container dựng sẵn; nút "Phân tích dữ liệu" bị khoá khi đang ở chat trống; `GET /sessions/mine` không trả `flow`; gateway ghi cột `flow` nên phải chạy migration `003` trước | `services/orchestrator/src/ensure.ts` (`model === undefined && flow === undefined`); `Sidebar.tsx` `disabled={newSessionDisabled}`; `services/gateway/src/db.ts` |
| 6 | Hội thoại fox làm việc trong `/repo` (mất khi container ngủ); chỉ `/data` gắn ra máy chủ | `packages/transport/src/server.ts:98`; Dockerfile `WORKDIR /repo`; `docker.ts` `Binds` |
| 7 | Worker có Python 3.11, không có `pip`, `pandas`, `IPython` | `docker run fox-harness-worker:dev` |
| 8 | `dsh-skill-filesystem` nhận thêm thư mục skill qua `customSkillDirs` | README `dsh-skill-filesystem` § Config |
| 9 | Ảnh trong kết quả tool là tham chiếu tệp đính kèm (`ctx.attachments`); adapter openai-compat **không gửi ảnh** cho model | `dsh-llm/lib/types/types.d.ts` `ImageBlock`; `dsh-tool-fs` `read_image`; `grep image packages/llm/openai-compat/src` → 0 |

---

## 4. Giai đoạn 0 — Mở rộng `packages/agent-driver`

**Mục tiêu:** driver fox làm được việc bản gốc làm mà chat dài cần. Chat thường chạy y như cũ.

### 0.0 — Đo hành vi hiện tại

LLM giả, worker chạy trên máy:

| Kiểu lỗi | Ghi lại |
|---|---|
| 429 hai lần rồi thành công | Nhật ký, lý do kết thúc lượt, có thử lại không |
| 500 mãi | Như trên |
| Vượt ngữ cảnh (HTTP 400 `context_length_exceeded`) | Như trên, có nén không |

### 0.1 — Ghi `request/header` và `request/context`

| Việc | File |
|---|---|
| Sau `prepareCall`: `canonicalHeader({ config, adapterDefaults, system, tools })`. Lần gọi đầu của agent: `reason` `initial` (chưa có header) hoặc `resume`. Sau đó chỉ ghi `change` khi `!headerEquals`. Ghi `request/context` khi provider/model/`contextWindow` đổi. Đánh dấu request bằng `markAgentLoopRequest` | `packages/agent-driver/src/agent.ts` (mẫu `dsh-agent-loop/lib/index.js:725-760`) |
| devDependency còn thiếu | `packages/agent-driver/package.json` |
| Cập nhật "Deliberate scope cuts" | `packages/agent-driver/README.md` |

Không đổi cách thanh bên đặt tên (quyết định a/b/c ở giai đoạn 5).

**Xong khi:** hội thoại mới có đúng 1 `request/header` (`initial`); mở lại có 1 `resume`; có `session/title` nguồn `provider`; chat thường, `web_search`, `create_skill`, quota vẫn chạy.

### 0.2 — Phát `agent/request-error`, mã lỗi đúng

| Việc | File |
|---|---|
| Sau stream: `finish.kind` là `error`/`aborted` → waterfall `agent/request-error` `{ turn, step, provider, failure, retryPolicy, signal }`. `retry` → gọi lại; không → ném `LlmError`, lượt kết thúc lỗi. Không ghi `assistant/message` cho lần gọi lỗi | `packages/agent-driver/src/agent.ts` (mẫu `dsh-agent-loop/lib/index.js:651-664`) |
| Đổi HTTP status thành mã chuẩn: 429 → `RATE_LIMIT`, 5xx → `SERVER`, vượt ngữ cảnh → `CONTEXT_WINDOW_EXCEEDED`, hết giờ → `TIMEOUT`, lỗi mạng → `TRANSPORT` | `packages/llm/openai-compat/src/adapter.ts` |
| Giao diện hiện lỗi khi lượt kết thúc vì model lỗi (nếu 0.0 cho thấy chưa hiện) | `apps/web/src/components/features/conversation/Conversation.tsx` |

**Xong khi:** 429 hai lần → có `llm/retry`, người dùng nhận câu trả lời; 500 mãi → lượt kết thúc lỗi, hiện rõ; vượt ngữ cảnh → nén rồi gọi lại.

---

## 5. Giai đoạn 1 — Chạy thử và sửa khung flow

| Việc | File |
|---|---|
| Chạy migration `003_add_flow_column.sql` (nay đã gộp vào `001_init.sql`) trên MariaDB máy phát triển; build image; khởi động lại gateway, orchestrator; thay container dựng sẵn | (triển khai) |
| Nút "Phân tích dữ liệu" không bị khoá khi đang ở chat trống | `apps/web/src/components/features/sidebar/Sidebar.tsx` |
| Thanh bên phân biệt chat dữ liệu: `GET /sessions/mine` trả `flow`, dòng chat dữ liệu có biểu tượng | `services/gateway/src/db.ts`, `apps/web/src/components/features/sidebar/HistoryChat.tsx` |
| Chú thích và đường dẫn cũ (`dsh-agent-driver-data-analysis`, `packages/profile-template/template/…`) trong code và tài liệu đang dùng | `apps/web/src/icons.tsx`, `README.md`, `docs/core-overview.md`, `packages/tool/serper-web-search/README.md` |

**Xong khi (Chrome thật):** chat mới mặc định y như cũ; từ chat trống bấm "Phân tích dữ liệu" mở được; hội thoại dữ liệu chạy profile `fox-harness-data-analysis`; mở lại sau khi ngủ vẫn đúng flow; thanh bên có biểu tượng.

---

## 6. Giai đoạn 2 — Tool `python` và thư mục làm việc

| Việc | File |
|---|---|
| Tool `python(code)`: một tiến trình Python sống suốt container chạy IPython, nói chuyện bằng từng dòng JSON; giới hạn thời gian mỗi ô (quá giờ → dừng tiến trình, báo model "biến đã mất, file vẫn còn"); trả stdout, stderr, giá trị, lỗi (cắt ngắn); biểu đồ matplotlib lưu PNG vào `/data/workspace/generated/` và trả đường dẫn | `packages/tool/python-repl/` (mới) |
| Chỉ có trong profile dữ liệu | `packages/profile-template/data-analysis/template/profile.package.json`, `package.json` gốc, `tsconfig.json` |
| Python venv + `ipython`, `pandas`, `numpy`, `matplotlib`; đo kích thước image trước/sau | `infra/docker/worker/Dockerfile` |
| Thư mục làm việc theo flow: `config.flows[...].cwd` → biến môi trường container → transport dùng làm `meta.cwd` (chat thường giữ `/repo`) | `services/orchestrator/src/config.ts`, `docker.ts`, `packages/transport/src/server.ts` |

**Xong khi:** đặt tay 1 CSV vào `/data/workspace` → "tính trung bình cột X" đúng; lượt sau dùng lại biến; sau khi container ngủ, model được báo và đọc lại file; chat thường không có tool `python`.

---

## 7. Giai đoạn 3 — Hàm dữ liệu, prompt, 9 skill

| Việc | File |
|---|---|
| Nạp sẵn trong kernel: `list_datasets`, `load_dataset`, `profile_dataset`, `save_artifact` (theo `rlm_agent/tools.py`, đường dẫn `/data/workspace`) | `packages/tool/python-repl/` |
| Prompt phân tích (ý từ `evidence-policy.md`, `turn-policy.md`; bỏ `repl-protocol.md`, `completion.md`) thay dòng log đánh dấu và tiền tố `[data-analysis flow]` | `packages/flow/data-analysis/src/index.ts`, `packages/profile-template/data-analysis/template/cordis.patch.yml` |
| 9 skill: pandas-expert, data-profiling, data-scientist, data-visualization, deliverable-export, ml-modeling, product-analytics, statistical-analysis, time-series-analysis. Bỏ `drivers`/`triggers`, bỏ nhắc hàm RLM | `packages/flow/data-analysis/skills/` + `skill-filesystem` `customSkillDirs` trong profile dữ liệu |
| Thư viện: `scipy`, `scikit-learn`, `statsmodels<0.15`, `seaborn`, `openpyxl`, `pyarrow`, `duckdb` | `infra/docker/worker/Dockerfile` |

**Xong khi:** chạy một số câu của `agent-core/benchmarks/rlm/cases-ds.json` với dữ liệu mẫu, so với `reports/rlm-benchmark/ds-baseline.json`; chat thường không thấy 9 skill.

---

## 8. Giai đoạn 4 — Tải file lên, xem file kết quả

| Việc | File |
|---|---|
| Gateway: tải lên (chủ hội thoại, ≤ 70 MB như agent-core), liệt kê, tải về | `services/gateway/src/index.ts` |
| Orchestrator: đọc/ghi `<dshHomeDir>/workspace/` (kiểm đường dẫn, không thoát ra ngoài) | `services/orchestrator/src/` (route nội bộ mới), `packages/contracts` |
| Giao diện chat dữ liệu: nút tải file, danh sách file (kể cả `generated/`), xem ảnh, tải về | `apps/web/src/components/features/conversation/` |

**Xong khi (Chrome thật):** tải CSV → hỏi → thấy biểu đồ và file kết quả.

---

## 9. Giai đoạn 5 — Đề xuất thêm, thực thi sau

| Việc | Ghi chú |
|---|---|
| ~~Câu trả lời chỉ có phần suy nghĩ, không có chữ~~ (gộp vào "Tắt thinking", đã làm) | Benchmark lần 2: 2/7 câu Qwen kết thúc bước cuối bằng `["reasoning"]` rồi `stop` → người dùng không thấy gì (giao diện ẩn suy nghĩ). Hướng: (a) tắt thinking của Qwen qua `extra_body` (hạng mục #2 cũ), hoặc (b) plugin móc `agent/turn-stopping`: bước cuối không có chữ thì `steer` nhắc model trả lời |
| Đánh số lượt sau khi mở lại hội thoại | Driver fox đếm lượt từ 0 mỗi lần tạo agent → lượt đầu sau khi mở lại trùng số lượt cũ. Bản gốc đọc `turn/start` cuối trong nhật ký (`dsh-agent-loop/lib/index.js:371`) |
| ~~Giới hạn số bước mỗi lượt cho chat dữ liệu~~ **Đã làm 2026-09-14** | `packages/flow/data-analysis`: quá `maxSteps` (8) → chèn câu nhắc "trả lời ngay, nói rõ chưa đầy đủ"; vẫn gọi tool → `reject` |
| ~~Hạn chót cả lượt~~ **Đã làm 2026-09-14** | Cùng cơ chế, `turnDeadlineMs` 600 000 (như `RLM_TURN_DEADLINE_MS`) |
| ~~Cấu hình nén ngữ cảnh~~ | **Đã làm 2026-09-14:** adapter khai báo `contextWindow` từ `OPENAI_CONTEXT_WINDOW`; cả hai profile `thresholdRatio 0.7`, `maxTokens 4096` (đo bằng LLM giả 32k, xem `rlm-transfer-changes.md`) |
| ~~Tắt thinking của Qwen~~ **Đã làm 2026-09-14** (`OPENAI_EXTRA_BODY`) | Benchmark nhiều lượt 2026-09-14: 10/12 lượt trượt do thinking — 7 lượt câu trả lời đúng nằm trong `reasoning`, 3 lượt lời gọi tool (`<tool_call>…`) nằm trong `reasoning` nên tool không chạy; nén thất bại "summarization produced no text summary content". Adapter bỏ `reasoning` khi gửi lịch sử (`serialize.ts:33-46`) nên câu trả lời đó cũng mất khỏi ngữ cảnh lượt sau. Proxy nhận `chat_template_kwargs: { enable_thinking: false }` (242 ms, 16 token so với 3218 ms, 507 token); `enable_thinking` ở cấp ngoài bị bỏ qua. Hướng: biến môi trường cho adapter thêm trường này vào request |
| ~~Bớt tool thừa ở profile dữ liệu~~ **Đã làm 2026-09-14** (14 dòng `disabled: true`, còn 10 tool) | 27 tool ≈ 7.1k token mỗi lời gọi (`workflow` 997, `bash` 811, `str_replace_editor` 595, `subagent*`, `goal*`, `ralph`, `todo_write`, `job_*`, `exit_plan_mode`…); cộng system 2.2k và danh sách skill 1.6k ≈ 11k/32k cố định. Model dùng `bash`/`write` để "ghi nhớ" vào file, `bash pip install torch`. Hướng: `disabled: true` các dòng `tool-*` không cần trong `cordis.patch.yml` profile dữ liệu (kiểm phụ thuộc, ví dụ `goal-round-driver`) |
| ~~Xoá chat làm orchestrator sập~~ **Đã làm 2026-09-14** | `DELETE /sessions/:id` → `purgeSession()` `rm` thư mục có `sessions/` do container tạo quyền root → `EACCES`; handler `void (async () => …)()` không `try/catch` → tiến trình chết, mọi chat sau 502. Hướng: bắt lỗi trả 500; xoá bằng quyền phù hợp (container chạy `User` trùng uid máy chủ, hoặc xoá qua một container tạm) |
| Thư viện `torch` trong image (tuỳ chọn) | **Đã thêm 2026-09-14:** `statsmodels duckdb pillow lightgbm xgboost-cpu` (+210 MB) và prompt "không tự cài thư viện". Còn `torch`/`transformers` (~1 GB) chưa thêm |
| Container mới chết khi nhiều chat cùng sống (phát hiện 2026-09-14) | ~35 worker cùng chạy (root, chung kernel) cạn `fs.inotify.max_user_instances = 128` → worker mới chết lúc khởi động `EMFILE` (chokidar theo dõi `/data/profiles/…`) → orchestrator chờ 15 s → 502; container chết không được dọn. Hướng: tăng giới hạn inotify trên máy, hoặc tắt theo dõi file trong worker; dọn container khi khởi động lỗi |
| Chính sách thử lại cấu hình được | Thêm `retryPolicy` vào cấu hình adapter openai-compat |
| ~~Tên do LLM đặt thay tên "vài chữ đầu"~~ **Đã làm 2026-09-14** (chọn b: cột `sessions.title_source`) | Chọn a (trình duyệt nhớ tên tạm) / b (cột nguồn tên trong DB) / c (giữ nguyên) |
| Container dựng sẵn cho flow dữ liệu | Hiện mở chat dữ liệu luôn dựng container mới |
| Gửi ảnh biểu đồ cho model | `ctx.attachments` + adapter gửi ảnh |
| `llm_query` trong code; `subagent` thay `rlm_query` | |
| Chạy tool song song; `ask_user_question`; `RuntimeContextProjection` | |
| ~~Workspace theo project~~ **Đã làm 2026-09-14** (bước 6.1–6.3; giao diện là trang dự án kiểu agent-core mở từ "Phân tích dữ liệu", có "Đưa vào dự án") | Thiết kế chi tiết ở mục 9.1; 6.4 còn: chuyển chat có sẵn vào dự án, dọn `generated/<chat>` khi xoá chat |
| Job nền trong kernel; duyệt trước lời gọi model con | |

### 9.1 — Workspace theo project (thiết kế chi tiết)

**Vấn đề hiện tại.** Mỗi chat dữ liệu có thư mục riêng: `config.flows['data-analysis'].cwd = '/data/workspace'`
(`services/orchestrator/src/config.ts:52`), mà `/data` của container là
`data/dsh-home/<id-chat>/` (`services/orchestrator/src/docker.ts:105`
`Binds: [`${dshHomeDir}:/data`]`). Tải `sales.csv` ở chat 1 thì chat 2 không thấy
(`list_datasets()` quét thư mục riêng của chat 2) → phải tải lại.

**Mẫu từ agent-core.** `seams/projects.ts`, `bundles/providers/project-registry/index.ts`,
`packages/ui-projects/src/ProjectHub.tsx`; hành vi chốt trong
`tests/project-workspace-isolation.test.ts`: chat cùng project chung thư mục dữ liệu, project
khác không thấy, kết quả nháp của từng chat tách riêng, "promote" mới đưa ra dùng chung.

**Đích (bước đầu).**

```
data/projects/<projectId>/            ← thư mục project trên máy chủ
  sales.csv, customers.xlsx           ← dữ liệu dùng chung mọi chat trong project
  generated/<sessionId>/…             ← kết quả của từng chat (không ghi đè nhau)

Container của chat thuộc project:
  /data            ← data/dsh-home/<sessionId>/ (như cũ: log, profile, skill)
  /data/workspace  ← data/projects/<projectId>/  (gắn thêm, đè lên thư mục riêng)
```

Chat dữ liệu **không** thuộc project chạy y như hiện nay. Chat thường không đổi.

#### Bước 6.1 — Lưu trữ và container

| Việc | File |
|---|---|
| Bảng `projects` (`id` int tự tăng, `project_id` varchar(36) unique — dùng làm URL và tên thư mục như `sessions.session_id`, `owner_id` → `users.id` on delete cascade, `name` varchar(120), `created_at`, `updated_at`); cột `sessions.project_id varchar(36) null`. Theo quy ước mới: sửa `001_init.sql`, rồi chạy `ALTER` tay trên DB máy phát triển | `infra/migrations/001_init.sql`, `docs/schema/schema.md` |
| `SessionRecord` thêm `projectId?` (Redis) — mở lại chat phải gắn đúng thư mục project, cùng cách đang giữ `flow` | `packages/contracts/src/index.ts` |
| `config.projectsDir` (mặc định `data/projects`) | `services/orchestrator/src/config.ts` |
| `ensureSession(sessionId, model, flow, projectId)`: ghi `projectId` vào record; cả nhánh tạo mới (`ensure.ts:128`) và nhánh mở lại (`ensure.ts:74`) truyền thư mục project cho `spawnWorker` | `services/orchestrator/src/ensure.ts`, `index.ts` (route `POST /sessions/:id/ensure` nhận `projectId`) |
| `spawnWorker(..., projectDir?)`: tạo thư mục trên máy chủ, thêm bind `${projectDir}:/data/workspace`, thêm env `FOX_OUTPUT_DIR=generated/<sessionId>` | `services/orchestrator/src/docker.ts` |
| `workspaceDirFor()`: record có `projectId` → `projectsDir/<projectId>` | `services/orchestrator/src/workspace-files.ts:20` |
| Route nội bộ file của project (tải lên trước khi có chat): `GET/PUT /projects/:id/files[/<path>]` dùng lại `listWorkspaceFiles`/`saveUpload`/`resolveInside`; `DELETE /projects/:id` dừng container các chat của project rồi xoá thư mục | `services/orchestrator/src/index.ts` |
| Kernel Python: `runner.py` lưu hình vào `FOX_OUTPUT_DIR` (mặc định `generated`), `save_artifact()` ghi vào đó; `kernel.ts` chuyển biến này vào env tối giản của tiến trình Python; `list_datasets()` vẫn bỏ qua `generated/` | `packages/tool/python-repl/python/runner.py:38-41`, `helpers.py`, `src/kernel.ts` |

**Xong khi:** (LLM giả hoặc Qwen) tạo project P, P2 bằng SQL/route nội bộ; chat A và B thuộc P; tải
`sales.csv` vào P → A và B đều `list_datasets()` thấy; chat C thuộc P2 không thấy; A và B cùng vẽ hình
→ hai file nằm ở `generated/<A>/`, `generated/<B>/`; xoá container A rồi nhắn tiếp → vẫn gắn P; chat
dữ liệu ngoài project và chat thường y như cũ.

#### Bước 6.2 — Gateway

| Việc | File |
|---|---|
| Hàm DB: `createProject`, `listProjectsForOwner`, `renameProject`, `deleteProject`, `getProjectOwner`, `listSessionsForProject`; `createSession(sessionId, ownerId, flow, projectId?)`; `listSessionsForOwner` trả thêm `projectId` | `services/gateway/src/db.ts` |
| Route: `GET/POST /projects`, `PATCH/DELETE /projects/:id`, `GET /projects/:id/sessions`, `GET /projects/:id/files[/<path>]`, `POST /projects/:id/files?name=` — mọi route kiểm chủ project (như `WORKSPACE_FILES_PATH` đang kiểm chủ chat) | `services/gateway/src/index.ts` |
| WebSocket chat mới nhận `&project=<id>`: kiểm chủ project, ép `flow = data-analysis`, truyền `projectId` cho `ensureSession`, ghi vào `createSession` (`index.ts:695-727`). Mở lại chat bỏ qua tham số này (dùng record), giống `model`/`flow` | `services/gateway/src/index.ts`, `orchestrator-client.ts` |
| Xoá project: xoá các chat của nó (dùng lại luồng purge) rồi xoá project | `services/gateway/src/index.ts` |

**Xong khi:** người khác không đọc/tải/xoá được project của mình (403); `?project=` của người khác bị từ chối; xoá project → chat của nó biến mất khỏi thanh bên.

#### Bước 6.3 — Giao diện

| Việc | File |
|---|---|
| API phía web: danh sách, tạo, đổi tên, xoá project; chat và file của project | `apps/web/src/components/features/projects/projectsApi.ts` (mới) |
| Trang "Dự án": tìm, tạo; trang chi tiết: tên (đổi tên, xoá), ô "chat mới trong <tên>", danh sách chat, danh sách file (tải lên, xem ảnh, tải về — dùng lại phần hiển thị của `WorkspacePanel`) | `apps/web/src/components/features/projects/ProjectHub.tsx` (mới, theo `agent-core/packages/ui-projects`) |
| Thanh bên: mục "Dự án"; dòng chat thuộc project hiện tên project | `Sidebar.tsx`, `HistoryChat.tsx` |
| `startNewSession("data-analysis", projectId)` → thêm `&project=` (cạnh `flowParam`, `App.tsx:381`) | `apps/web/src/App.tsx` |
| Chữ vi/en, style | `translations.ts`, `style.css`, `icons.tsx` |

**Xong khi (Chrome thật):** tạo project → tải CSV ở trang project → mở 2 chat trong project, cả hai phân tích được file đó mà không tải lại; `WorkspacePanel` trong chat hiện file của project.

#### Để sau (bước 6.4)

| Việc | Ghi chú |
|---|---|
| Kết quả nháp riêng từng chat + nút "đưa ra dùng chung" | agent-core: `.sessions/<id>/generated/` và `outputs/` (`promoteSessionOutput`) |
| Chuyển chat có sẵn vào project | Cần chép thư mục `workspace` riêng sang project |
| Project cho chat thường | Chat thường làm việc ở `/repo`, chưa có nhu cầu |
| Dọn `generated/<sessionId>/` khi xoá một chat trong project | Bước đầu để lại |

#### Mặc định đang chọn (đổi được)

| Điểm | Mặc định |
|---|---|
| Project dùng cho | Chỉ chat dữ liệu |
| Chat dữ liệu ngoài project | Vẫn cho phép (nút "Phân tích dữ liệu" giữ nguyên) |
| Kết quả của chat | `generated/<sessionId>/` trong thư mục project, mọi chat trong project đều thấy |
| Xoá project | Xoá luôn các chat và file của project |

---

## 10. Khác biệt còn lại so với RLM gốc (sau giai đoạn 0–4)

| Điểm | RLM gốc | Fox |
|---|---|---|
| Cách hành động | Khối ```` ```repl ````, `answer["content"]`/`ready` | Tool `python`, trả lời bằng chữ thường |
| Giới hạn vòng | `max_iterations` 8, `max_errors` 5 | Chưa có (giai đoạn 5) |
| Nhớ lượt trước | `context_N`, `history`, tóm tắt sau mỗi lượt | Lịch sử chat + nén khi đầy (giai đoạn 6, mục 12: thu gọn lượt cũ, sổ biến, `history(n)`) |
| Chọn skill | LLM chọn trước mỗi lượt | Model tự gọi `skill` |
| Hiển thị | Bước "🧠 Think", từng vòng | Ô tool |
| Gọi model con trong code, duyệt lời gọi model con, workspace theo project, job nền trong kernel | Có | Chưa (giai đoạn 5) |

---

## 11. Mặc định đang áp dụng khi thực thi (đổi được)

| Điểm | Mặc định |
|---|---|
| Nơi đặt 9 skill dữ liệu | `packages/flow/data-analysis/skills/` |
| Tên tool | `python` |
| Biểu đồ | File PNG trong `/data/workspace/generated/` |
| Giới hạn tải lên | 70 MB |
| Mở chat dữ liệu | Chấp nhận dựng container mới (chậm hơn chat thường) |

---

## 12. Giai đoạn 6 — Bộ nhớ cho task dài (A + B + D)

Lập 2026-09-15, **đã triển khai cùng ngày** (kết quả 12.7). Chọn A + B + D sau khi so với bê nguyên
bộ nhớ cuộn của RLM (12.1). Không gồm `max_errors` và "lưu biến xuống đĩa" (12.4).

**Sửa lần 2 cùng ngày:** bỏ file `.fox-history` trong thư mục làm việc. Không thêm
chỗ lưu nào: `history(n)` đọc lượt cũ từ log hội thoại đã có sẵn, qua một cầu nối
Python → worker (12.3, mục `history(n)`). Log sau này sẽ chuyển sang database;
thiết kế này không phải sửa khi đó.

### 12.0 — Vấn đề (đo thật 2026-09-15)

Một chat 12 lượt nối tiếp trên `retail_sales.csv`, stack thật + Qwen
(`cases-long-retail.json`, kết quả trong `rlm-transfer-changes.md`).

**Ngữ cảnh phình theo lượt, chưa lần nào được nén** (ngưỡng 22 400 = 0.7 × 32 000):

| Lượt | 1 | 3 | 6 | 9 | 11 | 12 |
|---|---|---|---|---|---|---|
| Token đầu vào (đỉnh) | 11 260 | 12 235 | 13 643 | 15 647 | 19 615 | 19 772 |

**Thành phần lịch sử gửi lại ở lượt 12** (lượt 1–11, đếm từ `session.jsonl.zstd`):

| Thành phần | Ký tự | Tỷ lệ |
|---|---|---|
| Kết quả tool | 17 661 | 39% |
| Code gửi cho tool `python` | 13 785 | 31% |
| Tin nhắn người dùng (5 905 là danh sách skill ở lượt 1) | 7 450 | 17% |
| Câu trả lời cuối của từng lượt | 5 880 | 13% |

**Model không dùng biến đã có → số liệu lệch nhau.** 17/18 lần gọi `python` đọc lại
CSV. Lượt 1 lọc 8 dòng ngày không tồn tại (`2025-02-29`, `2025-02-30`) → `sales`
611 dòng; lượt 7, 8, 9 đọc lại mà không lọc → tính trên 619 dòng (Clothing
59 396.36 thay vì 58 863.48); báo cáo lượt 12 ghi "611 bản ghi hợp lệ" nhưng dùng
số của 619 dòng. Lượt 1 cũng chạm giới hạn 8 bước (câu nhắc ở bước 9).

### 12.1 — Vì sao không bê nguyên bộ nhớ cuộn của RLM

Cơ chế RLM: mỗi lượt dựng prompt mới (`rlm.py` `_setup_prompt`), cuối lượt gọi LLM
tóm tắt (`bundles/providers/memory-rolling/index.ts`, tóm tắt ≤ 8 000 ký tự), các
bước thô cất vào biến `history_N`.

1. **Thêm một lời gọi LLM mỗi lượt, phải chờ xong.** Lượt 12 sinh 794 token mất
   6.7 s; bộ tóm tắt RLM ra tới 1 200 token → chậm thêm ~5–10 s mỗi lượt, trong khi
   lượt fox thường ~4 s.
2. **Mất chữ nguyên văn**, còn model không tự tra biến: `harness_adapter.py` ghi
   *"Prior turns showed the model claiming prior context was missing when the memory
   lived only in the REPL tail"* — agent-core phải đẩy tóm tắt thẳng lên prompt.
3. **Nhắm sai chỗ phình:** 70% là code + kết quả tool cũ, bỏ chúng không cần LLM.
4. **Không sửa lỗi lệch số** (lệch do đọc lại file, không do ngữ cảnh dài).

### 12.2 — Nguồn gốc từng phần

| Phần | Lấy từ | Đổi gì cho fox |
|---|---|---|
| A. Thu gọn lượt cũ + `history(n)` | RLM `history_N` (`ipython_repl.py` `add_history`); cách thay node của `dsh-compaction-tool-result-pruner` | Theo tuổi lượt thay vì độ dài; bản thô đọc từ log hội thoại thay vì cất vào biến |
| Cầu nối Python → worker cho `history(n)` | `host_tool_call` / `await_host_reply` (`loop-rlm/python/worker.py:118-270`) | Chỉ mở một loại yêu cầu: `history` |
| B. Sổ biến Python | RLM `SHOW_VARS()` (`ipython_repl.py` `_show_vars`); thuật toán `RuntimeContextProjection` (`dsh-agent-loop/lib/index.js:26-86`) | Tự đẩy mỗi khi đổi thay vì chờ model gọi (điểm 2 ở 12.1) |
| D. Tóm tắt khi vẫn đầy | RLM `_compact_history` (`rlm.py:665-705`); `summarize()` của `dsh-compaction-basic` | Lời dặn cho phân tích dữ liệu; chỉ chạy ở ngưỡng 0.7 như hiện nay |

### 12.3 — Thiết kế

#### A — Thu gọn lượt cũ (`packages/flow/data-analysis/src/collapse.ts`)

**Khi chạy:** `agent/turn-stopping` của lượt T (payload có `agent`). Làm ở cuối
lượt, không ở đầu lượt sau, để sổ biến B ở bước đầu lượt sau thấy surface đã gọn.

**Số lượt `n`:** thứ tự sự kiện `turn/start` trong `session.events`, không dùng
`data.turn` — driver fox đếm lại từ 1 sau khi mở lại hội thoại (giai đoạn 5, dòng
"Đánh số lượt"). `history(n)` dùng cùng cách đếm.

**Thu gọn** mọi lượt `n ≤ T − keepRecentTurns` (mặc định 2) chưa thu gọn:

- **Vùng thay:** trên `session.surface.nodes`, từ node đầu tiên của lượt `n` là
  `assistant/message` có tool-call, ghi chú sổ biến (B) hoặc ghi chú plugin
  (câu nhắc giới hạn bước) → tới `tool/result` cuối cùng của lượt `n` và các ghi chú
  plugin ngay sau nó (sổ biến thêm ở bước trả lời — thiếu phần này thì sổ biến cũ
  chồng lên nhau, tìm ra khi thử).
- **Giữ nguyên:** câu hỏi người dùng, danh sách skill, câu trả lời cuối của lượt,
  checkpoint của D.
- **Chỉ thay khi:** vùng cân bằng (mọi tool-call có result trong vùng) và ghi chú
  nhỏ hơn vùng theo `ctx.tokenMeter`; không thì bỏ qua lượt đó.
- **Ghi vào log giống pruner:** `compaction/prune` `{ shadowedRange, shadowedSeqs,
  shadowedTokenCount }`, ngay sau đó `user/message` nguồn plugin với
  `surfaceOp: { op: 'replace', start, end }` và `sourceEventSeqs` = các seq bị che.
  Token meter trừ đúng phần bị che (giao thức "shadow price", `dsh-token-meter`),
  nên nén theo ngưỡng (D) đo trên ngữ cảnh đã gọn.
- **Nội dung ghi chú** (model đọc, tiếng Anh):
  `[Turn 4 collapsed: python ×2 (1 error). Variables assigned: region_cat. Full code and output: print(history(4)) in python.]`
- Sự kiện thay là bản chỉ model thấy; log gốc và giao diện không đổi (tin nhắn nguồn
  plugin bị ẩn). Sự kiện gốc của vùng bị che vẫn nằm trong log, nên `history(n)` đọc
  lại được.

**Cấu hình** plugin `fox-harness-flow-data-analysis`: thêm `keepRecentTurns: 2`.

#### B — Sổ biến Python (`packages/tool/python-repl`)

- **`python/runner.py`:** sau mỗi cell trả thêm `variables` (tối đa 30) — tên và mô
  tả ngắn: `DataFrame 611×6 — date, region, …` (≤ 8 cột), `Series 611 (float64)`,
  `ndarray (3, 4) float64`, `dict 5`, số/chuỗi ngắn. Bỏ tên bắt đầu `_`, module,
  hàm, class, helper có sẵn, `In`/`Out`. Kèm `assigned`: biến có `id()` đổi trong cell.
- **`src/kernel.ts`:** giữ bảng biến gần nhất và lượt gán gần nhất của từng biến.
- **`src/index.ts`:** listener `agent/pre-step` dựng văn bản:
  ```
  Python variables still in memory (reuse them; do not reload files or recompute):
  - sales: DataFrame 611×6 — date, region, category, revenue, units, month (turn 1)
  - monthly: DataFrame 6×2 — total_revenue, total_units (turn 2)
  ```
  Tiến trình Python chưa chạy nhưng đã có `.python-session` (container ngủ đông rồi
  mở lại): `The Python session restarted: variables from earlier turns are gone; reload data (files are still there).`
  Chưa từng chạy Python: không thêm gì.
- **Cách đưa vào (thuật toán `RuntimeContextProjection`):** chỉ thêm tin nhắn khi
  văn bản khác bản gần nhất **còn trên surface**; bản đó bị A/D che thì thêm lại.
  "Bản gần nhất" tìm bằng quét `session.events` ngược lấy tin nhắn nguồn
  `fox-harness-tool-python-repl` rồi kiểm seq trong `session.surface.nodes` — không
  giữ trạng thái riêng, đúng cả sau khi mở lại hội thoại.
- **Không bật `RuntimeContextProjection` trong driver:** sẽ kéo theo ngữ cảnh
  `sandbox:policy` và `approval:policy` (`dsh-sandbox-policy`, `dsh-user-approval`)
  vào mọi profile, gồm chat thường, trong khi fox không nối kênh duyệt.
- **Prompt:** mô tả tool `python` và prompt flow thêm: dùng lại biến trong sổ,
  `history(n)` để xem code/kết quả đầy đủ của lượt cũ.

#### `history(n)` — đọc lượt cũ từ log hội thoại (`packages/tool/python-repl`)

**Không lưu thêm gì.** Bản thô của mọi lượt đã nằm trong log hội thoại
`session.jsonl.zstd` (`dsh-session-persistence-jsonl`, `root: dshHomePath('sessions')`
trong `dsh-base/cordis.patch.yml:98-101`). Hiện log ở ổ đĩa máy chủ
`data/dsh-home/<chat>/sessions/…`, còn database chỉ giữ thông tin về chat (bảng
`sessions` không có cột nội dung). Khi worker chạy, log đã được nạp vào bộ nhớ thành
`session.events`, kể cả sau khi mở lại chat (`ensure.ts:82` bật container mới gắn
đúng thư mục cũ, dsh đọc lại log). A và D chỉ thay phần model thấy (surface); sự
kiện gốc vẫn còn trong `session.events`.

**Đã chốt (2026-09-15):** lượt cũ lưu trong session (log hội thoại), không thêm
database hay file riêng. Session hiện lưu trên ổ đĩa, giữ nguyên; sau này session sẽ
được chuyển sang database. `history(n)` đọc `session.events` chứ không đọc file, nên
không phải sửa khi đó.

**Cầu nối Python → worker**, bê từ `host_tool_call` / `await_host_reply` của
`loop-rlm/python/worker.py`, chạy trên đường stdin/stdout JSON từng dòng mà tool
`python` đang dùng:

1. `python/runner.py` đưa vào namespace hàm `_fox_host(request)`: ghi một dòng
   `{"host": "history", "turn": 4}` ra kênh giao thức (stdout thật, không phải stdout
   của cell đang bị gom), rồi đọc một dòng trả lời từ stdin. Trong lúc cell chạy,
   worker không gửi cell mới nên stdin đang rảnh.
2. `src/kernel.ts`: dòng có `host` là yêu cầu, không phải kết quả cell (hiện
   `kernel.ts:91-93` coi mọi dòng là kết quả) → gọi hàm xử lý mà `index.ts` truyền
   vào `run()` → ghi `{"result": "…"}` hoặc `{"error": "…"}` vào stdin của Python.
3. `src/index.ts`: hàm xử lý dựng lượt `n` từ `exec.agent.session.events` thành
   Markdown: câu hỏi người dùng, từng lời gọi tool (code), kết quả, câu trả lời.
   Không có lượt `n` → lỗi nêu số lượt đang có.
4. `python/helpers.py`: `history(n)` gọi `_fox_host` và trả chuỗi. Chuỗi in ra vẫn
   bị cắt ở 20 000 ký tự như mọi output; lượt dài thì in từng đoạn
   (`print(history(4)[20000:])`).

Cầu nối này là nền cho `llm_query` sau này, nhưng giai đoạn 6 chỉ mở loại yêu cầu
`history`.

#### D — Tóm tắt kiểu RLM khi vẫn đầy (`packages/flow/data-analysis/src/compaction.ts`)

- **Class con `BasicCompactionEngine`**, ghi đè `summarize()` — hook duy nhất dsh cho
  phép (*"Override this sole hook for a template or remote summarizer"*). Gọi LLM như
  bản gốc (`summarizeWithLlm`, `dsh-compaction-basic/lib/index.js:257-330`), chỉ
  thay lời dặn "AI coding assistant … Files and Code" bằng bản dựa trên RLM:
  1. Các yêu cầu của người dùng theo thứ tự, cái nào đã trả lời, cái nào còn mở.
  2. Kết quả đã tính — số, giá trị, đường dẫn file, tên dataset và tên biến Python —
     **giữ chính xác**.
  3. Quyết định về dữ liệu mà việc sau phải giữ nhất quán (bộ lọc, bước làm sạch,
     dòng bị loại).
  4. Việc tiếp theo.

  Giữ luật gộp checkpoint cũ của bản gốc; nhắc model rằng biến vẫn có thể còn trong
  Python và `history(n)` còn đủ code/kết quả.
- **Nối dây:** `package.json` export `./compaction`; `cordis.patch.yml` của flow chèn
  dòng `fox-harness-compaction-data-analysis` (config `thresholdRatio: 0.7`,
  `maxTokens: 4096`); profile data-analysis đặt dòng `compaction-basic`
  `disabled: true`. Chat thường không đổi.

### 12.4 — Không làm trong giai đoạn này

| Việc | Lý do |
|---|---|
| `max_errors` (dừng sau 5 lỗi liên tiếp) | Chưa chốt trong đợt này |
| C — lưu DataFrame xuống đĩa để sống qua ngủ đông | Để sau; cả RLM lẫn fox đều chưa có |
| Bộ nhớ cuộn gọi LLM mỗi lượt của RLM | Xem 12.1 |
| `RuntimeContextProjection` trong driver | Xem B |

### 12.5 — Rủi ro

- **Cache của proxy:** thu gọn lượt T−2 đổi phần giữa lịch sử → phần sau phải tính
  lại. Proxy không trả số token cache nên chưa đo được; so thời gian trước/sau.
- **Hỏi lại chi tiết lượt cũ** ("code lượt 3 viết gì") → model phải gọi `history(3)`.
- **Cầu nối treo:** Python chờ trả lời mà worker không ghi gì → cell treo tới hạn
  120 s rồi tiến trình Python bị dừng. Hàm xử lý phải trả `result` hoặc `error` ở mọi
  nhánh.

### 12.6 — Kiểm thử và tiêu chí đạt

**1. Worker chạy trên máy + LLM giả** (kiểu `steps-test.sh`):

| Ca | Đạt khi |
|---|---|
| A: 5 lượt có tool | Sau lượt 5, lượt 1–3 trên surface là ghi chú; token meter không lỗi; mở lại hội thoại (replay log) không lỗi |
| B: cell tạo `df` | Bước sau có sổ biến; không đổi → không thêm; bị A che → thêm lại; giết tiến trình Python → câu "restarted" |
| D: ép ngưỡng thấp | Request tóm tắt mang lời dặn mới; checkpoint được ghi |
| `history(n)` qua cầu nối | Trả đúng lượt `n`, kể cả lượt đã bị A thu gọn; sau khi mở lại hội thoại (worker mới đọc lại log) vẫn đúng; lượt không có → lỗi rõ; không tạo file nào trong thư mục làm việc |

**2. Stack thật + Qwen, kịch bản 12 lượt `cases-long-retail.json`, so trước/sau:**

| Chỉ số | Trước | Đạt khi |
|---|---|---|
| Token đầu vào lượt 12 | 19 772 | ≤ 14 000 (ước tính ~12 000) |
| Lần gọi `python` đọc lại file | 17/18 | giảm ít nhất một nửa |
| Mọi lượt tính trên cùng dữ liệu đã lọc (611 dòng) | lệch ở lượt 7–9 | không lệch |
| Báo cáo lượt 12 đúng số các lượt trước | đúng | vẫn đúng |
| Tổng thời gian | 65 s | không chậm hơn đáng kể |

**3.** Bộ nhiều lượt cũ (9/10) và bộ memory không tụt. **4.** Chrome: chat dữ liệu
không hiện ghi chú thu gọn hay sổ biến.

### 12.7 — Kết quả (2026-09-15)

| Thử | Kết quả |
|---|---|
| LLM giả, ca A (thu gọn, sổ biến, `history(n)`, mở lại chat) | ✅ 12/12 |
| LLM giả, ca D (nén theo ngưỡng với lời dặn mới) | ✅ 4/4 |
| Qwen, chat 12 lượt: token lượt 12 | 19 772 → **12 183** ✅ (tiêu chí ≤ 14 000) |
| Qwen, chat 12 lượt: đọc lại file | 17/18 → **1/17** ✅ |
| Qwen, chat 12 lượt: cùng dữ liệu đã lọc mọi lượt | ✅ (trước lệch ở lượt 7–9); số khớp pandas |
| Qwen, chat 12 lượt: báo cáo lượt 12 đúng số | ✅ |
| Qwen, chat 12 lượt: thời gian | 64.2 s → 46.1 s ✅ |
| `cases-multiturn.json` | 9/10 như trước ✅; lượt 29/30 → 28/30 (thêm 1 lượt trả lời đúng bằng tiếng Việt); token lượt 3 +9% |
| Nhớ sau nén + mở lại (`bench-longmem.mjs`) | ✅ 4/4, cả 4 bản tóm tắt giữ mã và số |
| Chrome | ✅ không hiện ghi chú thu gọn, sổ biến |

Còn để ý: chat ngắn (≤ 3 lượt) tốn thêm vài trăm token cho sổ biến mà chưa có gì để thu gọn; sổ biến
liệt kê cả biến vòng lặp và biến vẽ (`i`, `fig`, `ax`).

**Sau khi đo mạnh và chỉnh prompt (2026-09-15, chi tiết trong `rlm-transfer-changes.md`):** sửa thêm
hai lỗi của giai đoạn này — bản tóm tắt D làm rơi quy tắc người dùng đặt (thêm mục "Standing
instructions"), sổ biến chen sau câu nhắc giới hạn bước (nay chèn ngay sau tin nhắn của bước) — cùng
persona tiếng Anh và vài luật prompt. Lần đo cuối: bộ task dài 51/52 lượt, chat 12 lượt 9 910 token ở
lượt 12 và đọc lại file 1/14, bộ nhiều lượt 30/30, bộ agent-core 82/88.
