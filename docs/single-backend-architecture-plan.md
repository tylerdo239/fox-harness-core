# Plan: bỏ orchestrator — 1 BE (1 runtime `dsh` chạy nhiều session) + 1 FE

> Trạng thái: **đã triển khai GĐ0–GĐ5** (2026-10-02, nhánh `spike/single-runtime`, chưa merge/commit).
> Phần 1–12 là thiết kế; **mục 13 là kết quả đo/chạy thật của spike**, **mục 14 là những gì đã làm và đã kiểm chứng
> end-to-end** (có chỗ khác thiết kế ban đầu, ghi rõ ở đó). Điều gì chưa kiểm chứng được ghi rõ là "chưa verify".
> Bối cảnh: orchestrator không được duyệt vì lý do scale kỹ thuật (nó điều khiển Docker daemon,
> xem `docs/orchestrator-k8s-deployment.md`). Yêu cầu: chỉ deploy **FE + BE**; BE có **một core agent duy
> nhất phục vụ nhiều session**; giữ logic hiện tại; phân quyền theo user id.
> (Phiên bản trước của file này đề xuất "1 tiến trình `dsh` con cho mỗi session"; đã bỏ theo yêu cầu.)

## 1. Kết luận ngắn

- **Làm được, và đây là hướng "đúng bản chất" của dsh.** Một process `dsh` vốn chạy được nhiều agent/session
  (`ctx.agents.create()` nhiều lần — `packages/transport` đã làm vậy), và dsh có sẵn cơ chế **agent scope**
  + **agent preset** để mỗi session có bộ tool/prompt riêng trong cùng process (mục 3).
- **Không còn container-per-session, không còn orchestrator, không còn Docker socket.**
- **Spike đã chạy: GO có điều kiện** (mục 13). Cô lập giữa user làm được nhưng chỉ khi thêm 2 lớp ta tự xây
  (guard cho tool fs + runner bwrap chặt hơn); mặc định của dsh KHÔNG đủ.
- **Việc phải làm không nhỏ** — không phải đổi hạ tầng đơn thuần mà là sửa 5 chỗ trong code lõi
  (mục 5): `agent-driver` chưa hỗ trợ scope, 2 kernel Python là singleton, flow đang phân biệt bằng
  `disabled: true` cấp process, transport có listener O(số kết nối), skills theo thư mục toàn cục.
- **Cô lập giữa user chuyển hoàn toàn thành cô lập logic.** dsh tự nói scope "không phải sandbox hay ranh giới
  quyền" (`dsh-scope` README). Mọi ranh giới giữa user là do ta xây (mục 6, 7). **Cần team bảo mật đồng ý.**
- **Trần scale:** một process Node = một CPU thread cho phần điều phối. Có đường mở rộng không cần
  orchestrator (mục 9), nhưng 1 replica là mốc đầu.

## 2. Kiến trúc đích

```
Browser ──HTTPS──► FE (nginx: static React + reverse proxy /api, /ws → BE)
                         │
                         ▼
        BE container (1 image) — 2 tiến trình, 1 supervisor
        ├─ gateway  (services/gateway: auth MariaDB+Redis, REST, authorize theo user id, proxy WS)
        └─ dsh runtime DUY NHẤT (profile hợp nhất, packages/transport nghe 127.0.0.1)
              ├─ session A (user 1, flow default)          ┐ mỗi session = 1 Agent + 1 scope
              ├─ session B (user 2, flow data-analysis)    │ tool/prompt theo preset của flow
              └─ session C (user 1, flow data-studio) ...  ┘ state log trên đĩa dùng chung
Dịch vụ ngoài (đã có, không phải thứ ta deploy): MariaDB, Redis, S3, Mongo, Dremio, Meilisearch, LLM
```

Gateway giữ vai trò supervisor của dsh: spawn 1 lần lúc boot, restart khi chết (backoff). Hai tiến trình
trong cùng container giữ được: code gateway không import `dsh-*` (đúng quy tắc repo), lỗi trong dsh không
kéo sập auth/REST. Biến thể "gộp luôn gateway vào process dsh" không khuyến nghị (phải phá quy tắc ranh
giới và viết lại auth thành plugin Cordis).

Gateway **luôn** truyền cho runtime, trên mỗi lần kết nối (cả new lẫn reconnect), toàn bộ tham số của session
đọc từ MariaDB: `flow`, `model`, `cwd`, `userId`. Nhờ đó runtime **không giữ trạng thái điều khiển** — restart
runtime xong, client reconnect là session tự `resume()` từ log (cơ chế đã có và đã test ở Phase 3).

## 3. Những gì dsh đã có sẵn (đã đọc trong source)

| Nhu cầu | Cơ chế có sẵn | Nguồn |
|---|---|---|
| Nhiều session/process | `ctx.agents.create/resume`; dsh-web-app chạy kiểu này | `dsh-agent`, `dsh-agent-loop` |
| Tool riêng theo agent | `ctx.tools.register()` trong scope của agent; `ctx.tools.restrict({allow/deny})` chỉ áp cho agent gọi; `ctx.tools.guard()` theo agent | `dsh-tools` `.d.ts` |
| System prompt riêng theo agent | `ctx.systemPrompt.section()` trong scope shadow section toàn cục cùng tên (kể cả persona `deployment:persona`) | `dsh-system-prompt` |
| Listener chỉ cho agent trong flow | scoped event: listener gắn scope chỉ nhận sự kiện của agent con | `dsh-scope` |
| Gói cả bộ trên cho 1 "flow" | **agent preset**: thư mục chứa `agent.cordis.yml`, mount **1 lần/process**, session join qua `ctx.agentPresets.mount(agentCtx, id)` trong hook `setup`; "plugin key state theo Session/Agent nên các session tách nhau trong 1 instance" | `dsh-agent-presets` README |
| Workspace-write theo session | `dsh-sandbox-policy` lấy `session.header.cwd` làm `workspaceRoot` của từng session | `dsh-sandbox-policy/lib/index.js:142` |
| Resume session từ đĩa | `ctx.agents.resume()` (đã dùng trong transport) | repo |

→ **3 flow hiện tại (`default`, `data-analysis`, `data-studio`) trở thành 3 preset** trong một profile hợp nhất.
Hiện chúng khác nhau bằng `disabled: true` cấp process trong `cordis.patch.yml` (ví dụ data-studio tắt
bash/fs/web/…): trong 1 process cách đó không dùng được, thay bằng `tools.restrict` + section scoped của preset.

## 4. Orchestrator → BE: ánh xạ

| `services/orchestrator` | Sau khi gộp |
|---|---|
| spawn/kill container, `dockerode`, port, `waitUntilReachable`, `CapAdd`, `Memory/NanoCpus/PidsLimit` | **Xoá.** Còn lại: supervisor 1 tiến trình dsh trong gateway |
| `ensure.ts` (running/hibernated/new, lock, quota) | Gateway gọi thẳng transport; "ensure" = `agents.get() ?? agents.resume() ?? agents.create()` trong runtime. Quota concurrent đếm trong gateway |
| `redis.ts` affinity + lock + warm pool | **Xoá** (1 runtime, không cần affinity/pool/cold start). Redis chỉ còn token + rate-limit |
| `sweep.ts` idle → hibernate | **Thành "dispose agent khỏi RAM"** khi không còn WS và không có turn đang chạy (mục 5.6). Dữ liệu vẫn trên đĩa |
| `archive.ts` | Giữ nguyên, gọi trực tiếp từ gateway |
| `materialize.ts` | Rút gọn: chỉ materialize **1** profile hợp nhất lúc build/boot, không per-session. Thư mục per-session chỉ còn `cwd` |
| `skills-sync.ts`, `workspace-files.ts` | Giữ logic, import trực tiếp vào gateway, bỏ HTTP hop + secret header |
| `x-fox-harness-internal-secret` | Còn dùng giữa gateway ↔ runtime (loopback) — xem 6.3 |
| `packages/contracts` `Ensure*`/`Touch*` | Xoá |

## 5. Thay đổi code bắt buộc (đã kiểm trong source)

1. **`packages/agent-driver` chưa có agent scope.** `FoxHarnessAgent` dùng thẳng `ctx` toàn cục
   (`agent.ts:86-93`), trong khi `dsh-agent-loop` gốc làm `this.scope = createScope(loopCtx, this)` và
   `this.ctx = scope.ctx.extend({agent: this})` (`dsh-agent-loop/lib/index.js:376-377`), rồi chạy hook
   `options.setup(agent.ctx)` trước khi publish (`:1260`). Factory của ta bỏ qua `options.setup`
   (`factory.ts`). Phải thêm: tạo scope + `agent.ctx` scoped, `agentEvents` với carrier đúng scope, chạy `setup`
   (nơi gọi `agentPresets.mount`), dọn scope khi dispose. **Đây là phần rủi ro nhất** vì driver là code tự
   viết lệch khỏi upstream; cần test event-log diff lại như Phase 1.
2. **Kernel Python là singleton theo process.** `new PythonKernel()` trong `apply()`
   (`packages/tool/python-repl/src/index.ts:58`) → mọi session dùng chung biến. Đổi thành `Map<sessionId,
   PythonKernel>` (khoá bằng `exec.agent.session.id`), cwd/`FOX_OUTPUT_DIR` truyền theo session thay vì env
   process (`kernel.ts:192-201` đọc `process.env.FOX_OUTPUT_DIR`). Kernel idle quá N phút thì kill; cơ chế
   "Python session restarted" note đã có nên mất kernel không phá logic.
3. **`DataStudioKernel` là 1 subprocess, 1 slot `reply`** (`packages/tool/data-studio-agent/src/kernel.ts:65-70`)
   → hai session cùng hỏi sẽ đè nhau. Câu hỏi là stateless nên đổi thành **pool K subprocess + hàng đợi**
   (K cấu hình, mỗi cái nặng vì import agno/sqlglot/chromadb). Timeout 600 giây giữ nguyên.
4. **Flow = preset.** Chuyển `packages/flow/data-analysis`, `python-repl`, `data-studio-agent`, skills dir của
   flow vào 3 thư mục preset (`agent.cordis.yml` + metadata). Listener `agent/pre-step` và
   `ctx.systemPrompt.section` trong `flow/data-analysis` hiện đăng ký toàn cục → phải nằm trong mount của preset
   (scoped). Persona/compaction của từng flow chuyển thành section/config của preset. Hợp nhất 3 profile-template
   thành 1 profile + 3 preset.
5. **`packages/core`: model theo session.** Listener `agent/request` hiện trả `OPENAI_MODEL_ID` từ env cho mọi
   agent (`core/src/index.ts`) → đổi: ưu tiên `agent.options.model` (truyền qua `agentOptions.model` lúc
   create/resume), env chỉ là mặc định. Quota token (`quota.ts`) đã khoá theo `session.id`, giữ nguyên.
6. **`packages/transport`:**
   - Mỗi kết nối đăng ký 1 `ctx.on('session/event')` và lọc theo id (`server.ts`) → với N kết nối, mỗi event
     gọi N listener. Đổi thành **1 listener + `Map<sessionId, Set<ws>>`**.
   - Nhận `flow`, `model`, `cwd` từ gateway (query, chỉ chấp nhận khi có header nội bộ hợp lệ), validate `cwd`
     nằm dưới `dataDir` đã cấu hình; thay `process.env.FOX_SESSION_CWD`.
   - Giữ `AgentHandle` trong Map để `dispose()` được agent idle (hiện bỏ handle). Dispose: flush log → dispose →
     xoá khỏi RAM; reconnect thì `resume()`.
   - Chặn tạo trùng agent cùng `sessionId` đồng thời (single-flight).
7. **Skills theo user** — **đã verify, giải pháp ở mục 13.5** (không cần plugin riêng).
   (Mô tả vấn đề ban đầu:) Hiện `skills-sync` ghi vào `<dshHomeDir>/skills` và
   `dsh-skill-filesystem` watch thư mục toàn cục `$DSH_HOME/skills`. Trong 1 process thư mục này dùng chung →
   skill của user A hiện cho user B. Cần spike: (a) `dsh-skill-filesystem` có root theo `session.header.cwd`/scope
   không; (b) nếu không, viết plugin nhỏ đăng ký provider skill trong scope của agent đọc
   `skillsDir/<userId>/`. Việc này chặn phát hành (rò rỉ dữ liệu giữa user).
8. **Env process-wide:** `FOX_SESSION_CWD`, `FOX_OUTPUT_DIR`, `DSH_PROFILE_NAME` hết ý nghĩa theo session; mọi
   chỗ còn đọc chúng (đã grep: python-repl `kernel.ts`, transport) phải đổi sang tham số session.

## 6. Phân quyền theo user id

Phần lớn đã có ở gateway (`canAccessSession`, `canAccessProject`, `role`, bảng `sessions.user_id`). Vì mất
cô lập vật lý, các điểm sau trở thành **bất biến bắt buộc**:

1. **Một hàm `authorize(identity, resource)` duy nhất** cho mọi route/WS có `sessionId`/`projectId`; test tự
   động liệt kê route và chạy ca "user B truy cập tài nguyên của A → 403/404" cho từng route.
2. **Đường dẫn đĩa dẫn xuất từ id đã authorize**, không từ input client: `dataDir/<userId>/<sessionId>/`
   (hiện chỉ `<sessionId>`; cần script di chuyển, đảo ngược được), UUID regex trước `path.join` (đã có),
   `resolveInside` cho file con (đã có).
3. **Runtime chỉ nghe loopback + yêu cầu secret nội bộ** trên mọi kết nối từ gateway (loopback không đủ vì code
   do model chạy trong cùng container có thể kết nối `127.0.0.1`). Secret không nằm trong env mà code của model
   đọc được (xem 7.2).
4. **Ràng buộc session ↔ user trong runtime:** gateway truyền `userId`; runtime ghi vào `meta` của session và
   từ chối `resume`/`create` nếu `userId` truyền vào khác `userId` trong header đã lưu (lớp phòng thủ thứ 2
   chống lỗi định tuyến của gateway).
5. Project dùng chung: `cwd` trỏ thẳng thư mục project (không cần bind mount), `FOX_OUTPUT_DIR` thành
   `generated/<sessionId>` truyền per-session; quyền theo `canAccessProject`.
6. Quota theo user (`maxConcurrentSessionsPerUser`, `maxTurnsRunningPerUser`) — giờ tài nguyên dùng chung nên
   cần; bảng `sessions` có `user_id` nên đếm được.

## 7. Rủi ro (bắt buộc đọc)

1. **Blast radius = toàn bộ user.** Một lỗi/OOM/memory leak trong runtime dừng mọi turn đang chạy (log vẫn
   bền, client tự reconnect + resume; supervisor restart trong vài giây). Một lỗi cô lập → đọc được dữ liệu
   mọi user.
2. **Code do model chạy (bash/python/fs) cùng OS user với runtime.**
   - Confine hiện dựa vào `dsh-sandbox-local` (bwrap) + `workspaceRoot = session.header.cwd`. Cần test thật
     từ session A: đọc `../<userB>/`, `/proc/<pid>/environ` của runtime, `dataDir`, `/repo`, `.env`. **Chưa
     verify.** bwrap cần user namespace / `CAP_SYS_ADMIN` trong BE container → phải được cấp.
   - **Secret trong env của runtime** (`OPENAI_API_KEY`, `MONGODB_URL`, `DREMIO_*`, …): runtime phải giữ chúng
     để gọi LLM/Mongo. Cần xác nhận bash tool/python kernel không thừa kế env đó (python kernel đã dùng env tối
     giản, `kernel.ts:192-201`; bash trong sandbox chưa kiểm). Nếu không chắc: `--clearenv` trong bwrap.
   - Tool `fs`/`fs-search` chạy **trong process runtime**, không phải trong tiến trình con: xác nhận chúng bị
     `dsh-fs-sandbox` chặn theo `workspaceRoot` chứ không chỉ tin đường dẫn do model đưa. **Chưa verify.**
3. **Tài nguyên không còn giới hạn theo session** (không `Memory/NanoCpus/PidsLimit`). Python kernel và
   `analyze_data` là nguồn nặng. Giảm nhẹ: giới hạn số kernel đồng thời + `prlimit` (AS/CPU/NPROC) cho tiến
   trình con Python, pool K cho data-studio, `MAX_CONCURRENT_TURNS`, timeout đã có.
4. **Event loop một thread:** `JSON.stringify(snapshot)` của session lớn, giải nén zstd khi `resume`, parse
   frame — chặn mọi session khác. Cần giới hạn kích thước snapshot/phân trang và đo (mục 10).
5. **RAM theo session:** mỗi `Session` giữ toàn bộ `events` trong RAM. Phải dispose agent idle (5.6), nếu không
   RAM tăng tuyến tính theo số session từng mở.
6. **Upstream:** ta đang dùng sâu hơn các API scope/preset của dsh bản `0.1.1-rc.2` (developer preview) và
   `agent-driver` tự viết phải theo kịp (`docs/upstream-upgrade-policy.md`).
7. Hướng gia cố thêm nếu bảo mật yêu cầu: gVisor cho cả pod BE (`docs/microvm-isolation-strategy.md`); tách riêng
   runtime dành cho flow có bash/python khỏi runtime của `data-studio` (xem 9, shard theo flow).

## 8. Deploy

- **BE image** = `infra/docker/worker/Dockerfile` (đã có Node 22, Python venv, bwrap, uv, build) + build
  `services/gateway`. CMD: gateway, gateway spawn runtime. Một image duy nhất.
- **FE image** = nginx + `apps/web/public`; proxy `/api/*`, `/ws/*` tới BE, hỗ trợ WS upgrade, timeout dài;
  `index.html` no-cache, `main.js` có hash. TLS ở ingress/LB.
- **Volume bền** cho `dataDir` (log session, workspace, projects, archive). Mất volume = mất lịch sử → backup
  theo `docs/object-storage-strategy.md`. 1 replica + volume RWO + `strategy: Recreate`.
- **Graceful shutdown:** `SIGTERM` → ngừng nhận kết nối mới, chờ turn đang chạy (tối đa N giây) để `wake()`
  flush log, đóng kernel Python, rồi thoát. `terminationGracePeriodSeconds` ≥ N.
- Env: bộ của gateway + phần worker (`OPENAI_*`, `SERPER_API_KEY`, `MONGODB_*`, `DREMIO_*`, `MEILISEARCH_*`,
  `EMBEDDING_*`, `S3_*`). Bỏ `ORCHESTRATOR_URL`, `WORKER_*`, `WARM_POOL_SIZE`. Secret từ Vault/secret manager.
- Health: `/healthz` (gateway), `/readyz` (MariaDB + Redis + volume ghi được + runtime trả lời probe).
- Quyền container: đủ cho bwrap (user namespaces), không cần Docker socket/RBAC tạo Pod. VM/compose cũng chạy
  được.

## 9. Đường mở rộng không cần orchestrator

1. **Nhiều runtime trong cùng BE (shard):** gateway supervisor chạy K runtime `dsh`, chọn runtime theo
   `hash(sessionId) % K` (hoặc theo flow: `data-studio` tách riêng khỏi flow có bash/python). Dùng được nhiều
   CPU core, giảm blast radius K lần, và gần như không đổi code (supervisor 1 → K, định tuyến theo hash).
2. **Nhiều BE replica:** cần (a) sticky routing theo `sessionId` ở FE/ingress (consistent hash), (b) storage
   dùng chung (RWX) hoặc chấp nhận session gắn cứng một replica, (c) lock theo session khi `resume` để hai
   replica không cùng mở một session (Redis lock — một phần nhỏ của `redis.ts` cũ). Không làm ở bước đầu.

## 10. Con số phải đo trước khi cam kết (chưa có số nào)

Memory dự án ghi mục tiêu peak 1,000–10,000 session. Hướng này **nhẹ hơn nhiều** so với process/container
per-session vì session idle chỉ tốn đĩa, nhưng cần đo:

1. RAM/session đang mở (Agent + `events`) và RAM runtime lúc rỗng.
2. Độ trễ event loop khi 100/500/1000 WS đang stream cùng lúc (mock LLM); chi phí snapshot/resume session lớn.
3. RAM/CPU của 1 Python kernel (data-analysis) và 1 subprocess data-studio → quyết định trần kernel/K.
4. Số session **đồng thời thực sự active** vs tổng session; từ đó chọn K runtime (mục 9.1) và kích thước pod.

## 11. Các bước thực hiện

| GĐ | Việc | Kiểm chứng (chạy thật) |
|---|---|---|
| 0 | **Spike chặn rủi ro:** (a) `agent-driver` + `createScope` + `agentPresets.mount` chạy được 2 session, 2 preset khác tool trong 1 process; (b) skills theo user (5.7); (c) test thoát sandbox/đọc chéo (7.2) | 2 session khác flow trong 1 process: tool khác nhau; log event diff vs `dsh-agent-loop` gốc; session A không đọc được file/env của B |
| 1 | Sửa code lõi mục 5.1–5.5: scope trong driver, kernel Map/pool, flow→preset, model theo session | test replay giữa chừng; kill runtime rồi reconnect → 0 mất dữ liệu; 2 user cùng python → biến không lẫn |
| 2 | Transport: 1 listener, `Map<sessionId, Set<ws>>`, nhận `flow/model/cwd`, dispose idle, single-flight, kiểm `userId` | 500 WS mock-LLM: độ trễ event loop; RAM sau dispose idle giảm |
| 3 | Gateway: supervisor runtime, bỏ orchestrator-client, gọi trực tiếp archive/skills/workspace, `authorize()` thống nhất, `userId` trong đường dẫn + script di chuyển, quota per-user | bộ test chéo-user toàn bộ route (đỏ→xanh); test cross-user filesystem |
| 4 | Graceful shutdown, health, log `sessionId` xuyên suốt (giữ), Dockerfile BE + FE nginx, manifest/compose, cập nhật README/`core-overview.md`/`.env.example` | `SIGTERM` giữa turn → turn xong, log flush, reconnect OK; smoke 3 flow trên staging |
| 5 | Xoá `services/orchestrator`, `dockerode`, `contracts` thừa, dọn `services/orchestrator/data/**` đang bị commit; (tuỳ chọn) shard K runtime (9.1) | `pnpm build` sạch, grep không còn `orchestrator` |

Rollback: giữ tag git trước GĐ5. Dữ liệu session tương thích hai chiều nếu script đổi đường dẫn `userId` có bản
đảo ngược. Phiên bản orchestrator cũ vẫn đọc được log vì định dạng log của dsh không đổi.

## 12. Câu hỏi cần chốt

1. Lý do không duyệt orchestrator chính xác là gì: *cần Docker socket/quyền hệ thống*, hay *không scale
   ngang*? Quyết định có cần mục 9.2 sớm không.
2. Team bảo mật có chấp nhận cô lập logic (user id + path + bwrap) thay vì container-per-session không? BE
   container có được cấp user namespace/`SYS_ADMIN` cho bwrap không? Có thể tách `data-studio` (không có
   bash/python) sang runtime riêng không?
3. Quy mô thật: số user, số session đồng thời, peak?
4. Redis có sẵn ở môi trường deploy không? (nếu không: token sang MariaDB, rate-limit sang RAM.)
5. Storage bền cho `dataDir`: loại gì, backup, giới hạn dung lượng mỗi user/session?
6. Chấp nhận phụ thuộc sâu hơn vào scope/preset của dsh `0.1.1-rc.2` và việc tự bảo trì `agent-driver` cho
   khớp upstream không?


## 13. Kết quả spike giai đoạn 0 (2026-10-01)

Môi trường: runtime `dsh` chạy trong image worker Linux (`fox-harness-worker:dev`) trên Docker Desktop (macOS,
10 CPU), LLM là mock xác định (`scripts/mock-llm.mjs`), driver/transport/core/python-repl **mới** bind-mount
đè lên image. Kiểm bằng `scripts/spike-single-runtime.mjs` (6 test) và `scripts/spike-load.mjs`. **Không** dùng LLM
thật, **không** chạy qua gateway, **không** chạy `scripts/upstream-smoke-test.mjs`. Mọi test trừ phần ghi rõ đều
chạy trong Linux (bwrap thật); trên macOS dev không có sandbox backend cho bash.

### 13.1 Presets — đạt
Một process, 2–3 session khác flow: `default` thấy 25 tool, `data-studio` thấy đúng `analyze_data`,
`data-analysis` có `python` và không có `bash`; persona khác nhau theo flow. Flow = preset đã chạy được.
Phát hiện cần ghi vào thiết kế: **`dsh/profile-boot` ép `roots` của `agent-presets` về thư mục preset đóng gói
của upstream** → preset của ta chỉ nạp được qua *user root* `$DSH_HOME/.agent-presets` (`includeUserRoot: true`).
Entrypoint của BE phải tạo symlink/copy `packages/profile-template/presets` → `$DSH_HOME/.agent-presets`.
Cordis không có inject tùy chọn → transport dùng `ctx.get('agentPresets')`.

### 13.2 Driver (`agent-driver`) — đạt
Đã thêm: scope riêng cho từng agent (`createScope` + `scope.ctx.extend({agent})`), chạy `options.setup(agent.ctx)`
trước khi publish (cả create lẫn resume), `dispose` memoized + `scope.dispose()`, phát `agent/session-start`,
khôi phục `turnSeq` từ log. Chuỗi *loại* event của một lượt thường (19 event) và lượt có tool call (29 event) từ driver
mới **giống hệt** driver cũ (image build trước khi vá). Số turn sau resume đúng (`[1,2]`); lỗi `turnSeq` cũ suy ra
từ đọc code, **chưa chạy A/B với code cũ** để thấy `[1,1]`.
Bug phát sinh do `setup` bất đồng bộ và đã sửa: transport gắn handler `message` sau khi tạo agent nên **frame gửi
ngay khi kết nối bị rơi**; đã sửa thành xếp hàng frame tới khi session sẵn sàng.

### 13.3 Cô lập giữa user — đạt, nhưng cần 2 lớp ta tự xây
Bộ test 22 vector (kèm 8 control "phải thành công" để chắc không chặn nhầm): **0 rò rỉ** sau khi áp 2 lớp dưới.
Trạng thái **mặc định của dsh** (đã đo, không phải suy đoán):
- Tool `read`, `glob`, `grep`, `str_replace_editor` chạy trong process runtime và **đọc được file user khác, file
  host**; `write` **ghi được** vào thư mục user khác (7/9 vector rò trên macOS dev). Fence của dsh chỉ canh việc ghi
  và là "policy fence".
- `bash` trong bwrap mặc định (`--ro-bind / /`) **đọc được mọi file** (đo trên Linux: 2/2 vector rò).
Hai lớp thêm vào:
1. `packages/transport/src/workspace-guard.ts`: `tools.guard()` đăng ký qua scope của từng agent, từ chối mọi tham số
   đường dẫn (sau `realpath`, theo symlink) ra ngoài cwd của session; chặn cả symlink do bash đặt rồi `read` đi theo.
   Chỉ cho đọc thêm `FOX_SHARED_READ_DIRS` (skill dựng sẵn). Đây là *policy fence*: còn cửa sổ check-then-use
   (symlink bị đổi giữa lúc kiểm và lúc dùng) và không nhìn được vào dòng lệnh `bash`.
2. `infra/docker/spike/fox-confine.sh`: runner bwrap cắm vào `sandbox-local` qua `runnerCommand`; root rỗng, chỉ bind
   `/usr` + vài file `/etc` + `/opt/fox-py` (ro), workspace của session (rw), `/tmp` tmpfs. Kết quả: file user khác,
   `/repo`, `/data` không tồn tại trong sandbox (`ls` data root chỉ thấy đường dẫn tới workspace của chính nó).
   Lỗi tìm ra khi đo: `--unsetenv` **không đủ** — process init của bwrap giữ nguyên env và `/proc/1/environ` đọc
   được `MONGODB_URL` (tên không khớp regex scrub của dsh `KEY|PASSWORD|SECRET|TOKEN`); đã chuyển sang
   `env -i` allow-list trước khi gọi bwrap (A/B: bản cũ rò, bản mới không).
Dùng chung cho python: kernel chạy qua cùng runner khi có `FOX_CONFINE_RUNNER`.

### 13.4 Python theo session — đạt (8/8)
`PythonKernel` là `Map<sessionId, kernel>` + mutex theo kernel + dừng kernel idle (`FOX_PY_IDLE_MS`) + trần LRU
(`FOX_PY_MAX_KERNELS`); sổ "kết quả đã nêu" giữ qua lần dừng. Đã kiểm: hai session chạy đồng thời không lẫn
output/biến; python của A không đọc được file B, không thấy env runtime, không liệt kê được data root.
Phát hiện: dưới bwrap, `SIGINT` gửi cho process con **không tới interpreter** (cell quá hạn bị `SIGKILL` cả kernel,
mất mọi biến). Sửa: spawn `detached` + `kill(-pgid, SIGINT)`, runner `trap '' INT` (bwrap sống sót), `runner.py`
bật lại `default_int_handler`. Sau sửa: cell quá hạn bị ngắt và biến còn nguyên. (Bỏ `--new-session` khỏi runner.)

### 13.5 Skills theo user — đạt, giải pháp đơn giản
Không cần sửa `dsh-skill-filesystem`: skill của user ghi vào `<cwd session>/.dsh/skills/<tên>/SKILL.md` (root theo
project, tính từ cwd) hiện đúng cho user đó và không cho user khác; skill dựng sẵn (`/repo/packages/skills`) vẫn dùng
chung. Điều kiện: không có `.git` ở tổ tiên workspace (nếu có, mọi workspace dưới nó dùng chung root). Skill dựng sẵn
chỉ dùng được trong sandbox khi đặt `FOX_SHARED_READ_DIRS` (guard) **và** `FOX_CONFINE_RO` (bind ro vào bwrap) —
thiếu một trong hai là hỏng (đã đo: control đọc skill dựng sẵn fail khi chưa cấu hình). `skills-sync.ts` của
orchestrator cần đổi đích ghi từ `<dshHomeDir>/skills` sang `<workspace>/.dsh/skills` (chưa làm, thuộc GĐ3).
Chưa kiểm: giới hạn `watchMaxProjects` (128) của watcher khi có hàng trăm cwd mở cùng lúc.

### 13.6 Kill -9 và resume — đạt
`SIGKILL` cả container có 3 session: 2 session idle resume từ đĩa, turn tiếp tục đúng số, **flow được join lại khi
resume** (session data-analysis vẫn có `python`, không `bash`, đúng persona). Session bị giết **giữa lúc stream**:
log đóng turn dở thành `interrupted`, chat tiếp được; các chunk chưa flush **mất** (người xem trực tiếp đã thấy,
log không có) — giống hành vi container-per-session cũ.

### 13.7 Số đo (mock LLM; chỉ đo phần điều phối của runtime, chưa gồm Python/data-studio nặng)
| | giá trị |
|---|---|
| RSS runtime rỗng | ~110–155 MB |
| RSS theo session đang mở (idle) | ~0.5–1 MB/session (500 session mở: ~341 MB) |
| N stream đồng thời (mỗi stream ~2,1 s lý tưởng) | 50 → p50 2,5 s · 200 → 4,0 s · 500 → 8,0 s |
| Thông lượng event của 1 runtime | **~2.300–2.800 chunk-event/s** thì bão hòa (CPU ~190%, main thread nghẽn) |
| RSS đỉnh lúc 500 stream cùng chạy | ~1,5 GB (chunk tích trong `session.events`), về ~0,6 GB sau dispose + GC |
| Idle dispose | 500/500 session được dispose; resume 1 session đã dispose: 0,5–1,2 s |
| Tạo session mới | 200 session: 8,7 s; 500 session: 57 s (chi phí/session tăng khi nhiều session mở — chưa tìm nguyên nhân) |
Hệ quả cho kích thước: **số session *đang stream cùng lúc* trên một runtime chỉ vào cỡ vài chục đến ~100–150**
(với LLM thật ~20–50 event/s/stream), không phải hàng nghìn; hàng nghìn session *idle* thì rẻ (đĩa + ~0,5 MB).
Vì vậy shard K runtime trong BE (mục 9.1) nên coi là **bắt buộc** nếu mục tiêu là hàng nghìn người dùng hoạt động,
không phải tuỳ chọn. Số liệu từ máy dev/Docker Desktop, cần đo lại trên phần cứng thật + LLM thật.

### 13.8 Kết luận go/no-go
**GO có điều kiện.** Cả 5 tiêu chí của plan đạt trong phạm vi đã đo. Điều kiện: (a) team bảo mật chấp nhận mô hình
cô lập = guard + runner bwrap tự viết (không phải ranh giới kernel cho tool chạy trong process; còn cửa sổ
check-then-use của guard); (b) coi shard K runtime là một phần của thiết kế; (c) chạy lại bộ test này với LLM thật
và qua gateway trước khi phát hành.

### 13.9 Chưa làm / chưa verify (việc còn lại cho GĐ1+)
- `DataStudioKernel` vẫn 1 subprocess/1 slot (blocker đã biết, cần pool + hàng đợi); `analyze_data` chưa chạy trong spike.
- Ràng buộc `userId` giữa gateway và runtime (header `meta` của session có giữ khoá tuỳ ý không — chưa kiểm).
- Gateway/FE chưa nối; `skills-sync`, `workspace-files`, `archive` chưa chuyển vào BE; `authorize()` thống nhất, `userId`
  trong đường dẫn, quota theo user, dispose idle khi đang có turn (đã chặn theo `agent.status`, chưa test turn dài).
- `FOX_PY_*` chưa đo RAM của một kernel Python thật (pandas); `project`/`FOX_OUTPUT_DIR` theo session chưa xử lý.
- `agent-driver`: chưa có tool song song, `RuntimeContextProjection`, `FactoryOwnership`, effect gắn owner-fiber.
- Nâng dsh (0.2.0-rc.2 hiện có): giữ `0.1.1-rc.2`; upstream đã đổi preset sang plugin bundle, `agent/created`, log V4.
- Cần `package.json` của `agent-driver` khai `@deepseek-ai/dsh-scope` (hiện dựa vào hoisting; chưa đụng lockfile).
- `bash` của flow `default` vẫn có mạng và đọc được `/usr`, `/etc` (đã chọn allow-list tối thiểu, chưa cắt mạng).
- Chạy lại `scripts/upstream-smoke-test.mjs` (cần LLM thật) làm baseline hồi quy.


## 14. Triển khai (GĐ1–GĐ5, 2026-10-02) — đã làm gì, kiểm chứng gì

Kiểm chứng bằng `scripts/e2e-backend.mjs`: stack thật gồm **nginx (image web) → gateway → 2 runtime `dsh` → mock LLM**,
MariaDB 10.11 + Redis + MinIO, hai user thật, qua HTTP/WebSocket như `apps/web` (`scripts/e2e-up.sh` dựng, `e2e-down.sh` gỡ).
12 test: health, chat + danh sách, flow khác nhau, quyền sở hữu, **cô lập chéo user** (8 vector bash/read/grep/`/proc`/env +
control; B's workspace thật), python + files API (8 kiểm tra), skill theo user, validation model/flow/project, idle dispose +
resume, `docker restart` rồi resume (flow join lại), **SIGTERM giữa lúc stream**, purge. Tất cả đạt.

**Đã làm**
- **DB**: thêm `discovery_sessions.model` (gateway đọc flow/model/project/owner từ hàng này ở MỌI lần kết nối).
- **Lõi**: quota token dựng lại từ log (WeakMap theo Session, không reset khi resume, không rò RAM); Map của flow
  data-analysis thành WeakMap; python-repl nhận `outputDir` theo session qua `agentOptions`; pool + hàng đợi cho
  `analyze_data` (`FOX_DS_WORKERS`, kiểm bằng kernel giả: giới hạn đồng thời, FIFO, timeout chờ, huỷ khi đang chờ).
- **Transport**: `userId`/`outputDir` qua `agentOptions`; từ chối user khác trên session đang sống; mọi HTTP/WS cần secret
  của gateway; `DELETE /sessions/:id` để runtime nhả session trước khi xoá file; `FOX_TRANSPORT_HOST/PORT` theo shard.
- **Gateway** (`src/runtime/`): supervisor (K runtime, readiness bằng WS handshake thật, restart backoff, secret mỗi lần
  boot, dừng êm), materialize profile hợp nhất, paths, skills-sync (`<workspace>/.dsh/skills`), workspace-files, purge,
  quota theo user/toàn cục (`live.ts`, test logic riêng), `/healthz` + `/readyz`. **Tự kiểm tra sandbox lúc boot bằng cách
  chạy thật runner** (không chỉ kiểm file tồn tại): thiếu `CAP_SYS_ADMIN` thì production từ chối khởi động với thông báo rõ
  (đã thử cả hai chiều). Từ chối khởi động nếu data dir nằm trong git checkout.
- **Profile**: một profile (`profile-template/runtime`) + 3 preset; ba profile cũ xoá. Phải đặt biểu thức `!!js` trong dấu nháy
  (YAML hiểu `? `/`: ` là cú pháp — lỗi gặp thật khi boot container).
- **Deploy**: `infra/docker/backend` (gateway + runtime, `NODE_ENV=production`, `HEALTHCHECK`), `infra/docker/web` (nginx,
  proxy cả WebSocket), `infra/deploy/docker-compose.yml` (+ profile `local-deps`) và README; FE mặc định gọi cùng origin.
- **Dọn**: xoá `services/orchestrator` (kèm `data/` bị commit nhầm), `dockerode`, 3 profile cũ, contracts còn `SkillFile`/`WorkspaceFile`;
  lockfile cập nhật; `dsh-scope`/`dsh-agent-presets`/`dsh-tools` khai báo trong `package.json`.

**Khác thiết kế ban đầu**
- Header của session dsh chỉ có trường cố định → `userId`/`outputDir` không lưu vào session mà truyền lại mỗi lần connect.
- Không có `userId` trong đường dẫn log của dsh (log theo `--<cwd>--/<sessionId>`); workspace thì có (`users/<userId>/<sessionId>`).
- Archive/hibernate ra ngoài đĩa **không** chuyển sang (mặc định tắt ở orchestrator cũ) — ghi ở core-overview §5.
- `login` vẫn không trả `userId` (giữ API); test e2e tìm workspace thật qua `docker exec`.

**Lỗi tìm ra khi chạy thật (đã sửa)**: biểu thức `!!js` không đặt trong nháy làm runtime không boot; frame gửi sớm bị rơi (xếp
hàng); quota/flow rò RAM; kernel python và `analyze_data` dùng chung giữa user; test e2e đầu tiên "đạt giả" vì đọc 8–12 event
cuối (bỏ sót `tool/result`) và trỏ nhầm sang `/data/users/undefined` — đã sửa để mỗi vector bắt buộc có kết quả tool thật.

**Chưa làm / chưa verify**
- Chạy với **LLM thật**, `analyze_data` thật (Dremio/Mongo/Meilisearch), FE trên **browser thật**.
- Image `backend` e2e được build trước khi thêm self-test sandbox (self-test đã kiểm riêng bằng cách mount `lib/` mới); cần build lại bản cuối.
- Chạy nhiều replica BE; đo tải lại trên phần cứng thật; `userId` bind thêm ở mức runtime chỉ là phòng thủ trong bộ nhớ.
- `scripts/upstream-smoke-test.mjs` chưa chạy lại (cần LLM thật và profile headless).
- Dev trên macOS: sandbox không có (bubblewrap chỉ Linux) — chỉ dùng cho máy dev.

**Lỗi tìm ra khi chạy với LLM thật (2026-10-02), đã sửa**: bridge Python của `analyze_data` in dòng `WARNING ...` ra stdout (kênh
giao thức JSON); `JSON.parse` không bọc try/catch trong handler `line` ném lỗi ra ngoài và **làm sập cả runtime** (mọi session
trên shard, `restarts: 1`). Trước đây lỗi này chỉ giết một container. Sửa ở cả `data-studio-agent/src/kernel.ts` và
`python-repl/src/kernel.ts`: dòng không phải JSON object bị ghi log (`stdout_noise`) và bỏ qua; có test tái hiện (kernel cũ làm lọt
exception, kernel mới sống sót). Bài học: trong kiến trúc nhiều session/process, một exception không bắt trong handler của tool
không còn là lỗi của một session mà là của cả shard.

**Lỗ hổng tìm ra khi review (2026-10-02), đã sửa**: guard chặn đường dẫn được đăng ký trên scope của agent cha, nhưng
subagent có scope riêng (nối vào preset của cha qua `composeFrom`, không nối vào scope của cha) nên **không bị guard**:
đo thật, `read` của subagent trả về file của user khác, và đọc được `/proc/self/environ` của runtime (khoá LLM, secret nội bộ).
Sửa: guard đăng ký **toàn cục** một lần trong `packages/transport/src/index.ts` (áp cho mọi agent, xét theo cwd của chính
session gọi tool) và quét cả tham số đường dẫn lồng nhau. Test hồi quy `subagentIsolation` trong `scripts/e2e-backend.mjs`
(fail trên image cũ, pass trên image mới). Bash/python của subagent vốn đã nằm trong sandbox bwrap.

**Còn mở (từ review)**: log của subagent không được flush xuống đĩa (đo thật: sau nhiều phút file chỉ có header) — mất khi
runtime restart, có lẽ đã tồn tại từ trước; subagent con không được Hub theo dõi nên không bị dispose khi idle (chưa đo RAM);
khe đua giữa dispose idle và một kết nối mới tới cùng session (chưa tái hiện).
