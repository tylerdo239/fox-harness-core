# Kế hoạch đưa phân tích dữ liệu (RLM) từ agent-core sang fox-harness-core

Lập ngày 2026-09-14. Gồm giai đoạn 0 (mở rộng `packages/agent-driver`, làm trước
tab dữ liệu) và giai đoạn 1–5 (tab "Phân tích dữ liệu").

---

## 1. Quyết định đã chốt

| Điểm | Chốt |
|---|---|
| Có chuyển nguyên `loop-rlm` không | **Không.** Giữ những gì RLM làm tốt, đưa sang dưới dạng **tool Python + prompt + skill** |
| Tab dữ liệu có phải loop mới không | **Không.** Cùng vòng lặp `packages/agent-driver`, khác **preset** (bộ tool/prompt/skill riêng) |
| Làm gì trước tab dữ liệu | Mở rộng dần `packages/agent-driver` cho gần `dsh-agent-loop` ở 3 điểm: `request/header`, `agent/request-error`, scope riêng + `setup` |
| Giao diện | Tab riêng "Phân tích dữ liệu" |

### Vì sao không chuyển nguyên loop-rlm (tóm tắt review)

| Vấn đề | Bằng chứng |
|---|---|
| **Hai bộ não:** RLM tự chạy vòng lặp, nén ngữ cảnh, bộ nhớ, hỏi người dùng, job nền, nạp skill trong Python — dsh đã có đủ | `vendor/rlm/rlm/core/rlm.py:370` `for i in range(self.max_iterations)`; dsh có `dsh-compaction-basic`, `dsh-tool-ask-user`, `dsh-tool-jobs`, `dsh-tool-skill` |
| **dsh chỉ cho một cài đặt vòng lặp** | `dsh-agent/lib/index.js:521` `throw new Error("an agent factory is already registered")`; README `dsh-agent-loop`: "the only package in the harness that contains concrete loop logic" |
| **Tách code bằng regex từ chữ**, prompt phải chống lỗi định dạng | `vendor/rlm/rlm/utils/parsing.py:39`; `prompt-rlm-data-agent/sections/completion.md`: "A response without a `repl` block is dropped" |
| **Nhật ký không khớp:** sự kiện tự đặt tên của RLM làm dsh từ chối dựng lại hội thoại | `dsh-session/lib/types/types.d.ts`: "a reader meeting an unrecognized type … MUST refuse to reconstruct the session" |
| **Chưa có số liệu RLM hơn vòng gọi tool thường** | `reports/rlm-benchmark/*.json` chỉ 2–9 câu, chỉ chấm RLM |
| 9 skill dữ liệu **không phụ thuộc** hàm riêng của RLM | `grep llm_query\|load_dataset\|ask_user\|run_job bundles/skills` → 0 file |

### Giữ lại từ RLM

- Biến Python sống qua các bước và các lượt chat.
- Kỷ luật phân tích trong prompt (`evidence-policy.md`, `turn-policy.md`).
- Hàm `load_dataset`, `profile_dataset`, `save_artifact` (`rlm_agent/tools.py`).
- (Tuỳ chọn, giai đoạn 5) `llm_query` gọi model con trong code.

---

## 2. Kiến trúc đích

```
Tab "Phân tích dữ liệu" (apps/web) ─ ?preset=data-analyst ─► gateway ─► worker
                                                                        │
packages/transport: agents.create({ meta: { agentPreset, cwd: /data/workspace }, setup })
                                                                        │
packages/agent-driver (CÙNG vòng lặp với chat thường)
  └─ setup(agent.ctx) → agentPresets.mount(agentCtx, 'data-analyst')
       └─ tool `python` (kernel IPython sống suốt hội thoại) + prompt phân tích + 9 skill
File dữ liệu & kết quả ─► /data/workspace  (gắn ra máy chủ, còn sau khi container ngủ)
```

Chat thường không truyền `preset` → không có gì thay đổi so với hiện nay.

---

## 3. Những điều đã kiểm định (đọc code, CHƯA chạy thử)

| # | Điều | Nơi |
|---|---|---|
| 1 | Driver fox phát `agent/pre-step`, `agent/request` như bản gốc | `packages/agent-driver/src/agent.ts:187-191`, `:239-243` |
| 2 | Driver fox **không** phát `agent/request-error`, **không** ghi `request/header`/`request/context` | `agent.ts:38-40` (chỉ có trong chú thích) |
| 3 | Driver fox **không xét `finish`** của stream; adapter openai-compat đổi mọi lỗi thành `finish` báo lỗi → khi model lỗi, fox có thể lặng lẽ nuốt lỗi | `agent.ts:254-283`; `packages/llm/openai-compat/src/adapter.ts:32-33` |
| 4 | dsh-base bật `llm-retry`, `compaction-basic`; cả hai nghe `agent/request-error` | `dsh-base/cordis.patch.yml:72`, `:284`; `dsh-compaction-basic/lib/index.js:802` |
| 5 | 6 package nghe `request/header`: `session-title`, `token-meter`, `session-persistence`, `session-query`, `plan-mode`, `tool-cordis`. `dsh-session-title` còn đọc dấu `isAgentLoopRequest` | grep `*/lib/index.js` |
| 6 | Hàm dựng header dùng lại được: `canonicalHeader`, `headerEquals` (`dsh-session`), `markAgentLoopRequest` (`dsh-llm`), `session.requestHeader()`/`requestContext()` | `dsh-session/lib/types/index.d.ts:26`, `:225`, `:234`; `dsh-llm/lib/types/index.d.ts:24` |
| 7 | Bộ tạo agent fox **bỏ qua `options.setup`**; agent fox dùng chung `ctx` của factory, không có scope riêng | `packages/agent-driver/src/factory.ts:42-48`, `:60-67`, `:78` |
| 8 | Agent gốc tạo scope riêng rồi mới chạy `setup` | `dsh-agent-loop/lib/index.js:376-377` (`createScope` + `extend({ agent })`), `:1250-1265` |
| 9 | Preset chỉ gắn được trong `setup(agentCtx)` của bộ tạo agent; dsh-base **không bật** `dsh-agent-presets` | README `dsh-agent-presets` "Where to call `mount()`"; grep `dsh-base/cordis.patch.yml` |
| 10 | Mẫu gắn preset lúc tạo và lúc mở lại | `dsh-host-apiproxy/lib/index.js:1754-1778` |
| 11 | Hội thoại fox làm việc trong `/repo` (thư mục code, mất khi container ngủ); chỉ `/data` gắn ra máy chủ | `packages/transport/src/server.ts:98`; `infra/docker/worker/Dockerfile` `WORKDIR /repo`; `services/orchestrator/src/docker.ts:91` |
| 12 | Worker fox có Python 3.11 nhưng không có `pip`, `pandas`, `IPython`. Image fox 1.42 GB, agent-core 3.82 GB | `docker run fox-harness-worker:dev` |
| 13 | Kết quả tool dsh nhận khối ảnh | `dsh-llm/lib/types/types.d.ts:79-85` (`'image': ImageBlock`) |

---

## 4. Giai đoạn 0 — Mở rộng `packages/agent-driver`

**Mục tiêu:** driver fox làm được 3 việc bản gốc làm mà tab dữ liệu cần. Chat thường
phải chạy y như cũ.

Thứ tự đề xuất: 0.1 → 0.2 → 0.3 (từ nhỏ tới lớn, mỗi bước thử xong mới qua bước sau).

### 0.0 — Đo hành vi hiện tại trước khi sửa

| Việc | Cách |
|---|---|
| Model trả lỗi 500 / 429 | LLM giả trả HTTP lỗi. Ghi lại: nhật ký có gì, giao diện hiện gì, lượt chat kết thúc thế nào (kiểm điều 3 ở mục 3) |
| Model trả lỗi vượt ngữ cảnh | LLM giả trả lỗi context overflow. Ghi lại như trên |
| Hội thoại dài | Kiểm `compaction-basic` có chạy trên `agent/pre-step` không (log "compaction (…)") |

Kết quả ghi vào `docs/rlm-transfer-changes.md` làm mốc so sánh.

### 0.1 — Ghi `request/header` và `request/context` (điểm 3)

| Việc | File |
|---|---|
| Trong `runStep`, sau `prepareCall`: dựng `header = canonicalHeader({ config, adapterDefaults, system, tools })`. Lần gọi đầu của agent này: ghi `request/header` với `reason` `initial` (chưa có header cũ) hoặc `resume`. Các lần sau: chỉ ghi `change` khi `!headerEquals(cũ, mới)`. Ghi `request/context` khi provider/model/`contextWindow` đổi. Đánh dấu request bằng `markAgentLoopRequest` | `packages/agent-driver/src/agent.ts` (mẫu: `dsh-agent-loop/lib/index.js:725-760`) |
| Thêm devDependency nếu thiếu (`@deepseek-ai/dsh-session` đang là phụ thuộc gián tiếp — xem TODO trong README) | `packages/agent-driver/package.json` |
| Cập nhật mục "Deliberate scope cuts" | `packages/agent-driver/README.md` |
| Quyết định: tên do LLM đặt có **thay** tên "vài chữ đầu" đã đặt không. Hiện `applyAutoTitle` chỉ đặt khi hội thoại **chưa có tên** | `apps/web/src/components/features/sidebar/HistoryChat.tsx` |

**Xong khi:**

- Nhật ký hội thoại mới có đúng 1 `request/header` (`initial`), không lặp lại khi header không đổi.
- Mở lại hội thoại sau khi container ngủ: có 1 `request/header` (`resume`).
- Có sự kiện `session/title` do LLM đặt (không còn chỉ `fallback`).
- Chat thường, `web_search`, `create_skill`, quota token vẫn chạy.

### 0.2 — Phát `agent/request-error`, bật thử lại (điểm 2)

| Việc | File |
|---|---|
| Sau khi stream xong, đọc `assembler.finish`. Nếu `error`/`aborted`: phát waterfall `agent/request-error` `{ turn, step, provider, failure, retryPolicy, signal }`. Nhận `{ kind: 'retry' }` → gọi lại model; không → ném `LlmError`, lượt chat kết thúc với lỗi. **Không** ghi `assistant/message` cho lần gọi lỗi | `packages/agent-driver/src/agent.ts` (mẫu: `dsh-agent-loop/lib/index.js:651-664`) |
| Đọc kỹ thứ tự `step/start`/`step/end` quanh chỗ phát ở bản gốc: `dsh-llm-retry` có bộ kiểm tra bất biến yêu cầu `llm/retry` "names the current open turn and latest closed step" | `dsh-agent-loop/lib/index.js`, README `dsh-llm-retry` |
| Giao diện hiện lỗi rõ khi lượt chat kết thúc vì model lỗi (kiểm lại sau 0.0) | `apps/web/src/components/features/conversation/Conversation.tsx` |

**Xong khi:**

- LLM giả trả 429 hai lần rồi thành công → nhật ký có 2 `llm/retry`, người dùng nhận được câu trả lời.
- LLM giả lỗi mãi → sau 5 lần thử (mặc định `dsh-llm-retry`) lượt chat kết thúc với lỗi hiện rõ trên giao diện.
- LLM giả trả lỗi vượt ngữ cảnh → `compaction-basic` nén rồi gọi lại.

### 0.3 — Scope riêng cho từng agent + chạy `setup` (điểm 4)

| Việc | File |
|---|---|
| Trong constructor agent: `this.scope = createScope(ctx, this)`, `this.ctx = this.scope.ctx.extend({ agent: this })`. Huỷ scope khi agent huỷ | `packages/agent-driver/src/agent.ts` (mẫu: `dsh-agent-loop/lib/index.js:376-377`, `:1141`) |
| `createAgent` và `resume`: tạo agent → `await options.setup?.(agent.ctx)` → gọi `commit()` nếu có → rồi mới `enter`/`announce`. `setup` lỗi thì huỷ scope, không công bố agent | `packages/agent-driver/src/factory.ts` (mẫu: `dsh-agent-loop/lib/index.js:1250-1265`) |
| Thêm devDependency `@deepseek-ai/dsh-scope` | `packages/agent-driver/package.json` |

**Rủi ro lớn nhất của giai đoạn 0:** đổi `agent.ctx` từ context chung sang context
riêng ảnh hưởng mọi thứ agent dùng (`systemPrompt.assemble`, `llm`, `tools`) và mọi
plugin nhận `agent` (quota trong `packages/core`, `create_skill`). Phải chạy lại toàn bộ
bài thử cũ.

**Xong khi:**

- Bài thử: một `setup` tạm thêm 1 đoạn system prompt qua `agentCtx` → model thấy đoạn đó ở hội thoại được tạo kèm `setup`, **không** thấy ở hội thoại khác; mở lại sau khi container ngủ vẫn đúng.
- Chạy lại toàn bộ bài thử cũ: chat, `web_search` (Serper), `create_skill` + lưu hộ, đồng bộ skill, tên hội thoại, quota, mở lại sau khi ngủ.

---

## 5. Giai đoạn 1 — Preset `data-analyst` chạy thử (chưa có Python)

**Mục tiêu:** đường `?preset=` đi từ gateway tới agent, preset gắn đúng lúc tạo và lúc mở lại.

| Việc | File |
|---|---|
| Bật `@deepseek-ai/dsh-agent-presets`: `roots` trỏ tới thư mục preset trong image (trust `system`), `includeUserRoot: false`, chọn preset mặc định | `packages/profile-template/template/cordis.patch.yml` |
| Preset mặc định (chat thường) và preset `data-analyst`, lúc đầu chỉ chứa 1 đoạn prompt để thử | `packages/presets/<id>/agent.cordis.yml`, `preset.yml` (vị trí chờ chốt, xem mục 10) |
| Tạo agent: đọc `?preset=`, truyền `meta.agentPreset` + `setup` gọi `agentPresets.mount`. Mở lại: lấy preset bằng `resolveSessionPreset({ header, events })` | `packages/transport/src/server.ts:98`, `:117` (mẫu: `dsh-host-apiproxy/lib/index.js:1754-1778`) |
| Nhận `preset` từ URL như `model`, nối vào URL worker `new?id=…&preset=…` | `services/gateway/src/index.ts` (cạnh `:655` và dòng `const workerPath = …`) |
| Lưu loại hội thoại; danh sách lọc theo loại | `infra/migrations/003_session_preset.sql` (mới), `services/gateway/src/db.ts:100-102`, `:161` |

**Cần kiểm khi làm:** preset mặc định có được là danh sách rỗng không (README: preset
"not a list of named plugin rows" bị coi là hỏng).

**Xong khi:** mở WS với `?preset=data-analyst` → model thấy đoạn prompt thử; chat thường
không thấy; mở lại sau khi ngủ vẫn giữ preset; orchestrator và container dựng sẵn không
phải sửa.

---

## 6. Giai đoạn 2 — Tool `python` và thư mục làm việc

**Mục tiêu:** trong tab dữ liệu, model chạy Python, biến sống qua các lượt, file còn sau khi container ngủ.

| Việc | File |
|---|---|
| Tool `python(code)`: một kernel IPython (`jupyter_client`) cho mỗi container worker, khởi động khi gọi lần đầu, giới hạn thời gian mỗi ô, trả stdout/stderr/giá trị + ảnh biểu đồ (khối `image`). Kernel mới khởi động lại → báo cho model "biến đã mất, file vẫn còn" | `packages/tool/python-repl/` (mới; tham khảo cách chạy kernel ở `vendor/rlm/rlm/environments/ipython_repl.py`) |
| Chỉ thêm tool vào preset `data-analyst` | `packages/presets/data-analyst/agent.cordis.yml` |
| Cài `pip` + bộ tối thiểu: `ipykernel`, `jupyter_client`, `pandas`, `numpy`. Đo kích thước image trước/sau | `infra/docker/worker/Dockerfile` |
| Hội thoại dữ liệu làm việc trong `/data/workspace` (`meta.cwd`). Kiểm `bash`/`read`/`write` ghi đúng chỗ đó dưới sandbox | `packages/transport/src/server.ts` |

**Xong khi:** đặt tay 1 file CSV vào `/data/workspace` của hội thoại → "tính trung bình
cột X" đúng; lượt sau dùng lại biến `df`; sau khi container ngủ, model được báo kernel
mới và đọc lại file.

---

## 7. Giai đoạn 3 — Hàm dữ liệu, prompt, 9 skill

| Việc | File |
|---|---|
| `load_dataset`, `profile_dataset`, `save_artifact` nạp sẵn trong kernel, đường dẫn theo `/data/workspace` | `packages/tool/python-repl/` (chuyển từ `rlm_agent/tools.py`) |
| Prompt phân tích: giữ ý `evidence-policy.md`, `turn-policy.md`; **bỏ** `repl-protocol.md`, `completion.md` (không còn ép khối ```` ```repl ````) | preset `data-analyst` |
| 9 skill dữ liệu: pandas-expert, data-profiling, data-scientist, data-visualization, deliverable-export, ml-modeling, product-analytics, statistical-analysis, time-series-analysis. Bỏ trường `drivers`/`triggers` như đợt skill trước | thư mục skill của preset hoặc `packages/skills/` (chờ chốt) |
| Thư viện: `matplotlib`, `seaborn`, `scipy`, `scikit-learn`, `statsmodels<0.15`, `openpyxl`, `pyarrow`, `duckdb` (chưa cài torch/transformers) | `infra/docker/worker/Dockerfile` |

**Xong khi:** chạy lại bộ câu `agent-core/benchmarks/rlm/cases-ds.json` với dữ liệu mẫu
trong `benchmarks/rlm/fixtures/`, so với `reports/rlm-benchmark/ds-baseline.json`.

---

## 8. Giai đoạn 4 — Tab, tải file, hiển thị

| Việc | File |
|---|---|
| Tab "Phân tích dữ liệu": chat mới gắn `&preset=data-analyst`, thanh bên lọc theo tab | `apps/web/src/App.tsx` (cạnh `:371`), `components/features/sidebar/` |
| Tải file lên: gateway nhận file (giới hạn dung lượng) → orchestrator ghi vào `<dshHomeDir>/workspace/`, theo đúng đường đồng bộ skill (worker không biết user, §7) | `services/gateway/src/index.ts`, `services/orchestrator/src/` |
| Hiện ảnh biểu đồ trong ô tool, danh sách file kết quả | `apps/web/src/components/features/conversation/Conversation.tsx` |

**Xong khi:** thử bằng Chrome thật: tạo chat ở tab dữ liệu → tải CSV → hỏi → thấy biểu đồ
và file kết quả; tab chat thường không có tool `python`.

---

## 9. Giai đoạn 5 — Tuỳ chọn

- `llm_query` trong code Python (cầu nối nhỏ về `ctx.llm`), chỉ khi có nhu cầu thật.
- Chạy tool song song (điểm 1 trong so sánh driver).
- Bật `ask_user_question` (`dsh-tool-ask-user`) cho tab dữ liệu.
- `RuntimeContextProjection` (điểm 5).

---

## 10. Chờ chốt

| Điểm | Đề xuất |
|---|---|
| Vị trí preset | `packages/presets/<id>/` |
| Vị trí tool Python | `packages/tool/python-repl/` |
| Tên preset chat thường | `standard` |
| 9 skill dữ liệu đặt ở đâu | trong thư mục preset `data-analyst` (chỉ tab dữ liệu thấy) |
| Tên do LLM đặt có thay tên "vài chữ đầu" không | có, khi user chưa tự đổi tên |
| Giới hạn dung lượng file tải lên | chốt ở giai đoạn 4 |
