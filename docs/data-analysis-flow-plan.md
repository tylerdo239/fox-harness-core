# Plan: thêm flow "Phân tích dữ liệu"

> Status: **đã implement xong khung (mục 1-13 dưới đây), chưa build/chạy
> thật để verify.** `pnpm install`/`pnpm run typecheck`/`pnpm run build` đã
> pass, nhưng chưa build lại worker image, chưa chạy migration `003` trên DB
> thật, chưa test end-to-end qua UI (xem mục Verification).
>
> **Cập nhật 2026-09-14 (lần 3) — gộp thư mục theo category.** Theo đúng
> convention có sẵn trong `pnpm-workspace.yaml` ("group folder... once a
> category has more than one package", đã áp dụng cho `packages/tool/*`,
> `packages/llm/*`): `packages/profile-template` (nay đã có 2 package) gộp
> thành `packages/profile-template/{default,data-analysis}`;
> `packages/flow-data-analysis` chuyển vào `packages/flow/data-analysis`
> (đón trước cho các flow sau này). Tên package npm (`@fox-harness/profile-template`,
> `@fox-harness/profile-template-data-analysis`, `@fox-harness/dsh-flow-data-analysis`)
> **không đổi** — `config.ts`/`package.json` chỉ tham chiếu theo tên npm, không
> theo đường dẫn, nên không cần sửa gì ở đó; chỉ `tsconfig.json` gốc (path
> reference) và `tsconfig.json` của `flow/data-analysis` (độ sâu `extends`
> tới `tsconfig.base.json` tăng 1 cấp) cần sửa. `packages/agent-driver` giữ
> nguyên chỗ cũ — nó là loop dùng chung, không phải "1 item per flow".
>
> **Cập nhật 2026-09-14 (lần 2) — đổi kiến trúc loop sau khi nghiên cứu
> upstream.** Bản đầu tiên scaffold `packages/agent-driver-data-analysis` là
> **bản copy nguyên turn/step state machine** của `packages/agent-driver`
> (~250 dòng `agent.ts` + `factory.ts` + `index.ts`), chỉ để chứng minh cơ
> chế swap loop chạy được. Người dùng hỏi đúng chỗ: core turn/step có đổi gì
> đâu, sao phải nhân bản? Đọc lại `node_modules/@deepseek-ai/dsh-agent-loop/README.md`
> (bản `0.1.1-rc.2` đúng version repo phụ thuộc, `package.json` trỏ thẳng
> `github.com/deepseek-ai/deepseek-harness`, dir `packages/core/agent-loop`)
> thấy rõ nguyên tắc thiết kế gốc:
>
> > "This is the **only** package in the harness that contains concrete loop
> > logic. **Everything else is an abstract service or a plugin against
> > extension points — new behavior goes into plugins, not here.**"
>
> Và concrete driver (`ReactLoopAgent`) là package-internal, không export để
> subclass — upstream chỉ cho 2 lựa chọn thật: dùng loop gốc + hook event
> taxonomy (`agent/pre-step`, `agent/request`, `tools/pre-execute` →
> `tools/execute` → `tools/post-execute`, `agent/turn-stopping`,
> `agent/request-error`...), hoặc viết hẳn 1 driver khác (đúng cái
> `packages/agent-driver` đã làm — quyết định có chủ đích, ghi rõ ở
> `docs/agent-core-architecture-roadmap.md` §0.2 "nấc 2", chọn trước khi có
> yêu cầu flow này).
>
> `FoxHarnessAgent` (packages/agent-driver/src/agent.ts) **vẫn dispatch đúng
> event taxonomy gốc** (`agent/pre-step`/`agent/request`/`agent/turn-stopping`
> qua `agentEvents(ctx, this)`) — nên 1 plugin thứ 2 hoàn toàn có thể hook
> vào CHÍNH loop mặc định đang chạy, không cần factory/Agent riêng. Đã đối
> chiếu cách hook thật trong `node_modules/@deepseek-ai/dsh-repeat-tool-reminder`
> (`ctx.on('agent/pre-step', (payload, next) => ...)`,
> `ctx.on('tools/post-execute', ...)`) để viết đúng pattern.
>
> **Quyết định:** bỏ `packages/agent-driver-data-analysis`, thay bằng
> `packages/flow/data-analysis` — 1 plugin nhỏ hook event trên loop mặc
> định, KHÔNG đụng `ctx.agents.setFactory()`. Chỉ khi nào flow này cần đổi
> *cấu trúc* turn/step thật sự (không chỉ nội dung trong 1 step) mới cần
> quay lại hướng factory riêng — lúc đó nên tách phần turn/step engine dùng
> chung ra 1 package base trước, vì `docs/skill-transfer-plan.md` §10 tự ghi
> "Fox chưa có bộ test tự động" — 2 bản copy sẽ trôi dạt không ai canh được.
>
> Toàn bộ phần "trục `flow` xuyên suốt" (contracts/DB/gateway/orchestrator/
> materialize/docker/entrypoint/FE) ở dưới **không đổi** — vẫn cần vì mỗi
> flow vẫn cần 1 profile/container riêng (để plugin hook chỉ load trong
> đúng flow của nó, không cần check flow lúc runtime bên trong hook). Chỉ
> mục 10-11 (loop mới) đổi cách làm.

## Context

Hiện tại toàn bộ hệ thống chỉ có 1 profile (`fox-harness`) và 1 agent loop
(`@fox-harness/dsh-agent-driver`, packages/agent-driver) — mọi session dùng
chung. Người dùng muốn thêm 1 nút trên UI ("Phân tích dữ liệu") mở ra 1 flow
chat mới, có hành vi khác (tool policy, thêm bước xử lý, v.v.) — không nhất
thiết phải là 1 turn/step state machine khác, xem ghi chú "Cập nhật lần 2"
ở trên.

Kiến trúc hiện tại cho phép việc này: mỗi session = 1 container Docker = 1
process `dsh` riêng, mỗi profile có bundle list riêng. Vì 2 session luôn
chạy trên 2 container độc lập, 1 plugin chỉ có trong profile "data-analysis"
sẽ không bao giờ load trong session flow mặc định.

Cách làm: thêm 1 trục `flow` chạy xuyên suốt, mô phỏng đúng cách trục `model`
đã được thêm ở Phase 12 (services/gateway → services/orchestrator →
Redis/DB record → materialize.ts → container). Giữ nguyên hành vi mặc định
(`flow` vắng mặt/`"default"`) y hệt hôm nay để không phá session cũ đã có
sẵn `profiles/fox-harness/` trên đĩa.

## Thiết kế

**Flow registry tĩnh** trong `services/orchestrator/src/config.ts` (chỉ 2
entry, không cần env-driven như `allowedModels` vì đây là quyết định
sản phẩm/deploy, không phải cấu hình vận hành):

```ts
flows: {
  default: { profileName: 'fox-harness', templatePackage: '@fox-harness/profile-template' },
  'data-analysis': { profileName: 'fox-harness-data-analysis', templatePackage: '@fox-harness/profile-template-data-analysis' },
} as const,
allowedFlows: Object.keys(flows),
```

`default.profileName` giữ nguyên `'fox-harness'` — bắt buộc, để session cũ
(đã có `profiles/fox-harness/` trên đĩa) tiếp tục rehydrate đúng.

## Các thay đổi theo lớp (mirror đúng pattern của `model`)

1. **`packages/contracts/src/index.ts`** — thêm `flow?: string` vào
   `EnsureSessionRequest`, comment giống hệt field `model` (bị bỏ qua khi
   reconnect/rehydrate).

2. **DB** — file migration mới `infra/migrations/003_add_flow_column.sql`
   (đổi số từ 002 lên **003**: `002_custom_skills.sql` đã bị `feat/skill-transfer`
   chiếm mất — theo README: không sửa file migration cũ):
   `alter table sessions add column flow varchar(64) not null default 'default';`
   `services/gateway/src/db.ts`'s `createSession()` nhận thêm tham số `flow`.

3. **`services/gateway/src/index.ts`** (WS upgrade handler,
   `server.on('upgrade', ...)` giờ ở dòng ~610, cạnh dòng đọc `model` ~L655) —
   đọc `flow` từ query, truyền vào `ensureSession()` (chỉ khi `isNew`, giống
   `model`) và vào `createSession()` (~L687). Không đụng gì tới `pushSkills()`
   (đồng bộ skill riêng, gọi ở 3 chỗ trong file này) — việc đồng bộ skill ghi
   theo `dshHomeDir`/`sessionId`, không quan tâm flow/profile nào, nên cả 2
   flow đều nhận skill riêng của user như nhau, không cần sửa gì thêm.
   **`services/gateway/src/orchestrator-client.ts`**'s `ensureSession()`
   thêm tham số `flow?: string`, gộp vào `EnsureSessionRequest` body.

4. **`services/orchestrator/src/errors.ts`** — thêm `InvalidFlowError`
   (giống `InvalidModelError`). **`services/orchestrator/src/index.ts`**'s
   catch block ở route ensure thêm 1 branch 400 tương ứng.

5. **`services/orchestrator/src/redis.ts`**'s `SessionRecord` — thêm
   `flow?: string` (optional, session cũ = `undefined` → coi như `default`).

6. **`services/orchestrator/src/materialize.ts`** — tham số hoá
   `materializeDshHome(dshHomeDir, flow = 'default')`: tra `config.flows[flow]`
   để lấy `profileName` + `templatePackage`, resolve `templateDir` qua
   `import.meta.resolve(`${templatePackage}/template/profile.package.json`)`
   (hiện đang hardcode `@fox-harness/profile-template`), dùng `profileName`
   thay vì literal `'fox-harness'` khi join `profiles/<profileName>`.

7. **`services/orchestrator/src/docker.ts`**'s `spawnWorker()` — thêm tham
   số `profileName = 'fox-harness'`, push `DSH_PROFILE_NAME=${profileName}`
   vào `Env` của container.

8. **`infra/docker/worker/entrypoint.sh`** — đổi 2 chỗ hardcode
   `fox-harness` thành `PROFILE_NAME="${DSH_PROFILE_NAME:-fox-harness}"`
   (mkdir/symlink + `--profile $PROFILE_NAME`). Mặc định giữ nguyên hành vi
   image hiện tại nếu env var vắng mặt.

9. **`services/orchestrator/src/ensure.ts`** — thread `flow` qua đúng những
   chỗ `model` đã đi qua:
   - validate với `config.allowedFlows` → `InvalidFlowError`
   - rehydrate: luôn dùng `existing.flow ?? 'default'`, không bao giờ dùng
     giá trị request mới gửi lên (giống `existing.model`)
   - warm pool: chỉ claim khi `flow === undefined` (pool member luôn là
     flow `default` — giống gate `model === undefined` hiện có)
   - cold-spawn: resolve `profileName` từ `config.flows`, gọi
     `materializeDshHome(dshHomeDir, resolvedFlow)` +
     `spawnWorker(..., profileName)`, lưu `flow` vào `SessionRecord`

10. **ĐÃ ĐỔI — plugin hook, không phải loop riêng.**
    `packages/flow/data-analysis/` (`@fox-harness/dsh-flow-data-analysis`):
    - `cordis.patch.yml`: **pure `insert:`**, KHÔNG disable row `agent-loop`
      — đây là companion plugin, không cạnh tranh `ctx.agents.setFactory()`
      với `packages/agent-driver`. Cùng pattern
      `packages/tool/serper-web-search/cordis.patch.yml`.
    - `src/index.ts`: không có `inject` (chỉ dùng `ctx.on(...)`, không đụng
      service nào cần khai báo). Hook `ctx.on('agent/pre-step', (payload, next) => {...; return next()})`
      — hiện tại chỉ log 1 marker (`fox-harness-flow-data-analysis/pre-step`)
      để chứng minh plugin thật sự load & chạy trong đúng session flow này.
      Thay marker bằng hành vi thật (tool policy, thêm bước lập kế hoạch,
      retry/compaction khác, ...) là việc tiếp theo.
    - Không cần `setup`/`factory` gì thêm — bundle này chỉ quan sát/chèn vào
      pipeline có sẵn của `FoxHarnessAgent`.

11. **Profile template mới** `packages/profile-template/data-analysis/`
    (copy `packages/profile-template/default/`): `template/profile.package.json`'s
    `bundles` = **danh sách mặc định hiện tại + thêm `@fox-harness/dsh-flow-data-analysis`**
    (không đổi `dsh-agent-driver`):
    ```json
    [
      "@deepseek-ai/dsh-base",
      "@fox-harness/dsh-core",
      "@fox-harness/dsh-agent-driver",
      "@fox-harness/dsh-flow-data-analysis",
      "@fox-harness/dsh-transport",
      "@fox-harness/dsh-llm-openai-compat",
      "@fox-harness/dsh-tool-serper-web-search",
      "@fox-harness/dsh-tool-create-skill"
    ]
    ```
    `template/cordis.patch.yml` copy nguyên overlay mặc định (Serper +
    system-prompt), chỉ đổi `persona` thêm tiền tố `[data-analysis flow]` —
    marker thứ 2, độc lập với marker log của plugin, để test dễ xác nhận
    bằng mắt qua UI mà không cần xem log server.

12. **Workspace wiring** — root `package.json`'s `dependencies`: thêm
    `@fox-harness/dsh-flow-data-analysis: workspace:*` (hoist vào
    `/repo/node_modules/@fox-harness`, giống `dsh-agent-driver`).
    `services/orchestrator/package.json`'s `dependencies`: thêm
    `@fox-harness/profile-template-data-analysis: workspace:*` (giống entry
    `profile-template` đã có).

13. **Frontend** — ĐÃ LÀM: `apps/web/src/App.tsx`'s `connect()` nhận thêm
    tham số `flow?: string`, append `&flow=${flow}` cạnh `modelParam` hiện
    có (cùng guard `sessionPath === "new"`). `startNewSession(flow?: string)`
    forward xuống `connect()`; guard "no-op nếu chưa chat" chỉ áp dụng khi
    KHÔNG truyền flow (truyền flow tường minh luôn mở session mới, kể cả từ
    1 session default rỗng). Thêm `MenuItem` "Phân tích dữ liệu"
    (`apps/web/src/components/features/sidebar/Sidebar.tsx`, dưới nút "Kỹ
    năng", icon `BarChart3`/`DataAnalysisIcon`) gọi
    `startNewSession('data-analysis')`. i18n key `sidebar.dataAnalysis`
    (vi/en). CSS `.fh-sidebar-data-analysis*` copy pattern của
    `.fh-sidebar-skills*` (kể cả rail mode thu gọn).

## Verification

- `pnpm install` (pick up 2 package mới) rồi `pnpm run typecheck` — **đã
  chạy, pass sạch**
- Build lại worker image:
  `docker build -f infra/docker/worker/Dockerfile -t fox-harness-worker:dev .`
- **Xoá warm pool cũ sau khi build image mới** (giống lưu ý ở
  `docs/skill-transfer-changes.md` mục "Lưu ý khi triển khai"): container
  trong `fh:warmpool` được dựng từ image cũ, không tự có bundle mới — xoá
  container + `DEL fh:warmpool` trên Redis rồi bật lại orchestrator
- Chạy migration DB dev — **cập nhật 2026-09-14**: `002`/`003`/`004` đã gộp
  lại vào `infra/migrations/001_init.sql` (xem README trong thư mục đó);
  DB dev đã chạy đủ trước khi gộp nên không cần chạy lại gì, chỉ fresh DB
  mới cần `001_init.sql` (đã có sẵn cột `flow`)
- Chạy gateway + orchestrator local, mở FE:
  - Click "New chat" (flow mặc định) → xác nhận hành vi y hệt hiện tại
    (regression check — profile dir vẫn `profiles/fox-harness`, KHÔNG thấy
    marker `[data-analysis flow]` hay log `fox-harness-flow-data-analysis`)
  - Click "Phân tích dữ liệu" → xác nhận container mới boot với
    `profiles/fox-harness-data-analysis/`; persona hiện tiền tố
    `[data-analysis flow]`; log orchestrator/worker thấy dòng
    `fox-harness-flow-data-analysis/pre-step` mỗi step — 2 marker độc lập
    xác nhận đúng plugin đã load, không rơi về flow mặc định
  - Kill container của session data-analysis rồi reconnect (rehydrate) →
    xác nhận quay lại đúng flow/profile cũ (vẫn thấy marker), không rơi về
    default
  - Restart orchestrator để warm pool nạp lại → xác nhận pool member vẫn
    chỉ thuộc flow `default`, request flow `data-analysis` không bao giờ
    claim nhầm pool
