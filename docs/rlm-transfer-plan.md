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
| Nhớ lượt trước | `context_N`, `history`, tóm tắt sau mỗi lượt | Lịch sử chat + nén khi đầy |
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
