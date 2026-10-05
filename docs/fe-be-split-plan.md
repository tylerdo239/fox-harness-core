# Plan: tách repo thành `app/` (FE) và `api/` (BE)

Mục tiêu:
- Hai folder độc lập: `app/` và `api/`. Mỗi folder có `Dockerfile` riêng và **build từ chính folder đó**
  (`docker build ./app`, `docker build ./api`), deploy riêng từng phần.
- Dev local vẫn dùng **một `docker-compose.yml` ở gốc repo**.
- Không đổi logic: chỉ di chuyển file và sửa đường dẫn. Kiểm chứng bằng toàn bộ e2e và LLM thật trước/sau.

## 1. Hiện trạng (đã đọc source)

```
apps/web/                 FE: React SPA, bundle bằng esbuild (scripts/build-web.mjs) → apps/web/public/main.js
services/gateway/         BE: gateway + supervisor của runtime dsh
packages/                 BE: agent-driver, core, transport, contracts, llm/, tool/ (gồm python data-studio),
                          flow/, profile-template/, skills/
infra/docker/api/     Dockerfile BE + fox-confine.sh (sandbox)
infra/docker/web/         Dockerfile FE + nginx.conf.template
infra/deploy/             docker-compose.yml (web + backend + profile local-deps) + .env + README
infra/docker/docker-compose.dev.yml   Mongo, Meilisearch, Dremio, MariaDB, Redis, MinIO cho dev chạy trực tiếp trên máy
infra/migrations/         001_init.sql (MariaDB)
scripts/                  build-web, serve-web (FE); create-admin, mock-llm, e2e-*, spike-*, bench, smoke (BE và e2e)
package.json, pnpm-workspace.yaml, pnpm-lock.yaml, tsconfig*.json   MỘT workspace pnpm chung cho cả FE lẫn BE
```

Những điểm quyết định cách tách:

| Phát hiện | Hệ quả |
|---|---|
| FE **không import gì từ BE**. Kiểu dữ liệu được chép lại trong FE (`wire.ts`, `skillsApi.ts`, `workspaceApi.ts`), có comment ghi rõ là cố ý | FE tách thành project độc lập hoàn toàn, không cần package dùng chung |
| `packages/contracts` chỉ được gateway và transport dùng | Để trong `api/` |
| Cả hai Dockerfile hiện build từ **gốc repo** (`COPY . .`), nên image FE kéo theo toàn bộ BE vào build context và ngược lại | Sau khi tách, mỗi Dockerfile chỉ thấy folder của mình |
| Backend tìm file theo `repoRoot` = gốc repo: `infra/docker/api/fox-confine.sh`, `node_modules/@deepseek-ai/dsh`, `packages/...`; Python bridge dùng `../../../packages/tool/data-studio-agent/python`; profile dsh dùng `FOX_REPO_ROOT ?? '/repo'` | Phải sửa danh sách đường dẫn ở mục 4; `repoRoot` sẽ trỏ về `api/` |
| Dữ liệu local nằm trong volume theo tên project compose: `fox-harness_*` (stack 8080) và `docker_fox-harness-*` (Mongo, Dremio, Meilisearch, MinIO của compose dev) | Compose mới phải **giữ đúng tên volume**, nếu không sẽ mất catalog Mongo, cấu hình Dremio và DB local |
| `dummy-mysql` (nguồn dữ liệu của Dremio) là container chạy tay, nối tay vào network `docker_default` | Đưa vào compose (mục 3.3) hoặc ghi rõ cách nối |
| Rác đang được track: `test-final.mjs` ở gốc, file debug `packages/tool/data-studio-agent/python/debug/pipeline_v3/…workflow_.md`, bundle build `apps/web/public/main.js` | Dọn ở bước 0 |

## 2. Cấu trúc đích

```
fox-harness-core/
├── docker-compose.yml          dev local: web + backend + toàn bộ hạ tầng (mục 3.3)
├── .env.example                biến cho compose (cổng, profile); secret của BE nằm ở api/.env
├── README.md                   tổng quan + cách chạy dev và deploy
├── docs/
├── scripts/                    chỉ các script chạy trên CẢ HAI phần: e2e-up.sh, e2e-down.sh, e2e-backend.mjs, mock-llm.mjs
│
├── app/                   (= apps/web)
│   ├── Dockerfile              build từ app/: esbuild → nginx
│   ├── nginx.conf.template
│   ├── .dockerignore
│   ├── package.json            React + esbuild + typescript, script build / dev
│   ├── pnpm-lock.yaml          lockfile riêng
│   ├── tsconfig.json           tự chứa (không extends file ở ngoài folder)
│   ├── scripts/build.mjs       (= scripts/build-web.mjs)
│   ├── scripts/serve.mjs       (= scripts/serve-web.mjs, dev server :5173)
│   ├── public/                 index.html, *.css (main.js là output build, không track)
│   └── src/
│
└── api/
    ├── Dockerfile              build từ api/
    ├── .dockerignore
    ├── .env.example            (= .env.example + infra/deploy/.env.example, gộp lại)
    ├── .nvmrc
    ├── package.json            (= package.json gốc, bỏ phần FE)
    ├── pnpm-workspace.yaml     services/*, packages/*, packages/*/*; giữ nodeLinker: hoisted
    ├── pnpm-lock.yaml
    ├── tsconfig.json, tsconfig.base.json
    ├── docker/fox-confine.sh   (= infra/docker/api/fox-confine.sh)
    ├── migrations/             (= infra/migrations)
    ├── services/gateway/
    ├── packages/               agent-driver, core, transport, contracts, llm, tool, flow, profile-template, skills
    └── scripts/                create-admin, smoke-data-studio-mongo, spike-*, upstream-smoke-test, bench/
```

`infra/` bị bỏ hẳn: Dockerfile và file đi kèm về folder của từng phần, compose về gốc, migrations về `api/`.

### Bảng chuyển file (dùng `git mv` để giữ lịch sử)

| Cũ | Mới |
|---|---|
| `apps/web/**` | `app/**` |
| `scripts/build-web.mjs`, `scripts/serve-web.mjs` | `app/scripts/build.mjs`, `app/scripts/serve.mjs` |
| `infra/docker/web/Dockerfile`, `nginx.conf.template` | `app/Dockerfile`, `app/nginx.conf.template` |
| `services/`, `packages/` | `api/services/`, `api/packages/` |
| `infra/docker/api/Dockerfile` | `api/Dockerfile` |
| `infra/docker/api/fox-confine.sh` | `api/docker/fox-confine.sh` |
| `infra/migrations/` | `api/migrations/` |
| `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `tsconfig*.json`, `.nvmrc`, `.env.example` | `api/…` |
| `scripts/create-admin.mjs`, `smoke-data-studio-mongo.mjs`, `spike-*.mjs`, `upstream-smoke-test.mjs`, `bench/` | `api/scripts/…` |
| `scripts/e2e-*.{sh,mjs}`, `scripts/mock-llm.mjs` | giữ ở `scripts/` gốc |
| `infra/deploy/docker-compose.yml` + `infra/docker/docker-compose.dev.yml` | gộp thành `docker-compose.yml` ở gốc |
| `infra/deploy/README.md`, `infra/docker/README.md` | gộp vào `docs/deploy.md` |

## 3. Chi tiết từng phần

### 3.1 Frontend

- **`package.json` riêng:** dependency React hiện có, thêm `esbuild` (đang nằm ở gốc) và `typescript`. Hai script:
  - `build`: chạy `node scripts/build.mjs`;
  - `dev`: chạy `node scripts/serve.mjs`, dev server cổng 5173, gọi backend ở `localhost:4000` như hiện tại (`App.tsx:99`).
- **`tsconfig.json` tự chứa:** chép các option cần từ `tsconfig.base.json`, không `extends` ra ngoài folder.
- **`Dockerfile`**, build context là `app/`:
  ```dockerfile
  FROM node:22-slim AS build
  RUN corepack enable && corepack prepare pnpm@11.7.0 --activate
  WORKDIR /app
  COPY package.json pnpm-lock.yaml ./
  RUN pnpm install --frozen-lockfile
  COPY . .
  RUN pnpm run build
  FROM nginx:1.27-alpine
  COPY nginx.conf.template /etc/nginx/templates/default.conf.template
  COPY --from=build /app/public /usr/share/nginx/html
  ENV BACKEND_URL=http://backend:4000
  EXPOSE 80
  ```
  Copy `package.json` và lockfile trước `COPY . .`, để lớp `pnpm install` được cache khi chỉ sửa code.
- **Không đổi:** nginx vẫn chuyển `/auth`, `/sessions` (cả WebSocket), `/users`, `/data-studio`… sang `BACKEND_URL`.
  Image FE vẫn không chứa secret nào.

### 3.2 Backend

- **Workspace pnpm** chuyển nguyên vào `api/`: giữ `nodeLinker: hoisted` (cần cho cách loader plugin của dsh
  import package) và `allowBuilds`. Bỏ `apps/*` khỏi workspace và bỏ importer `apps/web` khỏi lockfile. Phiên bản các
  package giữ nguyên, kể cả dsh `0.1.1-rc.2`.
- **Script `build`:** chỉ còn `tsc -b tsconfig.json` (không build web nữa).
- **`Dockerfile`**, build context là `api/`:
  - giữ `WORKDIR /repo` để không phải đổi các đường dẫn tuyệt đối đang có (`FOX_REPO_ROOT`, e2e);
  - sửa đường dẫn `fox-confine.sh` và python;
  - sắp lại thứ tự để **cache lớp `uv sync`**: copy `pyproject.toml`/`uv.lock` và chạy `uv sync` trước `COPY . .`.
    Hiện mỗi lần sửa code phải tải lại toàn bộ gói Python; có lần mất 15 phút.
- **Không đổi:** `cap_add: SYS_ADMIN, NET_ADMIN`, volume `/data`, healthcheck `/readyz`, `NODE_ENV=production`.

### 3.3 `docker-compose.yml` ở gốc (dev local)

Gộp hai file compose hiện có. Mục tiêu là `docker compose up -d` dựng được đúng stack 8080 hôm nay.

```yaml
name: fox-harness                    # giữ tên project → dùng lại volume fox-harness_* đang có
services:
  web:      { build: ./app, ports: ["${WEB_PORT:-8080}:80"], environment: { BACKEND_URL: http://backend:4000 } }
  backend:  { build: ./api, env_file: ./api/.env, cap_add: [SYS_ADMIN, NET_ADMIN], volumes: [backend-data:/data] }
  mariadb, redis, minio, mongo       # như profile local-deps hiện tại; mariadb nạp ./api/migrations/001_init.sql
  meilisearch, dremio                # thêm vào (hiện nằm ở compose dev); profile data-studio
  dummy-mysql (tuỳ chọn)             # nguồn dữ liệu mẫu cho Dremio; profile data-studio
volumes:
  mongo-data:       { external: true, name: docker_fox-harness-mongo-data }        # catalog Data Studio đang có
  dremio-data:      { external: true, name: docker_fox-harness-dremio-data }
  meilisearch-data: { external: true, name: docker_fox-harness-meilisearch-data }
  ...
```

Hai cách dùng:
- **Chạy toàn bộ trong Docker:** `docker compose up -d`, mở `http://127.0.0.1:8080`.
- **Dev chạy code trực tiếp** (sửa code thấy ngay):
  `docker compose up -d mariadb redis minio mongo meilisearch dremio`, sau đó chạy
  `cd backend && pnpm dev` và `cd frontend && pnpm dev`. Các dịch vụ hạ tầng mở cổng ra `127.0.0.1` như compose dev hiện tại.

Hiện có hai Mongo (`fox-harness-mongo-1` rỗng và `docker-mongo-1` chứa catalog thật). Compose mới chỉ giữ **một** Mongo,
dùng volume `docker_fox-harness-mongo-data` (có dữ liệu thật).

### 3.4 Môi trường (`.env`)

- `api/.env` = `.env` gốc hiện tại (dev chạy trực tiếp) gộp với `infra/deploy/.env` (Docker).
- Các URL khác nhau giữa hai cách chạy (`127.0.0.1` khi chạy trực tiếp, tên service khi chạy trong compose) được đặt
  đè trong `environment:` của compose, để chỉ cần **một** file `.env`.
- Frontend không cần `.env`.
- File `.env` có secret thật: mình chỉ **chuyển chỗ**, không in nội dung, không commit (giữ trong `.gitignore`).

## 4. Đường dẫn phải sửa trong code

| File | Hiện tại | Sau khi tách |
|---|---|---|
| `services/gateway/src/config.ts` | `repoRoot = ../../../` (gốc repo); `confineRunner = infra/docker/api/fox-confine.sh` | `repoRoot` tự thành `api/` (cùng độ sâu); `confineRunner = docker/fox-confine.sh` |
| `services/gateway/src/config.ts` | `dshBin = <repoRoot>/node_modules/@deepseek-ai/dsh/...` | Không đổi (`node_modules` nằm trong `api/`) |
| `services/gateway/src/data-studio-bridge.ts` | `../../../packages/tool/data-studio-agent/python` | Không đổi (đường dẫn tương đối vẫn đúng) |
| `runtime/materialize.ts`, `runtime/supervisor.ts` | `<repoRoot>/packages/...` | Không đổi |
| `packages/profile-template/runtime/template/cordis.patch.yml` | `FOX_REPO_ROOT ?? '/repo'` | Không đổi (giữ `WORKDIR /repo` trong image) |
| `api/Dockerfile` | `packages/tool/data-studio-agent/python`, `services/gateway/lib/index.js` | Không đổi (tương đối với context mới) |
| `app/scripts/build.mjs`, `serve.mjs` | `apps/web/src/main.tsx`, `apps/web/public` | `src/main.tsx`, `public` |
| `scripts/e2e-up.sh` | build từ `infra/docker/*`, mount `infra/migrations/001_init.sql` | `docker build ./app` / `./api`, mount `api/migrations/001_init.sql` |
| `scripts/e2e-backend.mjs` | đường dẫn `/repo/...` trong container | Không đổi |
| `api/scripts/smoke-data-studio-mongo.mjs` | `../services/gateway/src/...` | Không đổi (cùng độ sâu) |
| `.dockerignore` | một file ở gốc | Mỗi folder một file; `api/.dockerignore` vẫn loại `.env`, `.venv`, `node_modules`, `lib` |
| 25 file tài liệu | `apps/web`, `infra/...`, `services/...` | Cập nhật đường dẫn trong README và các tài liệu còn dùng; tài liệu lịch sử giữ nguyên, thêm một dòng ghi chú ở đầu |

Phần lớn đường dẫn trong backend **là tương đối và giữ nguyên độ sâu**, vì cả `services/` lẫn `packages/` cùng chuyển
vào `api/`. Nhờ vậy số chỗ phải sửa code thật ít.

## 5. Các bước thực hiện

Mỗi bước là một commit riêng, chạy kiểm chứng xong mới sang bước sau.

0. **Dọn dẹp:**
   - xoá `test-final.mjs` và file debug của pipeline python; thêm `debug/` vào `.gitignore`;
   - bỏ track `apps/web/public/main.js` (output build; Dockerfile tự build).
1. **Đo mốc trước khi tách:** chạy 19 e2e; ghi lại kích thước hai image; ghi kết quả LLM thật trên 8080
   (3 flow + Data Studio 77).
2. **Tách frontend:**
   - `git mv` sang `app/`; tạo `package.json`, lockfile, tsconfig, script build/serve, Dockerfile, `.dockerignore`;
   - kiểm: `docker build ./app` thành công; `main.js` build ra **giống hệt** bản cũ (so hash);
     `pnpm dev` ở cổng 5173 mở được.
3. **Tách backend:**
   - `git mv` services, packages, migrations, script BE, file workspace sang `api/`; sửa `confineRunner`;
     Dockerfile mới có cache `uv`;
   - kiểm: `tsc -b` qua; `docker build ./api` thành công; gateway boot với self-test sandbox qua;
     `dsh --dump-config` không đổi so với mốc ở bước 1 (vẫn tắt telemetry/DeepSeek).
4. **Compose gốc:** viết `docker-compose.yml`; xoá `infra/`; chuyển `.env`.
   - kiểm: `docker compose up -d` dựng lại stack 8080 **dùng đúng volume cũ** (đăng nhập được bằng tài khoản cũ,
     Data Studio vẫn ra 77 mà không phải sync lại).
5. **Script e2e và tài liệu:** sửa `scripts/e2e-*`, README, `docs/deploy.md`, `docs/core-readiness-review`.
   - kiểm: 19/19 e2e pass; grep toàn repo không còn `apps/web`, `infra/docker`, `infra/deploy`, `infra/migrations`
     ngoài tài liệu lịch sử.
6. **So sánh sau khi tách:**
   - image FE nhỏ hơn hoặc bằng, image BE bằng (build context nhỏ hơn);
   - LLM thật trên 8080 cho kết quả như bước 1;
   - dev chạy trực tiếp (`backend: pnpm dev`, `frontend: pnpm dev`) chạy được.

## 6. Rủi ro và cách xử lý

| Rủi ro | Xử lý |
|---|---|
| Mất dữ liệu local vì đổi tên project/volume compose | `name: fox-harness` + khai báo volume `external` theo đúng tên cũ (mục 3.3). Trước bước 4: backup DB (`mariadb-dump`) và Mongo (`mongodump`) |
| Lockfile tách ra làm đổi phiên bản package | Backend dùng lại lockfile cũ (chỉ bỏ importer `apps/web`); `--frozen-lockfile` trong Docker sẽ báo lỗi nếu lệch. Frontend tạo lockfile mới **cố định đúng phiên bản** đang có trong lockfile cũ |
| Loader plugin của dsh không tìm thấy package sau khi chuyển | Giữ `nodeLinker: hoisted`; kiểm bằng boot thật + `--dump-config` + e2e `flowsDiffer` |
| Sót đường dẫn cũ | Bảng ở mục 4 + grep sau bước 5 + e2e chạy trên image build từ context mới |
| Lịch sử git khó theo dõi | Dùng `git mv`; mỗi bước một commit; `git log --follow` vẫn chạy |
| Các nhánh khác đang sửa file ở đường dẫn cũ sẽ bị conflict khi merge | Làm sau khi đã push và merge các nhánh đang mở (`feat/role-based-authz` → `dev`); báo cho nhóm trước khi merge |

## 7. Quyết định đã chốt

1. Tên folder: `app/` (FE) và `api/` (BE).
2. Chỉ giữ `docker-compose.yml` ở gốc, **chỉ dùng cho dev local**. Deploy thật theo `docs/deploy.md`.
3. Đưa MySQL mẫu (`dummy-mysql`) vào compose, có alias mạng `dummy-mysql` để cấu hình nguồn của Dremio vẫn chạy.
4. Gộp hết hạ tầng: mỗi loại chỉ một instance (MariaDB, Redis, MinIO, MongoDB, Meilisearch, Dremio, MySQL).
5. Làm ngay trên nhánh `feat/split-app-api` (tách từ `feat/role-based-authz`), không chờ merge.

## 8. Kết quả (2026-10-05)

- **FE (`app/`):** lockfile riêng giữ đúng 251 package cũ (không phiên bản mới). Bundle có cùng 830 module cùng
  phiên bản; chỉ còn **một** bản `immer` 11.1.18 thay vì hai bản trùng do layout hoisted cũ. Image 53,9 MB.
- **BE (`api/`):** lockfile chỉ bớt 217 package của FE, không thêm phiên bản mới. Image 2,45 GB (trước 2,55 GB).
  Lớp `uv sync` và `pnpm fetch` được cache, sửa code không phải tải lại gói Python/Node.
- **Dữ liệu:** MariaDB, MinIO, Redis, backend-data dùng lại volume `fox-harness_*`. MongoDB, Meilisearch, Dremio,
  MySQL được **chép** sang volume mới của project (`mongodb-data`, `meilisearch-data`, `dremio-data`,
  `mysql-data`); số file khớp. Volume cũ không bị xoá. Backup ở `data/_backup/2026-10-05-before-split/`.
- **Lỗi tìm ra và đã sửa trong lúc làm:**
  - Hai runtime cùng chuẩn bị profile dsh một lúc thì race (`ENOENT … profiles/node_modules/react-dom`), xảy ra
    khi tập package đổi giữa hai lần deploy, kể cả khi rollback. Giờ runtime đầu tiên lên trước, các runtime sau
    mới chạy. Đã A/B: image chưa sửa lỗi, image đã sửa chạy được.
  - MySQL 8.4 không còn nạp `mysql_native_password`, Dremio không kết nối được. Compose bật lại
    (`--mysql-native-password=ON`), giống container cũ.
  - Script e2e ở gốc cần `ws`, trước lấy từ `node_modules` chung: giờ `scripts/` có `package.json` riêng.
  - Gateway dev không nạp `api/.env` khi chạy qua `pnpm --filter`: thêm `pnpm dev` ở `api/`.
- **Kiểm chứng:** e2e 19/19 pass trên hai image build từ folder riêng; LLM thật trên 8080 (data-analysis
  python, web search, Data Studio = 77 khớp Dremio) với tài khoản và dữ liệu cũ; chế độ dev chạy trực tiếp
  (`api: pnpm dev` ở :4000, `app: pnpm dev` ở :5173) đăng nhập được.
