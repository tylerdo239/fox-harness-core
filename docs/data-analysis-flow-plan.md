# Plan: thêm flow "Phân tích dữ liệu" với loop riêng

> Status: chỉ là plan, chưa implement gì. Ghi lại để làm sau.

## Context

Hiện tại toàn bộ hệ thống chỉ có 1 profile (`fox-harness`) và 1 agent loop
(`@fox-harness/dsh-agent-driver`, packages/agent-driver) — mọi session dùng
chung. Người dùng muốn thêm 1 nút trên UI ("Phân tích dữ liệu") mở ra 1 flow
chat mới, chạy trên **1 agent loop thực sự khác** (turn/step state machine
riêng, không phải chỉ đổi system prompt/tool set trên loop hiện tại — đã
xác nhận rõ với người dùng, không phải chỉ đổi profile).

Kiến trúc hiện tại cho phép việc này: mỗi session = 1 container Docker = 1
process `dsh` riêng, và `ctx.agents.setFactory()` chỉ giới hạn 1 factory
**trong 1 process** — không phải giới hạn toàn hệ thống. Vì 2 session luôn
chạy trên 2 container độc lập, 2 loop khác nhau có thể chạy song song, miễn
là mỗi container được materialize đúng profile/bundle của loop đó.

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

2. **DB** — file migration mới `infra/migrations/002_add_flow_column.sql`
   (theo README: không sửa `001_init.sql`):
   `alter table sessions add column flow varchar(64) not null default 'default';`
   `services/gateway/src/db.ts`'s `createSession()` nhận thêm tham số `flow`.

3. **`services/gateway/src/index.ts`** (upgrade handler, cạnh dòng đọc
   `model` ~L548) — đọc `flow` từ query, truyền vào `ensureSession()` (chỉ
   khi `isNew`, giống `model`) và vào `createSession()`.
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

10. **Package loop mới** `packages/agent-driver-data-analysis/` — scaffold
    y hệt cấu trúc `packages/agent-driver/`:
    - `package.json`: name `@fox-harness/dsh-agent-driver-data-analysis`,
      cùng shape `dsh.bundle.patch`/`exports`
    - `cordis.patch.yml`: disable row `agent-loop` gốc, insert row id khác
      (vd `fox-harness-agent-loop-data-analysis`) trỏ tới package này
    - `src/index.ts` / `factory.ts` / `agent.ts`: bắt đầu là bản copy của
      `FoxHarnessAgentLoop`/`FoxHarnessAgent` (đổi tên class) — mục tiêu của
      plan này là dựng xong đường dây loop thứ 2 chạy độc lập; phân kỳ hành
      vi turn/step thật sự cho phân tích dữ liệu là việc làm tiếp theo sau
      khi khung này chạy được.

11. **Profile template mới** `packages/profile-template-data-analysis/`
    (copy `packages/profile-template/`): `template/profile.package.json`'s
    `bundles` đổi `@fox-harness/dsh-agent-driver` thành
    `@fox-harness/dsh-agent-driver-data-analysis`; `template/cordis.patch.yml`
    copy nguyên, chỉnh persona sau.

12. **Workspace wiring** — root `package.json`'s `dependencies`: thêm
    `@fox-harness/dsh-agent-driver-data-analysis: workspace:*` (cái này được
    hoist vào `/repo/node_modules/@fox-harness` — chỗ entrypoint.sh symlink
    vào, giống entry `dsh-agent-driver` đã có).
    `services/orchestrator/package.json`'s `dependencies`: thêm
    `@fox-harness/profile-template-data-analysis: workspace:*` (giống entry
    `profile-template` đã có).

13. **Frontend** `apps/web/src/App.tsx` — thêm khái niệm `flow` giống
    `selectedModel`: `startNewSession(flow: string = 'default')`, append
    `&flow=${flow}` trong `connect()` cạnh `modelParam` hiện có (cùng guard
    `sessionPath === "new"`). Thêm 1 nút "Phân tích dữ liệu" cạnh nút "New
    chat" (`onNewSession`), gọi `startNewSession('data-analysis')`. Vị trí/
    UI chi tiết của nút sẽ chốt sau khi đường dây chạy được, không phải
    trọng tâm plan này.

## Verification

- `pnpm install` (pick up 2 package mới) rồi `pnpm run typecheck`
- Build lại worker image:
  `docker build -f infra/docker/worker/Dockerfile -t fox-harness-worker:dev .`
- Chạy migration `002_add_flow_column.sql` trên DB dev
- Chạy gateway + orchestrator local, mở FE:
  - Click "New chat" (flow mặc định) → xác nhận hành vi y hệt hiện tại
    (regression check — profile dir vẫn `profiles/fox-harness`)
  - Click "Phân tích dữ liệu" → xác nhận container mới boot với
    `profiles/fox-harness-data-analysis/`, `cordis.patch.yml` riêng active,
    và 1 turn chat thật sự đi qua loop mới (thêm tạm 1 log/persona khác biệt
    để xác nhận trực quan đúng là loop thứ 2, không phải loop mặc định)
  - Kill container của session data-analysis rồi reconnect (rehydrate) →
    xác nhận quay lại đúng flow/profile cũ, không rơi về default
  - Restart orchestrator để warm pool nạp lại → xác nhận pool member vẫn
    chỉ thuộc flow `default`, request flow `data-analysis` không bao giờ
    claim nhầm pool
