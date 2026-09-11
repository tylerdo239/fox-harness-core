# Quy tắc code — Agent Platform trên DeepSeek Harness

Tài liệu này là phần "luật" đi kèm `docs/agent-core-architecture-roadmap.md`. Roadmap giải thích *tại sao*; tài liệu này quy ra *làm thế nào* — quy tắc cụ thể để áp dụng khi viết code trong repo này. Đọc roadmap trước, tài liệu này không lặp lại lý do kiến trúc, chỉ lặp lại kết luận thành rule kiểm tra được.

**Nguồn xác minh:** các mục có ghi "đã verify" đã được đối chiếu trực tiếp với source code `deepseek-ai/deepseek-harness` (đọc file thật, không suy đoán từ mô tả). Mốc đối chiếu: repo HEAD lúc viết tài liệu này có `package.json` version `0.1.2-alpha.5`; bản đã publish lên npm dùng để cài là `@deepseek-ai/dsh@0.1.1-rc.2`, `@deepseek-ai/dsh-agent@0.1.0-rc.6`, `@deepseek-ai/cordis@4.0.2`. HEAD của git đi trước bản publish trên npm — nghĩa là khi `pnpm add @deepseek-ai/dsh`, ta nhận bản `0.1.1-rc.2`, có thể lệch nhẹ so với các chi tiết đã đọc từ HEAD.

---

## 0. Bốn chỗ roadmap gốc chưa khớp source thật — sửa trước khi code

1. **"9 component" không tồn tại trong source — con số thật là 135.** Đã chạy thật `dsh --profile web --dump-config` (cài `@deepseek-ai/dsh@0.1.1-rc.2` thật, 2026-09-03): profile `web` (`dsh-base` + `dsh-web-app`) compose đúng **135 row**. Toàn bộ output đã lưu tại `docs/reference/dsh-web-profile-dump-config.yml` — dùng file đó để lọc component thật cho Phase 0 mục 1, không phải đoán lại.
2. **Field khai báo phần client trong `package.json` là `dsh.client`, và nó là một OBJECT chứ không phải string path.** Đã verify bằng cách soi trực tiếp `package.json` thật của `@deepseek-ai/dsh-client-ui-theme@0.1.1-rc.2` (row `id: ui-theme` trong dump-config trên) — shape thật:
   ```json
   "dsh": {
     "client": {
       "inject": ["@deepseek-ai/dsh-client-connection", "@deepseek-ai/dsh-client-runtime", "..."],
       "platform": "web",
       "immediately": true
     }
   }
   ```
   `inject` liệt kê service khác mà client plugin cần trước khi chạy; `platform` chốt môi trường (`"web"`); `immediately` là có mount ngay lúc load hay chờ trigger. Package export thêm entry `"./client"` riêng trỏ vào bundle client (`lib/client.js` phía upstream — họ dùng tsdown ra 1 file; ta dùng `tsc` nên trỏ `lib/client/index.js`, không sao, chỉ cần khai đúng `exports["./client"]`). Roadmap gốc viết `dshClient` (string) — sai cả tên field lẫn kiểu dữ liệu.
3. **`docs/api-gateway.md` phía upstream nói về Typert — RPC nội bộ giữa Host và Client cùng một process (`@Remote`/`@RemoteScope`, layer `remotes → gateway → connection → webserver`) — không phải control-plane gateway multi-tenant.** Session-event stream, phân trang, và các stream protocol khác **nằm ngoài phạm vi Typert Remote theo đúng tài liệu đó** ("must not masquerade as Remote methods"). Gateway của chúng ta (auth, routing nhiều worker, streaming fan-out nhiều user) là code hoàn toàn mới, không kế thừa hay wrap Typert. Cái có thể tái dùng nhiều nhất là `Connection`/session-event transport nằm dưới `dsh-web-app`, không phải bản thân Typert object model. Tránh đặt tên gateway của mình dính tới "Typert" để khỏi nhầm với `@deepseek-ai/dsh-api-gateway`.
4. **Profile không phải npm package mà dsh tự phát hiện qua `node_modules` như bundle.** Type thật (`packages/boot/app-boot/src/profile.ts` phía upstream): `interface DshProfileManifest { bundles?: string[]; patchReload?: 'live' | 'startup' }`. Profile được **materialize lúc runtime** thành thư mục thật `$DSH_HOME/profiles/<name>/package.json` (field `dsh.profile.bundles` + `patchReload`), sinh từ một map template cứng trong code (`PROFILE_TEMPLATES`) hoặc từ default `['@deepseek-ai/dsh-base']` nếu tên profile không khớp template có sẵn. "Package profile" của chúng ta trong `packages/profile-template` chỉ là **bản mẫu** mà script init/orchestrator copy vào đúng chỗ lúc deploy hoặc first-boot — không phải thứ dsh tự tìm thấy qua workspace resolution.

   **Sửa lại (2026-09-09, đối chiếu lại thật với npm install hiện tại, không phải git HEAD):** `node_modules/@deepseek-ai/dsh-app-boot/lib/types/profile.d.ts`'s `DshProfileManifest` hiện chỉ có `{ bundles?: string[] }` — **không có field `patchReload` nào cả**. Đây không hẳn là research sai lúc đó — chính preamble đầu file này đã cảnh báo trước: bản đọc source lúc viết mục này là git HEAD (`0.1.2-alpha.5`), còn bản `pnpm add` thật cài về là bản npm đã publish (`0.1.1-rc.2`, cũ hơn HEAD) — "có thể lệch nhẹ so với các chi tiết đã đọc từ HEAD", đúng y hệt điều đã xảy ra ở field này. `packages/profile-template/template/profile.package.json` đã bỏ field `patchReload` (vô hại, dsh vốn bỏ qua field lạ, nhưng gây hiểu nhầm nếu đọc mà tin có tác dụng thật) — xem `packages/profile-template/README.md`.

---

## 1. Ranh giới thư mục

Theo đúng roadmap §1.4: monorepo pnpm workspace. **Cập nhật 2026-09-03** (theo yêu cầu người dùng — repo lúc đầu chỉ có single-package, giờ đã sprawl): layout mặc định là phẳng `packages/<name>`, nhưng khi một *nhóm* có nhiều hơn 1 package (ví dụ `llm` — nhiều adapter provider khác nhau) thì gộp thành `packages/<group>/<pkg>` hai cấp, đúng convention của chính upstream (đã note trong `docs/code-rules.md` §0 trước đây là "đơn giản hoá có chủ đích", giờ áp dụng lại đúng bản gốc khi cần). `pnpm-workspace.yaml` khai cả hai glob (`packages/*` và `packages/*/*`) nên không cần sửa lại mỗi lần thêm nhóm mới. Package đơn lẻ, chưa có anh em cùng nhóm (`core`, `agent-driver`, `transport`, `client-ui-theme`, `contracts`, `profile-template`) **giữ nguyên phẳng** — không tự ý gom nhóm khi chỉ có 1 package, chờ tới khi thật sự có ≥2 package cùng category.

```
packages/     → publish lên registry nội bộ (hoặc ít nhất build/versioned độc lập)
services/     → build ra container, KHÔNG publish
apps/         → FE bundle tĩnh
infra/        → docker, deploy, migrations
docs/
```

**Luật cứng:** `services/*` chỉ được import từ `packages/contracts`. Nếu thấy `services/gateway` import trực tiếp từ `packages/core` hay bất kỳ package `dsh-*` nào khác — dừng lại, đó là rơi tầng. Gateway/orchestrator/plugin-registry không được biết nội tại của bundle, chỉ biết type dùng chung.

Package nào là plugin ăn vào cây Cordis thì có tiền tố `dsh-` trong tên npm (`@fox-harness/dsh-core`, `@fox-harness/dsh-agent-driver`, ...). Package nào không phải plugin (type dùng chung, template) thì không có tiền tố đó (`@fox-harness/contracts`, `@fox-harness/profile-template`) — nhìn tên là biết cái nào compose được vào cây plugin.

---

## 2. `package.json` bắt buộc cho mỗi package trong `packages/`

- `"private": true`, version khớp version ở root.
- `"type": "module"` — ESM toàn repo, không CommonJS.
- Import nội bộ dùng specifier `.ts` tường minh trong source (`import { x } from './y.ts'`), compiler rewrite sang `.js` lúc build. Đây là convention thật của upstream (`AGENTS.md`), giữ theo để đọc chéo code hai bên không phải đổi ngữ cảnh liên tục.
- `main` → `lib/index.js`, `types` → `lib/types/index.d.ts`, `exports["."]` khớp hai field trên, `files` chỉ liệt kê artifact đã build (`lib/**`), **không bao giờ liệt kê `src`**.
- Package nào đóng góp config row (bundle) thì thêm:
  ```json
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
  ```
  Đây là toàn bộ shape thật — không có field nào khác (đã verify qua type `DshBundleManifest { patch: string }` phía upstream, đơn giản hơn những gì bản roadmap gốc gợi ý).
- Package nào có phần chạy trong browser thì thêm field `dsh.client` dạng object (`{ platform, immediately, inject? }`, đã verify §0.2) + entry `exports["./client"]` trỏ vào file client build ra.
- `@deepseek-ai/cordis` luôn khai cả trong `peerDependencies` **và** `devDependencies`, cùng version range — convention thật, không phải tuỳ chọn.

---

## 3. Effect & event — quy tắc lõi khi viết driver

- Mọi đăng ký (route, tool, listener, service...) đi qua `ctx.effect()` / `ctx.on()` và trả về disposer. Không side-effect nằm ngoài effect system — nếu có, hibernate/dispose sẽ để lại rác không dọn được.
- Waterfall listener (`agent/pre-step`, `agent/request`, `llm/stream`, `tools/pre-execute`, `tools/execute`, `tools/post-execute`) **phải gọi `next()`**, kể cả khi không làm gì thêm. Quên gọi `next()` là treo turn, không lỗi rõ ràng.
- `agent/turn-stopping` là **serial**, không có `next()` — đừng viết nó theo pattern waterfall.
- Bất cứ nội dung nào model nhìn thấy phải có event durable ghi log tương ứng (nguyên tắc 0.4 của roadmap). Thêm context cho model mà không ghi log là bug nguy hiểm nhất trong toàn hệ thống: không crash ngay, chỉ âm thầm sai dữ liệu khi hibernate/rehydrate.
- Event thật, đã verify khớp 100% với `docs/architecture.md` phía upstream (không phải diễn giải lại):
  - **Durable** (persist vào session log): `turn/*`, `step/*`, `user/message`, `assistant/*`, `tool/*`.
  - **Waterfall** (bắt buộc `next()`): `agent/pre-step`, `agent/request`, `llm/stream`, `tools/pre-execute`, `tools/execute`, `tools/post-execute`.
  - **Serial** (không `next()`): `agent/turn-stopping`.
- Driver bắt buộc implement các method thật trên runtime handle: `followup(message: UserMessage): void`, `steer(message: UserMessage): void`, và `inject(message: UserMessage): void` (context không đánh thức driver) — cả ba đã verify trực tiếp bằng cách `pnpm install @deepseek-ai/dsh-agent@0.1.0-rc.6` thật và đọc `lib/types/runtime-types.d.ts` (không chỉ đọc mô tả). Handle còn có `send()`, `cancel()`, `whenIdle()`, `runMaintenance()`, `status`, `ctx` — kiểm tra `core/agent-loop` thật (chưa cài được ở pass này) để biết driver cần cover tới đâu trong số đó. FE gọi thẳng qua đúng tên `followup`/`steer`.
- Không sửa `core/agent-loop` của upstream. Viết package driver riêng, patch row `core/agent-loop` trỏ sang plugin của mình (nấc 2 theo roadmap §0.2). Nếu thấy mình bắt buộc phải sửa file trong `packages/` của upstream để làm việc này — dừng lại, đó là dấu hiệu cần nấc 3 (vendor), không phải nấc 2, và cần bàn lại trước khi tiếp tục.

---

## 4. Bundle / patch / profile — cách ghép đúng

- `cordis.patch.yml` là danh sách operation; operation thấy trong source thật là `insert:` — mảng row `{ id, name, config?, disabled? }`. **Patch thay toàn bộ `config` của row theo `id`, không merge từng field.** Muốn đổi 1 field của row có sẵn vẫn phải chép lại nguyên `config` của row đó rồi sửa field cần đổi.
- Thứ tự áp dụng layer: từng bundle theo đúng thứ tự khai báo trong profile → `cordis.patch.yml` của profile → patch ở home → `--patch` overlay dòng lệnh.
- Profile của chúng ta **không** ship như npm package để dsh tự tìm qua `node_modules` (xem §0.4). Script init (Phase 1) hoặc orchestrator (Phase 3) phải tự ghi `$DSH_HOME/profiles/<tên>/package.json` với `dsh.profile.bundles` liệt kê đúng thứ tự bundle. **Sửa lại 2026-09-09** (xem §0.4 mục 4's correction): KHÔNG cần ghi `patchReload` — field này không tồn tại thật trong bản dsh đang cài (`dsh-app-boot@0.1.1-rc.2`), bỏ qua hoàn toàn không sao.
- **Đã xoá (Phase 16, 2026-09-08):** patch theo-user do `plugin-registry` sinh — service đó không còn tồn tại. Toàn bộ năng lực giờ cố định trong `packages/profile-template/template/profile.package.json`'s `bundles`, commit vào git bình thường như mọi package khác — không còn tầng data-plane patch nào riêng theo user/session nữa.

---

## 5. Toolchain

- Node: theo đúng engine mà `@deepseek-ai/dsh` yêu cầu — `^22.19.0 || >=24.0.0`. **Kiểm tra ngay:** nếu môi trường dev đang dùng Node thấp hơn (ví dụ Node 21 qua nvm), `pnpm add @deepseek-ai/dsh` sẽ cài được nhưng chạy CLI có thể lỗi hoặc bị cảnh báo engine — nâng Node trước khi thử chạy `dsh` thật, đừng debug lỗi lạ trước khi kiểm tra version Node.
- Package manager: `pnpm`, pin version cụ thể trong `packageManager` ở root `package.json` (giống cách upstream tự pin) để tránh trôi hành vi giữa các máy.
- `"type": "module"` toàn repo.
- TypeScript project references: `tsconfig.base.json` ở root, mỗi package có `tsconfig.json` riêng `extends` từ đó. Không dùng bundler làm type-check ngầm định.
- pnpm 10+ chặn install script mặc định. Nếu một dependency transitive của `dsh-base` cần build native (`esbuild`, `node-pty`, ...), phải thêm vào `pnpm.allowBuilds` trong `pnpm-workspace.yaml` — nếu không, postinstall âm thầm không chạy và lỗi chỉ lộ ra trễ, rất khó truy nguồn.

---

## 6. Kiểm tra bắt buộc trước khi coi 1 phase là "xong"

Cụ thể hoá tiêu chí hoàn thành ở §3 roadmap thành test có thể chạy:

| Phase | Test bắt buộc | Fail nghĩa là gì |
|---|---|---|
| 1 | Chạy song song driver mặc định và driver riêng trên cùng bộ prompt, diff session log | Driver bỏ sót event durable |
| 2 | Reload trang giữa lúc model đang stream | Chunk chỉ tới browser mà chưa ghi log trước |
| 3 | `kill -9` container giữa session (không phải shutdown sạch), rehydrate ở node khác | State đã rò ra ngoài log |
| 4 | Hai user bật bộ plugin khác nhau, thấy hai UI khác nhau từ cùng một FE bundle | Manifest hardcode thay vì sinh theo cây plugin instance thật |
| 5 | Bật/tắt plugin trên UI, hiệu lực ngay, không restart, không rác DOM | Client plugin không đảo ngược DOM mutation lúc Cordis dispose |

Không bỏ qua các test này để "xong sớm" — đây chính là tiêu chí hoàn thành phase theo roadmap, không phải việc nên-làm-thêm.

---

## 7. Ranh giới bảo mật / multi-tenant — không thương lượng

- Harness worker **không bao giờ** nhận hay biết `userId`. Logic nào cần biết "user X" để quyết định hành vi khác đi thì logic đó thuộc control plane — chuyển nó ra `services/`, không để rơi vào `packages/`.
- Không cho worker tự `git clone` lúc runtime để cài plugin. Plugin được build/verify ở `plugin-registry`; worker chỉ nhận artifact + patch đã duyệt.
- Custom element (roadmap §1.5) chỉ mở cho plugin first-party hoặc đã qua review. Plugin chưa duyệt chỉ được dùng contract khai báo (`type` + data, tra renderer đã compile sẵn).
- Nếu plugin user được phép chạy code tuỳ ý (câu hỏi mở #2 của roadmap chưa có đáp án), mỗi user phải có container/microVM riêng. Không bao giờ để nhiều user chạy plugin tuỳ ý chung một process.
- **(Phase 11)** `client.js` của plugin không được tự nhúng React/ReactDOM dù có khai báo `dsh.client.external` hay không — verify NỘI DUNG bundle thật (`services/plugin-registry/src/client-wrap.ts`'s `looksLikeRealReactIsBundled`), không chỉ tin field khai báo. Dự án này không có "build-time bundle purity gate" như dsh thật để bắt lỗi này từ phía tác giả plugin (docs/code-rules.md §24) — verify ở registry là lớp phòng vệ duy nhất.

---

## 8. Kỷ luật thay đổi

- Fork mỏng (roadmap §0.3): chỉ sửa `packages/` của upstream khi thật sự bắt buộc. Khi buộc phải sửa, ghi lại lý do + phạm vi thay đổi ở đầu README của package liên quan, để lần nâng cấp upstream sau biết chỗ nào cần merge tay.
- Pin version mọi package `@deepseek-ai/*`, không dùng `^`/`latest`. Nâng version là hành động có chủ đích, kèm chạy lại đúng hàng test ở §6 cho phase chạm tới seam bị đổi.
- Không commit `cordis.patch.yml` theo-user vào git — đó là data sinh runtime, thuộc DB/log store.

---

## 9. Đã xác minh bằng cài đặt thật (2026-09-03)

Toàn bộ 3 điểm còn treo ở bản trước của tài liệu này giờ đã verify bằng cách cài `@deepseek-ai/dsh@0.1.1-rc.2` thật (npm registry, Node 22.23.2, DSH_HOME cô lập trong scratch) và chạy `dsh --profile web --dump-config` thật:

1. ~~Field `dsh.client`~~ → verify xong, xem §0.2. Shape thật là object, không phải string.
2. ~~Row `id` thật của driver~~ → là `agent-loop` (không có tiền tố `core/`), config mặc định `{ agents: [] }`. Xem `packages/agent-driver/cordis.patch.yml`.
3. ~~Danh sách component/row thật~~ → 135 row, lưu đầy đủ tại `docs/reference/dsh-web-profile-dump-config.yml`.

Verify thêm ngoài 3 điểm trên: `@deepseek-ai/dsh-agent@0.1.0-rc.6` cài sạch qua `pnpm install` thật; `followup()`/`steer()`/`inject()` đúng như `runtime-types.d.ts` thật (§3). Repo này tự build sạch (`pnpm run typecheck`).

**Còn lại, chưa làm** (không phải fact-finding nữa mà là quyết định thiết kế + việc code thật):

- Lọc 135 row trong `docs/reference/dsh-web-profile-dump-config.yml` thành danh sách component *của riêng sản phẩm* cần viết — đây là việc con người quyết, không tự suy ra được từ dump-config.
- Cài thật `@deepseek-ai/dsh-web-app` như dependency của `packages/client-ui-theme` (hiện chỉ đang mô phỏng theo ví dụ đọc từ scratch install ngoài repo) nếu muốn build thử client thật.
- Toàn bộ phần code còn lại của Phase 1 (turn/step state machine trong `agent-driver`, transport thật, v.v.) — không phải việc "xác minh", là việc "viết".

---

## 10. Boot local thật — đã chạy được, và 4 pitfall thật gặp phải (2026-09-03)

Đã dựng và boot thành công một profile `fox-harness` thật ở `~/.dsh/profiles/fox-harness`, layer `dsh-base` + `dsh-web-app` + `@fox-harness/dsh-core` + `@fox-harness/dsh-transport` + `@fox-harness/dsh-client-ui-theme` (**không** gồm `dsh-agent-driver` — lý do ở cuối mục này). Kết quả: `curl http://127.0.0.1:3099/` trả về `HTTP 200`, HTML thật với `<title>DeepSeek Harness</title>`. Bốn lỗi thật đã gặp và cách sửa, theo đúng thứ tự gặp:

1. **`cordis.patch.yml` top-level phải là YAML array, không phải mapping có key `insert:`.** Bản đầu viết `insert:\n  - id: ...` (mapping) — dsh từ chối thẳng với lỗi "must be a top-level YAML array of loader patch entries". Đúng phải là `- insert:\n    - id: ...` (array chứa 1 operation object). Xem file thật `node_modules/@deepseek-ai/dsh-base/cordis.patch.yml` để đối chiếu bất cứ khi nào nghi ngờ shape.
2. **`name` trong mỗi row phải là package specifier import được thật, không phải một cái nhãn tuỳ ý.** Bản đầu đặt `name: fox-harness-core` (trùng `id`) — qua được `--dump-config` (lệnh này không import gì cả) nhưng boot thật báo `Cannot find package 'fox-harness-core'`, vì loader chạy `import(name)`. Phải là `name: '@fox-harness/dsh-core'`.
3. **Loader resolve module tương đối theo *chính nó* (`@deepseek-ai/dsh` cài ở đâu), không phải theo thư mục profile.** pnpm strict/symlink mặc định ẩn transitive dependency (`@deepseek-ai/dsh-llm` — dep của `dsh-base`) khỏi `import()` gọi từ `cordis-plugin-loader`. `--dump-config` vẫn chạy được (không import), nhưng boot thật báo `Cannot find package '@deepseek-ai/dsh-llm'`. Fix: `nodeLinker: hoisted` ở **`pnpm-workspace.yaml` gốc của repo này** (không chỉ ở profile — dsh tự sinh `hoisted` cho profile, nhưng đó không đủ, vì loader chạy từ node_modules của repo, không phải của profile).
4. **Vì lý do #3, package của chính mình (`@fox-harness/dsh-core`...) cũng phải được hoist vào node_modules gốc của repo — nghĩa là phải khai chúng làm `dependencies` thật ở root `package.json`** (`"@fox-harness/dsh-core": "workspace:*"`, v.v.), không chỉ để chúng nằm trong `packages/`. Chỉ link chúng vào profile bằng `dsh plugin --profile fox-harness add @fox-harness/dsh-core@link:<path>` là **không đủ** — `link:` trong profile giúp `dsh.profile.bundles` liệt kê đúng, nhưng không giúp loader (chạy từ node_modules của repo) tìm ra package.
5. **Version Node sai âm thầm tạo lỗi khó hiểu, không phải lỗi "version không đủ".** Quên `nvm use` (mặc định máy là Node 21, `.nvmrc` ghim 22.23.2) khiến boot thật fail với `Promise.withResolvers is not a function`, `node:zlib` thiếu `createZstdDecompress`, `node:module` thiếu `stripTypeScriptTypes` — toàn bộ là API Node 22+, không liên quan gì tới cordis/dsh. **Luôn `nvm use` (hoặc tương đương) trước khi chạy `dsh` trực tiếp**, không chỉ trước `pnpm install`.

**Vì sao `agent-driver` bị loại khỏi lần boot smoke-test này:** patch của nó thay row `agent-loop` bằng `apply(ctx) {}` rỗng — nếu load, agent sẽ không còn driver nào xử lý turn, chat sẽ treo/lỗi ngay khi gửi tin nhắn đầu tiên. Chỉ thêm `@fox-harness/dsh-agent-driver` vào profile sau khi state machine turn/step thật đã được viết (Phase 1, §3).

**Recipe boot local đầy đủ** (đã chạy thật, dùng lại được):

```bash
nvm use                                    # .nvmrc → 22.23.2, bắt buộc trước khi chạy dsh
pnpm install                                # nodeLinker: hoisted đã set ở pnpm-workspace.yaml
pnpm run build                              # lib/ cho packages/* phải tồn tại trước khi profile link tới

node_modules/.bin/dsh plugin --profile fox-harness add @deepseek-ai/dsh-web-app@0.1.1-rc.2
node_modules/.bin/dsh plugin --profile fox-harness add "@fox-harness/dsh-core@link:$(pwd)/packages/core"
node_modules/.bin/dsh plugin --profile fox-harness add "@fox-harness/dsh-transport@link:$(pwd)/packages/transport"
node_modules/.bin/dsh plugin --profile fox-harness add "@fox-harness/dsh-client-ui-theme@link:$(pwd)/packages/client-ui-theme"
# KHÔNG add dsh-agent-driver cho tới khi state machine turn/step viết xong.

node_modules/.bin/dsh --profile fox-harness --dump-config   # 138 row = 135 upstream + 3 của mình
node_modules/.bin/dsh --profile fox-harness --no-open --port 3099
```

**Chưa test được** (thiếu credential, không phải lỗi code): chat thật với model — máy này chưa có `DEEPSEEK_API_KEY`/credential nào. Server boot và serve UI được, nhưng gửi tin nhắn sẽ fail ở bước gọi LLM cho tới khi có credential thật.

---

## 11. Viết driver thật (Phase 1) — 4 bug thật nữa khi swap `agent-loop` (2026-09-03)

Sau khi viết state machine turn/step thật cho `packages/agent-driver` (đọc source thật của `@deepseek-ai/dsh-agent-loop`, không đoán — xem `packages/agent-driver/README.md`) và thử swap nó vào profile `fox-harness` thật, gặp thêm 4 lỗi thật trước khi boot sạch:

1. **`insert:` chỉ dùng để thêm row có `id` CHƯA tồn tại.** Dùng `insert:` cho `id: agent-loop` (đã tồn tại từ `dsh-base`) ra lỗi cứng `duplicate loader entry id: agent-loop`. Patch nhắm vào row đã tồn tại phải là entry KHÔNG có `insert:`, chỉ có `id` + field cần đổi trực tiếp (`name`/`config`/`disabled`) — xác nhận qua type thật `PatchOptions` của `@deepseek-ai/cordis-plugin-include`.
2. **Patch theo `id` không cho đổi `name` sang plugin khác.** Applier thật check `name` khớp row cũ trước khi áp dụng patch, không khớp thì in cảnh báo `"name mismatch... skipping"` và **bỏ qua âm thầm** (exit code vẫn 0!) — nghĩa là driver cũ vẫn chạy mà không có lỗi nào báo. Cách đúng để "nấc 2" (roadmap §0.2): **disable row gốc** (giữ nguyên `name` cũ để qua check) + **insert row mới với `id` khác** chạy plugin của mình. Factory chỉ có 1 slot (`ctx.agents.setFactory` throw nếu đã có người đăng ký) nên disable xong là driver mặc định không tự nhận slot nữa.
3. **Plugin Cordis (kể cả hàm `apply()` thường, không phải `class extends Service`) vẫn cần khai `inject` để đụng vào service có tên.** Thiếu `export const inject = ['agents']` ra lỗi `cannot get property "agents" without inject` ngay khi `apply()` chạm `ctx.agents`.
4. **Thêm `rewriteRelativeImportExtensions`/`allowImportingTsExtensions` vào `tsconfig.base.json` không tự invalidate `.tsbuildinfo` cũ.** `pnpm run build` báo "thành công" nhưng file `.js` biên dịch trước đó vẫn giữ nguyên `import './factory.ts'` (sai với runtime ESM), gây `ERR_MODULE_NOT_FOUND` lúc boot. Phải xoá `.tsbuildinfo` + `lib/` rồi build sạch lại khi đổi compiler option ảnh hưởng tới output emit.

**Kết quả cuối:** `dsh --profile fox-harness` boot sạch với driver thật của mình thay `agent-loop`, `curl` trả `HTTP 200`. Chưa test được một lượt chat thật (thiếu `DEEPSEEK_API_KEY`) — driver có chạy đúng logic model-call/tool-loop hay không vẫn cần verify bằng credential thật.

---

## 12. Chat thật đầu tiên chạy qua đúng driver + adapter của mình (2026-09-03)

User cung cấp credential thật cho 1 model self-host (endpoint OpenAI-compatible, qua proxy riêng). Thay vì browser (user từ chối cài Claude-in-Chrome), verify bằng 2 cách:

**A. Test độc lập `serialize.ts`/`sse.ts`/`translate.ts`** (gọi thẳng, không qua Cordis) — thành công 100%: model trả lời thật, `translate()` nhận đúng 2 loại block (`reasoning` rồi `text`) trong 1 response, `usage`/`finish` đúng shape.

**B. Test qua `dsh --profile <name>-headless "câu hỏi"`** — CLI one-shot, không cần browser (`dsh --profile headless` là app bundle riêng của upstream, tách biệt `dsh-web-app`). Đây là cách **scriptable** để test full integration mà không cần tương tác UI. Trên đường tới lượt chat thật đầu tiên, gặp thêm 2 bug thật:

1. **`ownerCtx` (context bên GỌI `AgentFactory.createAgent()`) KHÔNG cùng với `ctx` của chính plugin mình, và không chắc có inject cần thiết.** `factory.ts` ban đầu gọi `ownerCtx.sessions.prepare(...)` — qua được lúc `--dump-config`/boot thường (vì chưa ai thực sự gọi `createAgent()`), nhưng lượt headless đầu tiên (lần ĐẦU TIÊN `createAgent()` thật sự chạy — boot web bình thường không bao giờ đụng path này nếu chưa có ai chat qua browser) báo `cannot get property "sessions" without inject`, dù `inject` của chính plugin **đã** liệt kê `sessions`. Cordis gate `inject` theo TỪNG ctx, không theo plugin — chỉ `this.ctx` (ctx của chính plugin, nơi `inject` thật sự áp dụng) mới chắc chắn có quyền. Fix: factory giữ lại `ctx` của chính nó (từ `apply(ctx)`), dùng `this.ctx` cho MỌI lời gọi service (`sessions.*`, `agents.*`, và gán làm `.ctx` của chính đối tượng Agent — vì `runStep()` sau này đọc `.systemPrompt`/`.llm`/`.tools` từ đó); `ownerCtx` chỉ còn dùng để lấy `ownerCtx.agent` (agent cha, cho việc sở hữu).
2. **Bỏ `core/agent-loop` thì mất luôn side-effect lúc khởi tạo của nó, không chỉ mất phần turn/step.** `dsh-agent-loop` thật tự đăng ký 3 biến prompt template (`provider`/`model`/`cwd`) qua `ctx.systemPrompt.variable(...)`. Thiếu 3 dòng này, persona thật của `system-prompt` (`"...powered by the {{model}} model..."`) ném lỗi `unknown prompt variable "{{model}}"` ngay khi assemble prompt lần đầu. Fix: `agent-driver`'s `index.ts` tự đăng ký lại đúng 3 biến đó.

**Kết quả:** log session thật (giải nén từ `session.jsonl.zstd`) cho thấy đúng toàn bộ chuỗi event thiết kế, và `assistant/message.source` = `{kind:'model', provider:'openai-compat', model:'<model thật>'}` — chứng minh cả chuỗi driver → waterfall `agent/request` → override của `dsh-core` → adapter → HTTP thật → model thật hoạt động cùng nhau, không chỉ từng phần typecheck riêng lẻ. Đây là bài test hoàn thành Phase 1 theo đúng nghĩa.

**Bài học chung rút ra:** một server boot sạch (`HTTP 200`) **không chứng minh** `createAgent()` từng chạy — nếu chưa ai thật sự tạo session (qua browser hoặc CLI one-shot), toàn bộ nhánh code đó chưa được thực thi lần nào, kể cả khi "boot thành công" nhiều lần liên tiếp. Muốn verify thật một driver, phải kích hoạt được đường tạo agent thật — `dsh --profile <name>-headless "..."` là cách rẻ nhất để làm việc đó mà không cần browser.

**Bonus phát hiện khi user hỏi "file env để ở đâu":** `dsh` CLI thật có sẵn cơ chế đọc `.env` tự động, không cần dotenv hay code của mình — xác nhận trong `packages/boot/app-boot/src/index.ts`'s `loadLayeredEnv()`: đọc `.env` ở **thư mục invoking** (nơi gọi lệnh `dsh`, layer "project-env") và `$DSH_HOME/.env` (layer "user-env", áp dụng toàn máy). Thứ tự ưu tiên: env kế thừa từ shell > `.env` project > `.env` user-home. Có danh sách `BOOTSTRAP_NAMES`/`BOOTSTRAP_PREFIXES` (PATH, DSH_*, GIT_*, NODE_OPTIONS...) **không được phép** set qua `.env` — set qua đó sẽ throw lúc boot; `OPENAI_API_KEY`/`OPENAI_BASE_URL`/`OPENAI_MODEL_ID` không nằm trong danh sách đó nên dùng `.env` bình thường được. Repo này giờ có `.env.example` (commit được) + `.env` (gitignore) ở root — verify thật: boot `dsh --profile fox-harness-headless "..."` KHÔNG prefix `VAR=...` thủ công, log session vẫn đúng `provider`/`model` như trong `.env`.

---

## 13. Tool thật đầu tiên: `dsh-tool-duckduckgo-web-search` — đóng nốt phần "tool hoạt động" của Phase 1 (2026-09-03)

*(Đổi tên cùng ngày từ `dsh-tool-duckduckgo-search`/`duckduckgo_search` sang tên rõ nghĩa hơn, và gom vào `packages/tool/` — nội dung dưới đây giữ nguyên diễn biến thật, chỉ cập nhật tên cho khớp hiện tại.)*

User yêu cầu thẳng: build 1 tool search web free (DuckDuckGo) thành plugin, và **dùng thật**. Đây chính là phần còn thiếu cuối cùng của tiêu chí Phase 1 ("tool hoạt động") — mọi lượt chat thật trước đó chỉ là text/reasoning đơn thuần, chưa từng có tool call nào.

**API đăng ký tool** (đọc source thật của `@deepseek-ai/dsh-tool-web`, không đoán): `ctx.tools.register(defineTool({ name, description, parameters, output: { schema, render }, execute(args, exec) {...} }))`. `execute()` trả về giá trị thô khớp `output.schema`, không tự construct `ToolExecutionResult`/`ContentBlock[]` — `output.render(args, value)` lo phần đó. `inject: ['tools', 'systemPrompt']` bắt buộc (đúng quy tắc §11 mục 3).

**3 bug thật gặp phải trước khi có kết quả search thật:**

1. **`session.append()` từ chối `undefined` tường minh, khác với `JSON.stringify`.** `{key: undefined}` KHÔNG giống bỏ hẳn key — dù field đó optional trong type. Lỗi thật: `session event "assistant/chunk" carries non-JSON-serializable data`, xảy ra ngay tool-call đầu tiên vì `translate.ts` set `name: toolCallDelta.function?.name` (hầu hết delta tool-call chỉ có `name` ở delta MỞ đầu, các delta sau `name` là `undefined`). Có **3 chỗ** dính lỗi này: `translate.ts`'s `tool-call-delta.name`, `agent.ts`'s `tool/result`'s `error`/`meta`, và `assistant/message`'s `usage`. Cả 3 sửa bằng cách spread object rỗng có điều kiện (`...(cond ? {key: value} : {})`) thay vì gán `undefined` trực tiếp — **quy tắc chung**: bất cứ field optional nào lấy từ `?.`/giá trị có thể `undefined`, PHẢI dùng spread-có-điều-kiện trước khi đưa vào `session.append()`.
2. **DuckDuckGo không có API search miễn phí thật sự.** Instant Answer API (`api.duckduckgo.com`) chỉ trả knowledge-graph (rỗng với hầu hết query thường), và cũng bị chặn bot khi test. Cách thật (giống browser): GET `duckduckgo.com/` lấy cookie session, rồi POST (không phải GET) `html.duckduckgo.com/html/` kèm cookie đó — GET trơn không cookie ra thẳng trang challenge (HTTP 202 "anomaly").
3. **`fetch()` của Node bị chặn bot ngay cả khi có đủ header kiểu Chrome thật** (đã test: user-agent, accept, sec-ch-ua, sec-fetch-* đầy đủ — vẫn 202). `curl` từ đúng máy/mạng đó lại qua được, cookie thật. Kết luận: DDG detect ở tầng thấp hơn header (gần như chắc chắn là TLS/HTTP2 fingerprint) — không sửa được bằng JS. **Fix: gọi `curl` qua subprocess** (`node:child_process.execFile`, args dạng mảng — không qua shell string, không có injection risk) thay vì `fetch()` trực tiếp.

**Kết quả:** ép model gọi tool qua prompt rõ ràng, session log thật cho `tool/call`→`tool/result` với `isError: false`, kết quả search thật (title/URL/snippet khớp đúng nội dung thật trên web). Phase 1 giờ đã có đủ bằng chứng cho cả "session end-to-end" lẫn "tool hoạt động" — chỉ còn "log tương thích" (so log với driver mặc định) là chưa làm.

---

## 14. So log thật với driver mặc định — chốt nốt tiêu chí cuối của Phase 1 (2026-09-03)

Dựng thêm profile `fox-harness-baseline`: `dsh-base` + `dsh-headless` + `dsh-core` + `dsh-llm-openai-compat` + `dsh-tool-duckduckgo-web-search`, **không có** `dsh-agent-driver` — giữ nguyên `agent-loop` mặc định. Chạy **cùng 1 prompt** qua cả `fox-harness-headless` (driver mình) và `fox-harness-baseline` (driver gốc) song song, decompress cả 2 session log thật, diff theo **loại event** (không diff nội dung — model trả lời khác nhau mỗi lần do sampling, đó là bình thường, không phải bug).

**Giống nhau (phần lõi turn/step — đây mới là cái "tương thích" thật sự cần):** `turn/start → agent/inbox/spliced → step/start → user/message → assistant/chunk* (kể cả cơ chế gộp `reasoning-chunks`/`text-chunks` — cơ chế của tầng persistence, chạy giống hệt nhau ở cả 2, không phải thứ driver phải tự làm) → assistant/message → step/end → turn/end`. Xác nhận `dsh-core`'s `agent/request` listener hoạt động **độc lập driver** — cả driver gốc lẫn driver mình đều bị nó route đúng sang `provider: openai-compat` (đúng thiết kế, vì đây là Cordis event thường, không gắn với driver nào).

**2 khác biệt thật, cả 2 đều khớp đúng "cắt bớt có chủ đích" đã ghi từ trước — giờ xác nhận bằng dữ liệu thật thay vì chỉ đọc source:**

1. **`request/header`/`request/context`** — driver gốc ghi, driver mình không. Đúng như đã ghi rõ trong `agent.ts`'s class doc: "No `request/header`/`request/context` cosmetic bookkeeping events".
2. **"Runtime context snapshot"** — driver gốc tự chèn thêm 1 `user/message` tổng hợp (source: `{kind:'plugin', plugin:'@deepseek-ai/dsh-system-prompt', form:'snapshot'}`, nội dung mô tả sandbox/approval policy hiện tại) mà driver mình không có. Đây chính là cơ chế `RuntimeContextProjection` (`runtime-context.ts`) đã được fork nghiên cứu đầu tiên gắn cờ "safe to skip for v1" — giờ mới thật sự xác nhận bằng log thật, và đặt tên rõ ràng lần đầu.

**Phát hiện phụ (không liên quan tương thích driver, là bug thật của `dsh-core`):** persona `{{model}}` trong system prompt đọc từ `agent.options.model` (giá trị tĩnh lúc tạo agent), trong khi request LLM thật lại dùng model do `dsh-core`'s waterfall override (động, theo `OPENAI_MODEL_ID`) — 2 nguồn khác nhau, có thể lệch nhau. Baseline lộ ra điều này vì nó VẪN ghi `request/header` (thấy persona nói "deepseek-v4-flash" trong khi request thật dùng model Qwen) — driver mình thì do không ghi `request/header` nên **không thể tự audit** được lỗi này từ log của chính nó. Ghi nhận, chưa sửa (không nằm trong scope "so log driver", để riêng cho `packages/core`).

**Kết luận Phase 1:** log **tương thích ở phần lõi** (turn/step contract đúng 100%), 2 khác biệt còn lại đều là cắt bớt có chủ đích đã biết trước, không phải lỗ hổng bất ngờ. **Cả 3 tiêu chí hoàn thành Phase 1 giờ đã đạt**, theo đúng tinh thần roadmap (không phải log giống hệt byte-by-byte — cái đó chưa từng là mục tiêu, "log tương thích" nghĩa là cùng contract, khác biệt phải giải thích được).

---

## 15. Phase 2 — transport thật, chốt câu hỏi mở về SSE/WebSocket, replay test PASS (2026-09-03)

Trước khi code, giải quyết câu hỏi mở #4 (roadmap §5): đọc source thật của `dsh-web-app` (không phải đoán). Kết quả:

- **Là WebSocket, không phải SSE.** `packages/api/gateway/src/stream-protocol.ts` — một route WS duy nhất (`/api/remote.mux`), đa luồng logic qua `streamId`. Nghiên cứu trước đó (mục 0.3: "Typert loại trừ stream") **không sai nhưng chưa đủ** — Typert Remote CÓ hỗ trợ streaming method (`@Remote({mode:'stream'})`); cái bị loại trừ là một cơ chế forward-Cordis-event cấp thấp hơn, khác thứ này.
- **Event stream + command đi chung 1 connection.** `follow()` (stream method) phát session event; `prompt()`/`cancel()` (unary method) chính là nơi `agent.followup()`/`agent.steer()` được gọi — cùng multiplex qua 1 WebSocket, không phải endpoint POST riêng.
- **Log-before-fanout đảm bảo có sẵn, không phải tự lo:** cơ chế thật subscribe event Cordis `session/event` — doc comment thật của event này ghi rõ "Post-commit, fire-and-forget... callbacks run after [the log push]". Nghĩa là chỉ cần subscribe đúng event này, thứ tự ghi-log-trước-rồi-mới-fan-out tự động đúng, không cần tự canh thứ tự.
- **Replay kiểu snapshot-rồi-live, KHÔNG phải resume-từ-cursor.** `history.ts`'s `follow()` luôn trả `{type:'snapshot', ...}` đầy đủ trước, rồi mới tiếp tục live. Reload = mở lại connection logic mới, nhận lại snapshot đầy đủ — không có protocol "resume từ event N" riêng.
- **Không tái dùng được code, chỉ tái dùng được ý tưởng/wire shape.** Cơ chế thật của `dsh-web-app` gắn chặt vào 1 process (đóng qua closure `ctx` cục bộ), không tách rời được cho gateway đa-worker. `packages/transport` là việc mới hoàn toàn — đúng như roadmap đã dự tính, không phải bỏ sót.

**Quyết định kiến trúc:** `packages/transport` tự viết WebSocket server riêng (dùng `ws`), giao thức tự thiết kế (không copy Typert mux — quá gắn với same-process dispatch): 1 connection = 1 session, `/sessions/new` (tạo mới) hoặc `/sessions/<id>` (nối lại), snapshot-rồi-live, subscribe `session/event` thật, gọi thẳng `agent.followup()`/`steer()`.

**Verify bằng WebSocket client thật + test replay đúng nghĩa** (tiêu chí quan trọng nhất của Phase 2, roadmap gọi là "quan trọng nhất của cả dự án"): gửi 1 prompt dài (đếm 1-10, giải thích từng số), **đóng connection giữa lúc model đang stream** (giả lập reload), đợi 500ms, **kết nối lại cùng session** — snapshot trả về có đủ `turn/end` (turn đã hoàn thành đầy đủ dù client không còn kết nối lúc đó). Xác nhận bằng cách đọc thẳng session log thật (giải nén `.zstd`) — nội dung turn 2 đầy đủ, không thiếu, không cắt cụt. **PASS.**

**1 bug thật tìm thấy khi verify:** tạo session qua `ctx.agents.create({sessionId, agentOptions:{}})` mà không có `meta: {cwd}` không chỉ để trống — session bị rơi vào bucket `_no-cwd` trong log store thay vì đúng thư mục theo cwd (phát hiện khi đi tìm session vừa tạo, không thấy ở chỗ mọi session khác nằm). `dsh-headless`/`dsh-web-app` đều set field này. Fix: `meta: { cwd: process.cwd() }`.

---

## 16. `services/gateway` — auth + proxy, replay test PASS lại qua thêm 1 hop (2026-09-03)

`services/gateway` (roadmap Phase 2 bước 2: *"Gateway: auth cơ bản, phát token, proxy stream"*) đứng trước `packages/transport` — package đó tự khai rõ trong README "No auth at this layer... meant to sit behind a gateway, never exposed directly", nên đây là mảnh bắt buộc trước khi FE thật có thể nói chuyện với worker.

**Thiết kế:** Node `http` + `ws` trần (không framework — khớp cách tối giản của `packages/transport`), **không** import bất kỳ `@fox-harness/dsh-*` nào (luật §1 — gateway chỉ được biết `@fox-harness/contracts`). Hai route: `POST /auth/token` (đổi 1 shared secret duy nhất lấy token opaque, TTL 1 giờ, so sánh bằng `timingSafeEqual` có guard độ dài trước — `timingSafeEqual` throw thay vì trả `false` khi 2 buffer khác độ dài, một class bug thật nếu không canh) và WS upgrade `/sessions/<id-or-new>?token=...` (token qua query param, không phải header, vì browser không set custom header được trên WS upgrade request — cùng constraint đã thấy ở `dsh-web-app`'s route thật, §15). Sau khi xác thực token, `src/proxy.ts` mở 1 connection outbound riêng tới `packages/transport` và relay **verbatim** cả 2 chiều — gateway không parse giao thức của transport, chỉ forward string thô, giữ 2 package tách rời độc lập.

**Verify thật:** dựng 1 worker thật (`fox-harness-transport-test`: `dsh-core` + `dsh-agent-driver` + `dsh-llm-openai-compat` + `dsh-transport`, model self-host thật) + gateway trỏ vào nó, rồi chạy lại đúng bài test replay của Phase 2 (đóng connection giữa lúc model đang stream, mở lại) — lần này đi **qua thêm 1 hop gateway** thay vì nối thẳng transport. `POST /auth/token` sai secret → `401`; đúng secret → token thật. Kết nối qua proxy, hoàn thành 1 turn, gửi turn 2, đóng socket giữa lúc đang stream, đợi 8s, kết nối lại cùng session qua gateway — snapshot trả về `turn/end` = 2, reply thứ 2 dài 1226 ký tự, đầy đủ không thiếu. **PASS** — hop thêm không phá vỡ log-before-fanout, đúng như kỳ vọng vì proxy chỉ relay thô, không thể làm sai thứ tự.

**1 bug thật gặp phải — nằm ở chính test script, không phải ở gateway:** lần chạy đầu bị treo vô thời hạn ngay sau khi connect. Nguyên nhân: helper `nextFrame()` của test dùng `ws.once('message', ...)` await tuần tự từng cái một — nhưng `packages/transport` gửi `session` rồi `snapshot` liên tiếp không có `await` nào giữa 2 lần gửi ở phía server, nên cả 2 frame có thể tới cùng 1 tick. Nếu listener `.once()` thứ 2 chưa kịp gắn lúc đó, frame bị mất hẳn — `EventEmitter` không buffer. Fix: đổi sang 1 listener `ws.on('message', ...)` cố định đẩy vào queue, `nextFrame()` đọc từ queue thay vì đua 1 listener mới mỗi lần await. Bug liên quan phát hiện cùng lúc: pattern `Promise.race(nextFrame(), timeout)` ban đầu để lại waiter mồ côi trong queue mỗi lần timeout thắng — fix bằng cách cho nhánh timeout tự gỡ waiter của chính nó. Cùng 1 lớp bug ("message tới trước khi kịp lắng nghe") đã note ở §15 khi verify test replay lần đầu — ghi lại lần nữa vì sẽ còn gặp ở mọi test WS viết sau này.

---

## 17. Phase 3 — orchestrator/Docker thật, kill -9 + rehydrate test PASS, và 1 bug mất dữ liệu thật (2026-09-04)

Peak session target vừa nâng 100–1.000 → 1.000–10.000 cùng ngày (user request) — xem `MEMORY`/roadmap §5 mục 1. Phase 2 chưa containerize gì cả (mọi thứ chạy host process trần); Phase 3 phải bắt đầu từ việc chưa từng làm: build Docker image thật cho worker. Getting a real container to boot, resume a session, and pass the kill-9 test surfaced 6 real bugs, in this order:

**1. `resume()` (roadmap-flagged "Phase 3 concern", để trống từ đầu ở `packages/agent-driver/src/factory.ts`) là điều kiện tiên quyết — không phải Docker/Redis.** Không có nó, container mới không thể load lại session cũ từ log trên đĩa; mọi phần orchestrator khác vô nghĩa nếu thiếu mảnh này. API thật (đọc trực tiếp `.d.ts` cài thật, không đoán): `ctx.sessionPersistence.prepare(id, signal?): Promise<SessionPreparation>` — `SessionPreparation.session` đã LÀ một `Session` sẵn sàng dùng thẳng cho `enterAndAnnounce()` (giống hệt luồng `createAgent()`'s `ctx.sessions.prepare()`) — không cần tự dựng lại `{seed, meta}` như đoán ban đầu. `SessionPreparation` implement `Disposable`; gọi `preparation[Symbol.dispose]()` trong `finally` (không dùng cú pháp `using` — tránh phụ thuộc runtime `Symbol.dispose` downlevel-emit chưa chắc có). `ResumeAgentOptions`'s field tên là `resumeSessionId`, không phải `sessionId`.

**2. `insert:` trong `cordis.patch.yml` KHÔNG override theo id — nó append vô điều kiện.** Đây là chỗ §4 tài liệu này dễ bị đọc nhầm (bản thân §4 mô tả đúng, nhưng dễ lẫn 2 shape patch khác nhau làm một). Đọc thẳng `applyEntryPatches` thật (`@deepseek-ai/dsh-app-boot`): một patch có top-level `insert:` và KHÔNG có `id` → `data.push(...insert)`, append thô, không tra cứu, không thay thế gì cả. Dùng lại `insert:` với cùng `id` một row ĐÃ TỒN TẠI (từ patch layer khác, ví dụ bundle patch của chính row đó) → 2 row trùng `id` trong danh sách cuối cùng → `EntryGroup.update()` (cordis-plugin-loader) throw thẳng `"duplicate loader entry id"` khi boot, không silent-skip. Muốn **override** field của 1 row có sẵn: patch shape KHÁC — `{id, name?, ...overrides}`, KHÔNG có `insert:` — tra `entryMap.get(id)`, check `name` khớp (skip + warn nếu lệch), rồi gán đè field. Đây mới là shape §4 thật sự mô tả ("Patch thay toàn bộ config của row theo id"). `services/orchestrator/src/materialize.ts` (patch override `host: '0.0.0.0'` cho row `fox-harness-transport`) dùng đúng shape thứ 2.

**3. `@deepseek-ai/dsh-subprocess-local` (node-pty) không có prebuild cho Alpine (musl).** Container boot fail với `Cannot find module './prebuilds/linux-arm64/pty.node'` — nhìn tưởng do platform arch, thật ra là musl vs glibc: bật `allowBuilds` cho `node-pty` (`pnpm-workspace.yaml`) và cài toolchain build trên Alpine (`apk add python3 make g++`) **không** fix được — `node scripts/prebuild.js` báo "Done" nhưng không thật sự cài được gì dùng được. Đổi base image `infra/docker/worker/Dockerfile` từ `node:22-alpine` sang `node:22-slim` (Debian, glibc) fix ngay, không cần thêm gì khác ngoài `apt-get install python3 make g++` (fallback nếu prebuild không match). **Đừng disable `subprocess` row để né lỗi này** — thử rồi: 4 row khác (`dsh-bash-sandbox`, `dsh-permission-presets`, `dsh-tool-bash`, `dsh-tool-fs-search`) phụ thuộc service `subprocess`/`shell`, boot fail kiểu khác ("N entries did not activate") vì `assertEntriesActivated` không tha một row nào còn "pending".

**4. Bundle `@fox-harness/*` không tự resolve được từ trong profile directory.** `@deepseek-ai/dsh-base` resolve tự động (dsh tự biết ecosystem của chính nó), nhưng bundle custom (`@fox-harness/dsh-core`, ...) cần là package thật resolve được TỪ `$DSH_HOME/profiles/<name>/` — xác nhận qua 1 profile test-host thật (`~/.dsh/profiles/fox-harness-transport-test`) đã có sẵn `dependencies` với `link:<absolute-host-path>` + `node_modules` riêng (dsh tự chạy `pnpm install` khi materialize profile thật ngoài host). Trong container, path tuyệt đối trên host vô nghĩa. Fix rẻ hơn nhiều so với chạy lại `pnpm install` mỗi lần container boot: `infra/docker/worker/entrypoint.sh` tự symlink cả scope `@fox-harness` từ node_modules đã hoist sẵn của chính image (`/repo/node_modules/@fox-harness`) vào `/data/profiles/fox-harness/node_modules/@fox-harness` — instant, không cần lockfile/resolve gì thêm vì target luôn là node_modules của CHÍNH image này.

**5. `container.start()` xong KHÔNG có nghĩa là worker đã sẵn sàng nhận traffic.** `dsh` boot toàn bộ plugin tree (đặc biệt các row liên quan node-pty/tool/sandbox ở trên) tốn vài giây; Docker publish port ngay khi container start, không đợi app bên trong lắng nghe. Gateway proxy connect ngay sau khi `ensureSession()` trả về → `ECONNRESET` thật. **TCP connect-rồi-đóng KHÔNG đủ để phát hiện đúng** — vẫn intermittent reset dù connect "thành công" (rất có thể do vpnkit của Docker Desktop accept TCP handshake ở tầng port-forward proxy trước khi container thật sẵn sàng nhận). Fix đúng: `services/orchestrator/src/docker.ts`'s `waitUntilReachable()` làm 1 WebSocket handshake THẬT tới `/sessions/__orchestrator-readiness-probe__` (transport's phản hồi thật cho session lạ là `{type:'error'}` rồi đóng — đủ để chứng minh cả chuỗi container → dsh boot → transport WS server → message handling đã sống thật, không chỉ có socket mở).

**6. Bug mất dữ liệu thật — lý do chính xác Phase 3 gọi test này "quan trọng nhất của cả dự án".** Kill -9 ngay sau khi nhận đủ `assistant/message` qua live WebSocket → rehydrate → snapshot có `turn/end` nhưng **THIẾU `assistant/message`** (0 event, không phải lỗi filter test). Nguyên nhân xác nhận qua doc comment thật của `@deepseek-ai/dsh-session-checkpoint-policy`: nó chỉ checkpoint (flush ra đĩa) 1 response/result batch tại **request boundary TIẾP THEO** — nghĩa là phản hồi của turn CUỐI CÙNG (chưa có turn kế tiếp) chưa từng được flush thật, dù `session/event` đã báo cho live subscriber rồi (event đó fire sau khi COMMIT vào bộ nhớ, không phải sau khi FLUSH ra đĩa — 2 guarantee khác nhau). `dsh-headless`'s source thật (`lib/index.js`) tự vá đúng chỗ này: `await agent.whenIdle(); await sessions.flush(agent.session);` trước khi exit — vì đó là 1 process one-shot, buộc phải tự đảm bảo. Driver của chúng ta trước đây KHÔNG làm việc này. Fix: `packages/agent-driver/src/agent.ts`'s `wake()` — sau khi `drive()` xong (agent về idle), gọi `await this.ctx.sessions.flush(this.session)` trước khi resolve `idleWaiters`, để MỌI turn (không chỉ khi process sắp thoát) đều được flush ngay khi agent rảnh — an toàn hơn cả pattern gốc của `dsh-headless` (không phụ thuộc caller nhớ gọi `flush` riêng).

**Kết quả cuối — PASS với dữ liệu thật, đúng cả 5 việc + test bắt buộc của roadmap:** container thật (`infra/docker/worker`), Redis affinity + spawn lock thật (`services/orchestrator/src/redis.ts`), warm pool thật (claim tức thời từ pool, không cold-start), hibernate theo idle TTL thật (test riêng: TTL 5s, xác nhận `docker stop` + Redis chuyển `hibernated`), và bài test chính: gửi followup thật qua model thật → `docker kill -9` container thật giữa session → đợi → reconnect qua đúng gateway → orchestrator spawn container MỚI (id khác hẳn) mount lại đúng volume cũ → snapshot có đầy đủ `turn/end` + `assistant/message` với đúng nội dung reply gốc. "Rehydrate ở node khác" được proxy bằng "container hoàn toàn mới, zero shared memory với container cũ" — dev machine chỉ có 1 Docker daemon, không test được multi-host thật; ghi rõ đây là giới hạn môi trường, không phải bỏ tiêu chí.

---

## 18. Phase 4 — FE theme + manifest động, "hai session khác plugin thấy hai màn hình khác nhau" PASS (2026-09-04)

Research thật trước khi code (không đoán từ roadmap prose): đọc trực tiếp `@deepseek-ai/dsh-web-app`, `dsh-client-modules`, `dsh-client-ui-renderer` cài thật trong `node_modules`. Kết quả chính: manifest thật (`window.__DSH_BOOT__`) là mảng `{id, url, rev, inject?, immediately?, external?}` sinh từ việc **scan cây Loader** tìm package khai `dsh.client` (class `ClientModuleRegistry`, `dsh-client-modules/lib/index.js`); route `client.js` thật đúng dạng `/plugins/<id>/client.js`, resolve từ `exports["./client"]` — khớp `docs/code-rules.md` §0.2, không có gì thêm. Contract "declarative node" thật là một hệ **slots** khá phức tạp (`ctx.slots.install/inject/register`, nhiều outlet kind: single/keyed/list/chain) — nhiều hơn hẳn bản `type → renderer` phẳng roadmap mô tả. Gotcha symlink/BFS trong roadmap (`resolve.paths()` không theo symlink) **đã được fix ở chính dsh** (`dsh-app-boot`'s `healProfilesModuleFallback`/`packageDirFromAnchor`) — không phải bug đang chờ né.

**Quyết định kiến trúc — không copy cơ chế scan-cây-Loader, tự viết bản mỏng hơn (nấc 2):** thay vì dò cây Loader thật, `packages/core` sở hữu 1 Cordis service nhỏ (`ClientManifestRegistry`, `ctx.clientManifest`) mà package nào có `dsh.client` (hiện chỉ `client-ui-theme`) tự `register()` trong `apply(ctx)` của chính nó. Đúng-theo-session tự động vì `apply()` chỉ chạy cho package thật sự có trong bundle list của session đó — không cần dò cây, không cần dirty-set/microtask-batched rescan như bản thật.

**1 bug thật gặp phải — cross-package type augmentation bị TypeScript âm thầm xoá khỏi `.d.ts`.** `packages/core/src/index.ts` ban đầu chỉ `import { ClientManifestRegistry } from './client-manifest.ts'` rồi DÙNG nó như VALUE (`ctx.plugin(ClientManifestRegistry)`) — không xuất hiện ở type position nào trong chữ ký export của `index.ts`. TypeScript emit `.d.ts` chỉ giữ lại phần cần cho public type surface, nên import đó (và cùng với nó, `declare module '@deepseek-ai/cordis' { interface Context {...} }` bên trong `client-manifest.ts`) **biến mất hoàn toàn khỏi `index.d.ts`** — mọi package khác chỉ `import '@fox-harness/dsh-core'` để lấy augmentation (đúng pattern đã dùng khắp repo cho `@deepseek-ai/dsh-session-persistence` v.v.) sẽ thấy `ctx.clientManifest` không tồn tại, dù code hoàn toàn đúng. Fix: `index.ts` phải RE-EXPORT tường minh (`export { ClientManifestRegistry, type ClientManifestEntry } from './client-manifest.ts'`) — đúng lý do `packages/agent-driver/src/index.ts` đã re-export `FoxHarnessAgent`/`FoxHarnessAgentLoop` ở cuối file từ trước, không phải ngẫu nhiên.

**Cơ chế test "hai session khác plugin" (Phase 5 chưa tồn tại nên đây là test-only lever, không phải sản phẩm thật):** `EnsureSessionRequest.profileVariant?: string` — một NHÃN trừu tượng orchestrator dùng để chọn giữa preset cố định (`materialize.ts`'s `VARIANT_EXCLUDED_BUNDLE`), không phải tên bundle thật đi qua gateway/orchestrator — giữ đúng luật "services/* không biết nội tại bundle". `apps/web` đọc `?variant=` từ URL trang, forward khi tạo session mới. **Warm pool chỉ phục vụ variant mặc định** — pool member luôn materialize không variant, nên `ensure.ts` bỏ qua pool hoàn toàn khi request có `profileVariant`, cold-spawn thẳng thay vì âm thầm bỏ qua variant.

**Verify bằng dữ liệu thật (không có Claude in Chrome — verify qua HTTP thật + dynamic `import()` thật trong Node, không phải click browser):**
1. `POST /sessions/:id/ensure` (không variant) → claim từ warm pool → `GET /sessions/:id/manifest` qua gateway trả về `[{id:'@fox-harness/dsh-client-ui-theme', url:'/sessions/<id>/plugins/.../client.js', immediately:true}]`.
2. `POST /sessions/:id/ensure {"profileVariant":"no-theme"}` → cold-spawn (không claim pool) → manifest trả về `[]` rỗng. Đọc thẳng `profile.package.json` thật trên đĩa của 2 session: session 1 có `@fox-harness/dsh-client-ui-theme` trong `bundles`, session 2 không — khác nhau thật trên filesystem, không chỉ khác ở response JSON.
3. `curl` file `client.js` thật qua đúng đường gateway proxy → `content-type: text/javascript` đúng, nội dung đúng source thật.
4. `import()` file đó thật trong Node (ghi ra file tạm rồi dynamic import) → xác nhận `typeof mod.mount === 'function'` — module ES hợp lệ, đúng contract `mount(root): () => void` apps/web mong đợi.

**Chưa verify được (ghi rõ, không tự nhận đã xong):** phần render DOM thật qua browser (không có Claude in Chrome — giống mọi lần trước trong dự án này); registry `type → renderer` phía FE (`window.__FOX_HARNESS__.registerNodeRenderer`) có cơ chế thật nhưng chưa có plugin thật nào gọi nó (client-ui-theme chỉ set token, không có custom node type).

---

## 19. User hỏi tại sao UI không giống dsh — cân nhắc clone thật, rồi tách `apps/web` thành nhiều plugin (2026-09-04)

Sau Phase 4, user hỏi thẳng "sao UI không giống dsh tý nào" rồi đề nghị "clone cả hết dsh làm của riêng". Trước khi làm bất cứ gì, kiểm tra thật chi phí của việc đó (quyết định tốn kém, khó đảo ngược — đúng tinh thần "measure twice, cut once", không phải chỉ áp dụng cho code chạy được hay không mà cả cho quyết định kiến trúc).

**Đọc thẳng code nén thật của `@deepseek-ai/dsh-client-ui-conversation`:**
1. **Là React thật** — `require("react")`, `require("react/jsx-runtime")` ngay trong `lib/client.js`. `apps/web` cố tình không dùng framework nào từ Phase 2.
2. **Không phải ES module thường** — bọc trong `window.__ModuleLoader__.load({id, factory: (require) => ...})`, một module system tự chế kiểu AMD. Cơ chế `import()` per-manifest-entry của Phase 4 KHÔNG tải được các bundle này.
3. **Không có source thật, chỉ có compiled** — `exports["./src/*"]` trỏ tới thư mục không tồn tại trong bản publish; chỉ có `lib/client.js` đã build sẵn (10.251 dòng cho riêng 1 package).
4. **Kéo theo cả chuỗi phụ thuộc thật** — `inject` thật của riêng `dsh-client-ui-conversation` liệt kê `dsh-client-connection`, `dsh-client-locale`, `dsh-client-runtime`, `dsh-client-ui-settings`, `dsh-api-remotes`, `dsh-client-ui-layout` — không phải 1 package độc lập.

Kết luận: clone thật = đổi cả kiến trúc FE (thêm React + module loader riêng của dsh + cả chuỗi package), quy mô lớn hơn hẳn Phase 4, ngược nguyên tắc nền "nấc 2, fork mỏng" (roadmap §0.2/§0.3) mà toàn bộ dự án đã bám theo từ Phase 0. Trình bày thẳng chi phí này cho user trước khi làm gì — không tự quyết thay, không im lặng làm theo yêu cầu ban đầu.

**User chọn hướng giữa:** giữ `apps/web` tự viết (không React, không dùng package `dsh-client-ui-*` thật), nhưng (a) style lại dựa trên giá trị token thật của dsh (không copy code — xem palette mới trong `packages/client-ui-theme`), và (b) tách code hiện có thành nhiều package plugin riêng, giống cách dsh CHIA MODULE (không phải giống code).

**Tách `apps/web/src/main.ts` thành shell + `packages/client-ui-conversation`:** log rendering + composer (send form) chuyển hết sang package mới, theo đúng ranh giới package thật của dsh (`dsh-client-ui-conversation`'s package.json description thật: *"ordered chat flow, composer... and details host"* — 2 thứ này là MỘT package bên dsh, không phải 2). Cần thêm 1 lớp cầu nối mới giữa shell và plugin — trước đây `nodeRenderers` map + tất cả logic render đều nằm chung trong `main.ts` nên không cần cầu nối; giờ 2 concern tách ra 2 module compile riêng, phải giao tiếp qua `window.__FOX_HARNESS__` (mở rộng thêm `onFrame`/`send`/`getNodeRenderer`, không phải JS import — plugin bundle tải từ origin khác qua `import()` động, không chạm được vào module graph của shell). `onFrame` replay lại toàn bộ `frameHistory` ngay lúc subscribe — cùng nguyên tắc snapshot-rồi-live của chính wire protocol, áp lại một tầng cao hơn, để xử lý đúng race thật: `import()` + `mount()` là async, plugin có thể subscribe TRỄ hơn lúc frame đầu tiên đã tới.

**1 bug TypeScript khác gặp phải khi viết `client-ui-conversation`'s `mount()`:** guard `if (!logEl || !sendForm || ...) throw` ở đầu hàm không narrow được các biến đó bên trong những function declaration lồng bên trong (`appendMessageBubble`, `handleEvent`, ...) — TS không mang flow-narrowing của 1 `const` xuyên qua closure biên function, dù chắc chắn không bao giờ bị gán lại. Fix: gán lại thành const MỚI ngay sau guard (`const logEl = logQuery` sau khi đã check `logQuery` non-null) — type của const mới suy ra thẳng từ RHS đã narrow, không cần TS phải narrow lại bên trong closure nữa.

**1 bug cấu hình thật khi thêm package mới vào profile bundle list:** thêm `@fox-harness/dsh-client-ui-conversation` vào `packages/profile-template/template/profile.package.json`'s `bundles` không đủ — container boot fail `"cannot resolve profile bundle ... from the dsh installation or /data/profiles/fox-harness"`. Nguyên nhân: `resolveBundleDir` thật (`dsh-app-boot`) thử 2 anchor theo thứ tự — installation anchor trước (đi lên từ `/repo/node_modules/@deepseek-ai/dsh/`, tới `/repo/node_modules/`), rồi mới tới profile dir. Package mới không nằm trong `/repo/node_modules/@fox-harness/` vì **root `package.json`'s `dependencies` chưa liệt kê nó** — pnpm hoisted linker chỉ tạo symlink gốc cho package thật sự nằm trong 1 dependency graph nào đó, không phải cứ là workspace package cùng glob là tự nhiên được hoist lên root. Mọi package `dsh-*` bundle khác (transport, client-ui-theme, agent-driver, ...) đều đã có mặt trong root `package.json`'s `dependencies` từ trước — quy tắc: **thêm bundle package mới vào profile luôn phải thêm cả vào root `package.json`'s `dependencies`**, không chỉ vào bundle list string trong profile-template.

**Verify lại toàn bộ chuỗi thật sau khi tách** (không chỉ typecheck): manifest thật liệt kê đúng cả 2 plugin, cả 2 `client.js` serve đúng qua gateway (200, export `mount`), và — quan trọng nhất — 1 lượt chat thật đầy đủ vẫn chạy đúng qua kiến trúc đã tách (gửi followup → nhận đủ `assistant/message` thật qua model thật) — xác nhận việc tách FE không làm hỏng gì ở backend (đúng như dự đoán, không đụng gì tới packages/transport hay services/*, nhưng verify thật vẫn tốt hơn giả định).

---

## 20. Phase 5 — Plugin store: `disabled:` không tự re-read `bundles`, và 1 buổi debug đuổi nhầm hướng (2026-09-07)

**Thiết kế ban đầu sai — tưởng ghi lại `cordis.patch.yml` là đủ để live-enable 1 bundle CHƯA từng có trong `bundles`.** Bản đầu của `services/plugin-registry/src/patch.ts` chỉ thêm/bớt entry vào `bundles` của `profile/package.json` MỖI LẦN enable/disable, giả định `cordis-plugin-hmr` (§17-18 đã xác nhận: chokidar thật, tự watch `cordis.patch.yml`, không cần trigger) sẽ áp dụng luôn. Thực tế: `composeLive()` chỉ re-apply PATCH OVERLAY lên 1 danh sách bundle đã CỐ ĐỊNH từ lúc container boot — không bao giờ đọc lại `package.json`. Enable trả 204, ghi file thật, nhưng plugin không bao giờ xuất hiện. **Fix (kiến trúc đúng, đã verify):** liệt kê SẴN mọi plugin đã approved vào `bundles` ngay lúc `materialize.ts` chạy (lúc container boot), mỗi plugin có 1 override row `disabled: true` mặc định trong `cordis.patch.yml` (cùng cơ chế override-by-id đã dùng cho `fox-harness-transport`'s host, §17). Enable/disable sau đó chỉ FLIP field `disabled` của row đã tồn tại sẵn — đúng cơ chế override patch mà `cordis-plugin-hmr` áp live được, không phải thêm bundle mới. Hệ quả trực tiếp: **1 session chỉ live-enable được plugin đã approved TỪ TRƯỚC KHI session đó materialize** — approve sau khi session đã sống thì session đó cần rehydrate (dshHomeDir cũ, container mới) mới thấy, không có cách nào thêm bundle mới vào 1 process đang chạy.

**Warm pool cần "rehydrate" đúng nghĩa để nhặt plugin mới approve, không tự nhiên có** — pool member materialize 1 lần lúc được PUSH vào `fh:warmpool` (lúc orchestrator boot, hoặc lúc `claimWarmPoolMember` fire-and-forget refill sau 1 lần pop), không phải lúc được claim. Approve 1 plugin mới sau khi pool đã đầy → pool cũ vẫn thiếu plugin đó cho tới khi tự nhiên bị pop hết và refill. Test thật phải chủ động drain pool (`docker rm` hết container + xoá `data/dsh-home/_pool/*` + **`redis-cli del fh:warmpool`** — thiếu bước xoá key Redis này thì `replenishWarmPool`'s `warmPoolSize()` vẫn đếm ra "đủ", không spawn gì mới dù container/thư mục trên đĩa đã xoá sạch, im lặng không log lỗi gì) rồi mới restart orchestrator.

**Bài học chính — đuổi nhầm hướng debug 1 buổi vì không quay lại kiểm tra giả định gốc trước khi nghi ngờ tầng hạ tầng.** Sau khi fix 2 vấn đề trên, plugin vẫn không hiện trong manifest → nghi ngờ lần lượt: gateway proxy route có bug (thêm debug log, không thấy gì bất thường — request/response qua gateway hoàn toàn đúng), warm-pool timing (đã đúng, verify bằng cách đọc thẳng file trên đĩa của pool member mới nhất). Cả 2 nghi ngờ đều SAI. Nguyên nhân thật: **plugin demo tự viết để test (`fox-harness-demo-hello/index.js`) chưa bao giờ gọi `ctx.clientManifest.register(...)`** trong `apply(ctx)` — mà `packages/core`'s `ClientManifestRegistry` (§18) là cơ chế SELF-REGISTRATION có chủ đích, không quét `dsh.client` trong `package.json` như dsh thật làm (`dsh-client-modules`'s Loader-tree scan, §18 đã ghi rõ lý do không copy cơ chế đó). Không tự register thì plugin có load đúng cách mấy (log `apply()` chạy, `bundles`/`node_modules`/`disabled` đều đúng) cũng không bao giờ vào `GET /manifest` được — đây không phải bug ở hạ tầng, mà là plugin demo thiếu 1 dòng gọi service, đúng model self-registration đã thiết kế từ Phase 4. Fix: thêm `inject = ['clientManifest']` + `ctx.clientManifest.register({id, immediately: true})` vào demo plugin. **Rút kinh nghiệm cho lần sau:** khi 1 chuỗi nhiều tầng (gateway → registry → Postgres → filesystem → dsh loader → manifest service) không cho kết quả cuối như kỳ vọng, kiểm tra ĐẦU RA CỦA TỪNG TẦNG THEO ĐÚNG THỨ TỰ TỪ ĐẦU (ở đây: "plugin demo có tự register vào manifest service không" là câu hỏi RẺ NHẤT, đáng lẽ phải hỏi trước khi nghi ngờ gateway/warm-pool — 2 thứ tốn nhiều công điều tra hơn hẳn).

**Verify thật đầy đủ (script Node giả lập đúng wire protocol qua WS thật, không phải browser — chưa có Claude in Chrome):** build (`pnpm add <local-path>` thật) → approve → connect session thật qua gateway → `POST enable` → nhận được frame `{type:'manifest'}` LIVE trên CÙNG 1 kết nối WS đang mở, không reconnect → `GET /manifest` list có plugin demo → `POST disable` → frame `manifest` live thứ 2 → plugin biến mất khỏi list. Cả 4 bước PASS với plugin demo đã sửa.

---

## 21. Phase 6 — Vận hành: quota, telemetry, log retention, upstream upgrade, và microVM (chỉ chiến lược) (2026-09-07)

**Quyết định phạm vi trước khi code (user tự chọn qua AskUserQuestion):** 5
mục checklist Phase 6 không đồng đều về độ lớn — 4 mục đầu (quota, telemetry,
chiến lược upgrade, log retention) là code + test thật được trên máy dev
này; mục 5 (siết isolation xuống microVM) cần Firecracker/`/dev/kvm`, máy
dev đang dùng (Docker Desktop macOS) không có. User chọn: mục 5 chỉ viết
chiến lược (`docs/microvm-isolation-strategy.md`), 4 mục còn lại làm thật.
Không tự quyết thay — đúng tinh thần "trình bày chi phí thật rồi để user
chọn" đã áp dụng ở quyết định "clone dsh UI" (§19).

**Quota — không có "user" thật, nên "theo user" trong roadmap trở thành
GLOBAL hoặc PER-SESSION.** Dự án chưa từng xây khái niệm user/login (Phase 5
đã tự nhận scope cut này cho `session_enabled_plugins`) — 3 loại quota built:
concurrent-session cap (global, `services/orchestrator`, Redis-đếm), max
session age (per-session, `sweep.ts`, đếm từ `createdAt` giữ nguyên qua mọi
rehydrate — không thể né quota bằng cách bị kill/rehydrate liên tục), và
token budget (per-session, **in-worker** — `packages/core/src/quota.ts`,
KHÔNG phải control-plane, vì usage token real-time chỉ nhìn thấy được ngay
tại chỗ request thật xảy ra; đưa nó ra ngoài worker nghĩa là phải cho worker
1 kết nối Redis/Postgres nó không cần cho việc gì khác — vi phạm "worker
không biết gì về multi-tenant"). Token budget dùng đúng cơ chế
`agent/pre-step: reject | enter(messages)` roadmap §2.2 đã định nghĩa sẵn —
không phát minh cơ chế mới; 1 reject tự động hiện ra ở FE vì
`client-ui-conversation` đã render mọi `reason.kind !== 'completed'` từ
Phase 4, không cần sửa gì thêm.

**Log retention — nén/archive/xoá thật, dùng `tar` thật qua execFile, không viết lại logic nén.**
`services/orchestrator/src/archive.ts` shell ra `tar` thật (cùng pattern
"1 lệnh thật của 1 tool hệ thống qua execFile, args array" đã dùng cho
`pnpm` và `curl`) — compress `dshHomeDir` thành `.tar.gz`, xoá bản sống, và
tự động RESTORE lại lúc `ensure()` tiếp theo, hoàn toàn trong suốt với caller.
`SessionRecord.status` thêm giá trị `'archived'`. Verify thật: 1 session có
reply thật → idle-hibernate → archive (xác nhận `.tar.gz` thật ~13KB trên
đĩa, thư mục sống biến mất) → reconnect cùng session id → reply replay lại
Y HỆT ký tự-cho-ký-tự, chứng minh round-trip nén không làm hỏng gì.
Delete-on-request (`DELETE /sessions/:id`) xoá cả live dir lẫn archive
tarball lẫn Redis record — verify: sau purge, reconnect cùng id trả về
`unknown session` thật (orchestrator cold-spawn 1 container mới nhưng
transport không tìm thấy log cũ), không phải hồi sinh session cũ.

**Telemetry — JSON structured log, không phải tracing backend.** Roadmap chỉ
yêu cầu "gắn `sessionId`" xuyên tầng — 1 hàm `log()` ~6 dòng lặp lại (đúng
convention "mirrored, not imported") ở cả `services/gateway`,
`services/orchestrator`, `services/plugin-registry`, và
`packages/transport` (phía worker). Verify thật: 1 lượt chat thật, `grep`
đúng `sessionId` xuất hiện trong cả 4 log — bằng chứng thật, không phải suy
luận từ code.

**Bug thật: TypeScript parameter-property KHÔNG chạy được dưới
`--experimental-strip-types`.** Viết `class OrchestratorHttpError extends
Error { constructor(message: string, public readonly status: number) {...} }`
— cú pháp tắt "parameter property" của TS (khai báo field NGAY trong tham số
constructor) yêu cầu compiler thật sự BIẾN ĐỔI code (emit thêm dòng gán
field), không chỉ XOÁ type annotation — mà `node --experimental-strip-types`
(cơ chế chạy `.ts` trực tiếp toàn bộ `services/*` dùng xuyên suốt dự án,
không qua bước build) chỉ làm STRIP, không TRANSFORM. Gateway crash ngay khi
restart: `SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]: TypeScript
parameter property is not supported in strip-only mode`. Fix: viết field +
gán tường minh trong thân constructor (`readonly status: number` rồi
`this.status = status`), không dùng cú pháp tắt. **Quy tắc cho code mới
trong `services/*`:** không dùng parameter properties — `tsc -b` (typecheck)
không bắt được lỗi này vì cú pháp hợp lệ về mặt TYPE, chỉ vỡ lúc RUN THẬT
bằng strip-only mode; đây là lý do "chạy thật" luôn bắt được lỗi mà
typecheck sạch vẫn để lọt.

**Bug thật thứ hai, do chính smoke-test script phát hiện: profile local
`~/.dsh/profiles/fox-harness` bị DRIFT khỏi `profile-template`.** Viết
`scripts/upstream-smoke-test.mjs` để verify boot manifest có đủ 3 plugin
`client-ui-*` — lần chạy đầu tiên FAIL thật, thiếu
`client-ui-conversation`/`client-ui-settings-plugins`. Không phải bug ở code
dự án — profile hand-set-up từ hồi Phase 1-2 test local (KHÔNG đi qua
`services/orchestrator/src/materialize.ts`, cơ chế duy nhất thật sự đồng bộ
với `profile-template`) không bao giờ được cập nhật lại khi thêm package
mới vào `profile-template/template/profile.package.json`. Fix cho chính
script, không phải sửa profile thủ công (sửa tay chỉ giấu triệu chứng, lần
sau lại drift): script tự regenerate 1 `$DSH_HOME` tạm thời
(`data/_smoke-dsh-home`, gitignored) từ ĐÚNG `profile-template` mỗi lần
chạy, không bao giờ dựa vào profile local cũ nữa. Không cần `node_modules`
riêng dưới profile tạm — `resolveBundleDir`'s installation-anchor resolution
(đã verify ở §17-19) tự tìm thấy mọi package `@fox-harness/*` qua
node_modules đã hoisted sẵn của chính repo. **Ý nghĩa lớn hơn con bug này:**
đây chính xác là kiểu lỗi `docs/upstream-upgrade-policy.md` được viết ra để
bắt — 1 smoke test dựa vào state cục bộ không được quản lý sẽ tự nó trở
thành nguồn false-positive/false-negative, đúng bài học nên áp dụng khi viết
BẤT KỲ smoke test nào trong tương lai.

**Baseline hạ tầng isolation thật hôm nay (đọc thẳng `docker.ts`/`Dockerfile`,
không phải giả định) — ghi lại trong `docs/microvm-isolation-strategy.md`
nhưng đáng note ở đây vì là 1 phát hiện xác đáng:** container worker hiện tại
KHÔNG có resource limit nào (`Memory`/`CpuShares` trống trong `HostConfig`),
chạy như root (không có dòng `USER` trong Dockerfile), security opt mặc
định của Docker. Đây là baseline thật, không phải điều đã biết trước — việc
thêm non-root user + resource limit là 2 việc RẺ, KHÔNG PHẢI microVM, đáng
làm sớm hơn (ghi lại, chưa tự làm lần này vì ngoài phạm vi câu hỏi đã hỏi
user).

---

## 22. Phase 7 — Authentication & Authorization thật, 2 role admin/user (2026-09-07)

**2 quyết định kiến trúc hỏi user trước khi code (đúng như chính roadmap's Phase 7
section đã ghi "không tự chọn khi build"):** lưu token ở đâu (JWT vs Redis) —
user chọn **Redis-backed** (thu hồi tức thì, tái dùng hạ tầng Phase 3 có
sẵn); ai enforce authorization — user chọn **chỉ gateway** (đơn giản hơn,
rủi ro thật đã ghi rõ: nếu port nội bộ orchestrator/plugin-registry lỡ bị
expose ra ngoài thì mọi check ở gateway bị bypass hoàn toàn — đây không phải
lỗ hổng ẩn, mà là đánh đổi đã biết trước).

**Thiết kế cốt lõi — session ownership sống hoàn toàn ở gateway, không đụng
orchestrator/plugin-registry.** Vì quyết định "chỉ gateway enforce", 2
service kia không cần biết khái niệm user/owner gì cả — bảng
`session_owners` mới hoàn toàn thuộc gateway's Postgres bookkeeping riêng
(`infra/migrations/002_users_and_ownership.sql`), không phải field mới
trong `SessionRecord` của orchestrator's Redis. Kết quả: **0 dòng code nào
trong `services/orchestrator` hay `services/plugin-registry` bị sửa ở Phase
7** — toàn bộ thay đổi backend nằm gọn trong `services/gateway`. Đúng tinh
thần giữ ranh giới `services/*` sạch mà dự án đã theo suốt từ Phase 1.

**Session không có chủ (tạo trước Phase 7) — xử lý bằng chính logic check,
không cần bước migrate riêng.** `canAccessSession()`: `admin` luôn qua;
`user` phải khớp `session_owners.owner_id`. Không có row nào cho 1 session
= không user thường nào khớp = tự động rơi về "chỉ admin" — đúng hệ quả an
toàn tự nhiên của chính điều kiện đã viết, không cần thêm code migrate/gán
lại chủ cho dữ liệu cũ.

**2 giới hạn trình duyệt thật buộc phải dùng lại đúng 1 cách giải quyết đã
có từ trước (không phát minh cơ chế thứ hai):** dynamic `import()` của
`client.js` không set được custom header — WS upgrade đã giải quyết vấn đề y
hệt này từ Phase 2 (`?token=` query param, vì browser không set header tuỳ ý
được lúc upgrade). Phase 7 dùng LẠI đúng `?token=` cho `client.js` thay vì
nghĩ ra cách khác — `identityFromRequest()` chấp nhận cả header lẫn query
param, không phân biệt theo route.

**Password hashing — `crypto.scrypt` built-in, cố tình né native module.**
Không dùng bcrypt/argon2 (cả hai đều native binding) — dự án đã có 1 vết sẹo
thật với native module (`node-pty` trên Alpine/musl, §17 bug #3). `scrypt`
là KDF memory-hard thật, đúng chuẩn Node tự khuyến nghị trong doc chính thức
của `node:crypto`, không cần dependency ngoài nào.

**Route nguy hiểm nhất trước Phase 7 hoá ra không tồn tại qua gateway —
đáng ghi lại vì dễ hiểu nhầm.** Trước Phase 7, ai cũng tưởng
`POST /catalog/:id/approve` (duyệt plugin) là lỗ hổng "thiếu check token"
giống các route khác — thực ra kiểm tra lại thì gateway **CHƯA BAO GIỜ proxy
route đó cả** (chỉ `GET /plugin-catalog`, `GET .../plugins`,
`POST .../enable|disable` được proxy từ Phase 5). Nghĩa là route approve chỉ
gọi được bằng cách hit thẳng cổng nội bộ `:4200` — vô tình "an toàn" chỉ vì
chưa ai nối dây tới nó qua gateway, không phải vì có bảo vệ thật. Phase 7
vừa thêm route `POST /plugin-catalog/:id/approve` (admin-only) VÀ
`POST /plugin-catalog` (submit, mọi role) lần đầu tiên — nghĩa là trước khi
thêm check quyền, phải thêm CẢ route proxy vốn chưa hề có, không chỉ vá
route đã có.

**Verify thật đầy đủ (script Node, gọi HTTP + WS thật qua gateway, không
phải browser):** đăng ký 2 tài khoản `user` thật + dùng admin bootstrap qua
`scripts/create-admin.mjs` → login cả 3 lấy token thật → `GET /users` không
token → `401`, role `user` → `403`, role `admin` → `200` liệt kê đúng tài
khoản thật → tạo 1 session thật thuộc user A → user B đọc manifest/reconnect
WS session đó → `403` cả 2 đường (HTTP lẫn WS) → admin đọc được (bypass
đúng) → `GET /sessions` (admin) liệt kê đúng owner thật → user A submit
plugin demo thật → user A tự approve bị `403` → admin approve → `200` →
1 lượt chat thật vẫn hoàn thành đúng qua session đã bị ownership-gate →
purge session → owner cũ giờ bị `403` (ownership row đã xoá, không phải hồi
sinh session). Toàn bộ PASS thật, không phải suy luận từ code.

**1 bug thật trong chính script test, không phải trong gateway — đáng ghi
lại vì đúng loại bug đã gặp trước đây (§16).** Test đầu tiên treo >120s ở
bước "chat turn thật". Nguyên nhân: script dùng `ws.once('message', ...)`
để lấy `sessionId` từ frame đầu, RỒI SAU ĐÓ mới gắn 1 listener `on('message', ...)` thường trực để đọc các frame tiếp theo — khoảng trống giữa 2
listener đó (trong lúc script làm hàng loạt HTTP call khác) đủ để frame
`snapshot` đến và biến mất vĩnh viễn (`EventEmitter` không buffer). Fix:
gắn listener thường trực (queue pattern) NGAY sau khi mở WS, đọc mọi frame
kể cả frame đầu tiên từ CÙNG 1 queue đó — không bao giờ dùng `.once()` xen
giữa. Đúng bài học "gắn listener trước khi làm bất cứ việc async nào khác
trên cùng socket" đã rút ra lần đầu ở §16, giờ tái phạm lần 2 vì viết script
mới mà không tra lại bài học cũ trước.

---

## 23. Phase 9 — React + module loader tự chế kiểu dsh (2026-09-07)

**2 quyết định kiến trúc hỏi user trước khi code (đúng như chính phase doc
đã ghi "không tự chọn khi build"):** (1) cách chia sẻ 1 instance React duy
nhất giữa các plugin tải độc lập — đề xuất import map chuẩn của trình duyệt
(rẻ hơn, không cần code tự viết), user chọn đi đúng hướng dsh: tự viết
module loader kiểu `factory(require)`. (2) không có quyết định thứ 2 tách
riêng — phong cách styling (CSS-in-JS vs giữ token `--fh-*`) được quyết định
ngầm khi viết code: giữ nguyên hệ token `--fh-*` đã có từ Phase 4, chỉ đổi
cách áp dụng (qua React thay vì DOM thuần) — không thêm CSS-in-JS, tận dụng
lại đúng token đã verify từ trước thay vì phát minh style pipeline mới.

**Kiến trúc thật đã build:**
- `scripts/build-client-plugins.mjs` — bundler thật ĐẦU TIÊN của dự án
  (esbuild). Với 3 package UI: bundle `src/client/index.tsx`, đánh dấu
  `react`/`react-dom`/`react-dom/client`/`react/jsx-runtime` là `external`
  (format `cjs`, để lại `require(...)` thật trong output), rồi tự bọc output
  đó trong `window.__FOX_MODULES__.define(id, function(require) {...})` —
  kỹ thuật "UMD-wrap 1 bundle CJS thật" chuẩn, không có gì huyền bí. Với
  `apps/web` (shell/host): bundle KHÔNG external React — nhúng thật vào
  `public/main.js`, đây là bản duy nhất mọi plugin sẽ `require()` tới.
- `apps/web/src/main.ts` — thêm `window.__FOX_MODULES__` (`define`/`require`,
  memoize theo id), đăng ký `react`/`react-dom`/`react-dom/client`/
  `react/jsx-runtime` TRƯỚC khi tải plugin nào. `loadManifest()` đổi từ 1
  bước (`import()` rồi dùng thẳng kết quả) sang 2 bước: `import()` chỉ để
  chạy side-effect đăng ký, rồi `__FOX_MODULES__.require(entry.id)` lấy
  export thật — có fallback về kết quả `import()` thô nếu plugin không đăng
  ký gì (không ép mọi plugin tương lai phải qua pipeline mới).
- Cả 3 package UI viết lại bằng React thật (function component + hooks),
  KHÔNG port logic imperative cũ nguyên xi — đặc biệt `client-ui-conversation`
  chuyển từ DOM-append trực tiếp sang state khai báo thật
  (`entries: LogEntry[]` + `liveBubbles: Map`), khớp đúng cách React yêu cầu
  suy nghĩ, không chỉ bọc code cũ trong 1 component cho có.
- Hợp đồng `mount(root): () => void` GIỮ NGUYÊN — chỗ duy nhất thay đổi là
  BÊN TRONG `mount` giờ gọi `createRoot(container).render(...)` và trả về
  `() => reactRoot.unmount()`. Toàn bộ cơ chế manifest/dispose/Phase 4-5 đã
  verify trước đó không cần sửa gì ở tầng giao thức.

**1 bug thật khi viết `client-ui-conversation`: TypeScript không narrow
discriminated union xuyên qua closure lồng trong `setState` updater.**
`if (data.chunk.type === 'text-delta' || data.chunk.type === 'reasoning-delta') { setLiveBubbles(prev => { ... data.chunk.text ... }) }`
— TS narrow đúng ở outer `if`, nhưng bên trong callback truyền cho
`setLiveBubbles` (1 closure lồng), TS không mang narrowing đó theo (đúng lớp
bug đã gặp ở §19, giờ gặp lại dưới dạng MỚI — không phải nested function
declaration lần này mà là nested arrow callback truyền làm tham số). Fix
CÙNG NGUYÊN TẮC nhưng khác cách áp dụng: thay vì rebind biến object đã
narrow, tách hẳn GIÁ TRỊ PRIMITIVE (`const textDelta = chunk.text`, 1
string) ra NGOÀI closure trước khi gọi `setLiveBubbles` — 1 `string` không
còn gì để narrow, nên không còn gì để TS làm sai bên trong closure nữa. Bài
học rộng hơn: khi rebind-để-né-mất-narrowing không tiện (giá trị cần dùng
nằm sâu trong 1 callback bất đồng bộ), tách PRIMITIVE ra ngoài luôn hiệu quả
hơn tách OBJECT.

**Verify thật — không chỉ "build được, không crash" (đúng tiêu chí đã tự đặt
ra khi viết phase doc):**
1. **jsdom thật, React thật, file bundle thật** (không phải test double) —
   `apps/web/scratch/verify-react-sharing.mjs` (đã xoá sau khi verify, đúng
   convention dự án): dựng `window`/`document` bằng jsdom thật, đăng ký
   đúng 1 instance `react`/`react-dom`/`react-dom/client`/`react/jsx-runtime`,
   `import()` trực tiếp 3 file `lib/client/index.js` thật đã bundle, gọi
   `require('react')` qua module loader xác nhận `=== ` đúng instance đã
   đăng ký. Mount CẢ 3 plugin CÙNG LÚC (theme + settings-plugins +
   conversation) — nếu chúng có instance React khác nhau, React 18 sẽ throw
   "invalid hook call" ngay khi component thứ 2 render hook — KHÔNG throw
   chính là bằng chứng thật, không chỉ so sánh identity object suông.
   `client-ui-conversation` verify cả state thật: snapshot → bubble user
   thật hiện đúng text, streaming chunk → live bubble thật cập nhật đúng
   text, `assistant/message` → live bubble bị thay bằng bubble final đúng
   text. Dispose cả 3 → `#app` sạch hoàn toàn, 0 child node còn lại.
2. **Qua đúng chuỗi hạ tầng thật** — `services/gateway/scratch/phase9-e2e.mjs`
   (đã xoá sau khi verify): đăng ký/login thật → tạo session thật qua
   gateway → `GET /manifest` thật liệt kê đúng 3 plugin → fetch từng
   `client.js` thật qua đúng đường gateway proxy (không phải đọc file cục
   bộ) → xác nhận bytes thật ĐÃ ĐÚNG format bọc (`window.__FOX_MODULES__.define(...)`)
   và `react` thật là external (không lẫn source React vào bundle) → ghi
   bytes đó ra file tạm, `import()` thật trong Node + jsdom, mount thật —
   chứng minh KHÔNG chỉ file cục bộ đúng mà cả chuỗi build→Docker
   image→transport serve→gateway proxy cũng cho ra đúng bytes hoạt động
   được.
3. **Hồi quy** — `scripts/upstream-smoke-test.mjs` (Phase 6) chạy lại sạch
   sau toàn bộ thay đổi — xác nhận việc đổi cả tầng FE không làm hỏng
   turn/step/manifest/resume ở tầng dưới.

**Chưa verify được (ghi rõ, không tự nhận đã xong):** click-through thật
trong browser thật (vẫn chưa có Claude in Chrome, giống mọi lần trước trong
dự án này) — jsdom mô phỏng DOM/React chuẩn xác cho mục đích test, nhưng
không phải browser thật 100%. React dev build (chưa phân biệt dev/prod —
`apps/web/public/main.js` ~1MB, gồm cả code check/warning của React dev
mode) chưa tối ưu kích thước — dự án chưa có khái niệm build production
riêng ở bất kỳ đâu, không phải vấn đề mới do Phase 9 gây ra.

---

## 24. Research thật cho Phase 11 — cơ chế `external` thật của dsh, phát hiện SAU KHI Phase 9 đã code xong (2026-09-07)

**User hỏi thẳng "có tham khảo dsh chưa" lúc đang thiết kế Phase 11 — câu
trả lời thật lúc đó là CHƯA.** Toàn bộ thiết kế `window.__FOX_MODULES__` ở
Phase 9 (§23) được viết từ suy luận riêng dựa trên hình dạng
`window.__ModuleLoader__.load({id, factory: (require) => ...})` đã quan sát
được từ trước (§19), KHÔNG phải từ việc đọc cơ chế RESOLVE dependency thật
đứng sau nó. Đi đọc ngay sau khi bị hỏi — đúng kỷ luật "research thật trước
khi thiết kế" mà dự án này tự đặt ra nhưng lần này đã bỏ sót.

**Đọc trực tiếp `node_modules/@deepseek-ai/dsh-client-modules/lib/client.js`
(323 dòng, KHÔNG minify — chính là code thật đứng sau `window.__ModuleLoader__`,
gói `"Client module system, dual-face: node half composes the __DSH_BOOT__
entry graph ..., browser half is the lazy-CJS module table"`):**

1. `external` là 1 field khai báo THẬT trên từng manifest entry
   (`row.external`, validate bằng `optionalStringArray(...)`, đọc từ *"a
   `dsh.client` declaration or from the boot wire"*) — server sinh manifest
   đọc field này từ `dsh.client` của package, ghi thẳng vào wire
   (`{id, url, rev, external: [...]}`). Browser KHÔNG tự đoán bundle cần gì.
2. React tự nó cũng chỉ là 1 "row" trong graph (hoặc 1 "seed" — module host
   cấp thẳng, không qua bundle) — `arriveGraphRow()` xử lý MỌI entry đồng
   nhất, đệ quy load `row.external` trước khi load chính entry đó. Không có
   case đặc biệt hard-code nào cho React — khác thật với `window.__FOX_MODULES__`
   hiện tại của dự án này (Phase 9 hard-code 4 dòng `define('react', ...)`
   trong shell, không phải cơ chế graph tổng quát).
3. Có "build-time bundle purity gate" (nhắc 2 lần trong code) — dsh thật
   verify Ở LÚC BUILD (build tool riêng của họ, `tsdown`) rằng bundle khớp
   đúng `external` đã khai báo. Đây là verify ở PHÍA TÁC GIẢ, dự án này
   không kiểm soát được build tool của tác giả plugin bên thứ ba.

**Ảnh hưởng thật, không chỉ lý thuyết:**
- **Phase 9 (đã code, không sửa lại):** cách hard-code 4 dòng vẫn hợp lý
  cho quy mô hiện tại (3 package first-party, đúng 1 dependency cần chia
  sẻ) — một đơn giản hoá CÓ CHỦ Ý, không phải sai, nhưng khác thật với dsh's
  generalized graph mechanism. Ghi lại ở đây để không ai nhầm đây là đã
  "clone đúng cơ chế dsh" — chỉ là cùng Ý TƯỞNG (seed + external), khác hẳn
  độ tổng quát.
- **Phase 11 (chưa code, đã sửa lại thiết kế trong roadmap):** đổi tên field
  từ tự nghĩ ra sang đúng tên thật `dsh.client.external` (khớp convention
  dsh), nhưng GIỮ LẠI bước verify nội dung bundle sau build (grep tìm
  `ReactCurrentDispatcher`) làm lớp phòng vệ thật — vì dự án này không có
  "build-time purity gate" như dsh để bắt lỗi này từ phía tác giả, field
  khai báo suông không đủ tin cậy một mình.

**Bài học rộng hơn:** hỏi lại "đã tham khảo chưa" giữa lúc thiết kế, không
đợi tới lúc code xong, là cách rẻ nhất để bắt lỗi kiểu này — research sau
khi đã viết cả 1 phase doc vẫn tốt hơn không research, nhưng research TRƯỚC
khi viết docs (như mọi phase khác trong dự án này đã làm) vẫn luôn rẻ hơn.

---

## 25. Phase 11 — plugin bên thứ ba tự động tương thích, và 1 bug hạ tầng thật có từ trước, chưa từng bị phát hiện (2026-09-07)

**Đã build đúng thiết kế đã sửa ở §24**: `templates/plugin-react-ui/` (repo
mẫu thật, build được độc lập — verify bằng cách copy RA NGOÀI repo này, cài
`pnpm install` riêng, build thật, xác nhận `lib/client.js` có
`require("react")` thật, KHÔNG có `ReactCurrentDispatcher` nào — react ở
ngoài thật sự); `services/plugin-registry/src/client-wrap.ts` (hàm
`wrapClientModule`/`looksLikeRealReactIsBundled`/`resolveClientExportPath`);
`build.ts` gọi các hàm đó sau khi copy artifact, xoá sạch `dest` nếu wrap
thất bại (không để lại artifact nửa vời).

**1 bug thật trong chính template lúc viết** — `package.json`'s build
script dùng `tsc -p tsconfig.json --noEmit` — cờ `--noEmit` khiến
`src/index.ts` (entry PHÍA SERVER) không bao giờ được compile ra
`lib/index.js` — plugin build "thành công" (không lỗi gì) nhưng thiếu hẳn
file mà `dsh`'s Cordis loader cần để `import` bundle đó. Phát hiện được nhờ
verify thật (copy plugin ra ngoài, build, `ls lib/` thấy thiếu file) chứ
không phải đọc code suông. Fix: bỏ `--noEmit`, để `tsc` emit thật (kể cả
emit ra 1 bản `lib/client.js` phẳng chưa bundle — vô hại, `build.mjs` ghi đè
lại ngay sau).

**Bug hạ tầng thật, có từ trước Phase 11, chưa từng bị phát hiện tới giờ —
đáng chú ý nhất phiên này:** verify thật đầy đủ (build → approve → enable →
fetch client.js thật qua đúng chuỗi gateway → orchestrator → worker) phát
hiện `packages/transport`'s route `GET /plugins/:id/client.js` **CHƯA BAO
GIỜ thật sự phục vụ được client.js của plugin không thuộc scope
`@fox-harness/*`** — kể cả `fox-harness-demo-hello` (plugin demo đã "verify
thành công" nhiều lần ở Phase 5/6) cũng lỗi y hệt khi test lại. Té ra các
lần verify Phase 5/6 trước đó chỉ xác nhận `GET /manifest` LIỆT KÊ đúng
plugin (chứng minh `ctx.clientManifest.register()` chạy đúng) — **chưa bao
giờ thật sự fetch nội dung `client.js`** của 1 plugin bên thứ ba qua route
đó. Một gap verify thật, không phải suy đoán — lỗi nằm im tới khi Phase 11's
test mới thật sự đi fetch bytes.

**Nguyên nhân thật (đọc trực tiếp `@deepseek-ai/dsh-app-boot/lib/index.js`,
tìm `packageDirFromAnchor`/`resolveBundleDir`):** route cũ dùng thẳng
`import.meta.resolve(`${id}/client`)` — resolution CHUẨN của Node, đi theo
REALPATH của `packages/transport/lib/server.js` (Node theo mặc định resolve
qua symlink về đường dẫn thật, không giữ nguyên đường dẫn symlink) rồi đi
lên tìm `node_modules` — chỉ chạm tới `/repo/node_modules/`, nơi
`@fox-harness/*` CÓ mặt (nhờ `entrypoint.sh`'s symlink riêng cho đúng
scope đó), nhưng KHÔNG BAO GIỜ chạm tới
`/data/profiles/fox-harness/node_modules/` — nơi mọi plugin bên thứ ba thật
sự sống (do `services/orchestrator`'s materialize.ts hoặc
`services/plugin-registry` copy vào). Cơ chế 2-anchor thật của dsh
(`resolveBundleDir`, dùng `createRequire(anchor).resolve.paths(...)`) CHỈ
tồn tại BÊN TRONG code nội bộ của `dsh-app-boot` để nó tự compose cây bundle
— không hề patch/hook resolution toàn cục, nên code KHÁC (như
`packages/transport`) gọi `import.meta.resolve` thẳng không hề được hưởng
cơ chế đó.

**Fix:** `packages/transport/src/server.ts` thêm `resolveClientBundlePath(id)`
— thử `import.meta.resolve` trước (vẫn đúng, nhanh, cho case
`@fox-harness/*`), nếu thất bại thì fallback dùng
`createRequire(profilePackageJsonPath).resolve(`${id}/client`)` — cùng ý
tưởng `packageDirFromAnchor` thật của dsh, neo (anchor) vào
`$DSH_HOME/profiles/fox-harness/package.json` thay vì
`packages/transport`'s own path. Verify lại: cả `fox-harness-demo-hello` LẪN
`fox-harness-demo-react-plugin` mới đều fetch được client.js thật qua đúng
route, không cần build lại 2 plugin đó, chỉ cần rebuild+redeploy
`packages/transport`.

**Verify thật đầy đủ (script Node, HTTP + WS thật qua gateway, jsdom + React
thật, không phải browser):** đăng ký + login thật → session thật → enable
plugin bên thứ ba thật cho session đó → chờ đúng frame `{type:'manifest'}`
LIVE (không sleep mù, đúng bài học đã ghi nhiều lần) → `GET /manifest` liệt
kê đủ 4 plugin (3 first-party + 1 third-party) → fetch cả 4 `client.js`
THẬT qua đúng chuỗi gateway proxy → mount cả 4 CÙNG LÚC bằng jsdom + React
thật, không lỗi invalid-hook-call (bằng chứng thật shared-instance hoạt
động xuyên ranh giới plugin store, không chỉ với 3 package first-party như
Phase 9 đã verify) → dispose sạch cả 4. Riêng đường TỪ CHỐI: 1 plugin cố ý
khai `external:["react"]` nhưng build không tôn trọng (xoá dòng `external`
khỏi cấu hình esbuild của chính plugin đó) → registry từ chối thật (422),
không để lại artifact mồ côi trên đĩa (verify bằng `ls` thư mục artifacts).

**1 bug nhỏ trong chính script test — không phải sản phẩm:** lần chạy đầu
sau khi sửa `packages/transport`, 2/4 plugin (2 cái mount SAU CÙNG trong
vòng lặp) hiện ra DOM rỗng dù không throw lỗi gì. Nguyên nhân: React 18's
`createRoot().render()` dùng scheduler bất đồng bộ (concurrent mode) — gọi
LIÊN TIẾP 4 lần trong 1 vòng lặp đồng bộ rồi chỉ đợi đúng 1
`setTimeout(...,0)` không đủ để TẤT CẢ 4 root flush xong trong môi trường
jsdom (không có `MessageChannel`/scheduling y hệt browser thật). Fix (chỉ
trong test): đợi 200ms thay vì 0ms — đủ để mọi root flush. Không phải bug
thật của Phase 11, chỉ là hạn chế của cách verify không dùng `act()` (tiện
ích test chính thức của react-dom cho đúng việc này) — ghi lại vì sẽ gặp
lại nếu viết thêm test kiểu này sau này.

---

## 26. Phase 10 (một phần) — layout 3-cột thật, dựa trên thuật toán thật của dsh (2026-09-07)

**Phạm vi thật đã làm — CHỈ mục 1 trong 3 việc Phase 10 liệt kê, ghi rõ,
không tự nhận đã xong cả phase.** Roadmap Phase 10 có 3 việc: (1) layout
3-cột, (2) cập nhật lại Phase 8 dựa trên `dsh-client-ui-renderer` thật (một
việc DOCS, không phải code), (3) restructure state của `client-ui-conversation`
theo store pattern thật của dsh. User yêu cầu cụ thể "sidebar, button, chat"
— chỉ làm mục (1) lần này. Mục (2) và (3) VẪN CHƯA LÀM, còn treo.

**Đọc kỹ toàn bộ thuật toán thật** (không chỉ đọc sơ như lúc viết phase doc)
— `node_modules/@deepseek-ai/dsh-client-ui-layout/lib/client.js`, hàm
`computeColumns(viewport, sidebar, details)` thật:
```
s = sidebar===0 ? 56 : clamp(sidebar, 264, 420)
d0 = details===0 ? 0 : clamp(details, 300, 520)
nếu s+d0+640 <= viewport: {sidebar:s, center:viewport-s-d0, details:d0}
nếu không, d1 = d0===0 ? 0 : max(300, viewport-s-640); nếu s+d1+640<=viewport: {sidebar:s, center:640, details:d1}
nếu không: {sidebar:s, center:max(0,viewport-s), details:0}
```
Hằng số `SIDEBAR_AUTO_COLLAPSE = 1024` (breakpoint auto-collapse sidebar
thành rail). Reimplement Y HỆT thuật toán này trong `apps/web/src/main.ts`
(hàm `computeColumns`/`clampWidth`, cùng 2 hằng số 1024/56) — **cố tình bỏ**
tính năng drag-resize thật của dsh (pointer capture + rAF-throttled drag
handle, 2 handle riêng cho sidebar/details) — sidebar v1 ở đây có độ rộng CỐ
ĐỊNH (280px mở, 56px rail), không kéo tay được. `details` column vẫn tính
toán trong thuật toán (luôn = 0, chưa có gì chiếm) nhưng không render —
giữ đúng dạng 3-way thật thay vì đơn giản hoá bớt, dù hiện chỉ đi qua 2
nhánh đầu trong thực tế.

**Routing plugin vào sidebar vs center — hard-code, không phải hệ thống
tổng quát (đúng đã ghi trong phase doc: hệ slot tổng quát là việc Phase 8).**
`apps/web/src/main.ts`'s `SIDEBAR_PLUGIN_IDS` — 1 `Set` chứa đúng 1 id
(`@fox-harness/dsh-client-ui-settings-plugins`) — `loadManifest()` tra
Set này để quyết định `mount(sidebarRoot)` hay `mount(centerRoot)`. Thêm
plugin mới vào sidebar sau này = thêm id vào Set, không có cơ chế tự động
nào cả.

**1 vấn đề CSS thật gặp phải khi restructure — flex-fill chain bị đứt vì 1
tầng div trung gian không có class.** `client-ui-conversation`'s `mount()`
tạo 1 `<div>` KHÔNG có class/id rồi append `#log`/`#send-form` (qua React
Fragment) vào trong đó. CSS ban đầu viết `#center-col > #log { flex:1;
overflow-y:auto }` — SAI, vì `#log` không phải con TRỰC TIẾP của
`#center-col` (có 1 div bọc ở giữa) — selector không bao giờ khớp, `#log`
không co giãn được, đẩy cả trang cao ra thay vì cuộn nội bộ. Fix: đặt tên
class thật cho div bọc đó (`container.className = 'fh-conversation-root'`)
rồi viết đúng CHUỖI flex-fill hoàn chỉnh — `#center-col` (flex column) →
`.fh-conversation-root` (flex:1, min-height:0, flex column) → `#log` (flex:1,
min-height:0, overflow-y:auto). Thiếu `min-height:0` ở BẤT KỲ khâu nào trong
chuỗi cũng làm nó vỡ (mặc định `min-height:auto` của flexbox khiến nội dung
đẩy container cao lên thay vì container giữ cố định rồi nội dung tự cuộn) —
lỗi CSS flexbox kinh điển, ghi lại vì dễ tái phạm.

**Verify thật — không chỉ "build được, không lỗi TypeScript":**
1. **jsdom + real built `apps/web/public/main.js`+`index.html`** (không
   phải file tự viết) — mock CHỈ ĐÚNG 1 chỗ THẬT SỰ CẦN (jsdom không tính
   layout thật, `getBoundingClientRect()` luôn trả về 0 — set thẳng giá trị
   viewport giả trên `#app` TRƯỚC khi import `main.js`, để `updateFrameColumns()`
   chạy lúc module load dùng đúng số đó). Verify: viewport 1200px →
   `grid-template-columns` thật = `"280px 920px"` (khớp tay tính theo đúng
   `computeColumns`); viewport 800px (dưới breakpoint 1024) →
   `"56px 744px"` (sidebar co về rail đúng). Cả 2 con số đều tính tay đối
   chiếu, không đoán.
2. **Routing thật** — mount `client-ui-settings-plugins`'s bundle THẬT (file
   đã build, không phải code viết lại) vào đúng `sidebarRoot` mà `main.js`
   thật tạo ra, xác nhận panel render đúng bên trong `#sidebar-col`, và
   KHÔNG lọt sang `#center-col`.
3. **Qua đúng chuỗi hạ tầng thật** — rebuild Docker image (client-ui-conversation/
   client-ui-settings-plugins đổi), restart toàn bộ service, xác nhận static
   server serve đúng `index.html`/`main.js` mới (grep tìm
   `sidebar-col`/`SIDEBAR_AUTO_COLLAPSE` thật có trong file served), chạy lại
   `scripts/upstream-smoke-test.mjs` (Phase 6) sạch — xác nhận restructure
   layout không làm hỏng turn/step/manifest/resume ở tầng dưới.

**Chưa verify được (ghi rõ):** hành vi RESIZE THẬT trong browser thật (kéo
cửa sổ qua breakpoint 1024px, xem transition mượt không) — vẫn chưa có
Claude in Chrome, giống mọi lần trước. jsdom chỉ verify được ĐẦU RA của
thuật toán cho 1 viewport CỐ ĐỊNH tại thời điểm mount, không verify được
`ResizeObserver` thật phản ứng theo thời gian thực (đã stub `ResizeObserver`
trong test vì jsdom không có sẵn).

## 27. Phase 12 — đa-session, model picker, settings dialog thật, command palette; 1 slots system tự thiết kế thay vì clone dsh (2026-09-07)

**Quyết định thiết kế lớn nhất: KHÔNG clone `ctx.slots` thật của dsh.** Đọc
hết 988 dòng `dsh-client-ui-renderer/lib/client.js` trước khi code (đúng
yêu cầu của chính Phase 12's doc) — phát hiện `ctx.slots` thật không chỉ là
"outlet kind single/list" như suy đoán ban đầu, mà là CẢ 1 runtime Cordis
phía browser: session-scoped entries (`SessionMaybeEntry` với "adoption"
semantics), chain election, per-entry error boundary
(`SlotErrorBoundary`), locale integration, store-per-entry, injected Hooks
theo factory. Đúng tinh thần "nấc 2, fork mỏng" đã áp dụng suốt dự án —
KHÔNG port hệ đó. Thay vào đó tự thiết kế 1 cơ chế NHẸ đạt đúng hành vi
quan sát được cần cho Phase 12 (`single`/`list`, thứ tự, dispose sạch) xây
trên contract `mount(root): dispose` đã có sẵn từ Phase 4 — không phải hệ
component/context mới:
- `ClientManifestEntry.slot?: {outlet, order?}` — khai báo Ở PHÍA SERVER
  (trong chính `apply(ctx)` của package, giống `immediately`), không phải
  client tự suy luận — nhất quán với phát hiện `dsh.client.external` ở
  Phase 11 (server luôn là nguồn khai báo, không phải browser tự đoán).
- `apps/web/src/main.ts`'s `OUTLETS` map cố định (`sidebar.workspaces`:
  single, `settings.sections`: list) — KHÔNG có cơ chế đăng ký outlet động,
  reactivity dựa hẳn vào cơ chế "remount toàn bộ khi manifest đổi" đã có sẵn
  từ Phase 5 (`{type:'manifest'}` frame), không xây pub/sub riêng cho slot.
- Kết quả: thay hẳn hack cũ Phase 10 (`SIDEBAR_PLUGIN_IDS`, 1 Set id cứng)
  bằng cơ chế khai báo thật, nhưng độ phức tạp code thêm vào rất nhỏ (~60
  dòng trong `loadManifest()`), không phải 1 package mới.

**Settings dialog: KHÔNG nav-rail tab như dsh thật.** dsh thật
(`dsh-client-ui-settings-general`) có nav rail chọn section, dialog chỉ
hiện 1 section tại 1 thời điểm. V1 ở đây chỉ STACK toàn bộ section đã đăng
ký vào `settings.sections` (list outlet) thành 1 danh sách cuộn — đủ cho 2
section (`client-ui-settings-plugins`, `client-ui-plugin-inventory` mới),
không đáng công xây tab-switching cho 2 mục.

**Model picker: model là lựa chọn LÚC TẠO SESSION, lưu ở Redis
`SessionRecord.model`, không phải Postgres.** Vì mỗi session đã là 1
container riêng (Phase 0), cách rẻ nhất khớp kiến trúc có sẵn là: FE gửi
`?model=` trên URL WS upgrade CHỈ khi `sessionPath==='new'`
(`services/orchestrator/src/ensure.ts` validate against
`config.allowedModels`, ném `InvalidModelError` → gateway trả 400) → lưu
`model` vào `SessionRecord` lúc spawn → MỌI lần rehydrate sau đó
(`existing.model`) dùng lại đúng giá trị đó, KHÔNG đọc lại tham số `model`
mới nào (matching "chỉ chọn lúc tạo, không đổi giữa phiên" đã ghi trong
Ngoài-phạm-vi). Warm pool (`warmpool.ts`) SPAWN VỚI
`config.allowedModels[0]` TƯỜNG MINH (không phải "bất cứ gì
`OPENAI_MODEL_ID` env đang set" — 2 giá trị này có thể lệch nhau 1 khi
operator cấu hình `OPENAI_ALLOWED_MODELS` là danh sách thật), và
`ensure.ts` chỉ claim từ pool khi CẢ `profileVariant` lẫn `model` đều không
được chỉ định — request nào chỉ định 1 trong 2 đều cold-spawn, đúng quy tắc
đã có sẵn cho `profileVariant` từ Phase 4, áp lại cho `model`.

**1 bug thật tự gây ra rồi tự bắt được ngay bằng typecheck, đáng ghi lại
làm bài học:** viết `services/gateway/src/redis.ts` MỚI (cho
`getLiveSessionStatus`) mà KHÔNG đọc file cũ trước — file đó đã tồn tại từ
Phase 7 (token store thật, `fh:gwtoken:*`) và bị `Write` ghi đè mất hoàn
toàn. `tsc -b` báo lỗi ngay lập tức (`auth.ts` mất `resolveToken`/
`revokeToken`/`storeToken`/`TokenRecord`) — vì dự án CHƯA TỪNG commit 1 lần
nào (`git status` trống từ đầu), không có cách nào `git diff`/khôi phục từ
lịch sử; phải đọc lại `auth.ts`'s cách gọi để TÁI TẠO lại đúng 4 export đó
bằng tay, rồi mới thêm phần mới vào. Bài học: **Read trước khi Write, không
có ngoại lệ nào cho "chắc chắn file này chỉ mới mình đụng tới"** — dự án
không phải lúc nào cũng nhớ hết mọi file đã tồn tại từ phase trước, và ở
đây không hề có git history làm lưới an toàn.

**1 bug thật tìm được bằng chính test dispose (không phải đoán trước):**
outlet kind `list`'s wrapper `<div>` — do CHÍNH `loadManifest()` tạo ra để
bọc mỗi entry (không phải do plugin tạo) — không bao giờ bị xoá khi
unmount, vì disposer plugin trả về chỉ xoá đúng cái NÓ tự thêm vào bên
trong wrapper, không biết gì về wrapper. Rò rỉ 1 `<div>` rỗng mỗi lần
`{type:'manifest'}` frame kích hoạt remount-toàn-bộ (Phase 5's cơ chế có
sẵn) — càng bật/tắt plugin nhiều, DOM càng rác. Test dispose
(`apps/web/scratch/verify-slots-e2e.mjs`, đúng kỷ luật docs/code-rules.md
§6 Phase 5 "mọi mutation phải reversible") bắt được ngay ở lần chạy đầu.
Sửa: compose 1 disposer MỚI gọi cả `dispose()` gốc lẫn `wrapper.remove()`,
thay vì chỉ push thẳng `dispose()` gốc. Chỉ outlet `list` bị — `single` và
slotless mount thẳng vào container của outlet, không có wrapper trung gian
nào cả nên không có gì rò rỉ.

**1 giới hạn môi trường jsdom MỚI phát hiện (không phải bug sản phẩm):**
`runScripts:"dangerously"` chạy script qua Node's `vm` module, và `vm`
KHÔNG có sẵn `importModuleDynamically` callback — mọi `import()` động thật
sự (không phải static) bên trong script chạy qua đường này ném thẳng
`ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`. `apps/web/src/main.ts`'s
`loadManifest()` dùng chính xác `await import(url)` để tải plugin bundle —
nghĩa là chạy `main.js` NGUYÊN VẸN qua jsdom's vm không bao giờ tải được
plugin thật. Cách né (không phải sửa sản phẩm): phần còn lại của
`main.js` (đăng ký `window.__FOX_MODULES__`, wiring click cho settings
dialog, ...) vẫn chạy đúng qua đường jsdom's vm (verify riêng: dialog
mở/đóng đúng); PHẦN mount plugin được lái sang chạy ở REALM Node top-level
thật (`import()` ở đó không bị giới hạn này) bằng cách alias
`globalThis.window = dom.window`, rồi tái hiện lại (không phải suy diễn)
đúng thuật toán routing của `loadManifest()` ngay trong script test — cùng
họ giới hạn môi trường đã gặp ở Phase 9-11 (không có `ResizeObserver`,
không tính layout thật), không phải giới hạn mới về BẢN CHẤT, chỉ là góc
cạnh mới của cùng 1 vấn đề "jsdom không phải browser thật".

**Verify thật, đầy đủ, qua hạ tầng thật (không mock ở bất kỳ layer nào):**
1. **Backend/API** (Node WS+HTTP client thật, không browser): đăng ký/login
   2 user thật; `GET /models` không cần auth; model sai bị từ chối 400 ngay
   ở WS upgrade; session A dùng model thật CHẠY ĐƯỢC 1 lượt chat thật (gửi
   "pong", nhận `assistant/message` thật); session B dùng model giả (chỉ để
   test env, không chat) → `docker inspect` container thật xác nhận đúng
   `OPENAI_MODEL_ID` trong `Env`; **kill container B, reconnect (rehydrate),
   container MỚI vẫn giữ đúng model cũ** (không âm thầm revert về default —
   phần khó nhất của thiết kế item 4); `GET /sessions/mine` liệt kê đúng cả
   2, status join sống từ Redis; `PATCH` rename thật cập nhật Postgres;
   user khác PATCH session của user A → 403 thật; manifest có đúng field
   `slot` cho 3 package mới/sửa, không có cho 2 package cũ; `GET
   /plugin-inventory` trả về hàng thật từ `ctx.registry` (đếm được >5 hàng,
   có đúng tên module thật, state `active`); warm pool tự bù lại sau khi
   dọn sạch, và pool member mới mang đúng `allowedModels[0]`.
2. **FE** (jsdom + React thật + ĐÚNG file build ra, không phải code viết
   riêng cho test): outlet `single` chỉ có đúng 1 con; outlet `list` có
   đúng 2 con, ĐÚNG THỨ TỰ theo `order` khai báo; cột center vẫn nhận
   `client-ui-conversation` (không khai `slot` → default cũ); dialog
   settings mở/đóng đúng; gõ `/re` hiện đúng 1 gợi ý (`/rename`), gõ
   `/zzz` không hiện gì; model select có option thật lấy từ `GET /models`;
   dispose sạch cả 2 outlet + center, 0 node rác (bắt được bug wrapper ở
   mục trên chính từ bước này).
3. **Regression** — `scripts/upstream-smoke-test.mjs` (Phase 6) chạy sạch
   sau toàn bộ thay đổi, xác nhận cả 5 package client-ui-* (2 cũ sửa + 3
   mới) đều lên đúng boot manifest thật, và turn/step/resume ở tầng dưới
   không bị ảnh hưởng.

Rebuild Docker image thật (không chỉ `tsc`), restart toàn bộ service thật
(gateway/orchestrator, giữ nguyên plugin-registry không đụng tới), dọn warm
pool cũ (container + Redis key + thư mục `_pool/`) trước khi rebuild để
tránh pool member cũ (thiếu package mới) bị claim nhầm cho session test.
Script test (`services/gateway/scratch/*`, `apps/web/scratch/*`) đã xoá
sau khi verify xong, đúng quy ước dọn dẹp đã áp dụng từ đầu dự án.

## 28. User hỏi thẳng "login logout flow đâu" — phát hiện `logout()` chưa từng được gọi ở đâu cả (2026-09-07)

User check lại UI (sau Phase 12) hỏi: sidebar bên trái, khung chat ở giữa,
và luồng login/logout đâu. Không có browser thật để tự xem lại, nên grep
thẳng code thay vì đoán: `grep -n "logout" services/gateway/src/*.ts
apps/web/src/main.ts` — kết quả: **`services/gateway/src/auth.ts`'s
`logout(token)` (thu hồi token thật trong Redis, đã viết từ Phase 7) chưa
từng có nơi nào gọi tới cả** — không có route `POST /auth/logout` nào ở
`index.ts`, và `apps/web`'s nút "Disconnect" chỉ đóng WebSocket + ẩn UI,
KHÔNG xoá token khỏi `sessionStorage`, KHÔNG gọi logout gì cả. Hậu quả thật:
bấm "Disconnect" xong, token vẫn còn hiệu lực (cả trên Redis lẫn trong tab
đang mở) — reload trang trong cùng tab sẽ tự động kết nối lại y hệt như
chưa từng "logout". Đây là 1 khoảng trống thật, có từ Phase 7, chưa từng bị
phát hiện vì chưa có test nào check hành vi logout cả (mọi test trước giờ
chỉ check register/login/403/purge).

**Sửa thật:**
1. `services/gateway/src/index.ts`: thêm `POST /auth/logout` (không cần
   `identityFromRequest` đầy đủ — chỉ cần lấy token ra rồi gọi `logout()`,
   idempotent by design giống `register`/`login`).
2. `apps/web/src/main.ts`: đổi hẳn nút "Disconnect" → "Logout"
   (`#logout-button`, cả `index.html` lẫn `style.css`'s selector). Handler
   mới: đóng WS, xoá TOKEN khỏi `sessionStorage` + SESSION ID khỏi
   `localStorage` NGAY (không đợi network), rồi mới gọi `POST /auth/logout`
   thật ở background (fire-and-forget, cùng tinh thần `touchSession()`'s
   comment cũ — kể cả network lỗi, tab này vẫn không còn giữ token nữa).

**Thêm 1 phát hiện UX thật khi đọc lại — sidebar hiện SẴN dù chưa login.**
Trước khi có session nào, không plugin nào (`client-ui-session-list`,
`client-ui-settings-plugins`, ...) từng mount — chúng chỉ mount SAU khi
`loadManifest()` chạy, mà `loadManifest()` chỉ chạy sau khi có 1 session
thật kết nối. Vậy trước login, `#sidebar-col` hiện ra TRỐNG (không session
list, nút "⚙ Settings" mở ra dialog cũng trống trơn) — đúng là gây confusing
thật, không phải chỉ là cảm giác chủ quan của user. Sửa: `sidebarRoot.hidden
= true` mặc định, chỉ `= false` lúc WS `'open'` thật sự (và ngược lại lúc
`'close'`/logout) — có 1 guard chống race thật: `switchSession()`/`startNewSession()`
đóng socket CŨ trước khi mở socket MỚI, nên sự kiện `'close'` của socket cũ
có thể đến SAU khi socket mới đã `'open'` — dùng lại đúng guard
`if (ws !== socket) return` code cũ đã có sẵn cho đúng race này, áp thêm cho
việc ẩn/hiện sidebar. `updateFrameColumns()` cũng sửa: khi sidebar ẩn, grid
chỉ 1 cột full-width (không phải 2 cột với 1 cột trống do `display:none`).

**Verify thật, không đoán:**
1. Backend: đăng ký/login thật → gọi `/sessions/mine` với token → 200 →
   `POST /auth/logout` → 204 → gọi LẠI `/sessions/mine` với ĐÚNG token cũ →
   **401 thật** (thu hồi thật, không phải chỉ UI ẩn đi) → logout lần 2 với
   token đã revoke vẫn 204 (idempotent, đúng thiết kế).
2. FE (jsdom + main.js thật): trước login — sidebar `hidden=true`, `#app`
   grid 1 cột; submit form login thật qua đúng flow người dùng sẽ làm
   (gõ vào `#email-input`/`#password-input`, dispatch `submit`) → sidebar
   hiện ra, grid 2 cột, connect-form ẩn, session-bar hiện; bấm nút Logout
   thật → token/sessionId biến mất khỏi storage, sidebar ẩn lại,
   connect-form hiện lại — VÀ token vừa "logout" gọi `/sessions/mine` nhận
   401 thật (chứng minh nút bấm thật sự gọi tới server, không chỉ đổi UI).
3. `scripts/upstream-smoke-test.mjs` chạy lại sạch — xác nhận sửa layout/auth
   không đụng gì tới turn/step/manifest/resume.

Không cần rebuild Docker image lần này — cả `services/gateway` lẫn
`apps/web` đều không nằm trong image worker (chỉ services/gateway restart
lại process, apps/web là file tĩnh serve trực tiếp từ đĩa).

## 29. `python3 -m http.server` không gửi `Cache-Control` — nguyên nhân THẬT của "UI vẫn cũ" lặp lại lần 2 (2026-09-07)

User check `http://localhost:5173/` sau §28's fix, báo "UI hoàn toàn sai,
còn như bản demo lâu lắm rồi" — **đây là lần THỨ HAI trong cùng session gặp
đúng dạng report này** (lần đầu, trước cả Phase 12, đã curl xác nhận server
serve đúng file mới rồi đoán là cache trình duyệt, nhưng user sau đó
chuyển hướng sang yêu cầu redesign lớn thay vì xác nhận lại — nên chưa
từng thật sự đóng được vòng lặp này). Lần này verify LẠI kỹ hơn, không chỉ
đoán:
- `lsof -p <pid>` xác nhận process `python3 -m http.server 5173` đang chạy
  đúng từ `apps/web/public` (đúng thư mục, không lệch).
- `curl http://localhost:5173/` VÀ `curl .../main.js` đều chứa đúng nội
  dung MỚI NHẤT (`sidebar-workspaces`, `settings-dialog`,
  `switchSession`, `logout-button`, ...) — server-side hoàn toàn đúng,
  không nghi ngờ gì nữa.
- `curl -I` cho thấy response của Python's `http.server` chỉ có
  `Last-Modified`, **KHÔNG có `Cache-Control` nào cả** — với 1 response
  thiếu chỉ dẫn cache rõ ràng, trình duyệt tự áp dụng "heuristic freshness"
  riêng (RFC 7234) và có thể phục vụ bản cache cũ cho `main.js`/`style.css`
  ngay cả với reload thường (không phải hard refresh), mà KHÔNG hề gửi
  request mới lên server để mình verify qua log — giải thích tại sao lần
  trước "chắc chắn" server đúng nhưng user vẫn thấy cũ, và tại sao chuyện
  này LẶP LẠI.

**Sửa tận gốc, không chỉ bảo hard-refresh lần nữa:** dự án này chưa từng có
script chính thức nào để serve `apps/web/public/` cả — `python3 -m
http.server` chỉ là cách chạy tay tạm bợ, chưa bao giờ thuộc về repo. Viết
`scripts/serve-web.mjs` — 1 static file server Node nhỏ (không thêm
dependency mới, dùng thẳng `node:http`/`node:fs`), gửi
`Cache-Control: no-store` TRÊN MỌI RESPONSE — đảm bảo trình duyệt không
bao giờ phục vụ bản cache cũ nữa, chấp nhận đánh đổi hiệu năng cache (hợp
lý ở quy mô dev-only của dự án này, đúng tinh thần "no more than needed" —
không cần xây 1 chiến lược cache CDN thật cho production ở đây). Dừng
process Python cũ, chạy script mới trên ĐÚNG port 5173 (giữ nguyên URL
user đã quen dùng).

**Verify thật:** `curl -I` sau khi đổi server xác nhận header
`cache-control: no-store` có mặt trên MỌI response (cả `/` lẫn
`/main.js`), nội dung vẫn đúng y hệt (không đổi hành vi, chỉ đổi cách phục
vụ file). Đây là fix hạ tầng, không phải sửa `apps/web` — không cần chạy
lại `pnpm run typecheck`/rebuild gì cả.

## 30. Gỡ bỏ toàn bộ hệ UI plugin (Phase 4-12), gộp về 1 React app dùng chung — 2 bug thật tìm được lúc verify (2026-09-08)

**User quyết định sau nhiều lượt "UI vẫn sai" không giải quyết được dứt
điểm bằng debug cache/redeploy: bỏ hẳn cơ chế UI plugin động theo-từng-session,
quay về 1 web app React build sẵn, dùng chung cho mọi user.** Đây là lần
đầu tiên trong cả dự án 1 quyết định kiến trúc lớn bị ĐẢO NGƯỢC hoàn toàn
(không phải mở rộng/sửa như mọi phase trước) — Phase 4 (manifest động) →
Phase 9 (React + module loader riêng) → Phase 11 (third-party UI plugin
qua module loader) → Phase 12 (slots outlet) đều bị gỡ, không phải vì code
sai, mà vì chính cơ chế "mỗi plugin 1 bundle tải riêng qua `import()` động"
là nguồn gốc của hàng loạt bug cache/loading rất khó debug khi không có
browser thật (`ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING` trong jsdom,
`Cache-Control` thiếu ở static server, độ phức tạp routing qua nhiều tầng
gián tiếp). Bài học: đôi khi hướng đúng không phải "sửa thêm 1 lớp nữa" mà
là bỏ hẳn 1 lớp phức tạp không cần thiết — nhất là khi lớp đó tồn tại để
giải quyết 1 nhu cầu (mỗi session có UI khác nhau) mà thực tế chưa bao giờ
thực sự cần dùng tới.

**Giữ lại TOÀN BỘ tính năng thật đã xây (Phase 4-12), chỉ đổi cách phân
phối:**
- `apps/web/src/App.tsx` + `src/components/*.tsx` — 1 cây React DUY NHẤT,
  build 1 lần (`scripts/build-web.mjs`, thay `build-client-plugins.mjs`).
  Mỗi package `client-ui-*` cũ (`theme`/`conversation`/`settings-plugins`/
  `session-list`/`plugin-inventory`) → 1 component thật trong
  `apps/web/src/components/`, logic React giữ nguyên gần như 100% (copy
  rồi bỏ `window.__FOX_HARNESS__`/`mount(root)`, thay bằng
  `useRuntime()` — 1 React Context thật, `apps/web/src/runtime.ts`, cùng
  shape với `window.__FOX_HARNESS__` cũ).
- `theme.css` — từ 1 UI plugin tự inject `<style>` lúc runtime → 1 file
  CSS tĩnh thật, load thẳng qua `<link>` trong `index.html`.
- Xoá thật: `packages/core/src/client-manifest.ts`
  (`ClientManifestRegistry`), `packages/transport`'s `GET /manifest` +
  `GET /plugins/:id/client.js` (giữ lại `GET /plugin-inventory` — hạ tầng
  thật, độc lập với cách UI được phân phối), route proxy tương ứng ở
  `services/gateway`, bước wrap `dsh.client`/React ở
  `services/plugin-registry/src/build.ts` (`client-wrap.ts` xoá hẳn — plugin
  bên thứ ba vẫn thêm được tool/behavior thật qua `cordis.patch.yml`, chỉ
  không còn tự ship UI được nữa), `templates/plugin-react-ui/`, và cơ chế
  test-lever `?variant=` (Phase 4's `no-theme` demo) — lý do tồn tại DUY
  NHẤT của nó (loại `client-ui-theme` khỏi bundle list 1 session) không còn
  ý nghĩa gì khi không còn khái niệm "bundle list theo từng session" nữa.
  5 package `packages/client-ui-*` xoá hẳn thư mục (code đã chuyển, không
  mất).

**2 bug thật tìm được lúc verify lại từ đầu, cả 2 đều thuộc dạng "xoá 1 thứ
làm hỏng chỗ khác đang phụ thuộc ngầm vào nó" — đúng loại rủi ro cao nhất
của 1 cuộc dọn dẹp lớn:**
1. **`packages/transport/src/index.ts`'s `inject: ['agents', 'sessions',
   'clientManifest']`** — quên xoá `'clientManifest'` khi xoá
   `client-manifest.ts`. Cordis's `inject` chờ VĨNH VIỄN cho tới khi đủ
   service được liệt kê xuất hiện — nghĩa là worker's transport plugin sẽ
   KHÔNG BAO GIỜ activate, không hề có lỗi nào ném ra, chỉ đơn giản là cổng
   WS không bao giờ mở. Đây là loại bug ĐẶC BIỆT NGUY HIỂM vì im lặng hoàn
   toàn — không test tự động nào bắt được nếu không có ai grep lại
   `clientManifest` sau khi xoá file. Bắt được bằng `grep -rn` chủ động rà
   soát TOÀN BỘ repo tìm tên các thứ vừa xoá, không phải nhờ 1 test fail.
2. **Nhiều `<button>` mới trong `App.tsx` viết lại thiếu attribute `id`**
   (`#logout-button`, ...) mà cả `style.css`'s selector lẫn script test tự
   viết đều cần. TypeScript không bắt được (JSX không bắt buộc `id`) — bắt
   được bằng chính jsdom test thật, click thẳng vào nút qua `document.getElementById`
   trả về `null`.

**Verify thật, đầy đủ lại từ đầu (không tái sử dụng test cũ, vì kiến trúc
đổi hẳn):**
1. Dọn sạch: xoá toàn bộ container worker cũ, xoá `data/dsh-home/*`, xoá
   key Redis `fh:session:*`/`fh:warmpool`, rebuild Docker image
   `--no-cache`, restart sạch cả 3 service (gateway/orchestrator/plugin-registry).
2. `pnpm run typecheck` sạch trên toàn bộ workspace (còn 12 package, giảm từ
   17 — đúng số lượng sau khi xoá 5 package UI-plugin).
3. `scripts/upstream-smoke-test.mjs` viết lại (bỏ hẳn check "boot manifest
   lists every client-ui-* package" — route không còn tồn tại; dùng
   `GET /plugin-inventory` làm readiness probe thay `GET /manifest`) — PASS
   sạch cả headless turn lẫn WS replay.
4. Node WS/HTTP client thật: đăng ký/login → `GET /models` vẫn hoạt động
   (không phụ thuộc manifest) → session thật + lượt chat thật hoàn thành →
   `GET /sessions/mine` liệt kê đúng → `PATCH` rename vẫn hoạt động →
   `GET /plugin-inventory` trả về hàng thật, **xác nhận không còn module
   `client-ui-*` nào trong đó** (đúng bằng chứng đã xoá thật, không phải chỉ
   xoá code phía FE) → `GET /sessions/:id/manifest` **404 thật** (route thật
   sự biến mất, không phải chỉ lỗi).
5. jsdom + React thật + ĐÚNG file `main.js` build ra (không phải code viết
   riêng cho test) — lần này ĐƠN GIẢN HƠN HẲN mọi lần trước vì `main.js` giờ
   là 1 IIFE thật, KHÔNG còn `import()` động nào cả → né hẳn giới hạn
   `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING` của jsdom gặp suốt Phase 9-12,
   không cần lách qua Node's top-level realm nữa: React mount thẳng vào
   `#root` ngay khi script chạy; trước login không có sidebar (đúng, vì
   chưa có session nào); submit form login thật (gõ email/password thật,
   dispatch `submit`) → sidebar/session-list/conversation/logout-button đều
   xuất hiện thật; mở settings dialog thật, thấy đủ 2 section; gõ `/re` hiện
   đúng dropdown; bấm Logout thật → token biến mất khỏi storage, VÀ token đó
   gọi API thật nhận 401 (thu hồi thật trên server, không phải chỉ ẩn UI).

Script test (`services/gateway/scratch/*`, `apps/web/scratch/*`) đã xoá sau
khi verify xong.

## 31. Siết `POST /plugin-catalog` (nộp plugin) về admin-only — chính sách, không phải bug (2026-09-08)

User hỏi thẳng: "kho plugin phía admin viết kiểm soát hết" đúng không —
kiểm tra lại code thật thì SAI 1 phần: `POST /plugin-catalog` (nộp) từ
Phase 7 tới giờ cho phép **mọi role** (kể cả `user` thường), chỉ
`POST /plugin-catalog/:id/approve` mới admin-only. User xác nhận muốn đúng
như mô tả: user thường **chỉ xem + bật/tắt**, không được tự nộp gì cả — cả
kho plugin (nộp lẫn duyệt) đều do admin kiểm soát toàn bộ.

**Sửa:** `services/gateway/src/index.ts` — check `requireRole(identity,
'admin')` áp dụng cho CẢ `POST /plugin-catalog` lẫn
`POST /plugin-catalog/:id/approve` (trước chỉ áp cho approve).
`GET /plugin-catalog` (xem danh sách đã duyệt) và
`POST/GET /sessions/:id/plugins` (bật/tắt cho session của chính mình) giữ
nguyên — user thường vẫn dùng được, chỉ không tự thêm được gì vào catalog.

**Verify thật:** user thường đăng ký mới, gọi `POST /plugin-catalog` → 403
thật (trước đó là 201). Cùng user gọi `GET /plugin-catalog?status=approved`
→ vẫn 200 (xem được bình thường). `pnpm run typecheck` sạch, restart lại
gateway với code mới trước khi test — không cần đụng orchestrator/plugin-registry
(chỉ gateway biết về role, đúng ranh giới đã có từ Phase 7).

## 32. Phase 13 — hiện/ẩn UI theo plugin BE đã bật, verify thật qua 2 tài khoản (2026-09-08)

Implement đúng thiết kế đã viết: `apps/web/src/pluginUi.tsx` (bảng ánh xạ
tĩnh `KNOWN_PLUGIN_UI: Record<string, ComponentType>`, viết tay — hiện chỉ
1 dòng, gắn `fox-harness-demo-hello` (plugin demo THẬT đã approved sẵn
trong Postgres từ Phase 5, không cần tạo plugin mới) vào
`DemoPluginButton.tsx`), `apps/web/src/useEnabledPlugins.ts` (hook dùng
chung — factor ra từ logic fetch `GET /sessions/:id/plugins` vốn chỉ có ở
`SettingsPlugins.tsx`, giờ cả 2 nơi dùng chung 1 nguồn), `Sidebar.tsx`
thêm `PluginUiArea` — lọc `KNOWN_PLUGIN_UI` theo tập plugin đã bật, render
`null` nếu rỗng (không tạo `<div>` thừa).

**Verify thật, không chỉ tin logic đúng trên giấy:** jsdom + React thật
chạy đúng `main.js` build ra, qua đúng gateway/orchestrator/worker thật:
1. 2 tài khoản thật, session A (user A) enable `fox-harness-demo-hello`
   thật qua API — session B (user B) không đụng gì tới nó.
2. Trước khi enable: A không thấy nút. Sau khi enable: **A thấy nút thật**,
   click vào → state React thật cập nhật (counter tăng lên `(1)`, không
   phải chỉ render tĩnh).
3. **User B (dù cùng lúc, plugin ĐÃ được approve trong catalog chung) —
   không hề thấy nút** — đúng yêu cầu gốc: bật/tắt là theo TỪNG SESSION,
   không phải theo catalog chung.
4. Disable lại → nút biến mất thật, không cần reload.

Không có bug nào phát sinh lần này (thiết kế đơn giản, đúng ngay lần đầu) —
`pnpm run typecheck` sạch, `scripts/upstream-smoke-test.mjs` không hỏng
(thay đổi thuần FE, không đụng transport/orchestrator/gateway).

## 33. Phase 14 — implement thật, áp đúng literal thật đã đọc, không bịa scale radius/spacing (2026-09-08)

Implement đúng theo research đã có (không nghiên cứu lại) — điểm mấu chốt
đã ghi rõ trong Phase 14's design vẫn giữ nguyên khi code thật: **không hề
tạo bảng token `--fh-radius-*`/`--fh-spacing-*` tập trung** — dsh thật
không có, nên style.css áp thẳng literal (8px/12px/22px/24px/999px) vào
đúng từng chỗ, đúng cách dsh thật làm.

**`apps/web/public/theme.css`** thêm: 4 token shadow thật (`lv1/lv1-blur/
lv2/lv3`, dùng nguyên giá trị hex-alpha 8 ký tự đọc được, vd `#0000000d` —
giống nhau ở light/dark, đúng research), 4 token motion (`--fh-ease` +
3 duration), 13 token typography (`--fh-text-xxxs` → `-xl`, 5 cặp có
`-strong`, 3 mức hiển thị lớn `m/l/xl` không bịa thêm `-strong` vì research
không đọc được giá trị thật cho chúng — thà thiếu còn hơn đoán), 3 token
màu MỚI (`bg-hover`/`bg-raised`/`border-subtle`) — đây là màu **tự chọn**
(cùng gam màu xám-xanh đã có từ Phase 4), không phải giá trị hex thật của
dsh (research xác nhận không đọc được palette layer-2/3 thật của
`dsh-client-ui-primitives` — package đó không cài trên máy).

**`apps/web/public/style.css`** áp lại từng component theo đúng literal:
button base 12px (kiểu "sidebar/nav" thật), `button[type="submit"]` riêng
999px (pill — đúng 2 nút CTA thật của app này: Log in, Send), icon-button
tròn 28×28 (`.fh-sidebar-toggle`, `.fh-settings-close`) và 22×22
(`.fh-session-row-rename`), input/select 8px + cao 34px + focus chỉ đổi
màu viền (bỏ hẳn outline glow mặc định trình duyệt), `.fh-session-row`
**đổi hẳn từ viền-trái-khi-active sang đổi nền** (giữ 1 khác biệt CÓ CHỦ Ý
so với dsh thật: thêm màu chữ accent cho hàng active, vì app này chưa có
mô hình điều hướng đủ mạnh để chỉ dựa vào nền — ghi rõ trong comment, không
giả vờ đây là hành vi dsh thật), `.bubble` + `#send-form` cùng 22px (composer
đổi hẳn từ thanh full-width viền-trên sang thẻ nổi có bo góc + shadow,
đúng cấu trúc thật, không chỉ đổi số), `.card` 12px + nền `bg-raised` + viền
`border-subtle`, settings dialog 24px + `backdrop-filter:blur(2px)` +
`z-index:1000` (đúng 3 giá trị thật đọc được), scrollbar tuỳ biến 8px cho
`#log`/`#sidebar-workspaces`, `#log`'s gap đổi sang `1rem` (dùng `rem` chứ
không phải `em` — cố tình, vì `rem` đọc font-size ROOT mặc định 16px, khớp
đúng giá trị thật 16px dù `body` đang set 14px).

**1 gap thật phát hiện khi soát lại code cũ, không liên quan trực tiếp
research nhưng sửa luôn vì đang đụng đúng chỗ:** `#register-button` từ Phase
7 tới giờ **chưa từng có style riêng** — render y hệt nút "Log in" (nền
accent đặc), không có phân biệt thị giác chính/phụ nào cả. Sửa vào cùng
đợt với nhóm nút outline (`#new-session-button`/`#logout-button`).

**Icon:** `apps/web/src/icons.tsx` — 4 SVG inline tự vẽ (Gear/Close/Menu/
Pencil), thay 4 emoji (⚙✕☰✎). KHÔNG đọc/chép SVG thật của dsh (`dsh-client-ui-primitives`
xác nhận không cài trên máy — xem Phase 14's research) — chỉ vẽ tối giản
theo đúng tinh thần "path đơn giản, 1 màu, dùng `currentColor`" mà dsh thật
dùng.

**Verify thật:** `pnpm run typecheck` sạch, `scripts/upstream-smoke-test.mjs`
PASS (không đụng backend). jsdom + React thật chạy đúng `main.js` build ra:
grep trực tiếp `theme.css`/`style.css` được serve thật xác nhận có đủ token/
literal mới; toàn bộ flow tương tác cũ (command dropdown, settings dialog
mở/đóng qua ĐÚNG nút icon mới, session row rename có icon thật) vẫn hoạt
động sau khi đổi — không có regression. **Chưa verify được bằng mắt thật**
— vẫn không có Claude in Chrome, nên KHÔNG thể xác nhận "trông đẹp hơn"
bằng hình ảnh thật, chỉ xác nhận đúng giá trị số/cấu trúc đã áp vào đúng
literal đã đọc từ research. Đây là giới hạn thật, không giấu.

**Follow-up ngay sau đó (2026-09-08):** user yêu cầu thẳng — đừng tự vẽ
SVG, dùng icon của framework dsh hoặc 1 thư viện free đẹp hơn. `dsh-client-ui-primitives`
(icon thật của dsh) đã xác nhận không cài được trên máy (research Phase 14),
nên chọn **`lucide-react`** (MIT, fork được duy trì của Feather Icons, rất
phổ biến, cùng phong cách line-icon 1 màu `currentColor` như research đọc
được từ dsh thật). Thêm thật vào `apps/web/package.json` (`pnpm install`
thật, +1 package), `apps/web/src/icons.tsx` đổi thành lớp re-export mỏng
(`export { Settings as GearIcon, ... } from 'lucide-react'`) — giữ nguyên
tên cũ nên KHÔNG cần sửa 4 nơi gọi (Sidebar/SettingsDialog/App/SessionList),
chỉ thêm `size` cụ thể ở mỗi chỗ gọi (mặc định lucide 24px quá to so với
nút 22-28px đang có). Tiện thể đổi luôn emoji 🔌 còn sót lại ở
`DemoPluginButton.tsx` (Phase 13) sang icon `Plug` thật.

**Verify thật:** `pnpm run typecheck` sạch, bundle `main.js` tăng từ
~1.06MB lên ~1.14MB (xác nhận esbuild tree-shake đúng — chỉ 5 icon thật sự
dùng được gộp vào, không phải nguyên thư viện hàng nghìn icon), jsdom +
React thật xác nhận `<svg class="lucide...">` thật xuất hiện đúng ở cả 3
chỗ (settings-trigger, settings-close, session-row-rename) — không phải
path tự vẽ nữa. `scripts/upstream-smoke-test.mjs` không hỏng.

## 34. Màn hình ngoài cùng đổi thành 1 màn Login/Register thật (2026-09-08)

Sau khi mọi báo cáo "UI sai" trước đó (§29-33) hoá ra đều là user đang nhìn
đúng `ConnectForm` chưa login (không phải bug), user chỉ ra đúng vấn đề thật
còn lại: `ConnectForm` từ Phase 7 tới giờ nhét CHUNG 1 hàng — Gateway URL +
Email + Password + Model — trông như 1 form debug/config, không giống màn
login/register thật của 1 sản phẩm. Yêu cầu: màn NGOÀI CÙNG (đầu tiên user
thấy) phải là 1 màn login/register sạch.

**Sửa thật:**
1. `apps/web/src/App.tsx` — tách hẳn nhánh render: `!connected` return SỚM
   1 `<div className="fh-auth-screen">` chứa `<ConnectForm>`, KHÔNG còn
   dùng chung `#app`/`#header`/grid-2-cột với app đã connect nữa (trước đó
   `#app` luôn render, `ConnectForm` chỉ là 1 phần tử ẩn/hiện bên trong
   `#center-col`). `connected` return riêng `#app` grid như cũ (Sidebar +
   header + session-bar + Conversation), không đổi hành vi.
2. **Bug thật tìm được khi tách nhánh này:** `useEffect` gắn `ResizeObserver`
   vào `frameRef` chạy 1 lần lúc mount với deps `[]` — đúng lúc `#app` LUÔN
   có trong DOM (kiến trúc cũ). Giờ `#app` chỉ mount SAU KHI `connected`
   thành true, nên lần useEffect này chạy (lúc mount ban đầu, `!connected`)
   `frameRef.current` luôn là `null` → observer never gắn được, và không
   bao giờ chạy lại vì deps rỗng. Sửa: đổi deps thành `[connected]` — effect
   chạy lại đúng lúc `#app` thật sự tồn tại trong DOM.
3. `apps/web/src/components/ConnectForm.tsx` — viết lại thành 1 thẻ card
   thật (`.fh-auth-card`, giữa màn hình qua `.fh-auth-screen`): tiêu đề
   "fox-harness" + phụ đề đổi theo mode, 1 fieldset Email+Password DUY NHẤT,
   1 nút submit DUY NHẤT (`#connect-submit`, text đổi "Log in"/"Create
   account" theo `mode`), 1 nút toggle text-link (`#register-button`, đổi
   ý nghĩa từ "nút Register riêng gọi thẳng `onRegister`" — kiến trúc cũ —
   sang "chuyển mode, form submit mới thật sự gọi `onLogin`/`onRegister`
   tương ứng"), và Gateway URL + Model select **demote vào `<details>`
   "Advanced" đóng mặc định** (không còn hiện ngay từ đầu — hầu hết user
   không cần đổi 2 giá trị này).
4. `apps/web/public/style.css` — CSS mới cho `.fh-auth-screen` (full
   viewport, center flex), `.fh-auth-card` (16px radius, `--shadow-lv2`,
   max-width 360px), `.fh-auth-switch` (text-link, không viền/nền — thay
   hẳn style cũ của `#register-button` vốn dùng chung rule với
   `#new-session-button`/`#logout-button`; rule đó BỎ `#register-button` ra
   vì id selector có specificity cao hơn class, sẽ đè mất style text-link
   mới nếu còn giữ chung), `.fh-auth-advanced` (viền trên, thu nhỏ chữ).
   `#connect-form` đổi từ `flex-wrap` hàng ngang sang `flex-direction:
   column` (dọc, đúng bố cục card).

**Verify thật (jsdom + React thật, đúng `main.js` build ra, script tự viết
rồi xoá sau khi PASS — không mock gì ngoài `fetch`/`WebSocket`):**
1. Trước login: `.fh-auth-screen`/`.fh-auth-card` có mặt, **`#app` VÀ
   `#header` hoàn toàn không tồn tại trong DOM** (khác Phase 4-33 — trước
   đó `#app`/`#header` luôn có, chỉ `ConnectForm` ẩn/hiện).
2. Advanced là `<details>` đóng mặc định (`.open === false`), chứa đúng
   `#gateway-input`/`#model-select` bên trong.
3. Bấm nút toggle (`#register-button`) → nút submit đổi text "Log in" →
   "Create account" thật (chờ 1 tick — React 18 nhánh này set state
   ASYNC, không đồng bộ ngay sau `.click()`, phải `await` 1 nhịp timer
   trước khi đọc lại `textContent`, không phải bug).
4. Điền email/password thật, submit ở mode register → gọi ĐÚNG
   `POST /auth/register`, KHÔNG gọi `/auth/login`. Toggle lại mode login,
   submit → gọi ĐÚNG `POST /auth/login`.
5. Sau login thành công: `.fh-auth-screen` biến mất, `#app` grid + Sidebar
   + `#logout-button` xuất hiện thật — chứng minh nhánh return sớm không
   làm hỏng flow connected cũ.

`pnpm run typecheck` sạch, `scripts/build-web.mjs` build lại thành công.
Không đụng backend nào (chỉ FE) nên không cần `scripts/upstream-smoke-test.mjs`.

## 35. Toggle light/dark thật — theme.css đã có sẵn 2 bảng màu, chỉ chưa có cách chọn (2026-09-08)

User hỏi thẳng 2 việc sau khi thấy màn login/register mới: (1) `<details>`
"Advanced" để làm gì, và (2) "quan trọng là theme nên làm 2 màu light/dark
cho tôi". Việc (1) chỉ cần giải thích (Gateway URL/Model là config triển
khai, không phải phần đăng nhập — xem §34's design). Việc (2) là 1 gap thật:
`theme.css` từ Phase 4/14 đã có ĐẦY ĐỦ giá trị light lẫn dark (`@media
(prefers-color-scheme:dark)` + sẵn 2 hook `:root[data-theme="light"|"dark"]`
để override) — nhưng KHÔNG có UI nào từng đặt attribute `data-theme` cả, nên
dark mode trước giờ chỉ tự áp theo hệ điều hành, user không tự chọn được.

**Sửa thật:**
1. `apps/web/src/useTheme.ts` (mới) — hook 2 state: `override` (`'light'
   |'dark'|null`, khởi tạo từ `localStorage['fox-harness/theme']`) và
   `systemDark` (theo dõi live `matchMedia('(prefers-color-scheme:dark)')`'s
   sự kiện `change`). `theme` hiển thị = `override ?? (systemDark ?
   'dark':'light')`. **Quyết định thiết kế quan trọng, sửa lại sau khi tự
   phát hiện bug lúc verify:** bản đầu tiên ghi `localStorage` NGAY trong
   `useEffect` lúc mount dù user chưa bấm gì — khoá cứng user vào giá trị hệ
   điều hành lúc lần đầu ghé thăm, mất khả năng tự động đổi theo hệ điều
   hành về sau. Sửa: chỉ ghi `localStorage` + set `data-theme` trong
   `toggle()` — trước khi user bấm, KHÔNG set `data-theme` gì cả (để CSS's
   `@media` tự quyết, tự động sống theo hệ điều hành), đúng quy tắc "chưa có
   giá trị lưu thì để media query quyết" mà script chống-FOUC bên dưới cũng
   dùng.
2. `apps/web/src/components/ThemeToggle.tsx` (mới) — nút icon tròn 28px
   (dùng lại style `.fh-sidebar-toggle`), icon Sun/Moon từ `lucide-react`
   (đã có sẵn từ Phase 14 follow-up, không thêm dependency mới), đổi icon
   theo `theme` hiện tại.
3. `apps/web/src/App.tsx` — render `<ThemeToggle />` ở CẢ 2 nơi: trong
   `.fh-auth-screen` (trước login) và trong `#header` (sau khi connected) —
   cùng 1 hook, khác instance React, đồng bộ qua chung 1 key localStorage vì
   2 nhánh không bao giờ render cùng lúc.
4. `apps/web/public/style.css` — `.fh-theme-toggle` dùng chung rule với
   `.fh-sidebar-toggle`; thêm `.fh-auth-screen { position: relative }` +
   `.fh-auth-screen .fh-theme-toggle { position: absolute; top/right }` để
   nổi góc màn hình login (không có hàng `#header` nào để nằm ngang ở đó).
5. `apps/web/public/index.html` — thêm 1 `<script>` inline đồng bộ, đặt
   TRƯỚC 2 thẻ `<link rel="stylesheet">`, đọc `localStorage['fox-harness/theme']`
   và set `data-theme` NGAY trước khi trang vẽ pixel đầu tiên — không có nó,
   user đã chọn "light" nhưng hệ điều hành đang dark sẽ thấy 1 nhịp chớp
   dark lúc reload (theme.css's khối dark áp qua `prefers-color-scheme` tự
   động trước khi React kịp chạy để override).

**Verify thật (jsdom + React thật + đúng `main.js` build ra, script tự viết
rồi xoá sau khi PASS — 14 assertion):** script chống-FOUC inline chạy đúng
với giá trị lưu sẵn; trước khi user tương tác — KHÔNG có gì lưu trong
`localStorage`, KHÔNG có `data-theme` attribute nào (đúng thiết kế "theo hệ
điều hành"); bấm toggle → `data-theme` đổi thật, lưu `localStorage` thật,
icon Sun/Moon đổi thật (so `<svg class>` trước/sau); bấm lần 2 → quay lại
light, vẫn lưu. Login thật xong (form thật, `POST /auth/login` thật) → nút
toggle CŨNG xuất hiện trong `#header`, và lựa chọn theme từ TRƯỚC lúc login
vẫn giữ nguyên sau khi connect (không bị reset).

**1 giới hạn môi trường jsdom mới gặp, không phải bug sản phẩm:** jsdom
không có `window.matchMedia` — mọi trình duyệt thật đã hỗ trợ từ IE10, nên
stub trong script test (cùng nhóm với `ResizeObserver` đã stub từ trước),
không sửa code sản phẩm.

`pnpm run typecheck` sạch, `scripts/build-web.mjs` build lại thành công.
Không đụng backend, không cần `scripts/upstream-smoke-test.mjs`.

## 36. Bỏ hẳn Gateway URL + Model khỏi màn login (không chỉ ẩn trong Advanced) (2026-09-08)

User hỏi "advanced dấu đi sao show cổng sse và model ra thế" — kiểm tra
thật trước khi trả lời (không đoán): dev server (`scripts/serve-web.mjs`)
đang chạy ĐÚNG bundle mới nhất (`curl` xác nhận `fh-auth-advanced`/
`theme-toggle` có trong `main.js` served, `cache-control: no-store` đúng),
jsdom test xác nhận `<details>` mặc định `open === false`. Hỏi lại user qua
`AskUserQuestion` để xác nhận trạng thái thật đang thấy — trả lời: "Đóng,
nhưng tôi đã bấm vào nó" — nghĩa là ĐÚNG thiết kế (collapsed mặc định), user
tự bấm mở ra rồi hỏi tại sao có 2 field đó. Không phải bug.

Hỏi tiếp (`AskUserQuestion`) nên xử lý 2 field này thế nào — user chọn
**bỏ hẳn cả 2 khỏi màn login** (không phải chỉ ẩn trong Advanced nữa).

**Sửa thật:**
1. `apps/web/src/components/ConnectForm.tsx` — xoá hẳn khối `<details
   className="fh-auth-advanced">`, xoá 6 prop không còn dùng
   (`gatewayUrl`/`onGatewayUrlChange`/`models`/`onRefetchModels`/
   `selectedModel`/`onSelectedModelChange`) khỏi cả signature lẫn type —
   component giờ chỉ còn `error`/`connecting`/`onLogin`/`onRegister`.
2. `apps/web/src/App.tsx` — bỏ 6 prop đó khỏi lời gọi `<ConnectForm>`.
   **Gateway URL vẫn còn cơ chế override thật** — `defaultGatewayUrl()`
   (đọc `?gateway=` trên URL trang → `localStorage` → mặc định
   `http://localhost:4000`) không đổi, chỉ không còn Ô NHẬP nào trên UI cho
   nó nữa (`const [gatewayUrl] = useState(...)`, bỏ hẳn setter vì không ai
   gọi). **Model vẫn tự có giá trị thật** — đổi tên hàm
   `populateModelSelect` → `pickDefaultModel` (tên cũ nhắc tới 1 dropdown
   không còn tồn tại), bỏ `setModels`/state `models` hẳn (không còn ai đọc
   giá trị đó — trước đây chỉ tồn tại để render option list cho dropdown đã
   xoá), chỉ giữ lại đúng phần logic cần: gọi `GET /models` 1 lần lúc app
   mount, tự chọn `body.models[0]` làm `selectedModel` — logic `connect()`'s
   `&model=` param không đổi gì, vẫn nhận đúng giá trị thật.
3. `apps/web/public/style.css` — xoá hẳn 5 rule `.fh-auth-advanced*` (dead
   CSS, tính năng không còn tồn tại chứ không phải chỉ ẩn).

**Verify thật (jsdom + React thật + đúng `main.js` build ra, 6 assertion,
script xoá sau khi PASS):** không còn `#gateway-input`/`#model-select`/
`.fh-auth-advanced` nào trên trang login; login thật vẫn hoạt động hết (form
submit → `#app` mount); 1 session mới vẫn mang đúng model tự chọn
(`model-a`, phần tử đầu tiên `GET /models` trả về) trong URL WebSocket dù
không còn picker nào — chứng minh việc bỏ UI không làm mất khả năng chọn
model ngầm, chỉ bỏ khả năng NGƯỜI DÙNG tự đổi nó. Restart lại
`scripts/serve-web.mjs` (dev server cũ đang chạy từ trước, kill + chạy lại
để nó serve đúng bundle mới) — `curl` xác nhận `fh-auth-advanced` không còn
trong `main.js` served thật.

`pnpm run typecheck` sạch. Không đụng backend.

## 37. Sau khi "Create account" thành công, form không tự quay lại chế độ Login — bug thật (2026-09-08)

User báo: "create account thành công thì về màn login" — đọc lại code
`ConnectForm.tsx`/`App.tsx`'s `handleRegister` thì đúng là 1 bug thật, không
phải hiểu lầm: `handleRegister` cũ gọi xong `register()` thành công thì chỉ
`setConnectError('account created — click Log in')` — TÁI SỬ DỤNG đúng ô
lỗi (`#connect-error`, chữ đỏ) để hiện 1 câu KHÔNG PHẢI lỗi, và **không hề
đổi `mode` state** (state đó nằm trong `ConnectForm.tsx`, App.tsx không với
tới được) — nút submit vẫn hiện "Create account", user bấm submit lần nữa
vô tình gọi LẠI `POST /auth/register` với ĐÚNG email vừa tạo → chắc chắn lỗi
(tài khoản đã tồn tại) — không có đường nào thật sự đăng nhập được nếu
không tự tay bấm link "Already have an account? Log in".

**Sửa thật:**
1. `apps/web/src/App.tsx`'s `handleRegister` đổi chữ ký từ `void` sang
   `Promise<boolean>` — trả `true` khi `register()` thật thành công, `false`
   khi lỗi (vẫn `setConnectError` như cũ cho lỗi thật).
2. `apps/web/src/components/ConnectForm.tsx` — `onRegister` prop đổi type
   theo, thêm `handleSubmit()` async: ở mode `register`, `await
   onRegister(...)`, nếu `true` thì tự `setMode('login')` +
   `setPassword('')` (giữ nguyên email — user không phải gõ lại) +
   `setNotice('Account created — log in to continue')`. Thêm state
   `notice` RIÊNG (không dùng chung `error` nữa) + span mới `#connect-notice`
   class `.notice` (màu `--status-success`, khác hẳn `.error`'s màu đỏ) —
   phân biệt rõ ràng "báo thành công" khỏi "báo lỗi", không tái dùng nhầm ô
   như code cũ. Thêm state cục bộ `registering` (disable nút submit trong
   lúc chờ `POST /auth/register` — trước đó KHÔNG có, có thể double-submit).
3. `apps/web/public/style.css` — thêm rule `.notice { color:
   var(--status-success); font-size: 0.85em }` cạnh `.error`.

**Verify thật (jsdom + React thật + đúng `main.js` build ra, 10 assertion,
script xoá sau khi PASS):** submit ở mode register gọi đúng
`POST /auth/register`; SAU KHI thành công — nút submit tự đổi lại "Log in"
(đúng bug đã sửa), email vẫn giữ nguyên, password bị xoá trắng, `#connect-notice`
hiện đúng câu thông báo với class `.notice` (không phải `.error`), không có
`#connect-error` nào render. Bấm submit LẦN NỮA (không sửa gì thêm) — xác
nhận KHÔNG gọi lại `/auth/register` lần 2, mà gọi đúng `/auth/login` — chứng
minh luồng thật sự đăng nhập được ngay sau khi đăng ký, không bị kẹt.
Restart lại `scripts/serve-web.mjs` (dev server đang chạy sẵn), `curl` xác
nhận `connect-notice` có trong `main.js` served thật.

`pnpm run typecheck` sạch, `scripts/build-web.mjs` build lại thành công.
Không đụng backend.

## 38. Toast thật thay cho thông báo thành công nhét trong form (2026-09-08)

User yêu cầu thẳng: "thêm toast thông báo chứ đừng thành công trong form
như hiện tại" — §37 vừa sửa xong đã thay `.error`-nhầm-dùng bằng `.notice`
riêng, nhưng vẫn còn render NGAY TRONG `<form>` — user muốn 1 toast overlay
thật (nổi góc màn hình, tự biến mất), không nằm chung khối với các field.

**Sửa thật:**
1. `apps/web/src/useToast.ts` (mới) — hook dùng chung (không riêng cho
   login): `toasts: ToastItem[]`, `show(message, kind?)` (tự thêm id tăng
   dần, tự `setTimeout` gỡ sau 4s), `dismiss(id)`. Đặt Ở App.tsx (không
   phải trong `ConnectForm.tsx`) để sống sót qua chuyển màn login→connected
   (nếu 1 toast đang hiện lúc login xong, không bị unmount theo form).
2. `apps/web/src/components/ToastHost.tsx` (mới) — render danh sách toast,
   mỗi cái có nút đóng (`CloseIcon` từ `lucide-react`, đã có sẵn).
3. `apps/web/src/components/ConnectForm.tsx` — xoá hẳn state `notice`/span
   `#connect-notice`, thay bằng prop mới `onToast: (message: string) =>
   void` — lúc register thành công gọi `onToast(...)` thay vì set state nội
   bộ.
4. `apps/web/src/App.tsx` — `const toast = useToast()`, truyền
   `onToast={toast.show}` vào `<ConnectForm>`, render `<ToastHost
   toasts={toast.toasts} onDismiss={toast.dismiss} />` ở CẢ 2 nhánh
   (`.fh-auth-screen` lẫn trong `<RuntimeContext.Provider>`) — cùng pattern
   đã dùng cho `<ThemeToggle/>` ở Phase trước (2 nhánh loại trừ nhau, không
   bao giờ render cùng lúc).
5. `apps/web/public/style.css` — **phát hiện + sửa 1 lỗi thật tự gây ra ở
   §37**: rule `.notice` mới thêm lúc đó (`color: var(--status-success)`)
   TRÙNG TÊN với 1 class `.notice` CÓ SẴN từ trước (dùng cho entry lỗi/system
   trong `Conversation.tsx`'s chat log, màu `--error`) — bị đè nhầm, không
   phát hiện ra lúc đó vì chưa grep trước khi thêm. Gỡ hẳn rule trùng (không
   còn ai dùng `.notice` cho ConnectForm nữa), thêm rule mới tên riêng biệt
   `.fh-toast-host`/`.fh-toast`/`.fh-toast-success`/`.fh-toast-error`/
   `.fh-toast-close` — `z-index: 2000`, cao hơn settings dialog's `1000`
   (Phase 14) để không bao giờ bị che.

**Verify thật (jsdom + React thật + đúng `main.js` build ra, 10 assertion,
script xoá sau khi PASS):** không có `.fh-toast-host` nào trước khi tương
tác; register thành công → toast thật xuất hiện, đúng class
`.fh-toast-success`, KHÔNG nằm trong `.fh-auth-card` (xác nhận là overlay
riêng, không phải nhét trong form nữa); form vẫn tự chuyển về mode login
(giữ nguyên hành vi §37); bấm nút đóng → toast biến mất ngay; tạo tài khoản
thêm 1 lần → chờ đúng 4.1s không thao tác gì → toast tự biến mất (auto-
dismiss thật, không phải giả lập timer). Restart lại
`scripts/serve-web.mjs`, `curl` xác nhận `fh-toast-host` có trong `main.js`
served thật.

`pnpm run typecheck` sạch, `scripts/build-web.mjs` build lại thành công.
Không đụng backend.

## 39. Thay hand-rolled toast bằng `sonner` thật, theme lại đúng token của app (2026-09-08)

User: "toast xấu quá dùng 1 thư viện đẹp hơn có animation và style theme
custom theo của mình" — đúng tinh thần lucide-react ở Phase 14 follow-up
(đừng tự vẽ, dùng thư viện thật). Chọn **`sonner`** (`pnpm add sonner`,
version thật `2.0.8`, tác giả Emil Kowalski, dùng rộng rãi trong hệ sinh
thái React/shadcn) — animation thật (transform/opacity/height transition
400ms + swipe-to-dismiss gesture, đọc trực tiếp từ CSS thật đã cài, không
đoán), API tối giản (`toast.success(msg)` gọi thẳng từ bất kỳ đâu, không
cần Context/prop-drilling như bản tự viết).

**Nghiên cứu thật trước khi code (đọc thẳng `node_modules/sonner/dist/index.mjs`
+ `dist/styles.css` đã cài, không đoán theo tên biến quen thuộc):**
1. `sonner` xuất `dist/styles.css` RIÊNG (không tự inject qua JS) — phải tự
   load qua `<link>`, không phải `import` trong `.tsx`.
2. Theming qua CSS custom property thật: `--normal-bg/-border/-text`,
   `--success-bg/-border/-text`, `--error-bg/-border/-text`, đặt trên
   `[data-sonner-toaster][data-sonner-theme='light'|'dark']` — 2 block
   riêng, `theme` prop của `<Toaster>` quyết định giá trị attribute nào
   được set.
3. **Phát hiện quan trọng, dễ đoán sai:** rule `--success-*`/`--error-*`
   chỉ thật sự CÓ HIỆU LỰC (đổi màu nền/viền/chữ theo type) khi prop
   `richColors` bật — xác nhận bằng grep thật:
   `[data-rich-colors=true][data-sonner-toast][data-type=success]{background:var(--success-bg)...}`.
   Không bật `richColors` thì MỌI toast (bất kể type) đều chỉ dùng
   `--normal-*`, không phân biệt được thành công/lỗi qua màu.
4. `[data-sonner-toaster]` (danh sách `<ol>` thật) **CHỈ mount khi có ít
   nhất 1 toast** — trước đó chỉ có 1 `<section aria-label="Notifications
   alt+T" data-react-aria-top-layer>` RỖNG (v2 dùng react-aria's top-layer
   overlay, không phải `ReactDOM.createPortal` trần) — đúng cùng pattern
   "return null khi rỗng" bản tự viết đã dùng, không phải lỗi/giới hạn môi
   trường (ban đầu tưởng nhầm là bug jsdom, kiểm tra kỹ output thật mới xác
   nhận đúng hành vi thật của thư viện).
5. Icon dùng `fill="currentColor"` — tự đổi màu theo `color` kế thừa, không
   cần override riêng cho icon (khác với 1 bản nháp ban đầu đã LỠ tự thêm
   rule ép màu icon thủ công — bỏ đi, đúng cơ chế `richColors` lo hết).

**Sửa thật:**
1. Xoá hẳn `apps/web/src/useToast.ts` + `components/ToastHost.tsx` (Phase
   38's bản tự viết).
2. `apps/web/src/App.tsx` — `import { Toaster } from 'sonner'`, render
   `<Toaster theme="light" position="top-right" closeButton richColors />`
   ở CẢ 2 nhánh (giống pattern `<ThemeToggle/>`) — `theme="light"` cố định
   không quan trọng gì (đã giải thích trong comment) vì override CSS ở dưới
   không phụ thuộc giá trị đó, chỉ cần attribute TỒN TẠI.
3. `apps/web/src/components/ConnectForm.tsx` — bỏ hẳn prop `onToast`, gọi
   thẳng `toast.success(...)` từ `import { toast } from 'sonner'` — đúng
   API thật của thư viện, không cần truyền callback qua props nữa.
4. `apps/web/public/style.css` — xoá hẳn khối `.fh-toast-*` (Phase 38), thêm
   `[data-sonner-toaster][data-sonner-theme] { --normal-bg: var(--surface);
   ...; --success-text: var(--status-success); --error-text: var(--error);
   --border-radius: 12px; font-family: var(--fh-font) }` — cùng convention
   `.status-connected`'s "viền + chữ cùng màu status" đã có sẵn trong chính
   file này, không phát minh quy ước mới. Attribute value bỏ trống
   (`[data-sonner-theme]` không kèm `='light'`) để áp dụng bất kể sonner
   đang ở theme nào — token `--surface`/`--status-success`/... của APP đã
   tự đổi theo light/dark rồi, không cần đồng bộ 2 cơ chế theme riêng biệt.
5. `apps/web/public/index.html` — thêm `<link rel="stylesheet"
   href="./sonner.css">` GIỮA `theme.css` và `style.css` (thứ tự quan
   trọng: cùng specificity `[data-sonner-toaster][data-sonner-theme]`, ai
   load sau thắng — không cần `!important`).
6. `scripts/build-web.mjs` — thêm bước `copyFileSync(node_modules/sonner/dist/styles.css,
   apps/web/public/sonner.css)` chạy MỖI LẦN build — tự động theo đúng
   version cài trong `package.json`, không phải copy tay 1 lần rồi có nguy
   cơ lệch khi nâng cấp version sau này.

**Verify thật (jsdom + React thật + đúng `main.js` build ra, 13 assertion,
script xoá sau khi PASS):** trước khi có toast nào — KHÔNG có
`[data-sonner-toaster]` (đúng phát hiện #4, không phải bug), chỉ có
`[data-react-aria-top-layer]` rỗng; register thành công → `[data-sonner-toaster]`
mount thật, `[data-sonner-toast]` có `data-type="success"` +
`data-rich-colors="true"`, đúng text, KHÔNG nằm trong `.fh-auth-card`
(overlay thật, không nhét trong form); nút đóng THẬT (`[data-close-button]`,
do `closeButton` prop tạo ra, không phải tự vẽ) bấm vào → chờ đúng animation
dismiss (~600ms, khớp `transition: transform .4s` đọc từ CSS thật) → toast
biến mất thật. Restart lại `scripts/serve-web.mjs`, `curl` xác nhận
`sonner.css` served đúng (17681 bytes) và `main.js` có `data-sonner-toaster`.

`pnpm run typecheck` sạch, `scripts/build-web.mjs` build lại thành công (in
thêm dòng copy `sonner.css`). Không đụng backend.

## 40. Đổi màu chủ đạo sang cam `#F37021` — cả 2 theme, tính lại contrast thật (2026-09-08)

User: "màu chủ đạo phải là màu cam #F37021 sửa 2 theme xoay quanh màu này" —
thay hẳn accent xanh dương (Phase 4/14's "cùng gam màu blue-accent như dsh")
bằng đúng hex user chỉ định, áp cho CẢ light lẫn dark.

**Tính contrast thật trước khi chọn giá trị phụ thuộc (không đoán, dùng
đúng công thức WCAG relative-luminance, chạy bằng script Node thật):**
1. `#f37021` + chữ trắng = **2.94:1** — KHÔNG đạt AA (cần 4.5:1 cho chữ
   thường) → `--fh-accent-contrast` (chữ TRÊN nền accent, vd nút submit)
   phải là màu tối, không phải trắng. Chọn `#1a1006` (gần đen, ngả nâu ấm
   theo đúng gam màu cam) → contrast **6.38:1**, đạt tốt.
2. `#f37021` dùng làm MÀU CHỮ (không phải nền) trên các surface sáng của
   light theme (`--fh-surface`, `--fh-alias-bg-hover`) chỉ đạt
   **~2.5-2.6:1** — cũng KHÔNG đạt AA. Trên dark theme's surface tối thì
   NGƯỢC LẠI, đạt **~4.8-6.2:1** — đạt tốt, không cần sửa gì ở dark.
3. Sửa bằng cách thêm 1 tier alias MỚI, đúng convention static/alias/specific
   đã có sẵn trong chính file này (không phát minh hệ thống mới):
   `--fh-alias-accent-text` — light mode = `#b3450c` (cam cháy/burnt-orange,
   đậm hơn để đủ tối cho chữ, contrast **5.57:1** trên trắng, **4.66:1**
   trên `bg-hover`, cả 2 đều đạt AA), dark mode = **y hệt** `--fh-accent`
   (`#f37021`, vì đã đủ sáng để đọc trên nền tối rồi, không cần giá trị
   riêng).

**Sửa thật:**
1. `apps/web/public/theme.css` — `--fh-accent: #f37021` (cả `:root` lẫn 2
   khối dark), `--fh-accent-contrast: #1a1006` (cả 2 theme, không phải
   `#ffffff`/màu nền theme như trước — lý do: đây là màu CHO CHỮ TRÊN NỀN
   ACCENT, không phụ thuộc theme sáng/tối của TRANG, chỉ phụ thuộc độ sáng
   của chính màu accent), thêm mới `--fh-alias-accent-text` (2 giá trị khác
   nhau theo theme, xem tính toán trên). `--fh-bubble-user` (nền bong bóng
   chat của user — Phase 4's thiết kế vốn dùng tint CÙNG GAM MÀU accent) đổi
   từ tint xanh dương sang tint cam: light `#fdece0` (cam nhạt), dark
   `#3a2712` (nâu cam đậm) — giữ đúng nguyên tắc gốc "bubble-user tint theo
   accent hue", chỉ đổi hue từ xanh sang cam.
2. `apps/web/public/style.css` — alias layer (`:root`/`@media dark`) cập
   nhật fallback hex khớp theo (phòng khi `theme.css` load lỗi, trang vẫn
   dùng đúng gam cam thay vì cam-lẫn-xanh-cũ dở dang), thêm
   `--accent-text: var(--fh-alias-accent-text, ...)`. **2 chỗ dùng
   `color: var(--accent)` (chữ, không phải nền/viền) đổi sang
   `var(--accent-text)`**: `.fh-session-row.active .fh-session-row-title`
   (tên session đang active trong sidebar) và `.fh-auth-switch` (link
   "Register"/"Log in" toggle trên màn login). 3 chỗ `border-color:
   var(--accent)` (focus ring input/select) và nút submit's
   border+background giữ nguyên `var(--accent)` — border chỉ cần đạt 3:1
   (WCAG non-text), `#f37021` vs trắng = 2.94:1, gần sát ngưỡng, không đáng
   thêm 1 token nữa cho khác biệt nhỏ này.
3. `--fh-bubble-live` (bong bóng "đang trả lời", màu hổ phách/vàng) VÀ mọi
   `--fh-alias-status-*` (success/danger, xanh lá/đỏ) **giữ nguyên, không
   đổi** — đây là màu trạng thái NGỮ NGHĨA (đang chạy, thành công, lỗi),
   không phải nhận diện thương hiệu, đổi accent không kéo theo đổi các màu
   này.

**Verify thật:** rà `grep` toàn bộ `apps/web/public/*.css` tìm lại các hex
xanh dương cũ (`#4176e6`/`#679efe`/`#2563eb`/`#5b9dff`/`#edf3fe`/`#34415b`/
`#e8f0fe`/`#1e3a5f`) — **0 kết quả**, xác nhận đổi sạch, không sót. Liệt kê
lại TOÀN BỘ 7 chỗ dùng `var(--accent*)` trong `style.css`, xác nhận đúng
phân loại: 2 chữ → `--accent-text`, 4 nền/viền → `--accent`, 1 chữ-trên-nền-accent
(nút submit) → `--accent-contrast`. `curl` trực tiếp `theme.css` đang served
thật qua `scripts/serve-web.mjs` (không cần restart — CSS tĩnh, server đọc
lại từ đĩa mỗi request nhờ `Cache-Control: no-store`, §29) xác nhận cả 2
khối theme (light `:root` + dark `@media`/`[data-theme]`) đều có đúng giá
trị cam mới. `pnpm run typecheck` sạch (không đụng file `.ts`/`.tsx` nào,
thuần CSS).

## 41. Nút bấm chưa ổn — nghiên cứu lại thật kỹ hệ button của dsh, sửa theo đúng số liệu thật (2026-09-08)

User: "các button đang chưa ổn lắm tham khảo của dsh" — quay lại đúng
phương pháp Phase 14 (đọc thẳng compiled output đã cài, không đoán).
`dsh-client-ui-primitives` (nơi `Button` thật sự nằm) **vẫn chưa cài** trên
máy này (giống Phase 14) — nên lần này đào SÂU HƠN vào MỌI package
`client-ui-*` đã cài có CSS button thật của RIÊNG nó (không qua
primitives), tìm được bộ dữ liệu thật phong phú hơn hẳn Phase 14:

**Research thật (grep trực tiếp `node_modules/@deepseek-ai/dsh-client-ui-*/lib/client.js`,
trích đúng rule CSS, không đoán):**
1. `dsh-client-ui-sidebar`'s `.newSession` (CTA chính của sidebar) —
   `height:38px;border-radius:12px` — **hình chữ nhật bo góc MỀM, KHÔNG
   PHẢI pill**, dù cao tới 38px. Xác nhận LẠI đúng phát hiện Phase 14 (12px
   là radius nút sidebar/nav thật), lần này có đúng rule CSS đầy đủ, không
   chỉ suy luận từ tên class.
2. `dsh-client-ui-settings-models` có SẴN 1 hệ button thật đầy đủ nhất tìm
   được: `.primaryButton` (`background:var(--dsw-alias-button-primary-fill)`,
   kết hợp base `.addButton`: `height:36px;border-radius:18px` — ĐÚNG
   pill, `radius = height/2`), `.addModelButton`/`.linkButton` (tier nhỏ
   hơn: `height:28px;border-radius:14px` — cũng pill, cùng công thức
   `height/2`), `.dangerButton` (chữ đỏ, không viền/nền, 2 size),
   `.iconButton` (28px vuông bo `6px` — KHÔNG PHẢI hình tròn, khác hẳn icon
   button ngữ cảnh sidebar/toolbar). **`:disabled{opacity:.4}`** — xác nhận
   đúng SỐ THẬT (file cũ đang để `0.5`, gần nhưng sai).
3. `dsh-client-ui-agent-preset`'s `.secondaryButton` (chữ, không viền) +
   `.creatorButton` (viền NÉT ĐỨT, `height:44px;radius:12px` — mẫu "thêm
   mới X" thật, lặp lại y hệt ở `.addButton`'s biến thể dashed trong
   settings-models — xác nhận 2 nguồn ĐỘC LẬP cùng 1 convention thật, không
   phải trùng hợp).
4. **Kết luận quan trọng, sửa lại giả định sai của chính Phase 14**: dsh
   KHÔNG có 1 công thức radius duy nhất áp cho mọi nút — có 2 nhóm thật rõ
   ràng: nút NỔI BẬT/chính (sidebar CTA, settings save/discard 8px) dùng
   radius CỐ ĐỊNH nhỏ (8-12px) dù cao tới 36-44px; nút PHỤ/nhỏ hơn
   (addModelButton/linkButton/dangerButton-nhỏ) dùng pill thật
   (`radius=height/2`). Icon button cũng chia 2: NAV/toolbar (sidebar
   toggle, đóng dialog) = hình tròn `50%` (đã đúng từ Phase 14); INLINE/
   trong 1 hàng danh sách (nút đổi tên session) = vuông bo nhỏ `6-7px`, chứ
   không phải tròn — lỗi thật của Phase 14 áp nhầm hình tròn cho MỌI icon
   button không phân biệt ngữ cảnh.

**Sửa thật, đúng số liệu vừa đọc được:**
1. `button` (base, dùng cho nút nổi bật/mặc định) — thêm `height: 34px` cố
   định (khớp input 34px đã có, thay vì `padding` co giãn theo em), padding
   chỉ còn ngang `0 0.9em`, giữ radius `12px` (đúng `.newSession` thật —
   không đổi, chỉ sửa lại comment trích dẫn cho đúng rule CSS thật vừa đọc
   được thay vì chỉ tên class).
2. `button:disabled` — `opacity: 0.4` (sửa từ `0.5`, đúng số thật đọc từ
   `.iconButton:disabled`/`.addModelButton:disabled`).
3. `button[type="submit"]` (2 CTA chính: Log in, Send) — giữ nguyên
   `border-radius:999px` (tương đương hình ảnh HỆT `18px` tại chiều cao
   36px thật của `.primaryButton` — CSS tự động clamp radius về nửa chiều
   cao, 999px chỉ là cách viết an toàn hơn nếu chiều cao đổi sau này, không
   phải giá trị sai).
4. `#new-session-button, #logout-button` (nút phụ trong session-bar) —
   THÊM `height: 28px; border-radius: 14px` (tier nhỏ, pill thật —
   `height/2` — đúng `.addModelButton`/`.linkButton`), trước đó dùng
   CHUNG kích thước với nút CTA chính, không đúng phân cấp thật của dsh.
5. `.fh-auth-switch` (toggle Login/Register) — thêm `height: 28px; padding:
   0 10px; border-radius: 14px` — đúng `.linkButton` thật (28px/14px/`0
   10px`), cho nó 1 vùng bấm THẬT dù chrome vẫn trong suốt, không chỉ text
   trần co theo font-size như trước.
6. `.fh-session-row-rename` (nút đổi tên, nằm TRONG 1 hàng session-list) —
   đổi `border-radius` từ `999px` (tròn) → `6px` (vuông bo nhỏ) — đúng
   `.iconButton` thật của settings-models cho ngữ cảnh inline/list-row,
   KHÔNG áp dụng convention tròn của icon button ngữ cảnh nav/toolbar
   (`.fh-sidebar-toggle`/`.fh-theme-toggle`/`.fh-settings-close` VẪN giữ
   tròn `999px` — đúng, vì chúng thật sự ở ngữ cảnh nav/toolbar, xác nhận
   lại bằng `.iconButton` thật của CHÍNH `dsh-client-ui-sidebar`/
   `dsh-client-ui-workspace`, cả 2 đều tròn `50%` cho đúng ngữ cảnh đó).

**Verify thật:** `pnpm run typecheck` sạch, `scripts/build-web.mjs` build
lại (không đụng `.ts`/`.tsx` nào — thuần CSS, main.js build lại y hệt).
`curl` trực tiếp `style.css` đang served thật (không cần restart —
`Cache-Control: no-store`) xác nhận cả 6 chỗ sửa đều lên đúng giá trị. jsdom
+ React thật chạy đúng `main.js` build ra (7 assertion, script xoá sau khi
PASS): toàn bộ nút (submit, auth-switch, new-session, logout, theme-toggle)
vẫn render đúng qua cả 2 màn hình (login → connected) sau khi đổi CSS,
KHÔNG có lỗi React nào — xác nhận sửa thuần style không làm hỏng cấu trúc/
hành vi. **Chưa verify được bằng mắt thật** (vẫn không có Claude in Chrome
suốt dự án) — chỉ xác nhận đúng số liệu/cấu trúc đã áp đúng số thật đọc
được từ dsh, giống hệt giới hạn đã ghi nhận ở Phase 14.

## 42. Chữ/icon trắng trên nút nền màu đặc, cam light sáng hơn cam dark — quyết định thiết kế trực tiếp của user (2026-09-08)

User: "Các nút có màu thì nền mà full màu thì text hay icon nên màu trắng
và màu cam này khi light nên sáng hơn màu cam của khi dark" — 2 yêu cầu rõ
ràng, NGƯỢC lại quyết định contrast tôi tự chọn ở §40:
1. Nút nền đặc màu accent → chữ/icon PHẢI trắng (không phải gần-đen như
   §40 chọn vì lý do contrast).
2. Cam ở light theme phải SÁNG HƠN cam ở dark theme — ngược hẳn pattern
   thông thường của app này (accent xanh dương cũ trước đây SÁNG HƠN ở dark
   so với light, đúng kiểu "accent sáng hơn trên nền tối" phổ biến).

**Đây là quyết định thiết kế trực tiếp, rõ ràng của user — không phải yêu
cầu "sửa lỗi", nên làm đúng theo, không tự ý "sửa lại cho đúng chuẩn AA"
như đã làm ở §40.** Chỉ tính lại contrast thật (script Node, không đoán) để
CHỌN GIÁ TRỊ CAM CỤ THỂ cho từng theme sao cho vẫn còn đọc được ở mức chấp
nhận nhá được, không phải để phủ quyết yêu cầu.

**Giá trị mới (tính bằng script Node thật, công thức HSL + WCAG luminance):**
- Light `--fh-accent`: `#ff7a1f` (HSL ~24°,100%,56% — sáng hơn `#f37021`'s
  54%).
- Dark `--fh-accent`: `#d9600f` (HSL ~24°,87%,45% — tối hơn rõ rệt, đúng
  hướng "dark theme cam tối hơn" user yêu cầu).
- `--fh-accent-contrast`: `#ffffff` cả 2 theme (trước là `#1a1006`).
  Contrast trắng-trên-cam: light `2.61:1`, dark `3.73:1` — cả 2 đều DƯỚI
  4.5:1 (không đạt AA cho chữ thường) — user đã được thông báo rõ đây là
  đánh đổi có chủ đích ở §40's finding, giờ chọn ưu tiên đúng yêu cầu brand/
  thiết kế thay vì AA.
- **Tách hẳn `--fh-alias-accent-text` khỏi `--fh-accent`** (trước đó dark
  mode 2 token này TRÙNG giá trị `#f37021`) — vì giờ `--fh-accent` (dark) đã
  đổi thành `#d9600f` (tối hơn), nếu vẫn dùng chung giá trị thì
  `--fh-alias-accent-text` (dùng làm MÀU CHỮ trên nền dark, không phải nền
  accent) sẽ tụt xuống chỉ `3.75-4.21:1` (tính lại, dưới AA) so với
  `#f37021`'s `4.76-6.21:1` cũ. Giữ `--fh-alias-accent-text` dark = đúng
  `#f37021` (giá trị gốc, contrast tốt hơn khi dùng làm CHỮ), độc lập hoàn
  toàn với `--fh-accent` (giờ dùng cho NỀN/viền, brightness theo yêu cầu
  user) — 2 token phục vụ 2 mục đích khác nhau, không còn lý do gì để bằng
  nhau nữa.

**Sửa thật:** `apps/web/public/theme.css` (cả 3 khối: `:root`, `@media
dark`, `[data-theme="dark"]`) + `apps/web/public/style.css` (2 khối fallback
alias, `:root` và `@media dark`) — không đụng file `.ts`/`.tsx` nào, thuần
CSS.

**Verify thật:** `pnpm run typecheck` sạch, `scripts/build-web.mjs` build
lại. `curl` trực tiếp cả `theme.css` (cả 3 khối) lẫn `style.css` đang served
thật xác nhận đúng giá trị mới. jsdom + React thật (2 assertion, script xoá
sau khi PASS): login thật vẫn hoạt động, `#app` mount đúng, KHÔNG có lỗi
React nào sau khi đổi CSS — xác nhận thuần đổi màu không làm hỏng gì khác.

## 43. Phase 15 — build lại sidebar layout đúng cấu trúc thật của dsh (2026-09-08)

Implement đúng thiết kế đã viết ở `docs/agent-core-architecture-roadmap.md`'s
Phase 15 (research + quyết định phạm vi đầy đủ ở đó, không lặp lại ở đây).
Tóm tắt phần code thật:

**`apps/web/src/icons.tsx`** — thêm `Bot as BrandIcon` (brand mark trung
tính, không phải logo thật của dsh), `Plus as PlusIcon` (New session),
`Search as SearchIcon`, `PanelLeftClose/PanelLeftOpen as PanelLeftCloseIcon/
PanelLeftOpenIcon` (collapse toggle, đổi icon theo trạng thái).

**`apps/web/src/components/Sidebar.tsx`** — viết lại hoàn toàn theo đúng 4
vùng thật: logo row (brand mark+tên + nút collapse thật), New Session CTA
(chuyển từ `#session-bar` ở header vào đây — đúng vị trí thật), region chứa
`<SessionList/>`, `PluginUiArea` (Phase 13, giữ nguyên), footer Settings.

**`apps/web/src/components/SessionList.tsx`** — search đổi từ input luôn
hiện sang nút tròn 28px bung ra thành input khi bấm (đúng hành vi thật
`.search`/`.searchExpanded`), tự `blur()` khi rỗng thì thu lại; rename
button đổi icon size `13→11px` khớp kích thước nút mới (16px).

**`apps/web/src/App.tsx`** — thêm `STORAGE_SIDEBAR_COLLAPSED`, state
`sidebarPinnedCollapsed` (khởi tạo từ `localStorage`, cùng pattern
`useTheme.ts`). `sidebarCollapsed` đổi công thức: `narrow ?
!sidebarManuallyExpanded : sidebarPinnedCollapsed` — trước đó màn RỘNG
KHÔNG BAO GIỜ thu gọn được (`connected && narrow && ...`), giờ có
`toggleSidebarCollapse()` DÙNG CHUNG cho cả nút trong sidebar lẫn hamburger
ở header (2 nút, 1 hàm) — tự phân nhánh: màn hẹp = tạm hiện lại (không lưu,
đúng hành vi cũ), màn rộng = pin/unpin thật, lưu `localStorage`. `<Sidebar>`
nhận thêm `onToggleCollapse`/`onNewSession`; `#session-bar` chỉ còn
session-id + Logout (New Session đã chuyển đi).

**`apps/web/public/style.css`** — viết lại/thêm mới toàn bộ CSS vùng
sidebar theo đúng số liệu thật đọc được (chi tiết đầy đủ ở roadmap's Phase
15): `#sidebar-col{padding:6px 12px}`, `.fh-sidebar-logo-row{height:60px}`
(rail `36px`), `.fh-sidebar-brand-name{font-size:18px;font-weight:600;
letter-spacing:.04em}`, `.fh-sidebar-new-session{height:38px;border-radius:
12px}` (rail: icon-only 36×36, không viền/nền), `.fh-sidebar-region`
(đổi tên từ `#sidebar-workspaces`, cùng hành vi), search
toggle+expanded-input mới, session row đổi từ padding co giãn sang
`height:32px` cố định + `.fh-session-row-title{font-size:14px}` (trước đó
kế thừa `0.85em` của row ≈ 11.9px, nhỏ hơn thật). **Sửa lại LẦN 2**
`.fh-session-row-rename`: `22px/6px` (trích từ package settings-models, sai
ngữ cảnh) → `16px/4px` (trích đúng từ chính `dsh-client-ui-workspace`'s
`Rows.module.css`, đúng ngữ cảnh session-row) + thêm `display:none` mặc
định, chỉ hiện khi `.fh-session-row:hover` (đúng hành vi thật, trước đó
luôn hiện). Thêm `.fh-sidebar-collapse-toggle` vào chung selector 28px-tròn
đã có (`.fh-sidebar-toggle`/`.fh-theme-toggle`). **1 lỗi CSS specificity
thật tự bắt được lúc viết**: `.fh-session-list-search`'s `background:
transparent` bị rule `input[type="text"]` (định nghĩa sau, cùng/hơn
specificity) đè mất — sửa bằng selector `input[type="text"].fh-session-list-search`
(compound, chắc chắn thắng, không phụ thuộc thứ tự file).

**Verify thật (jsdom + React thật + đúng `main.js` build ra, 2 script,
xoá sau khi PASS):**
1. **Màn rộng** (`getBoundingClientRect` stub 1200px — jsdom không có
   layout thật, `ResizeObserver` stub cũng không tự bắn resize, nên phải tự
   stub kích thước để test đúng nhánh "rộng" thay vì mắc kẹt ở nhánh "hẹp"
   mặc định do `viewportWidth` khởi tạo `0` — giới hạn môi trường, không
   phải bug sản phẩm) — 18 assertion: brand row đúng tên+icon thật; toggle
   thật có mặt, bấm vào đổi `.fh-sidebar-rail` + LƯU `localStorage` đúng
   giá trị, bấm lại quay về + lưu lại; `#new-session-button` KHÔNG còn
   trong header; nút New Session trong sidebar bấm vào MỞ THẬT 1 WS connection
   thứ 2 (đếm số lần `FakeSocket` được tạo, không phải giả lập UI suông);
   search đúng hành vi bung/thu.
2. **Màn hẹp** (stub 600px) — 4 assertion: tự thu gọn mặc định, hamburger
   header vẫn hoạt động (tạm hiện lại), xác nhận KHÔNG lưu `localStorage`
   (đúng thiết kế — chỉ pin/unpin ở màn rộng mới lưu).

Restart lại `scripts/serve-web.mjs`, `curl` xác nhận `fh-sidebar-new-session`
(trong `main.js`) và `fh-sidebar-collapse-toggle` (trong `style.css`) đều có
trong bundle served thật. `pnpm run typecheck` sạch, `scripts/build-web.mjs`
build lại thành công. Không đụng backend — không cần
`scripts/upstream-smoke-test.mjs`.

## 44. `apps/web/public/` lẫn 1 đống file build thừa, served thật qua HTTP — bug thật, không phải câu hỏi suông (2026-09-08)

User hỏi thẳng: "các file trong đây là gì có dùng ko" (chỉ vào
`apps/web/public/`). Kiểm tra thật (không đoán) thì phát hiện 1 bug thật:
`apps/web/tsconfig.json` có `"outDir": "public"` — TRÙNG với thư mục
`scripts/serve-web.mjs` serve thật (`ROOT = apps/web/public`, serve MỌI
file trong đó, không giới hạn). Mỗi lần `tsc -b` chạy (là bước ĐẦU của
`pnpm run typecheck`/`build`), nó tự emit `.js`+`.d.ts` cho MỌI file
`src/*.ts(x)` thẳng vào `public/` — `App.js`, `components/*.js`,
`icons.js`, `runtime.js`, `wire.js`, ..., cộng `.tsbuildinfo` — TRỘN LẪN
với 5 file thật app cần (`index.html`/`main.js`/`theme.css`/`sonner.css`/
`style.css`, load qua `index.html`'s `<link>`/`<script>`). `main.js` của
tsc bị `scripts/build-web.mjs` (esbuild) chạy NGAY SAU đó ghi đè lại đúng
bundle thật — nên KHÔNG gây lỗi chức năng — nhưng mọi file CÒN LẠI (App.js,
components/*, .tsbuildinfo, ...) không hề bị ghi đè, nằm lại vĩnh viễn,
VÀ THẬT SỰ TRUY CẬP ĐƯỢC qua HTTP (xác nhận `curl -o /dev/null -w '%{http_code}'`
→ `200` cho `App.js`/`.tsbuildinfo`/`components/Sidebar.d.ts` trước khi
sửa) — không phải lý thuyết, dev server ĐANG serve chúng thật.

**Vì sao xảy ra:** `tsconfig.base.json` có `"composite": true` (bắt buộc để
`apps/web` tham gia được `tsc -b` từ root `tsconfig.json`'s `"references"`
list) → `composite:true` BẮT BUỘC `declaration:true` đi kèm (TypeScript tự
enforce) → mọi package trong monorepo đều thật sự emit `.js`+`.d.ts` khi
`tsc -b` chạy, kể cả `apps/web` dù nó không phải 1 thư viện ai import cả.
Mọi package KHÁC (`packages/*`, `services/*`) đều đặt `outDir: "lib"` (đã
có sẵn trong `.gitignore`) — chỉ riêng `apps/web` lỡ đặt `outDir: "public"`,
gần như chắc chắn là tàn dư từ trước khi `scripts/build-web.mjs` (esbuild)
được thêm vào (Phase 2, lúc đó có lẽ định để `tsc` tự emit thẳng `main.js`
vào `public/`), không ai dọn lại sau khi esbuild thay thế vai trò đó.

**Sửa thật:** `apps/web/tsconfig.json` — `outDir: "public"` →
`outDir: "lib"` + `tsBuildInfoFile: "lib/.tsbuildinfo"` — ĐÚNG y hệt
convention mọi package khác trong repo đang dùng (đối chiếu trực tiếp
`packages/core/tsconfig.json`, giống hệt). `lib/` đã nằm sẵn trong
`.gitignore` — không cần sửa gì thêm ở đó. Xoá thật 19 file/thư mục cũ
(`App.js`, `App.d.ts`, `main.d.ts`, `icons.js/.d.ts`, `pluginUi.js/.d.ts`,
`runtime.js/.d.ts`, `useEnabledPlugins.js/.d.ts`, `useTheme.js/.d.ts`,
`useToast.js/.d.ts`, `wire.js/.d.ts`, `.tsbuildinfo`, cả thư mục
`components/`) khỏi `public/`.

**Verify thật:** `pnpm run typecheck` chạy lại — xác nhận `lib/` giờ có
đúng bộ file `tsc` emit (kể cả `.tsbuildinfo`), `public/` chỉ còn ĐÚNG 5
file thật cần (`index.html`/`main.js`/`sonner.css`/`style.css`/`theme.css`).
Restart `scripts/serve-web.mjs`, `curl` lại: `App.js`/`.tsbuildinfo`/
`components/Sidebar.d.ts` giờ **404 thật**, 5 file thật vẫn **200**. jsdom +
React thật (2 assertion, script xoá sau khi PASS): app vẫn boot + login
được bình thường sau khi dọn — xác nhận đổi `outDir` không đụng gì tới hành
vi thật của app (chỉ dọn rác build, main.js's nội dung không đổi).

## 45. Đối chiếu layout thật với chat.deepseek.com (ảnh chụp thật, không phải research compiled source) (2026-09-08)

User: "Hiện tại layout đang rất sai và thiếu logic hãy tham khảo web
https://chat.deepseek.com/". `chat.deepseek.com` trả `403` qua `WebFetch`
(chặn bot) và không có Claude in Chrome (đã từ chối từ đầu dự án) — không
thể tự truy cập trực tiếp. User gửi 1 ảnh chụp màn hình THẬT của trang đó
(qua đường dẫn file cục bộ) — lần đầu tiên trong cả dự án đối chiếu bằng
ẢNH THẬT thay vì đọc compiled CSS-in-JS suy luận gián tiếp.

**Phát hiện thật từ ảnh (đọc trực tiếp, không suy đoán):**
1. Brand row thật gồm CẢ logo + icon search + icon toggle-panel trên CÙNG 1
   hàng — khác hẳn Phase 15's thiết kế (search nằm riêng trong header của
   session list).
2. Nút "New chat" hình PILL THẬT SỰ TRÒN 2 đầu — không phải bo góc mềm
   12px như trích dẫn từ package `dsh-client-ui-sidebar` đã cài (rất có thể
   version npm đã cài LỆCH so với bản đang chạy thật trên production —
   **ảnh chụp thật được ưu tiên hơn compiled source khi 2 nguồn mâu
   thuẫn nhau**, ghi rõ nguyên tắc mới này).
3. Session list chia nhóm theo NGÀY thật ("Today", "30 Days") — không phải
   danh sách phẳng như đang có.
4. Footer thật là 1 hàng TÀI KHOẢN (avatar tròn + tên thật + nút "…") —
   KHÔNG PHẢI nút "Settings" chữ + icon gear như đang có.
5. Màn hình "welcome" khi chưa có tin nhắn: 3 tab mode (Instant/Expert/
   Vision) + composer to nằm giữa màn hình với nút DeepThink/Search.

**Hỏi lại user qua `AskUserQuestion` về đúng 1 điểm mơ hồ nhất** (3 tab mode
— fox-harness không có khái niệm nhiều mode, chỉ 1 model cố định/session,
làm giống y hệt sẽ là UI giả không có chức năng thật đứng sau) — user chọn:
bỏ hẳn tab mode giả, chỉ style composer to hơn khi chưa có tin nhắn.

**Phát hiện phụ, phải sửa BACKEND mới làm được (không chỉ FE):** để hiện
đúng email thật ở footer, kiểm tra thấy FE **CHƯA TỪNG lưu email đăng nhập
ở đâu cả** — `POST /auth/login` (kể cả sau Phase 7) chỉ trả về `{token,
role}`, không có `email`. Sửa thật:
`services/gateway/src/auth.ts`'s `login()` thêm `email` vào kết quả trả về
(đã có sẵn `user.email` trong scope, không cần query thêm) → `index.ts`'s
route trả `{token, email, role}` → `apps/web/src/App.tsx` lưu email vào
`sessionStorage` (cùng vòng đời với token) → `runtime.ts` thêm
`userEmail: string` vào `Runtime`.

**Sửa thật FE:**
1. `apps/web/src/components/Sidebar.tsx` — search state (`searchOpen`/
   `query`) chuyển từ `SessionList.tsx` lên đây; nút search-toggle nằm
   TRONG logo row cạnh brand+collapse-toggle; input bung ra thành 1 hàng
   RIÊNG ngay dưới logo row khi bấm. Footer đổi hẳn từ nút Settings →
   `.fh-sidebar-account` (avatar tròn = chữ cái đầu email viết hoa +
   email thật) — VẪN mở đúng dialog Settings cũ (`id="settings-trigger"`
   giữ nguyên), chỉ đổi GIAO DIỆN của nút bấm, không đổi hành vi.
2. `apps/web/src/components/SessionList.tsx` — nhận `query` qua prop thay
   vì tự quản lý; thêm nhóm ngày thật (`Today`/`Yesterday`/`Previous 7
   Days`/`Previous 30 Days`/`Older`, tính từ `updatedAt` thật, bỏ nhóm rỗng
   — không phải fake, đúng dữ liệu thật của user).
3. `apps/web/src/components/Conversation.tsx` — thêm `isEmpty` (không có
   entry/live-bubble nào) → hiện `.fh-conversation-empty-heading` (icon +
   "Start a conversation") thay `#log` rỗng, composer CÙNG 1 form thật
   (không thêm control giả) được style to hơn qua class cha
   `.fh-conversation-empty` — ĐÚNG quyết định user vừa chọn (bỏ tab mode).
4. `apps/web/public/style.css` — `.fh-sidebar-new-session`'s radius
   `12px→999px` (ưu tiên ảnh thật hơn citation cũ), thêm
   `.fh-sidebar-search-toggle`/`.fh-sidebar-search-row`,
   `.fh-sidebar-account`/`-avatar`/`-email`, `.fh-session-group`/
   `-group-label`, `.fh-conversation-empty`/`-heading`. Xoá hẳn CSS chết
   (`.fh-session-list-header`/`.fh-session-search-toggle` cũ,
   `.fh-sidebar-settings-trigger`).

**Verify thật:**
1. **Backend thật** — restart lại `services/gateway` (`kill` process cũ,
   chạy lại đúng lệnh gốc `node --experimental-strip-types
   services/gateway/src/index.ts` từ repo root để `process.loadEnvFile()`
   đọc đúng `.env`), register + login thật qua `curl` → xác nhận response
   CÓ `email` thật (trước đây không có).
2. **jsdom + React thật + đúng `main.js` build ra** (14 assertion, script
   xoá sau khi PASS): search-toggle nằm trong logo row, KHÔNG còn header
   riêng trong session list; footer avatar hiện ĐÚNG chữ cái đầu + ĐÚNG
   email thật vừa đăng nhập (không phải placeholder); session cập nhật
   HÔM NAY được nhóm đúng "Today"; màn welcome hiện heading thật, XÁC NHẬN
   KHÔNG có chữ "Instant"/"Expert"/"Vision" ở đâu cả trong toàn bộ trang;
   gửi 1 frame `snapshot` có tin nhắn thật → `#log` xuất hiện, heading
   welcome biến mất — xác nhận chuyển trạng thái đúng, không phải bug 1
   chiều.

Restart cả `services/gateway` lẫn `scripts/serve-web.mjs`, `curl` xác nhận
mọi thay đổi đều served thật (`fh-sidebar-account-avatar`,
`fh-conversation-empty-heading` trong `main.js`, `border-radius: 999px`
trong `style.css`). `pnpm run typecheck` sạch.

## 46. Phase 16 — bỏ hẳn kho plugin theo user/session (đảo ngược kiến trúc lần 2) (2026-09-08)

Implement đúng thiết kế đã viết ở `docs/agent-core-architecture-roadmap.md`'s
Phase 16 (bối cảnh + lý do đầy đủ ở đó — user phát hiện qua chính cuộc hỏi
đáp về mô hình session rằng nhu cầu thật là "mọi user cần giống nhau về
năng lực", không phải "mỗi user/session tự chọn", nên cả cơ chế catalog lẫn
bật/tắt đều thừa). Tóm tắt phần code thật đã xoá/sửa:

**Xoá thật:**
- `services/plugin-registry/` — nguyên service (đã `kill` process đang chạy
  trước khi xoá source).
- `infra/migrations/004_remove_plugin_store.sql` (migration MỚI, không sửa
  lại `001_init.sql`) — `drop table session_enabled_plugins` rồi
  `plugin_catalog` (đúng thứ tự FK). **Áp dụng thật lên Postgres đang chạy**
  qua `psql`, xác nhận `\dt` chỉ còn `users`/`sessions`.
- `services/orchestrator/src/postgres.ts` — xoá nguyên file (chỉ tồn tại để
  đọc `plugin_catalog`, không còn ai gọi). Kéo theo: dependency `pg`/
  `@types/pg` khỏi `services/orchestrator/package.json` (chỉ dùng trong file
  vừa xoá), `config.databaseUrl`/`config.pluginArtifactsDir` khỏi
  `services/orchestrator/src/config.ts` (cả 2 đều hết consumer sau khi xoá
  `postgres.ts`).
- `services/orchestrator/src/materialize.ts` — bỏ `listApprovedPluginIds`,
  `pluginRow()`, toàn bộ vòng lặp copy artifact vào `node_modules`. Hàm
  `materializeDshHome` giờ chỉ còn: copy thẳng `profile.package.json` từ
  template (không cần đọc/parse/ghi lại nữa vì không còn gì để sửa), ghi
  `cordis.patch.yml` = đúng `transportRow()`.
- `services/gateway/src/index.ts` — bỏ 4 route (`GET/POST /plugin-catalog`,
  `POST /plugin-catalog/:id/approve`, `GET/POST /sessions/:id/plugins(...)`)
  + toàn bộ block proxy (~55 dòng). **Giữ nguyên** `GET /sessions/:id/plugin-inventory`
  — công cụ chẩn đoán đọc live Cordis Loader state, không liên quan gì tới
  cơ chế catalog/bật-tắt vừa bỏ.
- `services/gateway/src/config.ts` — bỏ `pluginRegistryUrl`.
- `tsconfig.json` — bỏ reference `services/plugin-registry`.
- FE: `SettingsPlugins.tsx`, `useEnabledPlugins.ts`, `pluginUi.tsx`,
  `DemoPluginButton.tsx` (4 file xoá hẳn). `Sidebar.tsx` bỏ `PluginUiArea`.
  `SettingsDialog.tsx` bỏ section `SettingsPlugins` (giữ nguyên
  `PluginInventory`).

**Verify thật (không phải chỉ đọc code):**
1. `pnpm run typecheck` sạch trên workspace đã giảm (11 project, trước đó
   12 — đúng số `services/plugin-registry` vừa bỏ).
2. Migration thật áp lên Postgres đang chạy — `\dt` xác nhận 2 bảng đã mất.
3. Restart thật cả `services/gateway` + `services/orchestrator` (code đổi
   ăn theo ngay), `curl` xác nhận `GET /plugin-catalog`/`GET /sessions/:id/plugins`
   trả **404 thật** (route không còn tồn tại), `GET /sessions/mine`/
   `GET /models` vẫn 200 bình thường.
4. **Test WS thật đầu-cuối** (script Node, xoá sau khi PASS): đăng ký/login
   thật → mở session MỚI thật qua `ws://.../sessions/new` → container thật
   boot thành công bằng đúng `materialize.ts` đã đơn giản hoá (không query
   Postgres gì nữa) → `GET /sessions/:id/plugin-inventory` vẫn 200 (route
   chẩn đoán sống sót đúng ý) → **xác nhận `duckduckgo_web_search` CÓ SẴN
   trong session hoàn toàn mới, không bật gì cả** — chứng minh năng lực thật
   vẫn còn nguyên, chỉ mất đúng lớp quản trị thừa.
5. jsdom + React thật + đúng `main.js` build ra (6 assertion, script xoá
   sau khi PASS): không còn `#sidebar-plugin-ui` nào; settings dialog mở
   được, còn ĐÚNG 1 section (`PluginInventory`, `SettingsPlugins` đã mất);
   không lỗi React nào.

**Dọn theo (không phải xoá nhầm, cố ý sửa lại 1 comment đã sai TỪ TRƯỚC cả
hôm nay):** `packages/core/src/quota.ts`'s comment cũ ghi "chưa có user
identity nào trong dự án" — SAI từ sau Phase 7 (user identity thật đã có từ
lâu), càng sai hơn khi trích dẫn `session_enabled_plugins` giờ không còn
tồn tại. Sửa lại đúng lý do THẬT quota vẫn tính theo session (worker không
có kết nối Postgres, không phải vì không có user identity).

Restart cả `services/gateway`, `services/orchestrator`,
`scripts/serve-web.mjs`. Không đụng `services/plugin-registry` (đã xoá, không
còn gì để restart).

## 47. Sidebar thu gọn (rail) được nhưng không mở lại được — bug thật, Phase 15 để sót (2026-09-09)

User báo: "sidebar có collapse nhưng ko có mở lại". Kiểm tra thật (không
đoán) thì đúng là bug thật, không phải hiểu lầm: `style.css` có rule

```css
#sidebar-col.fh-sidebar-rail .fh-sidebar-collapse-toggle {
  display: none;
}
```

— lúc sidebar thu gọn về dạng rail, chính CÁI NÚT duy nhất có thể mở lại nó
bị ẩn theo luôn. Vật còn lại hiện ra trong logo row lúc đó chỉ là brand mark
(icon logo tĩnh, KHÔNG có `onClick` gì cả) — 1 ngõ cụt thật, không có cách
nào bấm để mở lại ngoài F5 lại trang. Logic React (`Sidebar.tsx`'s
`onToggleCollapse` + đổi icon `PanelLeftOpenIcon`/`PanelLeftCloseIcon` theo
`collapsed`) hoàn toàn đúng từ đầu — đây thuần là lỗi CSS ẩn nhầm.

**Sửa thật:** đổi hẳn — ẩn `.fh-sidebar-brand-mark` (icon tĩnh, không chức
năng) trong rail mode THAY VÌ ẩn `.fh-sidebar-collapse-toggle`. Nút toggle
giờ LUÔN hiện, LUÔN bấm được, bất kể đang mở hay thu gọn — đúng nguyên tắc
"nút duy nhất điều khiển trạng thái không bao giờ được phép biến mất khỏi
DOM".

**Verify thật (jsdom + React thật + đúng `main.js` build ra, 6 assertion,
script xoá sau khi PASS):** nút tồn tại trước khi thu gọn; bấm → thu gọn
thật (`.fh-sidebar-rail` xuất hiện trên `#sidebar-col`); **xác nhận nút VẪN
CÒN trong DOM sau khi thu gọn** (đúng element, không phải bị unmount rồi
mount lại 1 cái khác); bấm LẦN NỮA từ trạng thái rail → **mở lại thật**,
`.fh-sidebar-rail` biến mất. Đây là style thuần CSS (không qua build step),
`scripts/serve-web.mjs` đã serve đúng bản mới ngay lập tức nhờ
`Cache-Control: no-store` (§29) — không cần restart gì.

## 48. Session rỗng (chưa chat gì) không nên hiện trong sidebar — thật, sửa bằng cột `first_message_at` (2026-09-09)

User hỏi rõ cơ chế logout→login (xác nhận đúng: mỗi lần login lại tạo
session MỚI, `App.tsx` cố ý xoá `localStorage['fox-harness/sessionId']` lúc
logout để tránh user B login cùng tab vô tình auto-resume nhầm session của
user A). User xác nhận hành vi đó ĐÚNG, nhưng chỉ ra 1 hệ quả thật cần sửa:
mỗi lần logout/login mà không chat gì vẫn tạo 1 row `sessions` MỚI (thật,
insert ngay lúc WS upgrade — `services/gateway/src/index.ts`'s
`if (isNew) await createSession(...)`), khiến sidebar dần chất đầy các
session RỖNG không ai dùng.

**Cân nhắc thiết kế quan trọng trước khi sửa:** KHÔNG được trì hoãn việc
tạo row ownership tới lúc có tin nhắn đầu tiên — nếu làm vậy, user reload
trang NGAY SAU khi mở session mới (trước khi gõ gì) sẽ bị `canAccessSession()`
trả về `403` thật (chưa có row nào để chứng minh quyền sở hữu). Thay vào đó:
**giữ nguyên việc tạo row ngay lúc connect** (an toàn), chỉ thêm 1 cột MỚI
đánh dấu "đã thật sự chat chưa", và **lọc theo cột đó khi LIST** — sửa đúng
chỗ hiển thị, không đụng logic ownership.

**Phát hiện thật giúp việc này khả thi mà KHÔNG phá nguyên tắc "gateway
không hiểu wire protocol, chỉ relay byte-blind"** (đã giữ từ Phase 2):
`apps/web/src/wire.ts`'s `ClientToServer` type thật chỉ có đúng 2 dạng —
`{type:'followup'}` / `{type:'steer'}` — xác nhận lại y hệt ở
`packages/transport/src/server.ts`. Nghĩa là: **BẤT KỲ frame nào client gửi
sau khi connect ĐÃ LÀ 1 tin nhắn thật**, theo đúng hợp đồng của wire
protocol — gateway không cần đọc/hiểu nội dung JSON gì cả để biết điều đó,
chỉ cần biết "có frame nào đó vừa tới từ browser".

**Sửa thật:**
1. `infra/migrations/005_session_first_message.sql` — `alter table sessions
   add column first_message_at timestamptz` (nullable).
2. `services/gateway/src/db.ts` — `markSessionFirstMessage(sessionId)`
   (`UPDATE ... WHERE first_message_at IS NULL`, tự idempotent).
   `listSessionsForOwner()` (hàm đứng sau `GET /sessions/mine`) thêm điều
   kiện `AND first_message_at IS NOT NULL`.
3. `services/gateway/src/proxy.ts` — `proxyToWorker()` nhận thêm callback
   tuỳ chọn `onClientMessage`, gọi ĐÚNG 1 LẦN ngay trong
   `browserWs.on('message', ...)` đã có sẵn — vẫn KHÔNG parse nội dung
   frame, chỉ biết "có frame tới".
4. `services/gateway/src/index.ts` — nối callback đó với
   `markSessionFirstMessage(sessionId)` tại đúng chỗ gọi `proxyToWorker()`
   trong WS-upgrade handler.

**Verify thật (không phải chỉ đọc code):**
1. Áp migration thật lên Postgres đang chạy (`psql`), `\d sessions` xác nhận
   cột mới.
2. Restart thật `services/gateway`.
3. **Script Node WS thật, đầu-cuối** (xoá sau khi PASS): đăng ký/login thật
   → mở session A qua `/sessions/new`, **KHÔNG gửi gì cả**, đóng kết nối →
   `GET /sessions/mine` trả về **RỖNG THẬT** (session A không hiện) → mở
   session B, gửi 1 `followup` thật → `GET /sessions/mine` giờ trả về
   **ĐÚNG 1 session, đúng là B** (không phải A) — 6 assertion, PASS hết.

Không đụng FE (`apps/web` không cần sửa gì — `GET /sessions/mine` vốn đã là
nguồn dữ liệu duy nhất sidebar dùng, lọc đúng ở tầng backend là đủ).
`pnpm run typecheck` sạch.

## 49. Migrate database engine từ Postgres sang MariaDB — prod VM buộc dùng MariaDB (2026-09-09)

User hỏi deploy lên prod VM thật khác gì so với dev, câu trả lời ban đầu đề
xuất "cài thêm Postgres riêng song song MariaDB có sẵn" — user bác bỏ thẳng:
**"Không DB server buộc phải dùng mariaDB vậy thì setup như thế nào đây"**.
Không phải chuyện đổi connection string: `services/gateway/src/db.ts` dùng
driver `pg`, driver này nói chuyện **Postgres wire protocol**, không kết
nối được với MariaDB — 2 engine khác hẳn nhau.

**Rà soát phạm vi trước khi sửa** (grep toàn repo qua 1 Explore agent, đúng
kỷ luật đã dùng ở Phase 16's plugin-store removal — khảo sát đầy đủ TRƯỚC
khi viết plan, không phải vừa sửa vừa phát hiện thiếu): chỉ đúng 2 chỗ có
code Postgres thật trong toàn repo — `services/gateway/src/db.ts` (8 hàm
query, dùng `pg.Pool`) và `scripts/create-admin.mjs` (SQL + `pg.Pool` của
riêng nó — script này chạy ngoài module graph của gateway, KHÔNG import
`db.ts`, nên cần rewrite riêng, không tự động ăn theo). Không service nào
khác đụng Postgres (`services/orchestrator` chỉ còn Redis từ khi Phase 16
xoá `postgres.ts`).

**Xác nhận version MariaDB trước khi viết SQL** (không đoán — hỏi thẳng
user vì ảnh hưởng cú pháp thật): user xác nhận prod chạy **10.11 LTS**.
Quan trọng vì vài tính năng SQL dùng bị gate theo version: CHECK constraint
cần ≥10.2, `CREATE INDEX IF NOT EXISTS` cần ≥10.5.2, DESC-index thật cần
≥10.8, `RETURNING` trên INSERT cần ≥10.5 — 10.11 đủ cả 4.

**Driver:** `mariadb` npm package (driver chính thức MariaDB Foundation)
thay `pg`/`@types/pg` — đúng convention "1 client chuyên cho 1 protocol
thật" (`ws`/`ioredis`/`dockerode`). Xác nhận API thật bằng cách đọc trực
tiếp package vừa cài (không đoán từ trí nhớ) —
`node_modules/mariadb/types/index.d.ts`: `createPool(config: PoolConfig |
string)`, `pool.query(sql, values)` trả thẳng mảng row (khác `pg`'s
`{rows: [...]}`). `node_modules/mariadb/lib/config/connection-options.js`
dòng 351/359: connection string PHẢI đúng scheme `mariadb://` (`url.protocol
!== 'mariadb:'` throw) — xác nhận `DATABASE_URL=mariadb://...` không phải
placeholder tuỳ ý mà là yêu cầu thật của driver.

**Rewrite query, mọi hàm trong `db.ts` + SQL riêng của `create-admin.mjs`:**
- `$1, $2, ...` → `?`. **Bẫy thật đã bắt được:** thứ tự mảng params phải
  khớp thứ tự `?` xuất hiện trong CHÍNH VĂN BẢN SQL, không phải chỉ đổi ký
  hiệu — `renameSession` cũ là `set title=$2, updated_at=now() where
  session_id=$1` với params `[sessionId, title]` ($1=sessionId dù đứng sau
  trong câu SET); giữ nguyên thứ tự văn bản SQL nhưng đổi placeholder thành
  `?` thì driver sẽ gán `?` đầu = title, `?` sau = session_id theo đúng thứ
  tự xuất hiện — nên params phải đổi thành `[title, sessionId]`. Verify
  thật bắt lỗi này (assertion riêng cho rename trong test end-to-end bên
  dưới, không chỉ suy luận).
- `insert ... on conflict (session_id) do nothing` (`createSession`) →
  `insert ignore into sessions (...)`.
- `insert ... on conflict (email) do update set ...`
  (`create-admin.mjs`) → `insert ... on duplicate key update password_hash
  = values(password_hash), role = 'admin'`.
- `returning *` (`createUser`) giữ nguyên chữ — MariaDB 10.5+ hỗ trợ
  `RETURNING` trên INSERT thật, server trả về row y như 1 SELECT nên
  `pool.query()` nhận được mảng row bình thường, không cần xử lý đặc biệt.

**Schema dialect** (`infra/migrations/001_init.sql`, MỚI — dựng lại
từ schema Postgres LIVE hiện tại qua `psql \d users`/`\d sessions` ngay
trước khi viết file, không phải replay máy móc 5 file migration Postgres cũ
— 5 file đó mô tả delta trên 1 Postgres instance chưa từng tồn tại trên
MariaDB, replay lại là replay lịch sử chưa từng xảy ra trên engine này):
- Cột khoá `text` → `varchar` có size: `varchar(36)` cho id/session_id/
  owner_id (UUID), `varchar(255)` cho email, `varchar(16)` cho role.
  `title` giữ `text` không size (không bao giờ index/khoá).
- `timestamptz` → `datetime`, KHÔNG dùng MariaDB `timestamp` — `timestamp`
  giới hạn tới 2038-01-19 UTC, `datetime` với `default current_timestamp`
  hành xử tương đương cho mục đích ở đây mà không có giới hạn range.
- `check (role in ('admin','user'))` giữ nguyên chữ — hỗ trợ thật ở 10.2+.
- `create index ... (owner_id, updated_at desc)` + `if not exists` khắp nơi
  giữ nguyên chữ — đủ điều kiện version ở 10.11.
- **FK viết dạng `constraint ... foreign key (...) references ...` tường
  minh ở cấp bảng, KHÔNG dùng `references` inline trên khai báo cột.**
  Phát hiện thật cần biết: MySQL/MariaDB PARSE cú pháp inline `references`
  trên 1 cột nhưng KHÔNG enforce thành FK constraint thật trên InnoDB —
  khác hẳn Postgres, nơi inline `references` tương đương hoàn toàn với
  table-level constraint. Chỉ dạng tường minh mới chắc chắn tạo FK thật —
  xác nhận lại bằng `show create table sessions` thật sau khi áp migration,
  thấy đúng dòng `CONSTRAINT ... FOREIGN KEY ...` trong output.
- `engine=innodb` tường minh cả 2 bảng (mặc định của MariaDB, nhưng ghi rõ
  vì FK bắt buộc InnoDB).

**5 file migration Postgres cũ (`infra/migrations/001-005*.sql`) giữ
nguyên trên đĩa, không sửa, không xoá** — bản ghi lịch sử "đã chạy gì trên
Postgres", đúng nguyên tắc "không viết lại lịch sử" đã dùng ở
`004_remove_plugin_store.sql` (drop bảng tiến tới, không sửa lại
`001_init.sql`). `infra/migrations/mariadb/001_init.sql` là track schema
sống từ giờ. `infra/migrations/README.md` viết lại giải thích rõ 2 track.

**Đảo ngược (2026-09-09, §51):** quyết định "giữ 5 file Postgres cũ làm
lịch sử" ở trên đã bị user yêu cầu đảo ngược thẳng cùng ngày — 5 file đó đã
xoá hẳn, `mariadb/001_init.sql` đã chuyển phẳng lên
`infra/migrations/001_init.sql` (không còn subfolder `mariadb/`, không còn
"2 track" nào để phân biệt). Xem §51 cho chi tiết đầy đủ.

**Dev infra:** `infra/docker/docker-compose.dev.yml` thay hẳn service
`postgres` bằng `mariadb:10.11` (khớp đúng bản prod đã xác nhận — quan
trọng vì CHECK/DESC-index/IF-NOT-EXISTS đều gate version), port
`3307:3306` (né MariaDB/MySQL cục bộ có sẵn, cùng kiểu né 5433-không-
phải-5432 cũ). `.env.example` cả 2 khối `DATABASE_URL` cập nhật theo; tiện
tay dọn luôn 1 khối `services/plugin-registry` chết còn sót lại trong file
này (service đã bị xoá từ Phase 16 nhưng khối env doc bị bỏ sót) —
`services/gateway/README.md` cũng có 1 dòng `PLUGIN_REGISTRY_URL` chết
tương tự, dọn luôn vì nằm sát dòng đang sửa.

**Verify thật (không chỉ typecheck):**
1. Dựng container `mariadb:10.11` thật qua compose file mới
   (`docker compose -f infra/docker/docker-compose.dev.yml up -d mariadb`),
   xác nhận version thật qua `mariadb --version` trong container
   (`10.11.19-MariaDB` thật, không phải giả định).
2. Áp `mariadb/001_init.sql` thật (`docker exec -i ... mariadb ... <
   infra/migrations/001_init.sql`), `show create table` xác nhận
   đúng FK/CHECK/DESC-index như thiết kế.
3. Trỏ `DATABASE_URL` sang container mới, restart thật `services/gateway`.
4. **Script Node WS thật, đầu-cuối** (xoá sau khi PASS) — tái dùng đúng bộ
   test đã verify Postgres trước đây: 2 account thật đăng ký/login đồng
   thời, 2 WS session thật mở đồng thời, 2 chat turn thật hoàn tất đồng
   thời, `GET /sessions/mine` cô lập đúng theo user, cross-user rename →
   403 thật. Thêm 1 assertion MỚI cho rename — xác nhận title thật sự đổi
   đúng, bắt được bug thứ-tự-params nếu có (không chỉ test 204 rồi dừng).
   PASS toàn bộ.
5. `scripts/create-admin.mjs` thật, chạy 2 lần liên tiếp: lần 1 tạo mới,
   lần 2 (mật khẩu khác) xác nhận qua SQL trực tiếp — cùng `id`, chỉ
   password/role đổi, không tạo row trùng (đúng nhánh `ON DUPLICATE KEY
   UPDATE`).
6. `pnpm run typecheck` sạch toàn workspace.
7. Container Postgres dev cũ (`docker-postgres-1`) dừng lại (không xoá,
   không mất dữ liệu) — chỉ chứa tài khoản test synthetic của các phiên
   verify trước đó trong session này, không phải dữ liệu thật của user.

## 50. WS reconnect vào session cũ kẹt vòng lặp sau migration DB — hệ quả thật của §49, sửa tận gốc (2026-09-09)

User báo: login/register có vẻ không hoạt động, không báo lỗi gì. Console
browser thật user gửi: `WebSocket connection to 'ws://localhost:4000/sessions/<id>?token=...' failed`.

**Chẩn đoán thật (không đoán):** gateway log xác nhận `login_ok` chạy nhiều
lần thành công cho đúng user đó — login KHÔNG hỏng. Vấn đề nằm ở bước SAU
login: `App.tsx`'s `handleLogin()` đọc `localStorage['fox-harness/sessionId']`
(sessionId của lần dùng app trước đó) rồi cố **reconnect** vào đúng session
đó qua WS. Query thật MariaDB cho sessionId đó trả về **0 row** — vì §49
migrate DB đã dựng MariaDB HOÀN TOÀN TRỐNG, không mang dữ liệu cũ từ
Postgres qua. `canAccessSession()` (`services/gateway/src/index.ts:86-90`)
thấy `getSessionOwnerId()` trả `undefined`, user role là `user` (không phải
`admin`) → 403 ngay ở tầng bắt tay WS, browser log đúng dòng lỗi user thấy.

**Bug thật lộ ra thêm** (không phải chỉ do migration — migration chỉ là
tác nhân kích hoạt 1 gap có sẵn từ trước): `App.tsx`'s `connect()` không có
xử lý cho case "handshake bị từ chối thẳng, chưa từng `open()`". Có sẵn 1
cơ chế tự phục hồi cho case gần giống — `handleFrame()`'s check "unknown
session" (dòng 197-199) — nhưng case đó chỉ áp dụng khi lỗi đến dưới dạng
1 frame JSON SAU khi socket đã mở thành công. Case 403-ngay-lúc-bắt-tay thì
socket không bao giờ mở, không có frame nào để đọc — sessionId chết kẹt
vĩnh viễn trong `localStorage`, mỗi lần reload lặp lại đúng lỗi y hệt,
không có đường tự thoát.

**Sửa thật** (`apps/web/src/App.tsx`'s `connect()`):
1. Thêm biến `didOpen` (closure-local, khởi tạo `false`), set `true` trong
   `open` handler.
2. Thêm listener `error` (rỗng có chủ đích — sự kiện `error` của WS không
   mang thông tin chẩn đoán nào theo spec, xử lý thật nằm ở `close`).
3. Trong `close` handler: nếu `!didOpen && sessionPath !== 'new'` (đang
   reconnect vào session đã biết, và chưa từng mở được) → xoá
   `STORAGE_SESSION_ID` khỏi `localStorage`, hiện `toast.info(...)` báo cho
   user biết, rồi tự gọi lại `connect(httpBase, token, 'new')`. Chặn vòng
   lặp vô hạn tự nhiên: lần retry truyền `'new'`, nên nếu retry cũng fail
   thì rơi thẳng vào `setStatus('disconnected')`, không retry tiếp lần 2.

**Verify thật** (script Node dùng `ws` thật, xoá sau khi PASS): đăng ký +
login 1 account thật → mở WS reconnect vào 1 UUID hợp lệ nhưng KHÔNG có
row nào trong MariaDB → xác nhận socket đóng mà **không bao giờ** bắn
`open` (đúng điều kiện `didOpen` fix đang kiểm tra) → mở lại `'new'` ngay
sau đó với cùng token → xác nhận `open` bắn bình thường. `pnpm run
typecheck` sạch, `build-web.mjs` rebuild `main.js` thành công.

Gỡ ngay cho user (trước khi fix build kịp lên): `localStorage.removeItem('fox-harness/sessionId')`
trong DevTools Console rồi reload — sau khi fix này lên, bước thủ công đó
không cần nữa cho bất kỳ ai gặp lại đúng case này (session bị purge, DB bị
thay, hoặc ownership đổi).

## 51. Xoá hẳn lịch sử migration Postgres — đảo ngược quyết định "giữ làm lịch sử" của §49 (2026-09-09)

User: *"check lại migration hãy bỏ đi những gì liên quan đến postgres"*.
§49 lúc migrate sang MariaDB đã CHỌN giữ 5 file migration Postgres cũ
(`001_init.sql` … `005_session_first_message.sql`) trên đĩa làm bản ghi
lịch sử, theo đúng nguyên tắc "không viết lại lịch sử" đã dùng ở
`004_remove_plugin_store.sql`. User giờ yêu cầu rõ ràng đảo ngược quyết
định đó — không phải hiểu nhầm, là chỉ thị thật, thực hiện đúng theo.

**Sửa thật:**
1. Xoá hẳn 5 file: `001_init.sql`, `002_users_and_ownership.sql`,
   `003_sessions.sql`, `004_remove_plugin_store.sql`,
   `005_session_first_message.sql` khỏi `infra/migrations/`.
2. Chuyển `infra/migrations/mariadb/001_init.sql` lên thẳng
   `infra/migrations/001_init.sql` (không còn lý do giữ subfolder `mariadb/`
   khi chỉ còn đúng 1 engine, không còn "2 track" nào để phân biệt) —
   `rmdir` subfolder rỗng sau khi move.
3. Viết lại `infra/migrations/README.md` — bỏ hẳn phần giải thích "2 track
   Postgres/MariaDB", chỉ còn 1 file, 1 convention duy nhất (thêm file mới
   đánh số tiếp, không sửa `001_init.sql` một khi đã chạy thật).
4. `001_init.sql`'s header comment viết lại — bỏ đoạn "không phải replay
   001-005*.sql cũ, các file đó giữ nguyên trên đĩa" (không còn đúng nữa).
5. Sửa lại MỌI đường dẫn `infra/migrations/mariadb/001_init.sql` trên toàn
   repo (grep xác nhận 10 file: root README.md, `docs/core-overview.md`,
   `docs/schema/schema.md`, `docs/code-rules.md` (chính file này),
   `services/gateway/README.md`, `services/orchestrator/README.md`,
   `docs/agent-core-architecture-roadmap.md`, `infra/docker/docker-compose.dev.yml`,
   `services/gateway/src/db.ts`) về đường dẫn phẳng mới
   `infra/migrations/001_init.sql`.
6. Sửa các câu khẳng định "5 file Postgres cũ giữ nguyên trên đĩa làm lịch
   sử" (giờ SAI) ở `docs/core-overview.md` và root `README.md`'s §49 bullet
   — thành ghi nhận rõ đã xoá, không giữ nữa (không xoá/viết đè nguyên văn
   bullet §49 gốc — đó vẫn là mô tả đúng quyết định TẠI THỜI ĐIỂM viết,
   chỉ thêm câu cập nhật).

**Không đụng:** phần lịch sử tường thuật (narrative) mô tả CÁC PHASE ĐÃ XẢY
RA nhắc tên file cũ (vd "Phase 16 xoá bảng ở migration 004") — đó là tường
thuật về việc đã làm tại thời điểm đó, vẫn đúng dù file vật lý không còn,
không phải yêu cầu sửa lại toàn bộ lịch sử dự án.

`pnpm run typecheck` sạch sau khi sửa (không đụng logic, chỉ path/comment).

## 52. Sliding token expiration + phân biệt "token chết" với "session chết" ở FE (2026-09-09)

User hỏi thẳng: token 1 giờ hết hạn nhưng user đang dùng thì sao — có
refresh token gì không. Xác nhận thật: KHÔNG có cơ chế gia hạn nào cả
(`storeToken` set `PX ttlMs` đúng 1 lần lúc login, `resolveToken` chỉ là
`GET` thường). Cân nhắc refresh-token 2 lớp (access ngắn hạn + refresh dài
hạn) — quyết định KHÔNG làm: token opaque backed-Redis hiện tại đã có đúng
lợi ích chính mà refresh 2 lớp mang lại (admin revoke tức thì, Phase 7's lý
do chọn opaque token thay JWT), refresh 2 lớp chủ yếu giải quyết 2 vấn đề dự
án này không có (access token cực ngắn hạn để giảm rủi ro lộ token; verify
stateless không cần round-trip store). Chọn **sliding expiration** — gia
hạn TTL mỗi lần có hoạt động thật.

**Backend (`services/gateway/src/redis.ts`):**
- `resolveToken(token, ttlMs)` đổi từ `GET` thường sang **`GETEX key PX
  ttlMs`** (xác nhận `ioredis` cài sẵn có hỗ trợ `getex`) — 1 round-trip,
  vừa lấy value vừa gia hạn TTL atomic. Áp dụng cho MỌI request REST + mọi
  lần WS connect/reconnect (đều đi qua `identityFromRequest` →
  `resolveIdentity` → `resolveToken`).
- `renewToken(token, ttlMs)` mới — chỉ `PEXPIRE`, không fetch value (caller
  đã biết token hợp lệ từ lần `resolveToken` lúc connect). Bù cho case
  `resolveToken` không phủ tới: 1 session mở WS, chat liên tục >1 giờ mà
  KHÔNG có request REST nào khác chen giữa (không đổi session, không
  rename, không reload) — token vẫn hết hạn thật trong Redis dù user đang
  hoạt động (không giết WS đang mở, nhưng sẽ strand ở lần reconnect kế
  tiếp).

**Backend — gia hạn theo hoạt động WS thật** (`proxy.ts` + `index.ts`): tái
dùng đúng cơ chế phát hiện §48 đã xây và verify cho `first_message_at` —
`apps/web/src/wire.ts`'s `ClientToServer` chỉ có đúng `followup`/`steer`,
nên bất kỳ frame nào từ browser ĐÃ LÀ hoạt động thật, không cần parse JSON.
`proxyToWorker()`'s `onClientMessage` cũ chỉ bắn 1 lần (đúng cho
`markSessionFirstMessage`) — thêm tham số MỚI `onEveryClientMessage` bắn
MỖI frame, wire vào `renewToken(token, config.tokenTtlMs)`. Không cần
throttle: frame client→worker chỉ xảy ra khi human gửi tin/steer (theo tốc
độ gõ phím), không phải chunk streaming (chunk chảy chiều worker→browser,
ngược lại).

**Frontend — phân biệt "token chết" với "session chết" (`App.tsx`):** phát
hiện quan trọng — WS `close`/`error` KHÔNG mang status code theo spec, nên
1 handshake bị 401 (token chết) và 1 handshake bị 403 (token sống, session
không truy cập được) nhìn **giống hệt nhau** phía browser JS. Fix §50 trước
đó (`!didOpen && sessionPath !== 'new'` → xoá sessionId, retry `'new'`) giả
định LUÔN là case session chết — sai khi thật ra là token chết: sẽ xoá oan
1 sessionId còn tốt, và lần retry (dùng lại đúng token đã chết) sẽ fail y
hệt, kẹt ở `disconnected` không có đường về login.

**Sửa:** trong `connect()`'s `close` handler, nhánh `!didOpen`, gọi 1 REST
probe nhẹ TRƯỚC (`GET /sessions/mine` — request thường có status code
thật, khác WS handshake):
- Probe trả `401` → token chết thật → `handleAuthExpired()` (hàm mới, dùng
  chung cho cả path này lẫn `authedFetch`): xoá token khỏi `sessionStorage`,
  `toast.info('Session expired...')`, `status='disconnected'` → `<ConnectForm>`
  tự hiện lại. **CỐ Ý không xoá `STORAGE_SESSION_ID`** — `handleLogin()` đã
  đọc lại giá trị đó, login lại là resume đúng session cũ, không mất gì.
- Probe KHÔNG 401 (200, hoặc lỗi mạng) → token ổn, rơi về đúng hành vi §50
  cũ (xoá sessionId + retry `'new'`, chỉ khi `sessionPath !== 'new'`) —
  không đổi.

**Frontend — hết nuốt 401 im lặng ở mọi nơi khác:** thêm `Runtime.authedFetch(path,
init?)` (bọc `fetch` + `authHeaders`, gọi `handleAuthExpired()` khi 401,
vẫn trả `Response` bình thường cho caller tự xử — không đổi logic
`if (!res.ok)` sẵn có ở bất kỳ đâu). Đổi 4 chỗ raw-fetch thật sang dùng nó:
`SessionList.tsx` (`refresh()`, `rename()`), `PluginInventory.tsx` (tiện
tay sửa luôn thiếu check `res.ok` trước `.json()` — bug tìm thấy sẵn từ
review trước), `Conversation.tsx`'s command `rename` (ctx signature đổi từ
`apiUrl`/`authHeaders` sang nhận thẳng `authedFetch`).

**Verify thật (script Node dùng `ws` thật, xoá sau khi PASS, gateway chạy
với `TOKEN_TTL_MS=6000` cho verify riêng phần này):**
1. Gọi REST lặp lại mỗi 2.5s, 3 lần (tổng 7.5s > TTL gốc 6s) — cả 3 lần vẫn
   200 (chứng minh `GETEX` gia hạn đúng).
2. Sau đó để yên hoàn toàn 7s (không gọi gì) — request tiếp theo trả 401
   thật (sanity: token không bị "bất tử" do bug, vẫn hết hạn đúng khi THẬT
   SỰ idle).
3. Mở 1 WS, gửi `followup` 2 lần cách nhau 4s (tổng ~8s kể từ lúc connect,
   > TTL gốc), **không gọi REST nào khác xen giữa** — request REST cuối
   cùng ngay sau đó vẫn 200 (chứng minh nhánh `onEveryClientMessage` hoạt
   động độc lập, không dựa vào REST).
4. Regression: token hợp lệ + session không truy cập được vẫn đóng mà
   không mở (403 path), VÀ token vẫn còn sống sau đó (xác nhận đúng đây là
   case session-chết, không phải token-chết) — không bị lẫn với case mới.
5. `pnpm run typecheck` sạch. Gateway restart lại về `TOKEN_TTL_MS` mặc
   định (1 giờ) sau khi verify xong.

Phần probe/`handleAuthExpired` ở FE chỉ verify được qua đọc code +
typecheck (logic JS chạy trong browser, không có công cụ mở browser thật
trong session này) — phần tín hiệu SERVER mà nó dựa vào (401 thật cho token
chết, đóng-không-mở thật cho session chết) đã verify thật ở trên.

## 53. Sửa 6/8 finding bảo mật từ review 2026-09-09 (giữ lại #2 và #8, chưa làm)

User yêu cầu đề xuất cách xử lý review bảo mật (`docs/security-performance-review-2026-09-09.md`),
rồi chốt: làm nhóm effort thấp/trung bình (6 finding), để lại #2 (`OPENAI_API_KEY`
dùng chung — cần quyết định kiến trúc proxy LLM riêng, effort lớn) và #8
(`--expose-internals` có thể thừa — cần điều tra trước khi xoá) chưa làm.

**#1 — `services/orchestrator` không có auth ở bất kỳ route nào (nghiêm
trọng nhất).** Thêm shared-secret giữa gateway↔orchestrator — KHÔNG phải
per-user auth (orchestrator vẫn không biết user là ai, đúng ranh giới kiến
trúc gốc), chỉ xác thực đúng caller là gateway:
- Config mới `internalSecret` (env `ORCHESTRATOR_INTERNAL_SECRET`) ở CẢ 2
  service (`config.ts`) — **fail loud lúc boot nếu chưa set** (`requireEnv()`
  throw thật), khác hẳn convention "chưa cấu hình = mặc định permissive"
  mọi setting khác trong file này đang dùng (`MAX_CONCURRENT_SESSIONS=0`...)
  — 1 control bảo mật mà im lặng vô hiệu khi chưa cấu hình thì fix coi như
  không có tác dụng. Friction thật thấp: cả 2 service đã đọc chung đúng 1
  file `.env` gốc rồi, chỉ cần thêm đúng 1 dòng.
- `services/gateway/src/orchestrator-client.ts`: cả 4 hàm gọi orchestrator
  thật (`ensureSession`, `fetchModels`, `purgeSession`, `touchSession`)
  đều gắn thêm header `x-fox-harness-internal-secret`.
- `services/orchestrator/src/index.ts`: check header này ngay đầu
  `createServer((req, res) => {...})`, TRƯỚC mọi route matching, bằng
  `timingSafeEqual` (đúng primitive `password.ts` đã dùng — tránh tự tạo
  thêm 1 timing side-channel mới ngay trên chính cái secret này) → `401`
  nếu sai/thiếu.

**#3 — Container worker không giới hạn resource.** Xác nhận field thật qua
`@types/dockerode` (`Memory` bytes, `NanoCpus` = số core × 1e9, `PidsLimit`)
— thêm vào `HostConfig` của `createContainer()` (`docker.ts`). Config mới
(permissive default, KHÔNG phải security control như #1 nên giữ nguyên
convention cũ): `WORKER_MEMORY_MB` (2048), `WORKER_CPU_LIMIT` (2),
`WORKER_PIDS_LIMIT` (512).

**#4 — Timing side-channel ở login.** `auth.ts`'s `login()` trước đây
return ngay (bỏ qua `verifyPassword`/scrypt hoàn toàn) khi email không tồn
tại — thời gian phản hồi lộ được "email có tồn tại hay không". Sửa: luôn
gọi `verifyPassword` với MỘT hash nào đó — hash thật nếu user tồn tại,
1 hash giả cố định (`DUMMY_PASSWORD_HASH`, tính 1 lần lúc module load) nếu
không — 2 nhánh giờ tốn thời gian như nhau.

**#5 — Không rate-limit `/auth/login`/`/auth/register`.** Bộ đếm Redis
fixed-window mới (`redis.ts`'s `checkRateLimit` — `INCR` + `PEXPIRE` chỉ ở
lần chạm đầu tiên trong window, không phải sliding). Config mới
`AUTH_RATE_LIMIT_MAX` (10), `AUTH_RATE_LIMIT_WINDOW_MS` (60000). Khoá theo
`req.socket.remoteAddress`, KHÔNG xử lý `X-Forwarded-For` (chưa có reverse
proxy nào trong deployment hiện tại — không xây cho topology chưa tồn tại,
ghi rõ cho ai thêm reverse proxy sau này biết cần bổ sung). 2 bucket riêng
(`login`/`register`) để 1 route bị spam không khoá luôn route kia.

**#6 — `sessionId` không validate format.** `SESSION_ID_RE` mới khớp đúng
hình dạng `randomUUID()` thật — áp ở 4 chỗ thật sessionId đến từ URL path
trước khi chạm DB/orchestrator: route `plugin-inventory`, `PATCH` rename,
`DELETE` purge, và nhánh RECONNECT của WS upgrade (nhánh brand-new dùng
`randomUUID()` nên luôn hợp lệ sẵn, không cần check). Sai định dạng → `400`
thật (WS: ghi `HTTP/1.1 400` rồi destroy socket, đúng pattern đã dùng cho
401/403).

**#7 — Lỗi DB thô trả thẳng client.** Catch block của `/auth/register` —
chỉ giữ lại đúng message an toàn có chủ đích ("email already registered",
409) cho đúng case đó; mọi lỗi khác giờ log đầy đủ ở server (không đổi)
nhưng trả về client message chung chung (`"registration failed"`, 500),
không còn `String(error)` nguyên văn.

**Verify thật (script Node dùng `ws` thật, xoá sau khi PASS):**
1. Boot orchestrator KHÔNG set `ORCHESTRATOR_INTERNAL_SECRET` → xác nhận
   throw thật, process không lên. Set secret thật (`openssl rand -hex 32`),
   restart cả 2 service, xác nhận flow thật (register→login→WS→chat) vẫn
   chạy bình thường.
2. `curl` thẳng vào port orchestrator, không có/sai header → `401` thật;
   đúng header → `200` thật.
3. `docker inspect` 1 container thật sau khi spawn → xác nhận
   `HostConfig.Memory`/`NanoCpus`/`PidsLimit` đúng giá trị cấu hình (không
   phải absent như trước).
4. Đo thời gian thật `POST /auth/login` cho email không tồn tại vs email
   tồn tại+sai password, nhiều lần — 2 giá trị trung bình gần nhau (trước
   đây nhánh không-tồn-tại bỏ qua scrypt hoàn toàn).
5. Bắn 15 request `/auth/login` liên tiếp cùng nguồn → nhận `429` thật;
   `/auth/register` cùng lúc đó KHÔNG bị chặn (bucket riêng).
6. Gửi sessionId sai định dạng vào rename/WS reconnect → `400` thật, không
   chạm DB; sessionId thật (UUID hợp lệ) vẫn hoạt động bình thường.
7. Trigger case "email đã tồn tại" thật → vẫn đúng message sạch 409 như cũ.
8. `pnpm run typecheck` sạch.

**Chưa làm (giữ nguyên, ghi rõ trong review doc):** #2 (`OPENAI_API_KEY`
dùng chung mọi container — cần quyết định có xây LLM-call proxy riêng hay
không, effort lớn hơn hẳn 6 finding trên) và #8 (`--expose-internals` có
thể thừa — cần rebuild + test trước khi dám xoá, chưa điều tra).

## 54. Sửa 7/12 finding performance từ review 2026-09-09 (giữ lại nhóm 3, chưa làm)

User yêu cầu đề xuất cách xử lý phần Performance của
`docs/security-performance-review-2026-09-09.md`, chốt làm nhóm 1+2 (7
finding, số thứ tự khớp đúng review doc): #1 (KEYS→index O(1)), #2 (N+1→MGET),
#3 (timeout fetch orchestrator), #6 (MariaDB connectionLimit), #7 (warmpool
song song), #5 (giới hạn frame WS), #4 (idle timeout LLM stream). Để lại
nhóm 3 (#8 proxy buffer, #9 duckduckgo rate-limit, #10 frameHistoryRef, #11
session-list pagination, #12 FE re-render) chưa làm.

**#1 — `KEYS fh:session:*` → SET-index O(1).** `services/orchestrator/src/redis.ts`'s
`setSession()` là chốt DUY NHẤT mọi status transition đi qua (xác nhận:
mọi caller trong `ensure.ts`/`sweep.ts` chỉ ghi qua đúng hàm này) — giờ
maintain thêm 3 Redis SET `fh:session:status:<status>` qua 1 pipeline:
`SREM` khỏi cả 3 set (cố định, không cần đọc status cũ trước), `SADD` vào
set mới. `deleteSession()` cũng `SREM` khỏi cả 3 (trước đây chỉ xoá record,
để sót id trong set sau khi purge). `listRunningSessionIds`/
`listHibernatedSessionIds` đổi thành `SMEMBERS` — hàm `listSessionIdsByStatus`
(KEYS+N×GET) xoá hẳn. Biết trước, chấp nhận được: session có sẵn trong
Redis từ trước fix này sẽ chưa có mặt trong set cho tới lần `setSession()`
ghi tiếp theo — chỉ là data dev, chưa commit gì.

**#2 — N+1 Redis GET ở `GET /sessions/mine` → `MGET`.** `services/gateway/src/redis.ts`'s
`getLiveSessionStatus(id)` đơn lẻ thay bằng `getLiveSessionStatuses(ids[])`
dùng đúng 1 `MGET`, trả `Map`. `index.ts`'s handler gọi đúng 1 lần thay vì
`Promise.all` N lệnh riêng.

**#3 — Timeout cho mọi `fetch()` gateway→orchestrator.** `orchestrator-client.ts`'s
4 hàm thật (`ensureSession`, `fetchModels`, `purgeSession`, `touchSession`)
đều thêm `signal: AbortSignal.timeout(config.orchestratorRequestTimeoutMs)`.
Config mới `ORCHESTRATOR_REQUEST_TIMEOUT_MS` (default 10000).

**#6 — MariaDB pool `connectionLimit`.** Phát hiện thật quan trọng lúc làm:
`mariadb.createPool(connectionString)` dạng string với `?connectionLimit=N`
trong query — **không tin cậy được** (test thật: `pool.opts` không đọc
được ở cả 2 dạng qua wrapper class, nên verify bằng HÀNH VI thay vì đọc
field). Chuyển hẳn sang dạng object: parse `config.databaseUrl` bằng `new
URL()` thành `host`/`port`/`user`/`password`/`database` rời rạc + field
`connectionLimit` riêng. Verify thật: 5 query đồng thời qua pool
`connectionLimit: 2` — `totalConnections()` không bao giờ vượt 2, cả ở
driver thô lẫn qua đúng `db.ts` thật. Config mới `DB_CONNECTION_LIMIT`
(default 10).

**#7 — Warm pool replenish chạy song song.** `warmpool.ts`'s
`replenishWarmPool()` đổi từ `for` tuần tự (mỗi `waitUntilReachable` tốn
tới 15s, `break` ngay khi 1 cái fail) sang `Promise.allSettled` song song
toàn bộ deficit — vừa nhanh hơn vừa đúng hơn (1 spawn fail không còn làm
mất luôn phần còn lại của batch). Verify thật: drain pool về 0, yêu cầu
`WARM_POOL_SIZE=3`, `replenishWarmPool()` thật xong trong 1369ms (so với
worst-case tuần tự 3×15s=45s) — 3 container thật, đúng image mới.

**#5 — Giới hạn frame WS.** `packages/transport/src/server.ts`: `new
WebSocketServer({ maxPayload: 100*1024 })` (chặn raw frame quá lớn ở tầng
`ws` trước khi vào handler) + check `frame.text.length > 50_000` trả về
`{type:'error'}` đúng pattern lỗi có sẵn (không phát minh cơ chế mới).
Verify thật qua chuỗi đầy đủ: WS thật → gateway → worker thật (rebuild
image), gửi `followup.text` 60.000 ký tự → nhận đúng error frame sạch,
không crash, không silently pass qua LLM thật.

**#4 — Idle timeout cho SSE stream LLM.** `packages/llm/openai-compat/src/sse.ts`'s
`parseSse(stream, idleTimeoutMs)` bọc mỗi `reader.read()` trong
`Promise.race` với 1 timeout RESET mỗi lần có chunk thật (idle timeout,
không phải timeout tổng — response dài thật vẫn stream được bình thường).
Timeout thật → `reader.cancel()` (abort thật kết nối dưới, không chỉ
release lock) rồi throw, rơi đúng vào error-handling path có sẵn
(`LlmRuntime.stream()` tự chuyển lỗi thành `error` finish chunk).
`adapter.ts` đọc `LLM_IDLE_TIMEOUT_MS` qua `launchEnvironmentOf` (cùng
pattern `resolveBaseURL()` đã dùng cho `OPENAI_BASE_URL`, không thêm
Cordis Config field mới), default 120000ms. Thêm `LLM_IDLE_TIMEOUT_MS` vào
`workerEnvPassthrough` để thật sự tới được container. Verify thật: 1
`ReadableStream` thật gửi đúng 1 chunk rồi im lặng vĩnh viễn (không
`[DONE]`, không close) — `parseSse` thật throw đúng sau ~1500ms (không
phải ngay lập tức, không phải không bao giờ), xác nhận chunk đầu vẫn nhận
được trước đó (đúng là idle timeout, không phải timeout tổng); stream bình
thường (3 chunk + `[DONE]`) hoàn toàn không bị ảnh hưởng.

**Chưa làm (giữ nguyên, ghi rõ trong review doc):** nhóm 3 — #8, #9, #10,
#11, #12 (xem review doc's "Đề xuất thứ tự xử lý" đã ghi rõ lý do từng cái
chưa làm).

`pnpm run typecheck` sạch. Worker image rebuild thật (đổi `packages/transport`
+ `packages/llm/openai-compat`), cả 2 service restart, mọi verify script
xoá sau khi PASS.

## 55. Sửa finding #8 (nhóm 3) — buffer `pending` không giới hạn ở `proxy.ts` (2026-09-09)

User chốt làm riêng #8 trong nhóm 3, bỏ qua #9 (rate-limit duckduckgo, cần
Redis trong worker — effort lớn hơn hẳn, để lại). Lúc thiết kế fix phát
hiện thêm 1 gap cùng loại: `services/gateway/src/index.ts:450`'s
`WebSocketServer` phía browser-facing **cũng không có `maxPayload`** — cùng
lỗ hổng đã đóng ở #5 cho phía worker-facing (`packages/transport`), chỉ
chưa áp cho đầu này. Gộp sửa luôn 1 thể.

**Sửa thật:**
1. `services/gateway/src/index.ts` — thêm `maxPayload: 100 * 1024` vào
   `WebSocketServer` (mirror đúng giá trị `packages/transport`'s
   `MAX_FRAME_BYTES` — không import, mirrored theo đúng convention
   services/* không import lẫn nhau).
2. `services/gateway/src/proxy.ts` — `pending` buffer giờ track tổng byte
   (`pendingBytes`), cap ở 2MB (`MAX_PENDING_BYTES`). Vượt ngưỡng → đóng
   `browserWs` với WS close code **1013** ("Try again later") + message rõ
   ràng — KHÔNG bao giờ silently drop frame (frame là tin nhắn thật của
   user). Thực tế ngưỡng này gần như không bao giờ chạm trong vận hành
   bình thường (`waitUntilReachable` phía orchestrator đã đảm bảo worker
   reachable trước khi gateway gọi `proxyToWorker`, cửa sổ `workerOpen=false`
   chỉ là vài ms bắt tay WS nội bộ) — đây là bảo hiểm cho case bất
   thường/cố ý spam, không phải fix cho case thường gặp.

**Verify thật:**
1. Flow bình thường (register→login→WS→session) vẫn hoạt động sau khi sửa.
2. Gửi raw frame >100KB thẳng vào socket gateway thật → đóng kết nối với
   close code **1009** ("Message too big") — xác nhận `maxPayload` hoạt
   động đúng ở tầng `ws` library, trước khi vào bất kỳ handler nào.
3. Test trực tiếp hàm `proxyToWorker` thật (không qua full E2E — cửa sổ
   race quá ngắn để kích hoạt tự nhiên): dựng 1 TCP server thật nhận
   connection nhưng không bao giờ hoàn tất WS upgrade (worker "treo" thật
   sự), đẩy 25 frame × 100KB (2.5MB > cap 2MB) qua `browserWs` giả (EventEmitter
   thật, đúng interface `on`/`send`/`close`/`readyState`) → xác nhận đóng
   đúng code 1013, đúng message.
4. `pnpm run typecheck` sạch.

## 56. Sửa 4/6 bug ở mục "Bug cần chú ý" từ review 2026-09-09 (2 bug còn lại đã sửa từ trước)

User yêu cầu "tiếp tục check các bug trong docs" — kiểm tra lại thật cả 6
bug trong review's mục 3 trước khi làm gì, không tin lại note cũ. Phát
hiện quan trọng: **note "đã sửa qua §50" tôi từng ghi cho bug #1 (lẫn
message giữa 2 session) trong review doc là SAI** — §50 sửa 1 bug khác
(retry logic khi handshake bị từ chối), không phải guard cho `message`
handler. Đọc lại `App.tsx` thật xác nhận `message` handler CHƯA có guard
`wsRef.current !== socket` (chỉ `close` handler có) — bug #1 vẫn còn
nguyên, chưa từng sửa. Xin lỗi user về nhầm lẫn này ngay khi phát hiện,
không giấu.

Trạng thái thật cả 6 bug sau khi kiểm tra lại:
- #1 (lẫn message), #2 (register TOCTOU), #3 (SSE nuốt lỗi), #4
  (duckduckgo fragile/không observability) — **vẫn còn, sửa trong mục này**.
- #5 (`PluginInventory.tsx` thiếu `res.ok`) — **đã sửa từ §52** (tiện tay
  lúc làm sliding-token-expiration, đổi sang `authedFetch`).
- #6 (comment/doc lệch — `plugin-registry`, `patchReload`) — **đã sửa từ**
  lúc dọn `packages/profile-template` (turn hỏi riêng về folder đó).

**#1 — `App.tsx`'s `message` handler thiếu stale-socket guard.** Thêm
đúng 1 dòng `if (wsRef.current !== socket) return` — y hệt guard `close`
handler đã có, cùng lý do (`switchSession()`/`startNewSession()` đóng
socket cũ rồi mở socket mới ngay, frame đang bay trên mạng của socket cũ
vẫn có thể tới sau khi `wsRef.current` đã trỏ sang socket mới).

**#2 — `register()`'s TOCTOU race.** Bắt riêng lỗi MariaDB thật khi
`createUser` fail do race (2 request đồng thời cùng email, cả 2 pass check
`getUserByEmail`, DB unique constraint chặn ở INSERT) — verify thật
`error.code === 'ER_DUP_ENTRY'` (errno 1062, sqlState 23000, test trực
tiếp lên MariaDB thật, không đoán) → re-throw đúng `Error('email already
registered')` để rơi vào nhánh 409 sạch có sẵn từ §53, thay vì lọt xuống
nhánh 500 chung chung.

**#3 — SSE parser hết nuốt lỗi im lặng.** `translate.ts`'s
`catch { continue }` thêm `console.error` log payload + lỗi thật trước khi
`continue` — hành vi xử lý (bỏ qua frame hỏng, không abort cả stream) giữ
nguyên, chỉ hết im lặng.

**#4 — `duckduckgo-web-search` log khi 0 kết quả.** Không đoán mò cách
phân biệt "bị chặn" với "0 kết quả thật" (chưa có mẫu HTML trang bị chặn
thật để đối chiếu) — chỉ thêm `console.error` khi `titles.length === 0`,
kèm độ dài HTML thật, đủ để operator tự debug bằng tay khi nghi ngờ.

**Verify thật:**
1. #1: chỉ verify được qua đọc code + typecheck (logic JS chạy trong
   browser, không có công cụ mở browser thật trong session này) — fix là
   copy nguyên guard đã proven đúng cho `close` handler, cùng pattern.
2. #2: script Node thật — 2 request `POST /auth/register` cùng email bắn
   ĐỒNG THỜI thật (`Promise.all`) → xác nhận đúng 1×201 + 1×409, cái thua
   race nhận đúng message sạch "email already registered", không phải lỗi
   DB thô.
3. #3: `translate()` thật với 1 chuỗi payload có xen 1 frame JSON hỏng cố
   ý → xác nhận `console.error` được gọi thật (log chứa "malformed SSE
   payload") VÀ 2 chunk tốt trước/sau vẫn qua được bình thường (stream
   không bị abort).
4. #4: `duckDuckGoSearch` thật gọi mạng thật với query thật → có kết quả
   thật (5 kết quả) VÀ xác nhận log rỗng KHÔNG bắn nhầm ở nhánh có kết quả
   (sanity, tránh false-positive). **Chưa verify được** nhánh thật sự log
   khi bị chặn/0 kết quả — không có mẫu request nào chắc chắn tạo ra case
   đó qua network thật, ghi rõ giới hạn này thay vì giả vờ đã test đủ.
5. `pnpm run typecheck` sạch. Rebuild worker image thật (đổi
   `packages/llm/openai-compat`, `packages/tool/duckduckgo-web-search`),
   restart gateway (đổi `auth.ts`), mọi verify script xoá sau khi PASS.

## 57. Real `/chat/<id>` URL routing — ẩn tới khi có tin nhắn thật đầu tiên (2026-09-09)

User hỏi hệ thống hiện đăng nhập là vào thẳng 1 session chat — có làm được
`/chat/[id]` như chat.deepseek.com/claude.ai không. Xác nhận thật trước
khi trả lời: `apps/web` **hoàn toàn chưa có URL routing gì** (grep xác
nhận không `history.pushState`, không router library) — `sessionId` chỉ
sống trong React state + `localStorage`. Đây là tính năng mới hoàn toàn.

User chốt yêu cầu rõ: **lúc login chưa chat gì thì không được show gì
liên quan tới session hiện tại cả** — đúng quy tắc `first_message_at` phía
backend (session chưa chat không hiện trong `GET /sessions/mine`) áp dụng
luôn cho URL và UI phía FE.

**Trước khi code, user hỏi lại: plan này có đúng như deepseek/claude thật
đang làm không.** Không có công cụ mở browser trong session để check trực
tiếp — trả lời thành thật dựa trên kiến thức đã biết, không giả vờ vừa xác
nhận. Từ đó phát hiện 1 điểm cần sửa thật: bấm Back ngay sau khi gửi tin
nhắn đầu tiên trên các platform đó KHÔNG quay về màn hình compose trống —
nhảy qua thẳng trang trước đó. Nghĩa là bước chuyển `/ → /chat/<id>` lúc
gửi tin đầu tiên phải dùng **`replaceState`** (không tạo history entry
mới), không phải `pushState` như thiết kế ban đầu. Điều hướng CHỦ ĐỘNG
(chuyển qua chat khác từ sidebar, bấm "New chat") vẫn dùng `pushState` thật
— để Back/Forward di chuyển đúng giữa các đoạn chat đã mở.

**Thiết kế:**
- `/` — không có session nào trong URL. Trạng thái sau login VÀ ngay sau
  "New chat", tới khi gửi tin đầu tiên.
- `/chat/<uuid>` — session đã thật sự chat. Chỉ set khi có nội dung thật.

**`apps/web/src/App.tsx` — bỏ hẳn `STORAGE_SESSION_ID`, URL thành nguồn sự
thật duy nhất** (8 chỗ dùng cũ) — lý do kép: URL tốt hơn hẳn cho việc này
(share/bookmark được), VÀ sửa luôn 1 bug tiềm ẩn thật: `localStorage` dùng
CHUNG mọi tab cùng origin, 2 tab hiện tại đang tranh nhau đúng 1
"session hiện tại" — URL tự nhiên scope đúng theo từng tab.

4 helper mới (mirror đúng hình dạng `SESSION_ID_RE` của
`services/gateway/src/index.ts`, không import — `services/*`/`apps/web`
không share runtime code):
```ts
function replaceChatUrl(id) { history.replaceState(null, '', `/chat/${id}`) }
function pushChatUrl(id) { history.pushState(null, '', `/chat/${id}`) }
function pushHomeUrl() { history.pushState(null, '', '/') }
function replaceHomeUrl() { history.replaceState(null, '', '/') }
```

State mới `hasChatted` (lazy-init từ `!!sessionIdFromUrl()` lúc mount) —
điều khiển cả việc đổi URL lẫn hiện `<span id="session-id">`.

**Từng chỗ đổi thật:**
- Mount effect: nguồn sessionId đổi từ `localStorage` sang
  `sessionIdFromUrl() ?? 'new'`; URL `/chat/` sai định dạng (garbage/typo)
  → `replaceHomeUrl()` dọn sạch trước khi connect.
- `handleLogin()`: cùng nguồn `sessionIdFromUrl()` — deep link lúc chưa
  đăng nhập tự hoạt động, không cần code riêng (URL giữ nguyên qua màn
  login).
- `connect()`'s close-handler retry (§50 self-heal): `replaceHomeUrl()` +
  `setHasChatted(false)` thay vì xoá `localStorage`.
- `handleFrame()`'s `'session'` case: **KHÔNG** đổi URL — nhận được
  sessionId chỉ là có id được cấp, chưa có nội dung thật. `'error'`
  (unknown session): `replaceHomeUrl()` + `setHasChatted(false)`.
- **`runtime.send()`** — điểm kích hoạt DUY NHẤT: ngay trước khi gửi
  `followup`/`steer` thật, nếu `!hasChatted` → `replaceChatUrl(sessionId)`
  + `setHasChatted(true)`. Đúng thời điểm mirror `markSessionFirstMessage`
  phía backend.
- `switchSession(id)`: `pushChatUrl(id)` + `hasChatted=true` ngay (điều
  hướng chủ động, session trong sidebar đã có `first_message_at` sẵn rồi).
- `startNewSession()`: `pushHomeUrl()` + `hasChatted=false` ngay (điều
  hướng chủ động).
- **`handleLogout()`** — phát hiện thật lúc code (không có trong plan gốc):
  code cũ xoá `STORAGE_SESSION_ID` lúc logout ĐỂ tài khoản khác login cùng
  tab không tự resume nhầm session tài khoản cũ. Không xoá URL thì bug y
  hệt tái diễn (tài khoản mới thử resume session tài khoản cũ → 403 → tự
  heal về `/` nhưng hiện toast "session không còn" gây khó hiểu cho lần
  login đầu tiên thật sự). Thêm `replaceHomeUrl()` + `setHasChatted(false)`
  vào logout để giữ đúng tính chất an toàn cũ.
- `popstate` listener mới (mount-only): Back/Forward thật — đọc lại URL,
  đóng socket cũ, connect tới target mới.
- `<span id="session-id">` chỉ render khi `hasChatted` — nửa còn lại của
  yêu cầu "không show gì liên quan session hiện tại".

**`scripts/serve-web.mjs` — SPA fallback.** Trước đây path không khớp file
thật → 404 thẳng. Giờ: path cuối không có dấu `.` (không giống asset thật)
→ serve `index.html` thay vì 404 — cho phép gõ thẳng/bookmark/reload
`/chat/<id>` hoạt động. Asset thật bị thiếu (`/does-not-exist.js`) vẫn 404
đúng như cũ.

**Verify thật:**
1. `curl` thật: `/chat/<uuid-giả>` → 200, nội dung giống hệt `/` (đúng
   fallback); `/does-not-exist.js` → vẫn 404; asset thật (`/main.js`) →
   vẫn 200.
2. Xác nhận lại đúng thời điểm backend/FE cùng trigger: 1 session WS thật
   chưa gửi gì → absent khỏi `GET /sessions/mine` (đúng lúc FE cũng đang
   `hasChatted=false`) → gửi 1 followup thật → xuất hiện ngay (đúng lúc FE
   cũng flip `hasChatted=true`) — 2 cơ chế độc lập nhưng khớp đúng cùng 1
   sự kiện.
3. Logic JS trình duyệt (`pushState`/`popstate`) chỉ verify được qua đọc
   code + typecheck — không có công cụ mở browser thật trong session này,
   ghi rõ giới hạn thay vì giả vờ đã test đủ.
4. `pnpm run typecheck` sạch.

## 58. Sửa "reload giật" khi chuyển route `/` ↔ `/chat/<id>` — hệ quả trực tiếp của §57 (2026-09-09)

User báo ngay sau khi §57 lên: *"lúc move giữa 2 route có reload giật làm
gì để ko bị như deepseek hay claude chat tôi ko thấy reload gì cả"*.

**Nguyên nhân thật (xác nhận qua đọc code, không đoán):** `apps/web/src/App.tsx`
trước đây gate TOÀN BỘ UI (sidebar/header/conversation) bằng
`const connected = status === 'connected'` rồi `if (!connected) return
<... ConnectForm auth-screen ...>`. Mọi lần reconnect —
`switchSession()`, `startNewSession()`, và `popstate` handler mới thêm ở
§57 — đều gọi `connect()`, và `connect()` set `status` về `'connecting'`
ngay dòng đầu (thậm chí thoáng qua `'disconnected'` giữa nhánh self-heal
của §50). Kết quả: mỗi lần chuyển session/điều hướng Back-Forward, cả app
unmount hẳn về màn hình đăng nhập full-screen rồi mount lại — thuần React
state, không phải reload trình duyệt thật, nhưng nhìn giống hệt reload
giật. Bug này **có sẵn từ trước §57** (route gate luôn tồn tại), chỉ là
§57 (`switchSession`/`popstate` mới) làm nó dễ thấy/dễ trigger hơn hẳn.

**Sửa:** tách "đã đăng nhập trong tab này" ra khỏi "socket đang mở" —
state mới `authenticated` (mặc định `false`), set `true` ngay khi socket
`'open'` lần đầu, chỉ set lại `false` ở 2 chỗ CHÍNH ĐÁNG: `handleLogout()`
và `handleAuthExpired()`. Render gate (`if (!authenticated)`), phép tính
`sidebarCollapsed`, và dependency của `ResizeObserver` effect (trước phụ
thuộc `connected`, giờ `authenticated`) đổi hết sang biến này — 1 lần
mount duy nhất khi đăng nhập thật, không unmount nữa dù `status` nhảy qua
lại `connecting`/`disconnected`/`connected` bao nhiêu lần. Header vẫn còn
`<span className="status status-${status}">{status}</span>` y nguyên —
đó là chỗ hiển thị "đang kết nối lại" hợp lý (giống deepseek/claude), một
thay đổi nhỏ tại chỗ thay vì unmount cả app.

Biến `connected` cũ bị xoá hẳn (không còn chỗ dùng sau khi đổi cả 3 điểm
tiêu thụ sang `authenticated`) — không để lại biến chết.

**Verify thật:**
1. `pnpm run typecheck` sạch (chạy full `tsc -b` + `build-web.mjs`, không
   còn tham chiếu biến `connected` đã xoá ở đâu — grep xác nhận).
2. Đọc lại toàn bộ 4 điểm gọi `connect()` (mount auto-reconnect,
   `handleLogin`, `switchSession`, `startNewSession`, `popstate` — 5 chỗ
   thật ra) xác nhận không chỗ nào còn phụ thuộc `status === 'connected'`
   để quyết định mount/unmount `#app`.
3. Hành vi unmount/remount qua browser thật (DOM thật, animation/flash
   thật) không verify được — không có công cụ mở browser trong session
   này, ghi rõ giới hạn này thay vì khẳng định đã thấy tận mắt hết giật.
   Cơ sở tin fix đúng: gate unmount duy nhất (`if (!connected)` ở dòng
   593 cũ) đã xác nhận qua grep trước khi sửa — không còn cách nào khác
   để `#app` unmount ngoài `authenticated` chuyển `false`, và chỉ 2 hàm
   logout/auth-expired làm việc đó.

## 59. i18n (vi/en, mặc định vi) cho apps/web (2026-09-10)

User: *"Hiện tại bảng web đang thiếu multi lang i18n hãy lên plan thêm và
chỉ support trc mắt 2 ngôn ngữ là Tiếng Việt và English vs mặc định là
Tiếng Việt"*. Đã khảo sát thật toàn bộ 9 file `apps/web/src` (không đoán)
trước khi lên plan — kiểm kê đầy đủ nằm trong plan file, không lặp lại ở
đây. Hỏi user 1 câu ảnh hưởng phạm vi trước khi code: lỗi từ
`services/gateway` (vd "invalid email or password") có cần dịch không —
user chọn **sửa cả backend**, thêm `code` field ổn định thay vì FE tự tra
chuỗi tiếng Anh cố định.

**Không dùng thư viện i18n ngoài** — `apps/web/package.json` chỉ có 4
dependency trước đây, ~50 key ngắn không cần pluralization/date-formatting
phức tạp, tự viết dictionary + Context là đủ.

**Kiến trúc (`apps/web/src/i18n/`):**
- `translations.ts` — 2 object phẳng `vi`/`en`, `TranslationKey = keyof
  typeof vi`, `en: Record<TranslationKey, string>` — TypeScript ép `en`
  PHẢI có đủ mọi key `vi` có. **Verify thật đã làm**: thêm tạm 1 key vào
  `vi` không thêm `en`, `pnpm run typecheck` báo lỗi thật
  (`TS2741: Property '__deliberate_break_test' is missing...`), sau đó xoá
  key thử nghiệm, typecheck sạch lại — xác nhận cơ chế ép kiểu THẬT hoạt
  động, không phải mô tả suông.
- `locale.tsx` — `LocaleContext`/`LocaleProvider`/`useLocale()`, **KHÔNG**
  mirror `useTheme.ts`'s pattern "mỗi component tự hook riêng, đọc lại
  `localStorage` độc lập" — pattern đó đúng cho theme (hiệu ứng là 1 DOM
  attribute toàn cục, 2 nơi mount loại-trừ-lẫn-nhau) nhưng sai cho locale
  (text dịch phải đồng bộ qua nhiều component mount ĐỒNG THỜI — Sidebar,
  SessionList, Conversation, SettingsDialog, PluginInventory). Dùng
  Context, giống `runtime.ts`'s `RuntimeContext`/`useRuntime()`. Mặc định
  LUÔN là `vi` (không theo `navigator.language`, khác hẳn `useTheme.ts`'s
  OS-follow default) — quyết định sản phẩm rõ ràng của user.
  `translateErrorCode(t, code, fallback)` — tra `error.<code>` runtime
  (không static-checked được vì `code` từ backend là string thường), luôn
  fallback về chuỗi gốc nếu `code` thiếu/không nhận diện.
- `App.tsx`: `export function App()` giờ chỉ là wrapper
  `<LocaleProvider><AppInner /></LocaleProvider>` — body cũ đổi tên thành
  `AppInner()`. Bọc NGOÀI CÙNG cả nhánh `!authenticated` (màn login) lẫn
  app frame — màn login phải dịch được TRƯỚC khi đăng nhập, nếu không
  user thích English bị kẹt ở default `vi` tới khi đăng nhập xong xuôi.
  `login()`/`register()` giờ throw `class AuthError extends Error { code?:
  string }` thay vì `Error` thường, giữ `error` gốc làm fallback.
- `components/LangToggle.tsx` (mới) — đặt cạnh MỌI `<ThemeToggle />` sẵn
  có (2 chỗ: `.fh-auth-screen`, `#header`), KHÔNG đặt trong SettingsDialog
  (dialog đó chỉ mở được sau khi `authenticated` — đặt ở đó tái tạo đúng
  cái gap "màn login không dịch được" vừa nói). Label nút là ngôn ngữ SẼ
  chuyển tới (giống icon `ThemeToggle` thể hiện trạng thái đích) — 2 chuỗi
  "English"/"Tiếng Việt" là HẰNG SỐ, không qua `t()` (tên ngôn ngữ luôn
  hiển thị bằng chính ngôn ngữ đó, quy ước chuẩn).

**Refactor thật cần thiết, không chỉ đổi chuỗi** — `SessionList.tsx`'s
`GROUP_ORDER` trước đây vừa là NHÃN HIỂN THỊ vừa là KEY group dữ liệu
(`Map` dùng thẳng "Today"/"Yesterday"/... làm key) — dịch nhãn tại chỗ sẽ
làm hỏng logic group (nhãn `vi` không khớp bucket `en`). Tách: key nội bộ
ổn định (`'today'|'yesterday'|'week'|'month'|'older'`) cho logic, dịch
riêng qua `GROUP_LABEL_KEY` chỉ ở chỗ render.

**Gap phát hiện lúc code, không có trong plan gốc**: `SessionList.tsx`'s
status-dot có `title={row.status}` render thẳng `"running"/"hibernated"/
"archived"` tiếng Anh thô — bỏ sót lúc kiểm kê ban đầu, thêm 3 key
`sessionList.statusRunning/Hibernated/Archived` khi phát hiện lúc sửa file.

**`services/gateway/src/index.ts`** — chỉ 2 route (`/auth/register`,
`/auth/login` — 2 route DUY NHẤT có lỗi hiển thị cho user hôm nay), 8 chỗ
emit lỗi, gộp 6 `code` phân biệt (`rate_limited`, `invalid_json`,
`invalid_registration_input`, `email_taken`, `registration_failed`,
`invalid_credentials`). Thuần additive — giữ nguyên `error` string cũ,
không đổi status code/hành vi. KHÔNG thêm `code` cho route khác (lỗi của
chúng chưa hiển thị UI ở đâu, chỉ `console.error`).

**Verify thật:**
1. `pnpm run typecheck` sạch (đã build cả `apps/web` lẫn `services/gateway`
   qua project-reference chung `tsconfig.json`).
2. Deliberate-break test ở trên (`en` thiếu 1 key → lỗi biên dịch thật).
3. Restart gateway thật (kill PID cũ, chạy lại
   `node --experimental-strip-types services/gateway/src/index.ts` — cùng
   cwd nên đọc lại đúng `.env` cũ, không đoán biến môi trường) — xác nhận
   MariaDB (`docker-mariadb-1`) + Redis (`docker-redis-1`) container vẫn
   `Up` trước khi restart. `curl` thật 3/6 code: `POST /auth/login` sai mật
   khẩu → `{"error":"invalid email or password","code":"invalid_credentials"}`;
   `POST /auth/register` thiếu password đủ dài →
   `code:"invalid_registration_input"`; đăng ký cùng 1 email 2 lần →
   `code:"email_taken"` ở lần 2. 3 code còn lại (`rate_limited`,
   `invalid_json`, `registration_failed`) không test sống — cùng 1 pattern
   `JSON.stringify` y hệt 3 code đã verify, và cố tình KHÔNG spam
   `/auth/login` để trigger `rate_limited` thật vì sẽ khoá luôn IP dùng
   chung cho lần đăng nhập tiếp theo của user.
4. Grep xác nhận không sót chuỗi tiếng Anh literal nào ngoài
   `i18n/translations.ts` trong `apps/web/src` — chỉ còn xuất hiện trong
   comment (mô tả lại chuỗi cũ) hoặc chính tên translation key.
5. Hành vi đổi ngôn ngữ SỐNG trên trình duyệt thật (bấm `LangToggle`, thấy
   toàn UI đổi ngay) — không verify được, không có công cụ mở browser
   trong session này; nêu rõ giới hạn này như mọi lần trước.

## 60. Account menu — nút profile sidebar mở popup thay vì mở thẳng Settings (2026-09-10)

User: *"tham khảo nút profile trên sidebar ấn đừng mở modal setting sẵn mà
hãy mở 1 popup phía trên nút có các option settings, logout và nút profile
ở phía cuối có icon ..."* — đúng pattern chat.deepseek.com/claude.ai: nút
account footer không mở thẳng dialog Settings nữa, mà mở 1 popup nhỏ NGAY
PHÍA TRÊN nó (nút nằm ở đáy sidebar, không có chỗ mở xuống dưới) gồm 2 mục
"Settings"/"Logout", và nút gốc có thêm icon "..." (`MoreHorizontal`) ở
cuối làm dấu hiệu "đây là menu, không phải hành động trực tiếp".

**Component mới `apps/web/src/components/AccountMenu.tsx`** thay cho
button `id="settings-trigger"` cũ trong `Sidebar.tsx`:
- **Portal tới `document.body`** (`react-dom`'s `createPortal`) — KHÔNG
  render inline cạnh trigger. Lý do thật: `#sidebar-col` có
  `overflow: hidden` thật (Phase 15, cần cho animation collapse-to-rail) sẽ
  cắt popup nếu render bên trong, đặc biệt ở rail mode (sidebar chỉ rộng
  56px). Vị trí tính từ `triggerRef.current.getBoundingClientRect()` lúc mở
  — `position: fixed`, `bottom: window.innerHeight - rect.top + 8` (mở lên
  trên), `left: rect.left`. App này chưa có portal/popover nào trước đây —
  đây là fix chuẩn, không phải over-engineer, cho đúng vấn đề "popup cần
  thoát khỏi ancestor overflow:hidden".
- Đóng khi click ra ngoài (document `mousedown` listener kiểm tra cả
  `triggerRef` lẫn `popupRef`) hoặc nhấn Escape — popup ĐẦU TIÊN trong app
  cần cơ chế dismiss kiểu này (command dropdown cũ trong Conversation.tsx
  đóng qua state của text input, không phải click-outside).
- Click "Settings" → gọi `onOpenSettings` (vẫn mở ĐÚNG dialog Settings cũ,
  không đổi gì bên trong dialog) rồi đóng popup. Click "Logout" → gọi
  `onLogout` (chính là `handleLogout` cũ ở App.tsx) rồi đóng popup.

**Quyết định tự đưa ra, không hỏi lại**: xoá nút "Logout" đứng riêng cũ
(`#logout-button` trong `#session-bar`) — Logout giờ chỉ còn 1 điểm vào
DUY NHẤT (trong popup này), đúng với chính tiêu chuẩn user đã lặp lại suốt
session này ("giống deepseek hay claude") — 2 nền tảng đó không có nút
Logout rời, chỉ có trong profile menu. `#session-bar` sau khi bỏ nút Logout
chỉ còn mỗi `#session-id` (hiện khi `hasChatted`) — đổi luôn thành render
CẢ block `#session-bar` theo điều kiện `hasChatted` thay vì render 1 thanh
rỗng có padding/border khi chưa chat gì (tránh 1 dải chrome trống vô nghĩa).

**Dọn dead code phát hiện lúc sửa**: CSS rule `#new-session-button,
#logout-button { ... }` — `#new-session-button` ĐÃ chết từ trước (nút New
session đổi sang dùng class `.fh-sidebar-new-session` từ Phase 15, id đó
không còn tồn tại trong JSX nào — xác nhận qua grep trước khi xoá, không
đoán); `#logout-button` chết THÊM sau khi xoá nút Logout rời ở trên → cả
rule block chết hẳn, xoá luôn.

**`Sidebar.tsx`**: bỏ hẳn `useRuntime()` (chỉ dùng để tính `initial` cho
avatar, giờ `AccountMenu` tự gọi `useRuntime()` nội bộ) — tránh import/biến
chết. Thêm prop `onLogout` (mới) truyền từ `App.tsx` xuống.

**Verify thật:**
1. `pnpm run typecheck` sạch (toàn repo, sau cả bước xoá `#new-session-button,
   #logout-button` lẫn đổi props `Sidebar`).
2. Grep xác nhận không còn tham chiếu nào tới `#settings-trigger`/
   `#logout-button` ngoài 1 dòng comment lịch sử (giải thích id CŨ, không
   phải selector còn sống).
3. Hành vi popup thật trên trình duyệt (mở đúng vị trí phía trên nút, đóng
   khi click ra ngoài/Escape, không bị `#sidebar-col`'s overflow:hidden cắt
   ở cả 2 chế độ rail/expanded) — không verify được, không có công cụ mở
   browser trong session này; nêu rõ giới hạn này như mọi lần trước.

## 61. Tái cấu trúc `apps/web/src/components/` — primitives/ + features/ (2026-09-10)

User: *"xem lại folder này cần đc tái phân loại lại đang tràn lan quá phân
ra cái gì là primitive ..."* — folder có 9 file phẳng (~1000 dòng), không
còn dễ quét bằng mắt nữa. Hỏi user chọn giữa 3 mức độ chia (chỉ tách
primitives/, 2 tầng primitives+features, hoặc 3 tầng chia cả theo domain
auth/chat/settings) — user chọn **2 tầng**, đúng quy mô app hiện tại (chia
sâu hơn theo domain là thừa cho 9 component).

**Tiêu chí phân loại thật** (không phải chia ngẫu nhiên): primitive = generic,
KHÔNG business logic, bê nguyên sang app khác vẫn dùng được. Chỉ 2/9 file
đạt: `ThemeToggle.tsx`, `LangToggle.tsx` — cả 2 chỉ đọc/ghi 1 hook
(`useTheme`/`useLocale`) rồi render 1 nút, không gọi API, không biết gì về
domain của app. 7 file còn lại đều gắn logic/domain riêng thật (không phải
chỉ "trông phức tạp hơn"): `AccountMenu` hardcode đúng 2 action
Settings+Logout của app này; `Sidebar` compose cả search+new-session+
session-list+account-menu; `Conversation`/`SessionList`/`PluginInventory`
gọi `authedFetch`/WS thật; `SettingsDialog` là shell cho đúng 1 section cố
định; `ConnectForm` gọi thẳng `onLogin`/`onRegister`.

```
components/
  primitives/
    ThemeToggle.tsx
    LangToggle.tsx
  features/
    AccountMenu.tsx
    ConnectForm.tsx
    Conversation.tsx
    PluginInventory.tsx
    SessionList.tsx
    SettingsDialog.tsx
    Sidebar.tsx
```

**Thực hiện**: `mv` thật (không `git mv` vì repo chưa có commit nào), sau
đó sửa import path ở TỪNG file di chuyển — độ sâu relative tăng 1 cấp nên
mọi `'../i18n/...'`/`'../icons.tsx'`/`'../runtime.ts'`/`'../useTheme.ts'`/
`'../wire.ts'` đổi thành `'../../...'`; riêng import giữa 2 file CÙNG nằm
trong `features/` (`Sidebar.tsx` → `./AccountMenu.tsx`/`./SessionList.tsx`,
`SettingsDialog.tsx` → `./PluginInventory.tsx`) giữ nguyên `./` vì vẫn là
anh em cùng thư mục. `App.tsx` (ở `src/`, không di chuyển) đổi 6 import
sang `./components/features/...`/`./components/primitives/...`.

**Dọn theo lúc sửa**: 1 comment còn sót trong `i18n/translations.ts`
(`// Auth screen (components/ConnectForm.tsx)`) trỏ path cũ — sửa thành
`components/features/ConnectForm.tsx`. `apps/web/README.md`'s `## Design`
→ `src/components/` section (doc sống, mô tả kiến trúc hiện tại, không
phải changelog theo ngày) viết lại theo cấu trúc 2 tầng mới, đồng thời sửa
luôn 1 câu đã sai từ trước (nói account row "vẫn mở đúng dialog Settings
cũ" — không còn đúng từ §60) và bổ sung `AccountMenu.tsx`/`LangToggle.tsx`
vốn chưa từng được thêm vào doc này. **Không** sửa các dòng path cũ trong
`docs/code-rules.md`'s các mục đã đánh dấu ngày trước đó (§18 trở về
trước, ...) — đúng convention "không viết đè lịch sử", các path đó ĐÚNG
tại thời điểm được ghi.

**Verify thật:**
1. Grep xác nhận không còn import nào trỏ path cũ (`components/ThemeToggle`,
   `components/Sidebar`, ...) trong `apps/web/src` sau khi sửa hết.
2. `pnpm run typecheck` sạch — chạy CẢ `tsc -b` lẫn
   `scripts/build-web.mjs` (bundler thật, không chỉ tsc resolve module
   riêng lẻ) — bundle thành công nghĩa là mọi import thật sự resolve đúng
   file trên đĩa, không chỉ đúng kiểu.

## 62. Settings dialog thành 2 tab General/Profile, theo đúng 2 ảnh chụp claude.ai thật (2026-09-10)

User gửi 2 ảnh chụp màn hình thật Settings modal của claude.ai: tab
**General** (Theme 3 lựa chọn Light/Dark/System + Language dropdown) và
tab **Profile** (Name, Email, Phone, "Log out of all devices", "Delete
account"). Yêu cầu: *"modal settings sẽ gồm 2 tab General và Profile của
user"*.

**Hỏi trước khi làm** (2 câu, vì làm y hệt ảnh sẽ tạo UI giả — backend
chưa có dữ liệu/khả năng thật đứng sau):
1. Profile tab có "Log out of all devices" + "Delete account" — backend
   CHƯA có API thu hồi hết token của 1 user (chỉ có logout token hiện
   tại, qua AccountMenu) và CHƯA có API xoá tài khoản. User chọn: **chỉ
   hiện Email + Role thật đang có, bỏ hẳn 2 nút này** — đúng tinh thần đã
   áp dụng trước đó với Instant/Expert/Vision mode tabs (Conversation.tsx)
   — không dựng UI giả không có gì thật phía sau.
2. Theme trong ảnh là 3-way (Light/Dark/System), `useTheme.ts` hiện chỉ
   2-way (toggle, luôn set override cứng, không có đường quay lại "theo
   OS"). User chọn: **giữ 2-way**, không thêm System option.

**Thực hiện thật:**
- `useTheme.ts` — thêm `setTheme(next: Theme)` (set 1 giá trị CỤ THỂ, khác
  `toggle()` chỉ lật ngược) — cần cho 2 thẻ chọn Theme thật trong General
  tab (bấm "Light" luôn ra light, không phải lật). `toggle()` (nút
  `ThemeToggle` header/auth-screen, không đổi) giờ gọi lại `setTheme()`
  nội bộ, không trùng logic.
- `i18n/locale.tsx` — thêm `setLocale(next: Locale)` tương tự, cần cho
  `<select>` Language thật (native `onChange` trả đúng giá trị chọn, khác
  `toggle()` chỉ lật). Đổi tên `useState` setter nội bộ thành
  `setLocaleState` để tránh đụng tên với `setLocale` export mới.
- **Gap thật phát hiện lúc làm**: `services/gateway`'s `/auth/login` đã
  trả `role` từ lâu (`res.end(JSON.stringify({ token, email, role }))`)
  nhưng FE chưa bao giờ đọc — y hệt gap `userEmail` đã sửa 2026-09-08.
  Thêm `userRole` vào `Runtime`, `App.tsx` (state + `sessionStorage`
  persist/clear đúng pattern `userEmail`/`STORAGE_EMAIL` đang có, không
  bịa cơ chế mới) để Profile tab hiển thị dữ liệu thật, không phải chuỗi
  rỗng/giả.
- `SettingsDialog.tsx` viết lại hoàn toàn: nav rail trái (2 nút General/
  Profile, icon `GearIcon`/`ProfileIcon` mới thêm vào `icons.tsx`) + nội
  dung phải theo tab đang chọn. General: 2 thẻ Theme (Light/Dark, gọi
  `setTheme` trực tiếp) + `<select>` Language (gọi `setLocale`) +
  `PluginInventory` (vì không có tab thứ 3 nào khác được yêu cầu, xếp
  tạm vào General). Profile: 2 dòng Email/Role thật, đúng quyết định đã
  hỏi ở trên.
- CSS: mở rộng `.fh-settings-panel` (560px → 720px, đủ chỗ nav rail +
  content), thêm `.fh-settings-body`/`.fh-settings-nav`/
  `.fh-settings-nav-item`/`.fh-settings-content`/`.fh-settings-theme-*`/
  `.fh-settings-profile-*`; xoá `.fh-settings-sections`/`> div`/
  `> div:last-child` (không còn dùng, layout stack cũ thay bằng nav+content).

**Verify thật:**
1. `curl` thật `/auth/login` với account test có sẵn (`i18n-verify-...`,
   tạo lúc verify §59) — xác nhận response THẬT có `"role":"user"` — Profile
   tab không hiển thị dữ liệu bịa.
2. `pnpm run typecheck` sạch (chạy cả bundler thật).
3. Grep xác nhận không còn literal "General"/"Profile"/"Theme"/"Light"/
   "Dark"/"Language"/"Email address"/"Role" nào ngoài `i18n/translations.ts`.
4. `apps/web/README.md`'s mô tả `SettingsDialog.tsx` (vừa viết lại ở §61)
   sửa tiếp cho khớp cấu trúc tab mới — 1 đoạn vừa viết cách đây vài phút
   đã lại stale ngay khi tính năng đổi tiếp, sửa luôn trong cùng lượt
   thay vì để lại nợ.
5. Hành vi bấm chọn tab/theme/language SỐNG trên trình duyệt thật — không
   verify được, không có công cụ mở browser trong session này; nêu rõ
   giới hạn này như mọi lần trước. Gateway đang chạy thật có traffic WS
   thật từ user trong lúc sửa (log xác nhận `ws_connect`/`ws_disconnect`
   liên tục) — không restart gateway lần này vì không đổi gì phía backend,
   tránh làm gián đoạn phiên đang dùng thật của user.

## 63. Sửa 4 lỗi Settings dialog vừa lên §62 (2026-09-10)

User báo 4 lỗi ngay sau §62:

1. *"Tiếng Việt của General là Cài đặt"* — đổi `settings.generalTab` (vi)
   từ "Chung" thành "Cài đặt" — trùng với `settings.title` (tiêu đề cả
   dialog), nhưng đúng theo yêu cầu rõ ràng của user, không tự ý đổi khác.
   `en` giữ nguyên "General" (user chỉ nói tiếng Việt).
2. *"Trong tab profile bỏ dòng vai trò và thêm nút logout ở cuối bên
   phải"* — bỏ hẳn dòng Role. Vì **không còn ai đọc `runtime.userRole`
   nữa**, revert toàn bộ phần vừa thêm ở §62 cho field này thay vì để lại
   chết: `Runtime.userRole`, `STORAGE_ROLE`, state `userRole`/`setUserRole`
   trong `App.tsx`, `login()`'s return type quay lại `{token, email}` (bỏ
   `role`) — đúng tinh thần dọn dead-code đã làm nhiều lần trong session
   này (không giữ code "để dành sau"). Thêm nút Logout thật ở cuối tab,
   canh phải (`justify-content: flex-end`) — gọi lại đúng `handleLogout`
   `AccountMenu` đã dùng (`onLogout` prop mới, `App.tsx` truyền
   `onLogout={handleLogout}` xuống `SettingsDialog` y hệt cách đã truyền
   xuống `Sidebar`), không phải hành động giả thứ 2.
3. *"Bỏ show danh sách plugin"* — bỏ `<PluginInventory />` khỏi General
   tab. Vì component này KHÔNG còn nơi nào khác mount (grep xác nhận
   trước khi xoá) → xoá hẳn file `PluginInventory.tsx` luôn, không để lại
   dead code — cùng 2 key dịch `plugin.title`/`plugin.empty` và toàn bộ
   CSS `.fh-plugin-inventory-*` cũng xoá theo (không còn selector nào
   dùng, xác nhận qua grep).
4. *"2 nút Sáng tối đang chưa đủ cao về height và chữ chưa căn giữa nút
   và thêm icon theo chiều dọc"* — **nguyên nhân thật tìm được, không phải
   đoán**: `.fh-settings-theme-card` không set `height` riêng, nên rule
   gốc `button { height: 34px }` (style.css's base reset) áp dụng —
   34px KHÔNG đủ chỗ cho icon 18px + gap + chữ xếp dọc
   (`flex-direction: column`), nên nhìn như bị nén/không thấy rõ đang xếp
   dọc dù CSS đã đúng logic từ đầu. Sửa: `height: auto` + `min-height:
   92px` (ghi đè rule gốc) + `justify-content: center` (căn giữa theo
   trục dọc — trước đó chỉ có `align-items: center` căn theo trục ngang).
   Các nút khác thêm cùng đợt trước đó (`.fh-settings-nav-item`,
   `.fh-account-menu-item`, `.fh-sidebar-account`) đều đã tự set `height`
   riêng nên không dính lỗi này — chỉ 1 rule bị sót.

**Verify thật:**
1. Grep xác nhận `userRole`/`STORAGE_ROLE`/`settings.profileRole` không
   còn xuất hiện ở đâu ngoài comment giải thích; `PluginInventory`/
   `plugin-inventory` không còn import/mount/CSS nào sống.
2. `pnpm run typecheck` sạch (chạy cả bundler thật) — xác nhận revert
   `userRole` không để sót tham chiếu nào gây lỗi biên dịch.
3. Đọc lại đúng root cause CSS trước khi sửa (không đoán) — xác nhận rule
   `button { height: 34px }` thật ở dòng base reset, và xác nhận 3 rule
   `.fh-settings-nav-item`/`.fh-account-menu-item`/`.fh-sidebar-account`
   khác đều đã tự override `height` nên không cần sửa thêm.
4. Hành vi hiển thị SỐNG trên trình duyệt (chiều cao nút, canh giữa, nút
   Logout đúng vị trí cuối-phải) — không verify được, không có công cụ mở
   browser trong session này; nêu rõ giới hạn này như mọi lần trước.

## 64. "New session" → "New chat" + sửa bug tự tạo session thừa khi bấm lúc chưa chat gì (2026-09-10)

User: *"Khi đang ở session mới và chưa chat gì thì ấn new session ko thực
hiện nha nó đang tự tạo session mới thì phải và tên tiếng anh nút new
session nên là new chat và cả tiếng việt luôn"*.

**Bug thật, xác nhận qua đọc code trước khi sửa** — `startNewSession()`
(`App.tsx`) trước đây LUÔN đóng socket hiện tại rồi mở socket mới với
`sessionPath: 'new'`, bất kể đang ở trạng thái nào — kể cả khi đang đứng
sẵn ở 1 session mới tinh, `hasChatted === false` (chưa gửi tin nhắn nào).
Bấm "New chat" lúc đó tạo THÊM 1 session orchestrator thật (container/
context thật) mà sẽ không bao giờ dùng tới — đúng như user mô tả "nó
đang tự tạo session mới". `hasChatted` đã là đúng tín hiệu "session hiện
tại có nội dung thật hay chưa" dùng xuyên suốt file này (URL routing,
hiện/ẩn session-id) — dùng lại chính nó thay vì bịa thêm 1 cách hỏi khác:
`if (!hasChatted) return` ngay đầu `startNewSession()`, no-op hoàn toàn
khi đã đứng ở 1 chat trống — khớp đúng hành vi claude.ai/chat.deepseek.com
thật (bấm "New chat" lúc đang ở chat trống không tạo thêm hội thoại thứ 2).

Thêm luôn `newSessionDisabled` (mới) truyền từ `App.tsx` xuống
`Sidebar.tsx` (= `!hasChatted`) để nút tự disable đúng lúc nó là no-op —
không chỉ im lặng không làm gì, còn có phản hồi thị giác thật (dùng lại
`button:disabled { opacity: 0.4 }` sẵn có, không cần CSS mới).

**Đổi tên**: `sidebar.newSession` ("New session"/"Phiên mới" →
"New chat"/"Trò chuyện mới") và `conversation.newSessionCmd` (mô tả lệnh
`/new` trong command dropdown, "Start a new session"/"Bắt đầu phiên mới" →
"Start a new chat"/"Bắt đầu trò chuyện mới" — đổi theo cho nhất quán, dù
user chỉ nói tới nút, để lại "session" ở đây sẽ lệch thuật ngữ với nút).
Từ khoá lệnh `/new` chính nó KHÔNG đổi (định danh kỹ thuật, không phải
text hiển thị).

**Verify thật:**
1. Grep xác nhận không còn literal "New session"/"Phiên mới" nào sống
   trong `apps/web/src`.
2. `pnpm run typecheck` sạch (chạy cả bundler thật) — xác nhận prop mới
   `newSessionDisabled` không để sót tham chiếu nào.
3. Hành vi bấm nút lúc đang ở chat trống (no-op thật, không tạo session
   thừa) SỐNG trên trình duyệt — không verify được, không có công cụ mở
   browser trong session này; nêu rõ giới hạn này như mọi lần trước. Cơ sở
   tin fix đúng: đọc lại toàn bộ `startNewSession()` xác nhận guard mới là
   `return` sớm DUY NHẤT trước bất kỳ side-effect nào (đóng socket, đổi
   URL, `connect()`), không còn đường nào lọt qua khi `hasChatted === false`.

## 65. Điều tra 2 bug "trang trắng" + fix thật: auth token chuyển sang localStorage, thêm Error Boundary, sửa cache-control thiếu ở 404 (2026-09-10)

User báo (nối tiếp §57's URL routing): mở `/chat/<id>` ở tab MỚI — trắng
hoàn toàn, không redirect. Điều tra bằng 2 subagent đọc code thật (không
đoán):

1. **Backend KHÔNG phải nguyên nhân** — đọc kỹ `services/gateway`,
   `services/orchestrator`, `packages/transport`: không có giới hạn "1
   session chỉ 1 kết nối" ở đâu cả — nhiều tab cùng connect vào 1 session
   là THIẾT KẾ có chủ đích (`packages/transport/src/server.ts` gửi đủ
   snapshot cho MỖI kết nối mới, không phá kết nối cũ).
2. **Đọc trực tiếp log JSONL thật** của đúng session user test
   (`data/dsh-home/<id>/sessions/--repo--/<id>/session.jsonl.zstd`) —
   session chỉ có 1 lượt chat, `turn/end` có `reason: {"kind":"completed"}`
   bình thường, không có event nào dị dạng có thể gây crash.

Không tìm ra root cause CHẮC CHẮN từ đọc tĩnh → thêm
**`apps/web/src/ErrorBoundary.tsx`** (component class thật, bắt buộc phải
là class vì `componentDidCatch`/`getDerivedStateFromError` không có bản
hook) bọc `<App/>` trong `main.tsx` — không tự nó sửa bug, nhưng biến
"trắng trơn vô thông tin" thành 1 thông báo lỗi đọc được thật, việc CHƯA
TỪNG có trong app này. Cố tình không phụ thuộc `useLocale`/`useTheme`/CSS
class nào của app — nếu cây React phía trên hỏng đủ nặng để rơi tới đây,
fallback không được phép dựa vào chính cái vừa hỏng.

User test lại, báo tiếp 2 lỗi cụ thể:

1. **Reload ngay trên 1 chat đang mở vẫn trắng** — dù ErrorBoundary đã
   deploy (xác nhận qua `grep -c "uncaught render error" main.js` = 1,
   build mới thật). Vì lỗi VẪN trắng dù có ErrorBoundary → suy luận: khả
   năng cao không phải lỗi crash trong RENDER (ErrorBoundary chỉ bắt lỗi
   trong render/lifecycle/effect, KHÔNG bắt lỗi trong raw
   `addEventListener` callback như các WS handler của `connect()` — lỗi ở
   đó sẽ không unmount React, trang vẫn hiện app frame, không "trắng
   trơn"). Chưa xác định được root cause chắc chắn — cần console log thật
   từ user để đi tiếp, đã hỏi lại.
2. **Mở tab mới bắt login lại** — ĐÂY LÀ BUG THẬT, không phải hiểu lầm:
   `STORAGE_TOKEN`/`STORAGE_EMAIL` dùng `sessionStorage` (chỉ scope theo
   TAB, không phải theo trình duyệt) — tab mới dù cùng trình duyệt đã
   login vẫn không có token. Sai với hành vi chuẩn của mọi chat platform
   thật (đăng nhập 1 tab = đăng nhập mọi tab). **Sửa**: đổi toàn bộ 12+
   chỗ dùng `sessionStorage` cho token/email trong `App.tsx` sang
   `localStorage` (dùng `replace_all`, xác nhận trước bằng grep rằng MỌI
   `sessionStorage.*` trong file này đều chỉ phục vụ 2 key này, không lẫn
   key nào khác). Logout vẫn xoá đúng + thu hồi token thật ở server, nên
   1 tab logout thì các tab khác tự heal qua cơ chế 401/handshake-reject
   có sẵn, không cần thêm cross-tab `storage` event listener nào mới —
   không over-engineer cho nhu cầu chưa ai hỏi.

**Gap phụ phát hiện lúc soát lại `serve-web.mjs`** (không phải root cause
2 bug trên, nhưng vi phạm đúng lời hứa của chính file này — "every
response is Cache-Control: no-store"): nhánh 404 (cả lúc SPA fallback tự
nó fail lẫn 404 thật) KHÔNG hề set header này — chỉ nhánh 200 (`sendFile`)
có. Một 404 từng bị cache theo heuristic mặc định của browser (không có
header nào nói đừng cache) có thể khiến 1 path CÓ THẬT sau này vẫn hiện
404 cache cũ. Sửa: gộp thành hàm `send404()` dùng chung, luôn kèm
`cache-control: no-store`.

**Verify thật:**
1. `pnpm run typecheck` sạch (cả bundler thật) sau mọi đổi.
2. Restart cả 2 dev process thật (gateway KHÔNG đổi lần này nên không cần
   đụng; `serve-web.mjs` CÓ đổi → kill PID cũ, chạy lại đúng lệnh cũ từ
   đúng cwd) — `curl` xác nhận: `/does-not-exist.js` → 404 kèm
   `cache-control: no-store` (trước đây thiếu); `/chat/<id-thật>` → vẫn
   200 nội dung thật.
3. Grep xác nhận không còn `sessionStorage` sống nào trong `apps/web/src`
   (chỉ còn comment giải thích lịch sử).
4. Hành vi SỐNG trên trình duyệt (tab mới không bắt login lại nữa; reload
   trên chat có hết trắng hay không) — không verify được, không có công
   cụ mở browser trong session này. Đặc biệt bug #1 (reload trắng) CHƯA
   xác nhận đã sửa hết — chỉ mới loại trừ được vài giả thuyết, chưa có
   root cause chắc chắn; đã hỏi lại user console log thật để đi tiếp thay
   vì đoán thêm.

## 66. TÌM RA root cause thật của cả 2 bug "trang trắng" — asset path relative trong `index.html` (2026-09-10)

User gửi đúng 1 dòng console log — đủ để xác định 100% nguyên nhân, không
cần đoán thêm:

```
53779890-...:25  GET http://localhost:5173/chat/theme.css net::ERR_ABORTED 404 (Not Found)
```

**Root cause thật**: `apps/web/public/index.html` dùng path RELATIVE cho
mọi asset (`href="./theme.css"`, `src="./main.js"`, ...). Path relative
resolve theo ĐỊA CHỈ THANH URL hiện tại của trình duyệt, KHÔNG phải theo
nơi HTML thực sự được phục vụ — dù `scripts/serve-web.mjs`'s SPA fallback
(§57) trả về ĐÚNG y hệt nội dung `index.html` cho cả `/` lẫn `/chat/<id>`,
trình duyệt vẫn tính `./theme.css` khác nhau tuỳ path hiện tại: ở `/` ra
đúng `/theme.css`, ở `/chat/<uuid>` ra SAI thành `/chat/theme.css` (trình
duyệt bỏ đoạn cuối cùng sau dấu `/` cuối, y hệt cách resolve relative URL
chuẩn — `<uuid>` bị thay bằng `theme.css`). **`main.js` cũng dính y hệt
lỗi này** (`src="./main.js"` → `/chat/main.js`, 404) — nghĩa là TOÀN BỘ
bundle JS chưa từng load được khi vào thẳng `/chat/<id>` (tab mới HAY
reload đều vậy) → React chưa bao giờ khởi động → giải thích chính xác cả
2 bug báo trước đó bằng 1 nguyên nhân DUY NHẤT, và giải thích luôn tại
sao Error Boundary (§65) "không giúp được gì" — không phải nó bắt lỗi
sai chỗ, mà là KHÔNG CÓ JS NÀO chạy để mà crash hay bắt cả (ErrorBoundary
chính nó nằm trong `main.js` chưa từng tải lên).

**Vì sao `curl` trước đó không phát hiện ra**: mọi lần verify trước
(§57, §65) chỉ `curl` chính document HTML rồi đọc nội dung bằng mắt —
nội dung ĐÚNG 100% byte-for-byte dù đứng ở `/` hay `/chat/<id>`. Bug chỉ
lộ ra khi có 1 TRÌNH DUYỆT THẬT tự động resolve href/src tương đối theo
URL hiện tại rồi tự fetch tiếp — đúng lỗ hổng verify đã nhiều lần nêu rõ
trong session này ("không có công cụ mở browser, không verify được hành
vi sống") — lần này hoá ra chính lỗ hổng đó là nơi bug thật sự nằm.

**Sửa**: đổi cả 4 chỗ (`theme.css`, `sonner.css`, `style.css`, `main.js`)
từ path relative (`./x`) sang ABSOLUTE (`/x`) — path absolute luôn resolve
từ gốc origin, không phụ thuộc route hiện tại đang sâu bao nhiêu cấp,
đúng thứ 1 SPA với client-side route thật sự cần.

**Verify thật:**
1. `curl` mô phỏng đúng những gì trình duyệt sẽ làm — không chỉ đọc HTML
   bằng mắt như trước: lấy HTML tại `/chat/<id-thật>`, xác nhận cả 4
   href/src giờ là absolute; rồi `curl` riêng từng path đó
   (`/theme.css`, `/sonner.css`, `/style.css`, `/main.js`) xác nhận CẢ 4
   trả 200 thật — mô phỏng đúng bước "trình duyệt resolve rồi fetch tiếp"
   mà lần verify trước bỏ sót.
2. `curl` lại `/` xác nhận không phá hành vi cũ (vẫn 200, asset vẫn load
   đúng).
3. Không cần restart `serve-web.mjs` — file `index.html` được đọc thẳng
   từ đĩa mỗi request (`sendFile` không cache), sửa có hiệu lực ngay.
4. Hành vi SỐNG trên trình duyệt thật (mở tab mới/reload không còn trắng
   nữa) — không tự verify được, không có công cụ mở browser trong
   session này; đây là fix có root cause xác định RÕ RÀNG từ chính log
   console thật user cung cấp (không phải suy đoán), độ tin cậy cao hơn
   hẳn các giả thuyết trước đó.

## 67. Primitives thật (Button/IconButton/MenuItem/SelectableCard/Input) — tái cấu trúc lần 2 `components/` (2026-09-10)

User: *"Hiện tại phân chia chưa chuẩn và ko có ý nghĩa tôi cần plan lại là
move về các component primitives như button, input,... để dùng chung cơ
và bỏ những component đang ko cần"* — phê bình đúng: §61's `primitives/`
chỉ có `ThemeToggle.tsx`/`LangToggle.tsx`, cả 2 đều gắn hook app-specific
thật (`useTheme()`/`useLocale()`), không phải primitive thật theo đúng
nghĩa (generic, không state riêng).

**Đọc lại toàn bộ 8 file component + `style.css` liên quan trước khi lên
plan** (không đoán) — tìm ra trùng lặp CSS/JSX thật: cùng 1 khái niệm UI
bị định nghĩa riêng lẻ ở nhiều nơi:
- Nút icon tròn 28px: `.fh-theme-toggle`, `.fh-sidebar-collapse-toggle`,
  `.fh-sidebar-search-toggle` (1 rule chung, có border) và
  `.fh-settings-close` (rule RIÊNG, y hệt nhưng không border, màu muted) —
  4 chỗ, 2 rule.
- `.fh-session-row-rename` — icon nhỏ 16px/4px radius, rule riêng thứ 3.
- `.fh-account-menu-item` và `.fh-settings-nav-item` — cùng khái niệm
  "hàng ngang icon+label, hover bg" nhưng 2 rule riêng (padding/radius/
  font-size lệch nhau chút).
- `.fh-sidebar-new-session`, `.fh-settings-profile-logout`, `.fh-lang-toggle`,
  `.fh-auth-switch`, `button[type="submit"]` — 5 "hình dạng nút" khác
  nhau (pill nền raised, pill viền 2 size, text-link, pill đặc accent),
  mỗi cái 1 rule CSS riêng dù cùng là "nút hành động".

**Nguyên tắc bắt buộc — KHÔNG redesign**: đọc từng giá trị pixel/màu CHÍNH
XÁC từ rule cũ trước khi viết primitive mới, copy verbatim — mục tiêu là
gom code trùng, không phải đổi giao diện.

**5 primitive mới** trong `components/primitives/`:
- `IconButton.tsx` — `size: 'md'|'sm'`, `variant: 'bordered'|'plain'`.
- `Button.tsx` — `variant: 'primary'|'raised'|'outline'|'link'`,
  `size?: 'sm'|'md'` (chỉ có ý nghĩa với `outline`).
- `MenuItem.tsx` — `variant: 'popup'|'nav'`, `active?`.
- `SelectableCard.tsx` — `active?`. Chỉ có 1 nơi dùng thật (2 instance:
  Light/Dark) nhưng vẫn tách vì là khái niệm UI thật riêng biệt, đúng tinh
  thần "primitive để dùng chung", không phải vì đã trùng lặp thật.
- `Input.tsx` — wrapper `forwardRef` quanh `<input>` (cần `ref` thật cho ô
  tìm kiếm sidebar tự focus) + `label?` tuỳ chọn. CSS input hầu như đã
  dùng chung sẵn từ trước (`input[type=...]` 1 rule) nên đây chủ yếu là
  gom trùng lặp JSX, không phải CSS.
- **Không tách `Select`**: `<select>` ngôn ngữ chỉ 1 nơi dùng, CSS đã
  global sẵn — tách ra là over-engineer, giữ nguyên thô.

**Thiết kế quan trọng — `className` vẫn truyền qua được**: 1 số chỗ dùng
cần thêm CSS riêng NGOÀI hình dạng chung (rail-mode thu gọn của nút New
chat, hover-reveal của nút rename trong session row) — mỗi primitive nhận
thêm `className` tuỳ chọn, nối vào sau class gốc, để những rule CSS riêng
đó (giữ nguyên, không xoá) vẫn áp dụng đúng. 2 trường hợp thật cần cẩn
thận về precedence:
- `.fh-sidebar-new-session` (rail-mode override) — specificity thật cao
  hơn (`#sidebar-col.fh-sidebar-rail .fh-sidebar-new-session`, 1 ID + 2
  class) nên LUÔN thắng `.fh-btn-raised` (1 class) bất kể thứ tự file.
- `.fh-session-row-rename`'s `display:none` mặc định — cùng specificity
  (1 class) với `.fh-icon-btn`'s `display`, nên đổi selector thành
  `button.fh-session-row-rename` (thêm element type) để CHẮC CHẮN thắng
  bất kể thứ tự khai báo trong file, không dựa vào source-order dễ vỡ.

**Di chuyển**: `ThemeToggle.tsx`/`LangToggle.tsx` ra khỏi `primitives/`,
sang `features/` — đúng phê bình ban đầu của user. `App.tsx`'s 2 import
đổi theo. Cả 2 giờ tự render qua `IconButton`/`Button` như mọi feature
khác.

**Migrate 6 file `features/*.tsx`** — thay từng `<button className="fh-x">`/
`<input>` thủ công bằng primitive tương ứng, giữ nguyên 100% logic/handler,
chỉ đổi phần thẻ render. 2 chỗ CHỦ Ý không migrate (không nằm trong phạm
vi plan): `AccountMenu.tsx`'s nút trigger (`.fh-sidebar-account` — composite
riêng: avatar+email+more-icon, không khớp primitive nào), checkbox "steer"
trong `Conversation.tsx` (input type khác, không phải text/password/email).

**Verify thật:**
1. Grep xác nhận mọi rule CSS cũ đã liệt kê không còn selector nào sống
   (chỉ còn trong comment).
2. Kiểm tra balance ngoặc `{}`/comment `/* */` thật bằng script — bắt được
   1 comment CSS quên đóng lúc sửa (đã tự phát hiện và sửa trước khi build).
3. `pnpm run typecheck` sạch (chạy cả bundler thật) — xác nhận mọi import
   mới/di chuyển resolve đúng, không còn tham chiếu nào tới đường dẫn cũ.
4. `curl` xác nhận `main.js` build mới THẬT chứa các class mới
   (`fh-btn-primary`/`fh-icon-btn`/`fh-menu-item`/`fh-selectable-card`),
   không phải bundle cũ chưa cập nhật.
5. Grep JSX xác nhận không còn `<button`/`<input` thủ công nào sót lại
   trong 6 file `features/*.tsx` ngoài 2 trường hợp chủ ý loại trừ ở trên.
6. Hành vi hiển thị SỐNG trên trình duyệt (đúng pixel như trước refactor)
   — không tự verify được, không có công cụ mở browser trong session này;
   nêu rõ giới hạn này như mọi lần trước.

## 68. `sessions.title` → varchar(255), `users.id`/`sessions.owner_id` → int (2026-09-10)

User: *"có update về DB title type là varchar(255) và các cột id nên là
type int"*.

**`title` — làm thẳng, không cần hỏi**: xác nhận trước qua code —
`renameSession()` (`services/gateway/src/db.ts`) là nơi DUY NHẤT ghi
`title`, đã tự cắt `.slice(0, 200)` trước khi insert từ trước — đổi sang
`varchar(255)` an toàn 100%, không có đường nào khác có thể ghi giá trị
dài hơn. Sửa `infra/migrations/001_init.sql`, `docs/schema/001_init.sql`,
`docs/schema/schema.md`, rồi `ALTER TABLE sessions MODIFY title
VARCHAR(255)` thật lên DB đang chạy (`docker-mariadb-1`, DB `fox_harness`)
— verify bằng `DESCRIBE`.

**`id` → int — HỎI TRƯỚC KHI LÀM**, vì đọc code xác nhận đây không đơn
thuần là đổi kiểu cột: `users.id`, `sessions.session_id`, `sessions.owner_id`
đều là UUID do CHÍNH APP tự sinh (`randomUUID()`, ở `services/gateway/src/
auth.ts`+`index.ts`, `services/orchestrator/src/warmpool.ts`,
`packages/transport/src/server.ts`) TRƯỚC khi insert — `session_id` còn
là route WS thật (`/sessions/<uuid>`), URL `/chat/<uuid>`, và tên thư mục
file thật trên đĩa (`data/dsh-home/<uuid>/...`). Đổi `session_id` sang int
sẽ cần viết lại thứ tự tạo session (DB assign id SAU insert, ngược hẳn
flow hiện tại cần id TRƯỚC insert) + sửa routing khắp gateway/orchestrator/
transport/FE + làm URL session dễ đoán hơn (mất tính an toàn của UUID
không đoán được). User xác nhận phạm vi hẹp: **chỉ `users.id`** (và
`sessions.owner_id` theo — phải khớp kiểu để giữ FK), `session_id` GIỮ
NGUYÊN UUID.

**Phạm vi thật đã đọc hết trước khi sửa** (grep xác nhận, không đoán) —
đúng 4 file gateway (`db.ts`, `auth.ts`, `redis.ts`, `index.ts` — file
cuối hoá ra không cần sửa gì, mọi type tự flow qua đúng nhờ suy luận kiểu
của TypeScript) + 1 script độc lập (`scripts/create-admin.mjs`, tự có SQL
riêng, không import `db.ts`) + 3 file schema + DB thật. Không đụng
`services/orchestrator`/`packages/*`/FE — không file nào ở đó tham chiếu
`userId`/`ownerId`.

**Code**: `createUser()` bỏ tham số `id` (DB tự gán qua `auto_increment`,
lấy lại đúng qua `returning *` — cơ chế y hệt đã dùng sẵn, không cần
`LAST_INSERT_ID()` riêng). `UserRecord.id`/`PublicUser.id`/`TokenRecord.userId`/
`ownerId` khắp `db.ts`+`redis.ts`+`auth.ts`: `string` → `number`.
`scripts/create-admin.mjs`: bỏ `randomUUID()` cho `id`, upsert vẫn đúng vì
`ON DUPLICATE KEY UPDATE` key theo `email` (unique), không phải `id`.

**Migrate DB thật, KHÔNG xoá dữ liệu** — DB đang có 20 user + 53 session
thật (dữ liệu tích luỹ suốt session dài này, không phải rác) — backup
thật bằng `mariadb-dump` trước (lưu
`scratchpad/fox_harness_backup_before_int_ids.sql`) rồi remap tại chỗ,
không drop/tạo lại bảng:
1. Drop FK `sessions_owner_id_fkey` (để đổi kiểu 2 cột liên quan tự do).
2. Thêm `users.new_id int auto_increment unique`.
3. Thêm `sessions.new_owner_id int`, `UPDATE ... JOIN` remap từ
   `owner_id` (UUID cũ) → `new_id` tương ứng — verify NGAY: đếm tổng số
   dòng vs số dòng `new_owner_id IS NULL` (phải bằng 0, xác nhận map hết
   100%, không sót session nào).
4. `users`: drop PK+cột `id` cũ, đổi tên `new_id` → `id` + PK.
5. `sessions`: drop cột `owner_id` cũ, đổi tên `new_owner_id` → `owner_id`
   + NOT NULL.
6. Re-add FK + index `(owner_id, updated_at desc)`.

**Bug thật tự phát hiện lúc migrate**: bước 6 tạo lại index bằng
`CREATE INDEX IF NOT EXISTS sessions_owner_id_updated_at_idx (owner_id,
updated_at desc)` tưởng chạy đúng (exit 0) nhưng `SHOW INDEX` sau đó lộ
ra index chỉ còn 1 cột `updated_at` — lý do: lúc drop cột `owner_id` cũ ở
bước 5, MariaDB không xoá hẳn index composite, chỉ tự RÚT GỌN nó xuống
còn cột còn lại, VẪN GIỮ NGUYÊN TÊN cũ — nên `IF NOT EXISTS` thấy tên đã
tồn tại và bỏ qua, để lại index sai (thiếu `owner_id`). Sửa: `DROP INDEX`
tường minh rồi `CREATE INDEX` lại (không `IF NOT EXISTS`) — verify lại
bằng `SHOW INDEX` xác nhận đủ 2 cột đúng thứ tự.

**Verify thật:**
1. `SELECT COUNT(*)` cả 2 bảng trước/sau — 20 user, 53 session, khớp
   tuyệt đối, không mất dòng nào.
2. `JOIN users/sessions` thật theo id mới, xem 10 dòng đầu — email/số
   session khớp đúng logic (vd tài khoản test thật của user có 40 session,
   đúng như đã dùng để test suốt session dài này).
3. Restart gateway thật (đổi code `db.ts`/`auth.ts`/`redis.ts` cần
   restart process, không hot-reload) — `curl` thật: register user mới →
   `"id":21` (int thật, tăng đúng từ 20 user có sẵn), login → token thật,
   `GET /sessions/mine` → `[]` không lỗi (xác nhận toàn bộ chuỗi
   token→userId→ownerId type mới hoạt động đúng qua Redis + MariaDB).
4. `scripts/create-admin.mjs` chạy lại thật với email admin đã có sẵn
   (`id=4`) — xác nhận vẫn giữ đúng `id=4` sau khi bỏ `randomUUID()`,
   không tạo dòng trùng, đúng hành vi idempotent cũ.
5. `pnpm run typecheck` sạch — xác nhận `index.ts` không cần sửa gì
   (type suy luận tự đúng), không có chỗ nào còn giả định `string`.

## 69. Register: thêm ô xác nhận mật khẩu + tách lỗi validation thành 3 case riêng (2026-09-10)

User: *"Màn register cần có input xác nhận lại mật khẩu thêm nha và việc
báo lỗi đang quá chung chung báo 3 loại lỗi Cần email khi ko nhập email,
mật khẩu phải 8 ký tự, và mật khẩu xác nhận ko trùng 3 case tuỳ trường
hợp"*.

**Hiện trạng trước khi sửa** (đọc code xác nhận): `ConnectForm.tsx` KHÔNG
có validation client-side nào cả — bấm submit là gọi thẳng `onRegister`,
mọi lỗi đều rơi vào ĐÚNG 1 message chung từ server
(`error.invalid_registration_input`: "Cần email và mật khẩu tối thiểu 8
ký tự", gộp cả 2 case khác nhau làm 1) — và không có ô confirm password
nào để mà báo lệch.

**Sửa**: thêm state `confirmPassword` + ô `<Input>` MỚI, chỉ hiện khi
`mode === 'register'`. Thêm state `validationError` — TÁCH RIÊNG khỏi
prop `error` cũ (lỗi thật từ server, vd "email đã đăng ký") — check tuần
tự NGAY trong `handleSubmit()`, TRƯỚC khi gọi `onRegister` — sai bất kỳ
case nào thì dừng lại, không gọi mạng:
1. `email.trim()` rỗng → `auth.emailRequired`
2. `password.length < 8` → `auth.passwordTooShort`
3. `password !== confirmPassword` → `auth.passwordMismatch`

Hiển thị: `displayError = validationError ?? error` — ưu tiên lỗi
validation cục bộ, fallback về lỗi server thật nếu không có lỗi cục bộ
nào (vd sau khi qua hết 3 check, gọi server thật và server báo "email đã
đăng ký" — vẫn hiện đúng ở CÙNG 1 chỗ `#connect-error`, không cần 2 slot
UI khác nhau). `validationError` tự xoá khi chuyển qua lại
login/register (tránh lỗi cũ còn treo lúc quay lại).

**Cố tình KHÔNG động vào**: mode login (không thêm validation email/mật
khẩu ở đó — lỗi "invalid email or password" từ server vốn đã đúng ngữ
nghĩa cho login, khác hẳn "input sai định dạng" của register) và
server-side check (vẫn giữ nguyên message gộp cũ làm lớp chống lưng thật
sự — nếu JS bị bypass hoàn toàn thì vẫn có validation, chỉ là FE giờ
chặn được trước gần như mọi lần dùng bình thường).

**4 key dịch mới**: `auth.confirmPassword`, `auth.emailRequired`,
`auth.passwordTooShort`, `auth.passwordMismatch` — đủ cả vi/en (ép qua
`Record<TranslationKey,string>` như mọi lần).

**Verify thật:**
1. `pnpm run typecheck` sạch (chạy cả bundler thật).
2. `grep -c` xác nhận cả 4 key dịch mới có mặt thật trong `main.js` build
   mới, không chỉ trong source.
3. Đọc lại toàn bộ luồng `displayError`/`validationError` xác nhận không
   còn đường nào gọi `onRegister` khi 1 trong 3 check trên fail — return
   sớm ngay sau `setValidationError`, trước dòng `setRegistering(true)`.
4. Hành vi hiển thị SỐNG trên trình duyệt (đúng message đúng lúc, ô
   confirm password hiện/ẩn đúng theo mode) — không tự verify được,
   không có công cụ mở browser trong session này; nêu rõ giới hạn này
   như mọi lần trước.

## 70. Dropdown ngôn ngữ trong Settings — thay `<select>` thô bằng UI thật (2026-09-10)

User: *"Dropdown lang trong setting đang chưa có UI thêm đi"*.

**Bối cảnh**: §67 CỐ Ý không tách primitive `Select` cho `<select>` ngôn
ngữ — lý do lúc đó: chỉ 1 nơi dùng, CSS `select {}` đã global sẵn, tách
ra là thừa. Nhưng để nguyên native `<select>` thì nhìn lệch hẳn so với 2
thẻ Theme (Light/Dark) đã có UI thật ngay phía trên — user chỉ ra đúng
chỗ thiếu này.

**Sửa**: file mới `components/features/LanguageSelect.tsx` — nút trigger
hiện tên ngôn ngữ hiện tại + icon chevron, bấm mở popup thật với 2 dòng
(dùng lại `MenuItem` primitive sẵn có, `variant="popup"`, đánh dấu
`active` đúng ngôn ngữ đang chọn). Portal ra `document.body`, mirror y
hệt kỹ thuật đã dùng ở `AccountMenu.tsx` (trigger ref →
`getBoundingClientRect()` → position fixed → đóng khi click ra ngoài/
Escape) — lý do: `.fh-settings-content` (nơi control này nằm) có
`overflow-y: auto`, có nguy cơ cắt popup y hệt lý do `#sidebar-col` từng
buộc AccountMenu phải portal — tái dùng kỹ thuật đã CHỨNG MINH hoạt động
thay vì tự nghĩ cách mới có nguy cơ dính lại đúng bug cũ.

**Không tạo primitive `Select` mới** — vẫn đúng lý do cũ (chỉ 1 nơi
dùng), chỉ là native `<select>` không đủ "UI thật" như user muốn, nên
xây thẳng component feature-level tái dùng `MenuItem` sẵn có, không phải
tạo thêm tầng trừu tượng mới.

**Dọn theo, xác nhận qua grep trước khi xoá**: `<select>` không còn nơi
nào trong JSX toàn app nữa → xoá hẳn rule CSS `select {}`/`select:focus`
(chết hoàn toàn). `SettingsDialog.tsx` bỏ `locale`/`setLocale`/
`import type { Locale }` không dùng nữa (chuyển hết vào
`LanguageSelect.tsx`). Sửa 1 comment cũ trong `i18n/locale.tsx` nhắc tới
"native `<select>`'s onChange" — không còn đúng nghĩa đen sau khi đổi,
viết lại theo lý do thật (chọn đúng ngôn ngữ đang dùng là no-op, không
phải lật ngược, `toggle()` không diễn tả được).

**Verify thật:**
1. `pnpm run typecheck` sạch (cả bundler thật).
2. Balance ngoặc `{}`/comment `/* */` của `style.css` (thói quen từ §67
   sau khi từng bắt được 1 comment quên đóng).
3. Grep xác nhận không còn `<select` nào trong JSX + không còn selector
   CSS `select`/`select:focus` nào sống.
4. `curl` xác nhận `main.js`/`style.css` build mới serve đúng 200, `grep -c`
   xác nhận 2 class mới có mặt thật trong bundle.
5. Hành vi hiển thị SỐNG (mở đúng vị trí dưới trigger, đóng đúng lúc,
   không bị `.fh-settings-content`'s overflow cắt) — không tự verify
   được, không có công cụ mở browser trong session này; nêu rõ giới hạn
   này như mọi lần trước.

## 71. `components/features/` hết phẳng — nhóm theo layout/page thật (2026-09-10)

User: *"cấu trúc lại feature theo cấu phần nó nằm tổng theo layout hay
page"* — `features/` có 9 file phẳng, muốn nhóm theo khu vực layout/page
thật đang dùng.

**Đọc thật quan hệ import/render trước khi nhóm** (grep, không đoán) —
`App.tsx` chỉ import trực tiếp 6/9 file, còn lại là con của 2 file kia:
`Sidebar.tsx` tự import `AccountMenu.tsx`+`SessionList.tsx` (không nơi
nào khác dùng); `SettingsDialog.tsx` tự import `LanguageSelect.tsx`
(không nơi nào khác dùng); `ConnectForm`/`ThemeToggle`/`LangToggle` render
CÙNG 1 khối JSX trong `App.tsx` (`.fh-auth-screen`) — cả 3 chỉ tồn tại ở
màn auth. 4 nhóm rút thẳng từ quan hệ thật này, đặt tên theo ĐÚNG prefix
class CSS đã có sẵn trong chính các file đó (`fh-auth-*`/`fh-sidebar-*`/
`fh-conversation-*`/`fh-settings-*`, không bịa tên mới):

```
components/features/
  auth/            ConnectForm.tsx, LangToggle.tsx, ThemeToggle.tsx
  sidebar/         AccountMenu.tsx, SessionList.tsx, Sidebar.tsx
  conversation/    Conversation.tsx
  settings/        LanguageSelect.tsx, SettingsDialog.tsx
```

**Thực hiện**: `mv` thật 9 file vào 4 thư mục con. Sửa import path
RELATIVE bên trong từng file — độ sâu tăng 1 cấp
(`features/X.tsx` → `features/<nhóm>/X.tsx`): mọi `'../../...'` (tới
`i18n/`/`icons.tsx`/`runtime.ts`/`useTheme.ts`/`wire.ts`) → `'../../../...'`;
mọi `'../primitives/...'` → `'../../primitives/...'` — làm bằng `sed`
theo batch từng thư mục (9 file, pattern y hệt, không cần sửa tay từng
dòng — 2 pattern không giao nhau: `'../../` chỉ khớp import 2 cấp, không
khớp `'../primitives/` vốn chỉ có 1 cấp `../`, nên chạy 2 `sed` không lo
đè lẫn nhau). Import CHÉO giữa 2 file CÙNG vào 1 nhóm
(`Sidebar.tsx`→`./AccountMenu.tsx`/`./SessionList.tsx`,
`SettingsDialog.tsx`→`./LanguageSelect.tsx`) GIỮ NGUYÊN `./` — đúng như
dự đoán trong plan, không cần sửa. `App.tsx` sửa 6 import sang path nhóm
mới.

**Dọn theo**: grep quét toàn bộ `apps/web/src` tìm path cũ còn sót —
bắt được 2 comment (không phải import thật) còn trỏ path cũ
(`i18n/locale.tsx` nhắc `features/LanguageSelect.tsx`,
`i18n/translations.ts` nhắc `components/features/ConnectForm.tsx`) — sửa
cả 2 cho khớp path mới. `apps/web/README.md`'s đoạn mô tả kiến trúc
`components/` (đã viết lại ở §61, §67) viết lại lần 3 theo cấu trúc nhóm
mới — tiện phát hiện `LanguageSelect.tsx` (thêm ở §70) CHƯA TỪNG được
nhắc trong doc này, bổ sung luôn.

**Verify thật:**
1. Grep quét TOÀN BỘ `apps/web/src` (không chỉ file đã sửa) tìm mọi biến
   thể path cũ (`features/ConnectForm`, `features/Sidebar.` — có dấu
   chấm để không khớp nhầm `features/sidebar/`, ...) — xác nhận 0 kết
   quả sau khi sửa cả 2 comment sót ở trên.
2. `pnpm run typecheck` sạch — chạy cả bundler thật, xác nhận mọi import
   mới/di chuyển resolve đúng file trên đĩa.
3. `curl` thật `main.js`/`style.css`/`/` — cả 3 vẫn 200 sau rebuild.

## 72. Auth screen dùng chung `LanguageSelect.tsx`, xoá `LangToggle.tsx` (2026-09-10)

User: *"trong Auth có langtoggle đổi thành lang change dropdown lun"* —
màn auth (`ConnectForm`/`ThemeToggle`/`LangToggle` trong
`.fh-auth-screen`, §71) đang dùng `LangToggle.tsx` (nút toggle 2 chiều
đơn thuần), trong khi Settings > General đã có `LanguageSelect.tsx`
(dropdown thật, §69) cho đúng cùng 1 việc — chuyển màn auth sang dùng
lại y hệt component đó thay vì giữ 2 kiểu control khác nhau cho cùng 1
tính năng ở 2 nơi.

**Thực hiện**:
- `features/settings/LanguageSelect.tsx` → move lên `features/LanguageSelect.tsx`
  (phẳng, ngay dưới `features/`) — không còn thuộc riêng `settings/` nữa
  vì giờ có 2 consumer không liên quan nhau (`SettingsDialog.tsx` và
  `App.tsx`'s auth screen), đúng luật "group theo usage thật" đã dùng để
  tổ chức lại `features/` ở §71 — 1 file có 2 cha không liên quan thì
  không thuộc về cha nào cả. Đổi `id` từ `settings-language-select` →
  `language-select` (không còn gắn riêng ngữ cảnh Settings); CSS class
  đổi `fh-settings-lang-*` → `fh-lang-select-*` cho khớp.
- `App.tsx`: bỏ import `LangToggle`, thêm import
  `LanguageSelect` từ `./components/features/LanguageSelect.tsx`;
  `.fh-auth-screen-controls` render `<LanguageSelect />` rồi
  `<ThemeToggle />` (trước là `<LangToggle />` rồi `<ThemeToggle />`).
- `SettingsDialog.tsx`: sửa import `LanguageSelect` từ `./LanguageSelect.tsx`
  → `../LanguageSelect.tsx` (lên 1 cấp, theo vị trí file mới).
- `features/auth/LangToggle.tsx` — XOÁ hẳn (grep xác nhận 0 consumer còn
  lại trước khi xoá).
- `primitives/Button.tsx` — bỏ hẳn prop `size`. `size` trước có 2 giá trị
  thật cho variant `outline` (`sm` = `.fh-lang-toggle` cũ, `md` =
  Settings Profile-tab Logout button) — xoá `LangToggle.tsx` khiến
  `outline` chỉ còn đúng 1 size thật đang dùng, không còn lý do giữ 1
  dimension mà không component nào exercise nữa.
- `public/style.css`: `.fh-settings-lang-trigger`/`:hover`/
  `.fh-settings-lang-popup` đổi tên `fh-lang-select-*`; bỏ
  `width: 100%; max-width: 220px` (giả định full-width chỉ đúng trong
  Settings) thay bằng `min-width: 160px` (giờ còn nằm trong hàng flex
  ngang của auth screen nữa). `.fh-btn-outline-sm` (dead — không còn
  caller) xoá hẳn; `.fh-btn-outline-md` (`height:34px; padding:0 1em;
  font-size:0.85em`) gộp thẳng vào `.fh-btn-outline` vì giờ là size duy
  nhất còn dùng.
- `apps/web/README.md`'s đoạn kiến trúc `components/` (§61/§67/§71) cập
  nhật: bỏ mục `LangToggle.tsx` riêng khỏi `features/auth/`, ghi chú sự
  xoá/thay thế ngay trong mô tả `ThemeToggle.tsx`; thêm mục
  `LanguageSelect.tsx` phẳng ngay dưới `features/` (không lồng
  `auth/`/`settings/`); mục `SettingsDialog.tsx` trỏ sang vị trí chung
  mới thay vì tự nhận là con của `settings/`.

**Verify thật**:
1. Grep toàn bộ `apps/web/src`/`apps/web/public`/docs tìm
   `LangToggle`/`fh-settings-lang-`/`fh-btn-outline-sm`/`fh-btn-outline-md`
   còn sót ngoài comment lịch sử (ghi lại chuyện đã xảy ra, không phải
   reference sống) — sạch.
2. `pnpm run typecheck` sạch — chạy cả bundler thật
   (`scripts/build-web.mjs`), xác nhận mọi import mới resolve đúng file
   trên đĩa, không còn tham chiếu `LangToggle.tsx` nào sống sót.
3. Hành vi hiển thị SỐNG trên auth screen (dropdown mở đúng vị trí, chọn
   đổi ngôn ngữ ngay lập tức) — không tự verify được, không có công cụ
   mở browser thật trong session này; nêu rõ giới hạn này như mọi lần
   trước.

## 73. Bug thật: chọn 1 chat cũ trong sidebar bị "nhảy" vị trí + đổi tên `SessionList.tsx` → `HistoryChat.tsx` (2026-09-10)

User: *"Hiện tại SessionList tên vầy là ko chuẩn đây là HistoryChat và khi
chọn 1 trong các đoạn chat list này sẽ bị nhảy tại sao check cho tôi"* —
2 việc: (1) tên component `SessionList` không đúng bản chất; (2) 1 bug
thật khi bấm vào 1 chat cũ trong sidebar.

**Điều tra root cause của "nhảy"** — không đoán, lần theo đúng chuỗi thật:
`HistoryChat.tsx` (lúc đó còn `SessionList.tsx`) refetch `/sessions/mine`
mỗi khi `runtime.sessionId` đổi, rồi sort/group lại theo `updated_at desc`
— nếu `updated_at` của đúng session vừa bấm bị đổi ngay lúc đó, hàng nó
sẽ nhảy thẳng lên đầu nhóm "Hôm nay", ngay dưới con trỏ chuột vừa bấm.
Grep `services/gateway/src` tìm mọi nơi ghi `updated_at` — thấy
`index.ts`'s WS upgrade handler gọi `void touchSessionRow(sessionId)`
**vô điều kiện ngay khi WS connect** (dòng ngay cạnh `touchSession(...,
'connected')` — hàm KHÁC, ping orchestrator giữ container sống, không
liên quan sort order, không đổi). Nghĩa là chỉ BẤM VÀO để XEM 1 chat cũ —
chưa gửi tin nhắn gì — đã đủ bump `updated_at = now()`, khiến hàng đó nhảy
lên đầu ngay lập tức. Đối chiếu `db.ts`'s comment cũ ("called on every real
WS connect ... so a session a user is actually USING climbs back to the
top") — sai ở chỗ coi "connect" = "using", trong khi mở để đọc lại 1 chat
cũ không phải là "đang dùng" theo nghĩa real dsh/deepseek/claude.ai áp
dụng (chỉ gửi tin nhắn thật mới đẩy lên đầu, mở xem không đẩy).

**Fix**: chuyển điểm bump `updated_at` từ "connect-time" sang đúng tín
hiệu hoạt động thật đã có sẵn — `proxy.ts`'s `onEveryClientMessage` (fire
trên MỖI frame browser→worker thật, không phải chỉ frame đầu như
`markSessionFirstMessage`/`onClientMessage`) — cùng chỗ `renewToken()` đã
dùng cho sliding token expiration, lý do y hệt: đây mới là tín hiệu "user
thật sự đang chat", không phải "socket đang mở". `index.ts`: xoá dòng
`void touchSessionRow(sessionId)` khỏi WS-connect handler; gộp
`void touchSessionRow(sessionId)` vào callback thứ 2 của `proxyToWorker(...)`
(cùng chỗ `renewToken`). `db.ts`'s `touchSessionRow` comment viết lại cho
đúng trigger mới.

**Đổi tên `SessionList.tsx` → `HistoryChat.tsx`**: "session" vẫn là khái
niệm backend/routing THẬT ở chỗ khác trong app này (bảng `sessions`,
`runtime.sessionId`/`switchSession()`, URL `/chat/<id>`) — giữ nguyên tên
đó ở đúng những chỗ nó THẬT LÀ vậy; riêng component này là danh sách
lịch sử chat hiển thị cho người dùng, nên đổi theo đúng tên người dùng
nhìn thấy, không đổi tên "session" ở toàn bộ codebase (phạm vi hẹp, đúng
với complaint thật của user, không lan ra `runtime.ts`/gateway API).
Đổi toàn diện, nhất quán (không chỉ đổi tên file):
- File + hàm: `SessionList` → `HistoryChat`.
- CSS: `fh-session-list`/`fh-session-list-search`/`fh-session-group`/
  `fh-session-group-label`/`fh-session-row`(+`-title`/`-rename`) →
  `fh-history-chat-*` tương ứng. `fh-status-dot` giữ nguyên (tên đã chung
  chung, không dính "session"). Nhân tiện phát hiện `.fh-session-list-empty`
  là CSS CHẾT thật (grep xác nhận không có JSX nào render class này — trạng
  thái rỗng hiện tại chỉ là `<></>`) — xoá hẳn, không giữ lại.
- i18n keys: `sessionList.*` → `historyChat.*` (cả `vi` và `en`, compile-time
  check của `TranslationKey = keyof typeof vi` tự bắt nếu thiếu key nào).
- Cập nhật mọi comment còn nhắc `SessionList.tsx`/`fh-session-*` bằng tên
  cũ sang tên mới (`icons.tsx`, `locale.tsx`, `Sidebar.tsx`,
  `IconButton.tsx`, `translations.ts`, `apps/web/README.md`) — các đoạn
  lịch sử trong chính file này (§61 trở về trước) KHÔNG sửa, giữ nguyên
  vì mô tả đúng thời điểm nó được viết.

**Verify thật**:
1. Grep toàn bộ `apps/web/src`/`apps/web/public/style.css`/README tìm
   `SessionList`/`fh-session-list`/`fh-session-row`/`fh-session-group`
   còn sót ngoài các comment cố ý ghi lại lịch sử đổi tên — sạch.
2. `pnpm run typecheck` sạch — build composite gồm cả `services/gateway`
   (cùng 1 `tsc -b tsconfig.json` ở root, `services/gateway` nằm trong
   `references`) lẫn `apps/web`'s bundler thật, xác nhận cả 2 phía
   (backend fix + rename FE) không có tham chiếu vỡ.
3. CSS brace/comment balance check (script Node đếm `{`/`}`/comment) —
   sạch, depth cuối = 0.
4. Hành vi SỐNG (bấm 1 chat cũ, xác nhận hàng KHÔNG nhảy vị trí nữa; gửi
   tin nhắn thật trong chat đó, xác nhận CÓ nhảy lên đầu) — không tự
   verify được, không có công cụ mở browser thật trong session này; nêu
   rõ giới hạn này như mọi lần trước.

## 74. Mỗi chat item: hover hiện nút "..." mở dropdown Đổi tên/Xoá (2026-09-10)

User: *"Trong từng chat item khi hover sẽ hiện nút icon 3 chấm và dropdown
có 2 option khi ấn là đổi tên và xoá"* — `HistoryChat.tsx`'s mỗi row trước
đó chỉ có 1 nút bút chì (PencilIcon) hiện khi hover, bấm là đổi tên thẳng,
không có Xoá. Đổi thành nút "..." (`MoreIcon`, icon đã có sẵn từ
`AccountMenu.tsx`) hiện khi hover, bấm mở popup 2 dòng: Đổi tên, Xoá.

**Backend đã có sẵn, không cần thêm gì**: grep `services/gateway/src`
thấy `DELETE /sessions/:id` (Phase 6 checklist item 4 — thật, có kiểm tra
`canAccessSession` đầy đủ, proxy sang `purgeSession` orchestrator +
`deleteSessionRow` DB) đã tồn tại từ lâu nhưng CHƯA từng được FE gọi tới —
chỉ cần nối dây, không cần route/logic mới.

**Thực hiện** (`HistoryChat.tsx`):
- Thêm state `menuRow: SessionRow | null` (giữ NGUYÊN row, không chỉ id —
  handler Rename/Delete trong popup cần đúng `title`/`sessionId` hiện tại,
  tránh phải tra lại từ `rows`) + `menuPosition` + 2 ref (trigger hiện tại,
  popup) — y hệt state shape `AccountMenu.tsx` đã dùng, chỉ khác ở chỗ
  trigger giờ ĐỘNG theo từng row thay vì cố định 1 cái.
- `openRowMenu(row, trigger)`: lấy `trigger.getBoundingClientRect()` (qua
  `event.currentTarget` ngay tại lúc click — `IconButton` không forward
  ref, nên dùng thẳng DOM event thay vì thêm ref-forwarding cho 1 chỗ
  dùng), neo popup bằng `right` (khoảng cách tới mép phải viewport) chứ
  không phải `left` — vì hàng nằm sát mép phải sidebar, popup ~160px mở
  theo hướng phải sẽ tràn ra ngoài sidebar/viewport (nhất là rail mode);
  mở theo hướng TRÁI từ trigger thì luôn nằm gọn trong sidebar — cùng lý
  do `AccountMenu.tsx` neo bằng `bottom` thay vì `top`.
- Dismiss outside-click/Escape — copy y hệt pattern `AccountMenu.tsx`.
- `remove(row)`: `window.confirm(...)` trước (destructive, không có undo)
  → `DELETE /sessions/:id` → nếu đúng session đang mở thì gọi
  `runtime.newSession()` để thoát khỏi 1 session vừa xoá (không thể
  reconnect lại được nữa) → `refresh()`. Xác nhận `newSession()`'s no-op
  guard (`!hasChatted`) không bao giờ chặn nhầm trường hợp này: mọi row
  hiện trong list đã có `first_message_at` (điều kiện lọc sẵn của
  `GET /sessions/mine`), nên `hasChatted` luôn `true` cho bất kỳ row nào
  đang là session hiện tại.
- CSS: `.fh-history-chat-row-rename` → `.fh-history-chat-row-menu-trigger`
  (đổi tên đúng bản chất — giờ mở menu 2 lựa chọn, không còn là hành động
  đổi tên trực tiếp nữa). Thêm rule hiện nút khi `.menu-open` (class do
  React state set, không phải `:hover` thật) — gap thật tự phát hiện lúc
  code: popup portal ra ngoài row, nên khi rê chuột về phía popup thì
  `:hover` của row kết thúc, nút "..." biến mất trong lúc popup của chính
  nó vẫn đang mở — sửa bằng cách hiện nút khi HOẶC `:hover` HOẶC
  `.menu-open`.
- `.fh-history-chat-row-menu-popup`: bản sao thứ 3 (sau
  `.fh-account-menu-popup`, `.fh-lang-select-popup`) của đúng 1 khối chrome
  "floating card" (bg/border/radius/shadow/padding/z-index giống hệt) —
  CHƯA gộp thành 1 class chung lần này, ghi rõ trong comment là ứng viên
  gộp thật nếu có lần thứ 4, để giữ đúng phạm vi user thật sự yêu cầu
  (không tự ý refactor 2 popup có sẵn khi user không nhờ).
- `.fh-menu-item-danger` (rule mới, 1 dòng: `color: var(--status-danger)`)
  — `MenuItem`'s `className` passthrough có sẵn, không cần thêm `variant`
  mới cho 1 chỗ dùng duy nhất hiện tại.
- `icons.tsx`: thêm `Trash2 as TrashIcon`. `translations.ts`: thêm
  `historyChat.rowActions`/`.delete`/`.deleteConfirm` (cả `vi`/`en`) — bỏ
  `{title}` interpolation khỏi confirm message (tránh escaping dấu ngoặc
  kép thật trong tiêu đề chat lồng vào chuỗi JS cũng dùng dấu ngoặc kép).

**Verify thật**:
1. Grep toàn bộ `apps/web/src`/`apps/web/public/style.css` tìm
   `fh-history-chat-row-rename` còn sót ngoài comment lịch sử ghi lại
   chuyện đổi tên — sạch.
2. `pnpm run typecheck` sạch — bundler thật xác nhận `MoreIcon`/`TrashIcon`
   resolve đúng từ `lucide-react`, mọi translation key mới có đủ cả
   `vi`/`en` (compile-time check của `TranslationKey`).
3. CSS brace/comment balance — sạch, depth cuối = 0.
4. `curl` xác nhận `main.js` build mới có chứa
   `fh-history-chat-row-menu-trigger`/`fh-menu-item-danger` (grep trực
   tiếp trong bundle đã build) — xác nhận code mới thật sự nằm trong output
   đang serve, không chỉ nằm trong source.
5. Hành vi SỐNG (hover hiện nút, bấm mở đúng vị trí, Đổi tên/Xoá hoạt động
   đúng, xoá đúng session đang mở thì chuyển sang chat mới) — không tự
   verify được, không có công cụ mở browser thật trong session này; nêu
   rõ giới hạn này như mọi lần trước.

## 75. Dropdown mở bên phải + Rename thành inline input + check 255 ký tự thật (2026-09-10)

User: *"dropdown xuất hiện từ bên phải nút 3 chấm và khi ấn đổi tên biến
title hiện tại thành ô input để nhập và ấn enter là xong nhớ có check lỗi
ko quá 255 kí tự"* — follow-up trực tiếp của §74, 3 việc: (1) đổi hướng mở
popup; (2) Rename từ `window.prompt` sang input tại chỗ; (3) check lỗi
thật khi vượt 255 ký tự.

**(1) Popup mở bên phải, không còn bên dưới-trái**: `openRowMenu()` đổi từ
neo `right: window.innerWidth - rect.right` (mở xuống dưới, lệch trái) →
neo `left: rect.right + 4` (mở sang phải, `top` bằng `rect.top` của
trigger). Popup vẫn portal ra `document.body` (không đổi) nên việc tràn
qua khỏi mép phải sidebar vào vùng nội dung chính là CHỦ Ý, không phải
bug — sidebar's `overflow` không còn liên quan nữa. CSS
`.fh-history-chat-row-menu-popup` đổi theo, style inline đổi `right` →
`left`.

**(2) Rename thành inline input** (`HistoryChat.tsx`): thêm state
`renamingRow`/`renameValue` + ref input. Bấm "Đổi tên" trong popup gọi
`startRename(row)` (chỉ set state vào chế độ edit, KHÔNG gọi API ngay) —
tách khỏi `commitRename(row)` (gọi khi Enter, mới thật sự PATCH). Render:
khi `renamingRow` khớp đúng row, `<span className="fh-history-chat-row-
title">` được thay bằng `<Input type="text">` (title hiện tại prefill +
auto-select toàn bộ lúc mount qua `useEffect`), nút "..." của CHÍNH row đó
ẩn đi trong lúc edit (tránh chồng chéo). Enter → `commitRename`; Escape/blur
→ huỷ (`setRenamingRow(null)`, không gọi API) — không lưu khi click ra
ngoài, đúng như user chỉ nhắc Enter là hành động submit duy nhất. Row's
`onClick` (switch session) được guard thêm: bỏ qua nếu đúng row đang edit
(input tự `stopPropagation` khi click vào chính nó rồi, guard này chỉ cho
phần còn lại của row — status dot — lúc đang edit).

**(3) Check lỗi 255 ký tự thật — cả 2 phía**:
- FE (`commitRename`): `trimmed.length > 255` (255 = độ rộng THẬT của cột
  `sessions.title varchar(255)`, không phải số đoán — xem migration DB
  title/id trước đó trong file này) → `toast.error(t("historyChat.
  titleTooLong"))`, KHÔNG gọi server, KHÔNG thoát edit mode (giữ nguyên để
  user tự sửa rồi Enter lại) — đúng thứ tự "validate FE trước khi gọi
  server" y hệt form Register đã dùng. Input KHÔNG đặt `maxLength` HTML
  native — cố ý, vì native `maxLength` sẽ ÂM THẦM chặn gõ/paste quá 255,
  khiến nhánh lỗi ở trên không bao giờ thật sự chạy được — trái với đúng
  ý "nhớ có check lỗi" (phải có lỗi HIỂN THỊ thật, không phải chặn ngầm).
- **Gap thật phát hiện lúc code, không nằm trong yêu cầu gốc**: grep
  `services/gateway/src/index.ts`'s PATCH handler thấy
  `body.title.trim().slice(0, 200)` — âm thầm CẮT chuỗi thay vì từ chối,
  và 200 là số KHÔNG khớp với cột thật `varchar(255)` (lệch từ trước khi
  cột được đổi sang 255 ở lần migrate DB trước đó trong session này, không
  ai cập nhật lại con số này). Sửa: thêm check thật
  `if (title.length > 255) return 400`, bỏ hẳn `.slice(...)` — giờ FE và
  BE cùng enforce đúng 1 con số thật, không còn 2 giới hạn khác nhau âm
  thầm (FE tưởng 255 nhưng BE trước đó âm thầm cắt ở 200).
- i18n: thêm `historyChat.titleTooLong` (`vi`/`en`).

**Verify thật**:
1. Grep xác nhận không còn `.slice(0, 200)` nào trong PATCH handler; không
   còn selector CSS `right:` cũ nào áp cho popup này (đã đổi hết sang
   `left`).
2. `pnpm run typecheck` sạch — build composite gồm cả `services/gateway`
   lẫn `apps/web`'s bundler thật.
3. **Bug CSS specificity thật tự bắt được lúc viết, sửa trước khi commit**:
   viết `.fh-history-chat-row-rename-input` như 1 class selector thường
   (không kèm `input[type="text"]`) — do base rule `input[type="text"],
   input[type="password"], input[type="email"] {height:34px;...}` (ở dưới,
   cùng file) có specificity CAO HƠN 1 class đơn (element+attribute = 2
   thành phần > 1 class = 1 thành phần), quy tắc mới của mình sẽ bị đè âm
   thầm bất kể thứ tự trong file — ĐÚNG loại bug `.fh-history-chat-search`
   (dòng ~360, cùng file) đã từng gặp và ghi chú lại. Tự phát hiện khi đối
   chiếu với đúng comment đó, sửa lại thành selector kép
   `input[type="text"].fh-history-chat-row-rename-input` (thêm luôn
   `type="text"` vào JSX `<Input>` — trước đó thiếu, khiến attribute
   selector còn không match được input nào cả). CSS brace/comment balance
   check sau đó — sạch, depth cuối = 0.
4. `curl` xác nhận bundle mới (`main.js`) chứa
   `fh-history-chat-row-rename-input`/`titleTooLong` — code mới thật sự
   nằm trong output đang serve. Restart lại `services/gateway` process
   (chạy thẳng từ source, không có watcher) để fix backend có hiệu lực —
   xác nhận log khởi động lại sạch, cổng 4000 vẫn nghe.
5. Hành vi SỐNG (popup mở đúng bên phải; Enter lưu tên mới; gõ tên >255 ký
   tự thấy toast lỗi thật, KHÔNG bị chặn gõ ngầm; PATCH thật với tên >255
   bị BE từ chối 400) — không tự verify được, không có công cụ mở browser
   thật trong session này; nêu rõ giới hạn này như mọi lần trước.

## 76. User báo "chưa đổi được tên" — điều tra thật bằng jsdom+React thật, không đoán (2026-09-10)

User: *"oke rồi nhưng hiện tại chưa đổi được tên check lỗi"* sau §75. Đọc
lại toàn bộ `HistoryChat.tsx` nhiều lần không tìm ra bug logic nào —
quyết định KHÔNG đoán tiếp mà verify bằng cách thật sự CHẠY:

**Bước 1 — test riêng backend**: script Node thật (register → login →
mở WS `/sessions/new` → gửi 1 tin nhắn thật → `PATCH /sessions/:id` đổi
tên → `GET /sessions/mine` xác nhận) — PATCH trả `204`, tên đổi thành
công thật sự trong DB. Backend 100% đúng, không phải nguồn lỗi.

**Bước 2 — test thật UI bằng jsdom + React thật chạy đúng `main.js` đã
build** (kế thừa đúng kỹ thuật README's "Verified end-to-end" section
từng dùng): seed `localStorage` với token thật (bỏ qua form login, dùng
đúng cơ chế auto-reconnect có sẵn ở `App.tsx` dòng ~641), load
`index.html` thật vào `JSDOM`, polyfill những API jsdom không có mà app
cần thật (`fetch`/`WebSocket` — dùng thẳng global Node 22 có sẵn,
`matchMedia`/`ResizeObserver` — jsdom không implement, stub tối thiểu),
chạy `main.js` thật, rồi dispatch các sự kiện DOM THẬT (click nút "...",
click "Đổi tên", set giá trị input đúng kỹ thuật React-controlled-input
(qua native value setter, không set `.value` suông), dispatch keydown
Enter thật) — không phải gọi hàm nội bộ, đúng như 1 user thật tương tác.

**Phát hiện giả (đã tự sửa trước khi báo)**: lần chạy đầu bắt được lỗi
uncaught DOMException thật `"The node to be removed is not a child of
this node"` ngay lúc app chuyển từ auth screen sang app frame — trông rất
giống bug thật, ErrorBoundary phải rebuild lại cả cây React. Điều tra
tiếp bằng cách monkey-patch `Node.prototype.removeChild`/`insertBefore`
để log ngay trước khi throw — lộ ra **đây là bug trong chính test script,
không phải trong app thật**: `index.html` (được load vào `JSDOM` với
`runScripts:"dangerously"` + `resources:"usable"`) vẫn còn nguyên thẻ
`<script src="/main.js">` — jsdom TỰ ĐỘNG fetch+chạy file đó (dev server
:5173 serve thật), CỘNG THÊM script tự `window.eval(mainJs)` một lần nữa
thủ công → `main.js` chạy 2 LẦN ĐỘC LẬP, 2 React root tranh nhau cùng 1
`#root` → chính xác loại lỗi "node not a child" quan sát được. Sửa: strip
thẻ `<script src="/main.js">` khỏi HTML trước khi đưa vào `JSDOM`, chỉ
chạy `main.js` đúng 1 lần qua `window.eval`. Re-run: 0 lỗi, app connect
sạch.

**Kết quả xác nhận sau khi sửa harness**: toàn bộ flow rename (mở popup
bên phải → click Đổi tên → input hiện ra, tự focus+select → gõ tên mới →
Enter → input biến mất, title cập nhật ngay trong DOM → verify độc lập
qua `GET /sessions/mine` thật xác nhận tên đã đổi ở server) chạy sạch,
không 1 lỗi console nào. Rename hoạt động đúng.

**Vẫn giữ lại 1 thay đổi thật đã làm trong lúc điều tra "bug giả" ở
trên**: gộp 2 `<Toaster>` riêng biệt (1 trong nhánh `!authenticated`, 1
trong nhánh app-frame của `AppInner`) thành 1 `<Toaster>` duy nhất đặt ở
`App()` (ngoài `AppInner`, không unmount/remount theo `authenticated`
nữa) — dù XÁC NHẬN đây KHÔNG phải nguyên nhân crash quan sát được (crash
đó là do test harness, không phải do Toaster), việc có 2 instance của 1
component vốn tự quản lý 1 portal DOM node riêng, mount/unmount đồng thời
ngay lúc chuyển màn hình, vẫn là kiến trúc yếu hơn thật sự cần thiết —
giữ lại vì tự nó đã tốt hơn (1 nguồn sự thật cho toast, không còn 2
instance tranh nhau), không phải vì "đã sửa xong bug report của user".

**Không tìm được nguyên nhân thật của "chưa đổi được tên"** sau khi đã
verify sâu nhất có thể trong session này (backend thật + React thật chạy
đúng bundle đã build, không phải đoán qua đọc code) — khả năng cao nhất
còn lại: tab trình duyệt của user vẫn đang chạy JS CŨ đã load từ trước
những lần sửa gần đây (dù `scripts/serve-web.mjs` đã set
`Cache-Control: no-store` từ trước — header đó chỉ ngăn cache cho request
MỚI, không ép JS ĐANG CHẠY trong tab tự nạp lại) — cần 1 lần reload thật
(không chỉ mở lại tab) để chắc chắn đang chạy bundle mới nhất. Đã báo lại
cho user y như vậy, kèm xin thêm chi tiết cụ thể (input có hiện ra
không? gõ được không? bấm Enter có phản ứng gì không?) nếu vẫn còn lỗi
sau khi reload thật.

**Verify thật**:
1. `pnpm run typecheck` sạch sau khi gộp `<Toaster>`.
2. Test tự động (backend script + jsdom/React script) — cả 2 chạy thật,
   không mock, xác nhận PASS, output đầy đủ được đọc lại (không đoán qua
   exit code).
3. Dọn sạch file test tạm (`.scratch-test-rename-ui.mjs`) khỏi repo root
   sau khi xong — không để lại file rác.

## 77. Root cause thật của "chưa đổi được tên": IME Enter, không phải logic (2026-09-10)

User báo tiếp: *"vẫn ko đổi tên thành công check log lỗi"* sau §76 (lúc đó
đã verify code đúng nhưng chưa tìm ra vì sao user vẫn gặp lỗi). Lần này
không đoán tiếp — đọc thẳng log THẬT của `services/gateway` process đang
chạy (file log ở scratchpad, ghi bằng chính `log()` function của gateway,
real-time).

**Bằng chứng quyết định**: log cho thấy `userId: 5` (tài khoản thật của
user) có hoạt động THẬT gần đây — 2 lần `ws_connect isNew:true` liên tiếp
(tạo chat mới), rồi `ws_connect isNew:false` (mở lại 1 chat cũ) — đúng
kiểu hành vi đang test. Nhưng **KHÔNG có bất kỳ dòng `rename_ok` hay lỗi
PATCH nào** quanh khoảng thời gian đó — trong khi MỌI tài khoản test của
CHÍNH tôi (§75/§76) đều để lại `rename_ok` rõ ràng ngay sau khi rename.
Kết luận: request PATCH **chưa từng rời khỏi trình duyệt** — bug nằm hoàn
toàn ở client, trước khi chạm tới network, KHÔNG phải lỗi server hay lỗi
logic đã verify ở §76.

**Giả thuyết dựa trên bằng chứng thật, không đoán mò**: input tiếng Việt
thường gõ qua bộ gõ IME (Unikey/VNI/...). Enter, với hầu hết IME, còn có
vai trò XÁC NHẬN 1 candidate đang gõ dở — trình duyệt vẫn bắn ra
`keydown` với `key === 'Enter'` NGAY CẢ khi IME đang composing, đây là
hành vi chuẩn của spec, không phải bug của trình duyệt. Handler cũ ở
`HistoryChat.tsx`'s inline rename input chỉ check `event.key === 'Enter'`
— KHÔNG check `event.nativeEvent.isComposing` — nên bắt nhầm cái Enter
"IME đang confirm candidate" này, gọi `commitRename` với `renameValue`
lúc đó CHƯA kịp cập nhật giá trị tiếng Việt thật (React's onChange giữa
lúc composition có thể chưa fire/chưa đồng bộ) → rơi vào nhánh "empty ->
huỷ, không lỗi, không gọi server" của `commitRename` — im lặng tuyệt đối,
khớp CHÍNH XÁC với "chưa đổi được tên" + "0 dòng log nào" quan sát được.
Test tự động ở §75/§76 KHÔNG bắt được gap này vì set giá trị input bằng
native value setter trong 1 bước (mô phỏng "gõ xong luôn"), chưa từng mô
phỏng chuỗi sự kiện IME thật (`compositionstart`/`compositionupdate`/
Enter-giữa-composition/`compositionend`).

**Fix**: `onKeyDown`'s nhánh Enter thêm `if (event.nativeEvent.isComposing)
return;` trước khi `preventDefault()`+`commitRename` — cách chuẩn, cross-
browser để phân biệt "Enter thật" với "Enter IME đang dùng để confirm
candidate". `isComposing` là property chuẩn của `KeyboardEvent` (không
phải hack riêng), React's `nativeEvent` expose thẳng ra.

**Verify thật — mô phỏng đúng chuỗi sự kiện IME thật** (không chỉ set
value 1 phát): `compositionstart` → `compositionupdate` (giá trị tạm
"Xin ch") → dispatch Enter với `isComposing: true` → xác nhận KHÔNG thoát
edit mode, KHÔNG gọi server (đúng hành vi mong muốn sau fix) →
`compositionend` (giá trị cuối "Xin chào <timestamp>") → dispatch Enter
THẬT (`isComposing: false`) → xác nhận thoát edit mode, title cập nhật
đúng trong DOM VÀ verify độc lập qua `GET /sessions/mine` thật xác nhận
tên tiếng Việt có dấu đã lưu đúng ở server. PASS — chuỗi Enter-giữa-
composition bị bỏ qua đúng như thiết kế, Enter thật commit đúng.
`pnpm run typecheck` sạch. Dọn file test tạm sau khi xong.

**Bài học ghi lại cho lần sau**: khi 1 automated test PASS nhưng user vẫn
báo lỗi, đừng dừng lại ở "test PASS nên chắc user đang dùng bản cũ" —
kiểm tra xem test ĐÃ THẬT SỰ mô phỏng đúng cách user tương tác chưa (ở
đây: gõ tiếng Việt qua IME thật khác hẳn "set value 1 phát" tôi đã test).
Log THẬT của server (không phải đọc code) mới là thứ dẫn thẳng tới root
cause lần này — "0 request nào tới server" loại trừ ngay lập tức toàn bộ
mọi giả thuyết về backend/network, thu hẹp phạm vi xuống đúng phần client
trước khi gọi API.

## 78. Root cause THẬT SỰ của "chưa đổi được tên": thiếu PATCH trong CORS allow-methods (2026-09-10)

User báo tiếp, lần này kèm bằng chứng trực tiếp: *"http://localhost:4000/
sessions/53779890-... có rõ ràng mà bị lỗi cors"* — user đã tự thấy lỗi
CORS thật trong console trình duyệt của họ (chính là "log lỗi" đã nhắc ở
§77 mà tôi không đọc được, nên đi vòng qua giả thuyết IME).

**Root cause thật**: `services/gateway/src/index.ts`'s CORS header
`access-control-allow-methods` liệt kê `'GET, POST, DELETE, OPTIONS'` —
**THIẾU `PATCH`**, dù route `PATCH /sessions/:id` (rename) đã tồn tại từ
Phase 12 item 2, rất lâu trước khi `DELETE` được thêm (§74). Gateway
(`:4000`) và `apps/web` (`:5173`) là 2 ORIGIN khác nhau thật (khác port)
→ trình duyệt BẮT BUỘC gửi preflight `OPTIONS` trước mọi PATCH thật →
preflight trả về allow-methods KHÔNG có PATCH → trình duyệt tự chặn
request PATCH thật, KHÔNG BAO GIỜ gửi nó đi — khớp chính xác 100% với
bằng chứng ở §77 ("0 dòng `rename_ok` nào trong log gateway dù có hoạt
động WS thật từ đúng tài khoản đó" — vì bị chặn ở TRÌNH DUYỆT, request
chưa từng chạm tới server để có gì mà log).

**Vì sao §75-§77 KHÔNG bắt được lỗi CORS này dù đã test rất kỹ**: `fetch()`
gọi trực tiếp từ Node.js (script test backend ở §75) và `window.fetch`
tôi TỰ GÁN vào jsdom ở §76/§77 (dùng thẳng `fetch` global của Node làm
"polyfill") **ĐỀU KHÔNG THỰC THI CORS** — CORS là cơ chế bảo mật của
TRÌNH DUYỆT, Node's fetch (kể cả khi chạy bên trong jsdom qua polyfill
thủ công) không hề biết/không hề enforce same-origin policy. Đây là
đúng 1 BLIND SPOT thật của toàn bộ phương pháp test đã dùng — mọi request
"thành công" trong các test trước đều bypass hoàn toàn lớp bảo vệ mà
TRÌNH DUYỆT THẬT áp dụng. Fix bug §77 (IME `isComposing`) vẫn là cải
tiến đúng, giữ nguyên (Enter giữa lúc IME composing thật sự không nên
submit) — nhưng KHÔNG phải nguyên nhân của report gốc.

**Fix**: thêm `PATCH` vào danh sách — `'GET, POST, PATCH, DELETE, OPTIONS'`.

**Verify thật — đúng cách trình duyệt thật kiểm tra, không lặp lại sai
lầm dùng fetch không-enforce-CORS**: `curl` thẳng 1 request `OPTIONS`
preflight thật với đúng header trình duyệt gửi (`Origin`,
`Access-Control-Request-Method: PATCH`, `Access-Control-Request-Headers`)
— xác nhận response header `access-control-allow-methods` giờ có PATCH.
Đây chính xác là điều kiện trình duyệt thật kiểm tra để quyết định có
cho phép request PATCH thật đi tiếp hay không — verify ĐÚNG lớp bị lỗi,
không lặp lại việc dùng 1 client không-enforce-CORS để "xác nhận" như 3
lần trước. `pnpm run typecheck` sạch. Restart lại `services/gateway`
process (không có watcher) để fix có hiệu lực — xác nhận log khởi động
sạch, cổng 4000 vẫn nghe.

**Bài học ghi lại, quan trọng hơn cả bug này**: mọi automated test HTTP
trong dự án này TỪ TRƯỚC ĐẾN GIỜ (kể cả `scripts/upstream-smoke-test.mjs`
cũ) đều chạy qua Node's `fetch`/`ws`, nghĩa là **CHƯA TỪNG có 1 bài test
nào của dự án này thật sự verify được hành vi CORS** — một lớp bug hoàn
toàn có thể tồn tại nhiều nơi khác mà không test nào bắt được. Ghi nhận
đây là 1 giới hạn thật của bộ test hiện có, không phải điều đã verify và
có thể tin tưởng.

## 79. Conversation.tsx "casual" redesign — ẩn turn divider, bỏ steer checkbox, gộp tool call/result thành pill thu gọn (2026-09-10)

User hỏi trước: *"cho tôi logic sao phần chat lại có chuyển hướng hay
show turn 1 cũng như có đoạn chat tiếng anh khi chat tiếng việt vậy"* —
giải thích: `chuyển hướng` = label của checkbox `steer` (map thẳng
`{type:'steer'}` vs `{type:'followup'}`, khái niệm thật của wire protocol
dsh); `turn 1` = divider `turn/start` push mỗi lượt, kể cả lượt đầu tiên
(không có gì để "chia" cả); đoạn tiếng Anh = raw tool name/JSON args/
result (không dịch được, là dữ liệu thật) VÀ/HOẶC chính câu trả lời/
reasoning của model (ngoài tầm kiểm soát của FE i18n). User follow-up:
*"hide hết và làm UI UX lại cho casual như các platform ai agent"* — hỏi
lại 1 câu duy nhất về phần code-tradeoff thật sự (ẩn tool activity hoàn
toàn hay thu gọn) qua AskUserQuestion, user chọn **thu gọn thành pill,
bấm để xem chi tiết** (giống claude.ai/ChatGPT).

**Đọc real type trước khi code, không đoán field** — grep thẳng
`.d.ts` đã cài thật của `@deepseek-ai/dsh-session`/`dsh-llm`: `tool/call`
event data có `callId: CallId` thật (field trước đó KHÔNG được cast/dùng
tới); `ToolResultBlock.toolCallId: CallId` khớp đúng field này — đây
chính là cơ chế real correlate 1 lời gọi tool với đúng kết quả của nó,
quan trọng khi nhiều tool chạy song song trong cùng 1 lượt.

**3 thay đổi thật**:
1. **`turn/start` không render gì nữa** — bỏ hẳn kind `'divider'` khỏi
   `LogEntry` union, case vẫn giữ EXPLICIT (không rơi vào `default`) kèm
   comment giải thích lý do có chủ đích, tránh ai đó vô tình thêm lại mà
   không biết đây là quyết định UX thật. `turn/end` (thông báo khi lượt
   kết thúc BẤT THƯỜNG — lỗi, huỷ, ...) giữ nguyên, KHÔNG bị ẩn — đây là
   tín hiệu thật có giá trị (khác divider vốn hiện ở MỌI lượt kể cả bình
   thường), user chỉ nhắc tới divider/turn-1.
2. **Bỏ checkbox `steer` khỏi composer** — `onSubmit` gửi thẳng
   `{type:'followup'}` luôn. `wire.ts`'s `ClientToServer` GIỮ NGUYÊN cả 2
   variant (`steer` vẫn là capability thật của dsh session) — chỉ ẩn UI
   điều khiển nó, không xoá khả năng thật ở tầng dưới.
3. **`tool/call`+`tool/result` gộp thành 1 `ToolPill` thu gọn** (kind mới
   `'tool'`, thay hẳn kind `'card'` cũ — 2 card monospace luôn-mở-rộng
   riêng biệt trước đây). `tool/call` push entry `id: tool-${callId}`,
   status `'running'`, label "Đang dùng {name}…". `tool/result` KHÔNG
   push entry mới — dùng `updateEntry()` (hàm mới, `setEntries(prev =>
   prev.map(...))`) tìm đúng entry qua `tool-${block.toolCallId}` và cập
   nhật `status`/`resultText` tại chỗ. Thu gọn mặc định (`expandedTools`:
   `Set<id>` state riêng ở Conversation, tách khỏi `entries` — đúng kiểu
   tách "server data" khỏi "local UI state" `liveBubbles` đã dùng), bấm
   header mới hiện `args` (pretty JSON, indent 2) + `resultText`. Trạng
   thái lỗi (`status:'error'`, khi `data.error`/`block.isError`) đổi label
   thành "Lỗi khi dùng {name}" + tint `--error` — tái dùng đúng token màu
   `.notice` đã dùng, không bịa token mới.

**Dọn dead code phát sinh**: `conversation.turnDivider`/`conversation.steer`/
`conversation.toolError` (cả `vi`/`en`) xoá hẳn — grep xác nhận không còn
nơi nào dùng trước khi xoá. CSS `.card`/`.card-error`/`.divider`/
`.steer-label` xoá hẳn (chỉ tồn tại vì `kind:'card'`/`'divider'` cũ, giờ
không còn JSX nào render nữa) — thay bằng `.tool-pill`/`.tool-pill-header`/
`.tool-pill-chevron`/`.tool-pill-error`/`.tool-pill-detail`/`.tool-pill-args`,
tái dùng ĐÚNG giá trị hình khối cũ của `.card` (12px radius, `--bg-raised`,
`--border-subtle`) — đây là restructure cho tương tác thu gọn/mở rộng,
không phải redesign hình ảnh từ đầu. `ToolIcon` (Wrench, lucide-react) —
icon chung cho mọi tool (search/bash/fs/...), giống cách platform thật
dùng 1 affordance chung "đã dùng tool", không phải icon riêng theo tên.

**Verify thật — jsdom + React thật chạy đúng `main.js`, gửi 1 tin nhắn
thật kích hoạt đúng tool thật đã cấu hình cho profile này**
(`packages/tool/duckduckgo-web-search`, cấu hình thật trong
`packages/profile-template/template/profile.package.json`):
1. `#steer-checkbox` — 0 kết quả trong DOM (đã bỏ hẳn). PASS.
2. `.divider` — 0 element trong DOM sau khi model trả lời (kể cả khi lượt
   kết thúc lỗi, vẫn không có divider nào). PASS.
3. `.tool-pill` xuất hiện thật, thu gọn mặc định (`.tool-pill-detail` là
   `null` trước khi bấm) — bấm vào mở ra đúng `args`+`result`. PASS.
4. Tool call THẬT bị lỗi (`WebError` — sandbox dev này không có network
   ra ngoài, không liên quan code UI) — xác nhận LUÔN TIỆN nhánh lỗi
   cũng chạy đúng: label đổi thành "Lỗi khi dùng web_search", tint lỗi áp
   dụng, VÀ `.notice` "lượt 1 kết thúc: error" (turn/end abnormal, được
   GIỮ có chủ đích) xuất hiện riêng — phân biệt rõ với `.divider` đã bị
   xoá, không nhầm lẫn 2 khái niệm khi verify.
5. `pnpm run typecheck` sạch, CSS brace/comment balance sạch (depth cuối
   = 0), grep sweep toàn bộ `apps/web/src`+`style.css`+README không còn
   tham chiếu chết ngoài 1 comment lịch sử cố ý. Dọn file test tạm khỏi
   repo root sau khi xong.

## 80. Follow-up: ẩn reasoning + bỏ bubble container cho AI reply (2026-09-10)

User follow-up ngay sau §79: *"check vẫn có dòng tiếng anh reasoning hide
đi và ui đoạn chat AI trả lời ko cần bọc container như 1 chat message
full đi"* — 2 việc, cùng 1 buổi làm với §79 nên áp dụng ĐÚNG design
language vừa thống nhất (collapse-by-default, không xoá hẳn), không hỏi
lại user lần nữa vì họ vừa mới chọn rõ hướng này cho tool-call.

**1. Reasoning thu gọn** (`ReasoningToggle`, cấu trúc y hệt `ToolPill`) —
label "Đang suy nghĩ…" khi còn đang stream (live bubble), "Đã suy nghĩ"
khi đã xong (finished entry) — bấm mới hiện nguyên văn. Dùng chung 1
`expandedDetails: Set<string>` với tool pill (đã đổi tên từ
`expandedTools`), namespace bằng prefix (`tool-...` vs `reasoning-...`),
không tạo thêm state riêng.

**Bug thật tự bắt được lúc viết test, sửa trước khi báo xong** — lúc đầu
dùng 2 khoá KHÁC NHAU cho reasoning: bubble đang live dùng
`reasoning-live-${stepKey}`, bubble đã xong (từ `assistant/message`) dùng
`reasoning-${evt-seq}` (khác hẳn, vì trước đó entry ID của bubble xong
luôn là `evt-${event.seq}`, không liên quan gì tới stepKey). Hệ quả: bấm
mở reasoning LÚC ĐANG STREAM, rồi model trả lời xong ngay sau đó → toggle
tự đóng lại, vì entry mới có 1 khoá expand-state HOÀN TOÀN KHÁC chưa từng
nằm trong `expandedDetails`. Test jsdom+React thật (gửi 1 câu chào đơn
giản, không cần tool) bắt được đúng hiện tượng này. Fix: đổi ID của bubble
`assistant/message` từ `evt-${event.seq}` sang CHÍNH `stepKey(turn, step)`
— khớp đúng key mà live bubble đã dùng — nên khoá `reasoning-${id}` giờ
ổn định xuyên suốt live→done, giống hệt cách `tool-${callId}` của
`ToolPill` chưa bao giờ đổi giữa running/done/error.

**2. AI reply không còn bọc `.bubble`** — chỉ `bubble-user` giữ nguyên
(bubble tròn, lệch phải, có màu nền — không đổi gì). Assistant dùng
`.assistant-text` mới: text phẳng, canh trái, không nền/viền/shadow, rộng
gần full cột — đúng convention thật của claude.ai/ChatGPT/Gemini/
chat.deepseek.com (tất cả đều làm y hệt: user = bubble, assistant = text
thường). `.bubble-assistant`/`.bubble-assistant.live`/`.bubble .reasoning`
xoá hẳn (chỉ còn `.bubble`/`.bubble-user` — vẫn dùng thật). Token CSS
`--bubble-assistant`/`--bubble-live` ở `:root` GIỮ NGUYÊN dù tạm thời
không còn rule nào dùng — đây là design token công khai (cùng nhóm với
`--accent`/`--status-danger`), khác loại với 1 CSS rule chết, không xoá
theo cùng logic đã áp dụng cho `.card`/`.divider` ở §79.

**Verify thật — jsdom + React thật, gửi 1 tin nhắn thật (câu chào đơn
giản, không cần tool, tránh phụ thuộc network THẬT của sandbox này)**:
1. AI reply KHÔNG có class `.bubble` (và không nằm trong bất kỳ ancestor
   `.bubble` nào) — PASS. User message VẪN dùng `.bubble-user` — PASS
   (xác nhận chỉ đổi 1 phía, không lỡ tay xoá cả 2).
2. Reasoning toggle: `.reasoning-toggle-body` là `null` trước khi bấm
   (thu gọn đúng mặc định); bấm vào hiện đúng nguyên văn reasoning thật
   (tiếng Anh, đúng loại nội dung user muốn ẩn) — PASS.
3. Lần chạy đầu bắt được đúng bug key-mismatch ở trên (label "Đang suy
   nghĩ…" lúc check nhưng bấm xong `detail visible after click: false` —
   tức đã tự đóng lại) — sửa xong, chạy lại xác nhận PASS thật với
   reasoning text thật hiện ra sau khi bấm.
4. `.divider` — vẫn 0 (không hồi quy từ §79).
5. `pnpm run typecheck` sạch, CSS brace/comment balance sạch. Grep sweep
   không còn tham chiếu `.bubble-assistant`/`'reasoning'` (class) chết.
   Dọn file test tạm khỏi repo root sau khi xong.

## 81. Follow-up: bỏ hẳn reasoning, bỏ /new+/rename, bỏ border input chat (2026-09-10)

User follow-up ngay sau §80: *"bỏ luôn phần reasoning luôn đi ko cần nữa,
bỏ cả /new và /rename này luôn và khi input focus ko cần outline cam
cũng như border input là ko cần thiết cho input chat"* — 3 việc, tất cả
đều là XOÁ HẲN (không phải thu gọn/ẩn thêm nữa).

**1. Reasoning xoá hẳn, không còn cả toggle**: §80 làm collapsed toggle
(`ReasoningToggle`) là 1 lựa chọn thiết kế thật có chủ đích lúc đó (giữ
minh bạch, giống tool pill) — user dùng thử rồi quyết định không cần
luôn, kể cả bản thu gọn. Xoá hoàn toàn, không phải giấu:
- `ReasoningToggle` component xoá hẳn.
- `LogEntry`'s bubble variant + `LiveBubble` bỏ field `reasoning`.
- `buildBubbleEntry` bỏ đoạn extract `ReasoningBlock` khỏi content.
- `assistant/chunk` handler: nhánh `else if (chunk.type ===
  'reasoning-delta')` xoá hẳn — chunk loại này giờ không được xử lý gì cả
  (rơi qua như mọi chunk type khác app không render), KHÔNG CÒN accumulate
  vào state nữa, không chỉ là "không render nó".
- `ThinkingIcon` (icons.tsx), `conversation.reasoningRunning`/
  `.reasoningDone` (translations.ts, cả vi/en) xoá hẳn — grep xác nhận 0
  nơi dùng trước khi xoá.
- CSS `.reasoning-toggle`/`-header`/`-header:hover`/`-chevron`/`.expanded
  .reasoning-toggle-chevron`/`-body` xoá hẳn.
- `id` của bubble assistant (`key = stepKey(turn,step)`, đổi từ
  `evt-${event.seq}` ở §80 để giữ ổn định expand-state cho reasoning
  toggle) — GIỮ NGUYÊN dù lý do gốc (reasoning toggle) đã mất, vì vẫn là 1
  id thật, duy nhất, hợp lệ — không có lý do đổi lại chỉ để đổi. Comment
  giải thích cập nhật lại cho đúng thực tế hiện tại (trỏ về §80 cho lịch
  sử, không còn mô tả như đang fix bug sống).

**2. `/new`+`/rename` command palette xoá hẳn**: cả 2 action đã có UI
thật riêng ở nơi khác từ lâu (Sidebar's "New chat" button; HistoryChat's
rename inline input, §75) — command palette giờ chỉ là 1 cách trùng lặp
để làm đúng 2 việc đã có UI thật. Xoá: `Command` interface, `COMMANDS`
array, `commandMatches`, `runCommand`, khối JSX `.fh-command-dropdown`.
`onSubmit` chỉ còn gửi `followup` thẳng, không check command nữa.
`conversation.placeholder` bỏ đoạn gợi ý "(thử /new hoặc /rename)" (cả
vi/en). `conversation.newSessionCmd`/`.renameSessionCmd`/
`common.renameSessionPrompt` (translations.ts) xoá hẳn — `common.
renameSessionPrompt` từng được note ở §75 là "chỉ còn /rename command
dùng" — giờ user con đó cũng xoá, nên xoá theo, không còn ai dùng thật.
CSS `.fh-command-dropdown`/`.fh-command-item`/`.active`/`-name`/`-desc`
xoá hẳn; `#send-form`'s `position: relative` (chỉ tồn tại để làm anchor
cho dropdown giờ đã mất) cũng xoá theo — không còn gì bên trong cần
positioning context nữa.

**3. `#text-input` bỏ border, mọi trạng thái kể cả focus**: base rule
dùng chung `input[type="text"], input[type="password"], input[type="email"]`
(+`:focus` đổi border-color sang `--accent`) VẪN GIỮ NGUYÊN cho MỌI input
khác trong app (login, search sidebar, ô rename inline của HistoryChat,
...) — chỉ riêng ô chat composer opt-out. `#text-input { border: none;
}` — 1 dòng, KHÔNG cần thêm rule `:focus` riêng: specificity ID
(1,0,0) đã thắng tuyệt đối `input[type="text"]:focus`'s (0,2,1) bất kể
trạng thái, nên 1 declaration duy nhất che cả 2 case (nghỉ + focus).

**Verify thật**:
1. jsdom+React thật: gõ "/" và "/new" vào composer — 0 `.fh-command-
   dropdown` xuất hiện cả 2 lần. PASS.
2. Gửi 1 tin nhắn thật (câu chào tiếng Việt đơn giản) — chờ reply xong,
   quét TOÀN BỘ document tìm `.reasoning-toggle` — 0 kết quả dù model
   chắc chắn có sinh ra reasoning thật (đã xác nhận có ở §80 với đúng
   câu hỏi tương tự) — xác nhận reasoning bị bỏ hoàn toàn, không phải
   tình cờ model không reason lần này.
3. `.assistant-text` vẫn không nằm trong `.bubble` — xác nhận không hồi
   quy phần đã làm ở §80.
4. **Giới hạn thật của jsdom phát hiện lúc verify border** — `getComputedStyle(el).borderStyle`/`.borderTopWidth`/`.border` đều trả
   về CHUỖI RỖNG, kể cả với 1 `<input>` trần chèn thẳng vào document
   không qua React/CSS phức tạp gì — xác nhận đây là giới hạn thật của
   jsdom's CSSOM (border-shorthand computed style resolution không đầy
   đủ), KHÔNG PHẢI dấu hiệu rule sai — các computed style property khác
   (`display`, `margin`) đọc đúng bình thường qua cùng jsdom instance,
   nên không phải toàn bộ `getComputedStyle` hỏng, chỉ riêng nhóm
   `border`. Verify thay bằng đọc trực tiếp CSS + tính specificity bằng
   tay (ID (1,0,0) > element+attribute+pseudo-class (0,2,1)) — cùng
   phương pháp đã dùng thành công để bắt bug specificity thật ở §75 (lúc
   đó verify được qua text của bundle đã build, ở đây verify qua chính
   text rule trong `style.css`, không đoán).
5. `pnpm run typecheck` sạch, CSS brace/comment balance sạch. Grep sweep
   `apps/web/src` xác nhận 0 tham chiếu sống `ReasoningToggle`/
   `reasoning-delta` (xử lý)/`COMMANDS`/`commandMatches`/`fh-command-*`/
   `common.renameSessionPrompt`/`conversation.newSessionCmd`/
   `.renameSessionCmd`/`.reasoningRunning`/`.reasoningDone` ngoài comment
   lịch sử cố ý. Dọn file test tạm khỏi repo root sau khi xong.

## 82. Màn loading lúc check token thật — và 1 bug thật của gateway lộ ra khi làm (2026-09-10)

User: *"lúc quay lại web khi đang check token nên có màn loading để tránh
hiện form login"* — reload (hoặc mở tab mới, vì token đã ở localStorage
từ trước) khi ĐANG có token lưu sẵn trước đó hiện flash form login trong
khoảnh khắc ngắn giữa lúc mount và lúc auto-reconnect WS thật sự mở xong,
dù > 99% trường hợp reconnect sẽ thành công.

**State mới `authCheckPending`**: khởi tạo `true` CHỈ KHI có token thật
trong `localStorage` lúc mount (`useState(() => !!localStorage.
getItem(STORAGE_TOKEN))`) — người chưa từng đăng nhập thấy form login
NGAY, không có màn loading giả nào cả. Tắt (`false`) ở đúng 3 nơi đạt kết
quả DỨT ĐIỂM cho lần reconnect đầu: WS `open` (thành công), `handleAuth
Expired()` (token chết), và nhánh `setStatus('disconnected')` cuối cùng
trong `close` handler của `connect()` (gateway không tới được/mạng đứt).
UI: `!authenticated && authCheckPending` → render spinner CSS thật (1
`@keyframes` đầu tiên của app — ngoại lệ thật cho nguyên tắc "không thêm
animation khi chưa được yêu cầu" đã áp dụng ở §80, vì lần này ĐÚNG là màn
loading được yêu cầu thật) thay vì `<ConnectForm>`.

**Bug thật của gateway lộ ra khi test (không phải do state mới gây ra,
chỉ là bị CHE TRƯỚC ĐÓ)**: viết test jsdom+React với 1 token BỊA HOÀN
TOÀN để xác nhận màn loading fallback đúng về login form — test bị TREO
15 giây không bao giờ thấy `#connect-form` xuất hiện lại. Điều tra riêng
bằng 1 script Node CHẠY THẲNG (không qua app) tạo `WebSocket` tới gateway
thật với token bịa — xác nhận: `error` event bắn ra gần như ngay lập tức
("Received network error or non-101 status code"), nhưng **`close` event
KHÔNG BAO GIỜ bắn ra** dù đợi thật 10 giây. Root cause:
`services/gateway/src/index.ts`'s `server.on('upgrade', ...)` từ chối
token xấu bằng `socket.write('HTTP/1.1 401...\r\n\r\n'); socket.destroy()`
— 1 cú đóng socket TCP thô, không phải WebSocket close handshake thật —
Node's `WebSocket` client (undici) không đối xử việc này như 1 `close`
đàng hoàng. Toàn bộ logic xử lý thất bại của `connect()` (probe 401, self-
heal session-gone, ...) TRƯỚC ĐÓ CHỈ gắn vào `close` (comment cũ ghi rõ
"close fires immediately after error" — giả định này SAI với đúng kiểu
reject này). Trước khi có `authCheckPending`, bug này bị CHE vì
`!authenticated` vốn đã luôn render form login mặc định — giờ với màn
loading mới, cùng bug đó biến thành spinner treo VĨNH VIỄN, rõ ràng hơn
hẳn, đúng lúc cần verify tính năng mới thì lộ ra.

**Fix root cause, không phải vá quanh triệu chứng**: tách logic xử lý
thất bại (probe → 401 thì `handleAuthExpired()`, session-gone thì retry 1
lần, cuối cùng `setStatus('disconnected')`) ra hàm riêng
`handleHandshakeFailure()`, gọi được từ 2 nơi: `close` handler (như cũ,
khi nó THẬT SỰ bắn ra) VÀ 1 timer chờ 300ms gắn vào `error` handler (nếu
`close` chưa tự bắn trong 300ms thì tự gọi thẳng). Cờ `handshakeSettled`
chặn double-run nếu cả 2 đường cùng chạm tới. 300ms đủ dư cho trường hợp
`close` bắn đúng chuẩn (thường dưới vài ms sau `error`), không đủ để
người dùng cảm nhận được độ trễ thật.

**Verify thật — 3 kịch bản qua jsdom+React thật, không mock WS**:
1. Token hợp lệ thật: spinner hiện ngay lúc mount, KHÔNG có form login;
   sau khi kết nối xong cả 2 đều biến mất, app frame thật hiện ra. PASS.
2. Không có token nào: form login hiện ngay, KHÔNG có spinner nào cả (dù
   chỉ thoáng qua). PASS.
3. Token bịa hoàn toàn: spinner hiện đúng lúc đầu — rồi tự rơi về đúng
   form login sau khi bug ở trên được fix (trước khi fix: treo mãi mãi,
   test timeout 15s). PASS.
`pnpm run typecheck` sạch, CSS brace/comment balance sạch. Dọn file test
tạm khỏi repo root sau khi xong.

**Bài học ghi lại**: gap thật này tồn tại từ Phase 7 (lúc route WS-
rejection này được viết) nhưng chưa từng lộ ra vì `!authenticated` luôn
render login form mặc định — chỉ lộ ra khi 1 tính năng MỚI (loading
screen) đặt cược vào đúng tín hiệu (`close` event) mà bug này làm hỏng.
Đúng kiểu bug "ẩn sau 1 hành vi che đậy tình cờ" — verify kỹ tính năng
mới đôi khi lộ ra bug cũ hoàn toàn không liên quan tới thay đổi vừa làm.

## 83. Sandbox bash/fs tool `SANDBOX_UNAVAILABLE` + crash thật khi escalation không có approval channel (2026-09-11)

Roadmap Phase 18 (`docs/agent-core-architecture-roadmap.md`). User hỏi bộ
core plugin hiện tại có chuẩn không, có nên xây thêm skill/loop/sandbox
plugin — điều tra thật lộ ra `dsh-sandbox`/`tool-bash`/`tool-fs`/`skill`/
`subagent`/`workflow` đã mount sẵn qua `dsh-base`, không cần xây gì mới,
chỉ 2 bug thật khiến năng lực có sẵn chưa chạy được.

**Bug 1 — thiếu `bubblewrap` + thiếu `CAP_SYS_ADMIN`**: test thật (đăng
ký user, mở WS, yêu cầu model chạy `echo` qua bash) trả về lỗi
`SANDBOX_UNAVAILABLE`: "no sandbox backend is usable on this host".
`infra/docker/worker/Dockerfile` (base `node:22-slim`) không cài
`bubblewrap`. Cài xong (`apt-get install ... bubblewrap`) VẪN còn lỗi —
điều tra tiếp bằng `docker exec "$CID" bwrap ...` chạy ĐÚNG lệnh probe
thật của `dsh-sandbox-local` (đọc thẳng source compiled ở
`node_modules/@deepseek-ai/dsh-sandbox-local/lib/index.js`,
`bwrapProfileArgs()`/`defaultProbeBwrap()`):
```
bwrap --ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent -- true
```
→ `bwrap: Creating new namespace failed: Operation not permitted`. Một
test tay RỘNG HƠN (`--unshare-all`, không có `--unshare-pid`/`--proc
/proc`) lại THÀNH CÔNG — dễ gây hiểu lầm "bwrap đã hoạt động", nhưng
lệnh probe thật khác lệnh test tay ở đúng 2 flag đó. Nguyên nhân: tạo PID
namespace (cần để remount `/proc` bên trong `bwrap`) đòi `CAP_SYS_ADMIN`,
Docker container không có theo default (`services/orchestrator/src/
docker.ts`'s `HostConfig` trước đó không có `CapAdd`/`SecurityOpt`/
`Privileged` nào). Fix: thêm `CapAdd: ['SYS_ADMIN']` vào `HostConfig`.
Đánh đổi ghi rõ tại chỗ trong code: capability cấp cho tiến trình `dsh`
(trusted), không phải lệnh bash của model — `bwrap` tự drop quyền cho
tiến trình con nó wrap, lớp cô lập multi-tenant (1 container/session)
không đổi.

**Bug 2 — crash thật khi escalation `danger-full-access` không có
approval channel**: `packages/agent-driver/src/agent.ts`, trong
`runStep()`'s tool-call loop, dòng build `tool/result` payload:
```ts
...(result.isError ? { error: result.error.info } : {}),
```
Khi sandbox backend không dùng được, model tự escalate lên
`danger-full-access` (đúng theo hướng dẫn `dsh-tool-bash` đưa ra) —
`dsh-sandbox`'s `approveEscalation()` throw 1 `Error` THƯỜNG (không phải
`HarnessError`) cho outcome `"unavailable"` (app này không wire approval
channel nào, có chủ đích — hệ thống multi-tenant không có
human-in-the-loop). `dsh-tools`'s `errorInfo(error)` chỉ trả `{name,
code}` khi `error instanceof HarnessError`, còn lại trả `undefined` —
nên `result.error.info` là `undefined`, dòng trên đưa `error: undefined`
thẳng vào event → `dsh-session`'s `Session.append()` (`isJsonValue`
check) từ chối `undefined` tường minh như non-JSON-serializable → **sập
cả turn** (`turn/end` với `reason.kind: "error"`). Đây là 1 biến thể
KHÁC của đúng class bug đã ghi nhận trước đó ở chính file này (chỗ khác
trong cùng đoạn code, xem comment cũ ngay phía trên dòng bug): guard
`result.isError` không đủ — `result.error.info` chính nó có thể
`undefined` NGAY CẢ KHI `result.isError` `true`. Fix:
```ts
...(result.isError && result.error.info !== undefined ? { error: result.error.info } : {}),
```

**Verify thật — và 1 bẫy thật gặp lúc verify Phase 1, đáng ghi lại cho
lần debug sau**: sau khi build lại image + restart `services/
orchestrator`, test lặp lại VẪN thấy `SANDBOX_UNAVAILABLE` dù
`docker exec bwrap ...` trực tiếp trên container "mới nhất" (theo
`docker ps`) lại probe THÀNH CÔNG — mâu thuẫn y hệt 1 lần trước đó trong
cùng investigation này. Root cause: `services/orchestrator/src/
warmpool.ts` lưu warm pool trong **Redis** (`fh:warmpool`), không phải
in-memory — restart orchestrator process không xoá pool cũ. Request thật
`popWarmPool()` trúng 1 entry pool CŨ (spawn từ ~18 giờ trước, image cũ,
chưa có `CapAdd`) — trong khi `claimWarmPoolMember()`'s replenish
(fire-and-forget, chạy ngay sau khi pop) spawn 1 container MỚI đúng fix,
khiến "container mới nhất nhìn thấy qua `docker ps`" KHÔNG PHẢI container
thật sự phục vụ request. Xác nhận đúng container bằng `containerId` ghi
trong log JSON của orchestrator (event `hibernate_idle` gắn `sessionId`),
không đoán qua "mới nhất". Sau khi `DEL fh:warmpool` + xoá container pool
cũ, request tiếp theo cold-spawn (pool rỗng) từ image/`docker.ts` hiện
tại — `tool/result` trả `isError:false`, `content` là stdout thật
(`"SANDBOX_FIXED_98765\n"`), không còn `SANDBOX_UNAVAILABLE`, không cần
escalation; bug 2 xác nhận hết crash qua kịch bản escalation-unavailable
riêng (`turn/end` `reason.kind:"completed"`, model nhận lỗi sạch thay vì
sập turn). `pnpm run typecheck` sạch trước khi build image mỗi lần.

**Gap dọn dẹp có thật, ngoài phạm vi phase này**: `warmpool.ts` không bao
giờ xoá `data/dsh-home/_pool/<uuid>` của pool member cũ bị thay thế —
quan sát được 76 thư mục mồ côi tích luỹ từ nhiều ngày test trước đó. Chưa
sửa — ghi lại làm gap thật ở `docs/core-overview.md` mục 5.
