# Hiệu năng và nền tảng UI (2026-10-30, giai đoạn 1–4 xong)

Mục tiêu: web (`app/`) tải nhanh và chạy mượt hơn, code dễ sửa hơn, trên một tech stack chuẩn — **giữ nguyên layout
và style**. Mọi bước trong plan này phải ra giao diện y hệt trước đó (0 pixel khác), kiểm bằng `app/scripts/ui-parity.mjs`
(§3). Thiết kế lại giao diện là việc riêng, không nằm trong plan này.

## 1. Hiện trạng trước khi làm (đo 2026-10-30)

| Vấn đề | Số đo |
| --- | --- |
| Build bằng esbuild tự viết (`scripts/build.mjs`), **không minify**, **React bản development** | `main.js` 2,87 MB + chunk chung 2 MB (có React dev) |
| nginx **không gzip** | mỗi lần mở trang tải đủ 2,87 MB |
| Tên file cố định → mọi thứ `no-cache` | kể cả `chunks/` đã có hash |
| `react-syntax-highlighter` import từ gốc gói → esbuild kéo theo ~800 file ngôn ngữ | `public/chunks/` 9,5 MB (trình duyệt không tải, nhưng build nặng) |
| recharts, sql-formatter nằm trong bundle chính | ~610 KB, chỉ vài màn hình cần |
| Dev server tự viết (`scripts/serve.mjs`), không có HMR | sửa code phải build lại cả bundle |
| File quá lớn | `Conversation.tsx` 1.900 dòng, `App.tsx` 1.260 dòng, `style.css` 150 KB |
| Không có router, không có lớp quản lý dữ liệu server | `App.tsx` tự đọc URL; mỗi màn tự `fetch` + `refresh()` / `bumpSessionsVersion` |

Đo trên Chrome headless, mạng giả lập 20 Mbit/s, độ trễ 20 ms, tới khi form đăng nhập hiện:
lần đầu **2.284 ms, 5.069 KB**.

## 2. Tech stack đích (cập nhật sau giai đoạn 4)

| Phần | Đang dùng | Ghi chú |
| --- | --- | --- |
| Build / dev server | **Vite 7** | §4 |
| Framework | **React 19** (SPA) | §7. Không Next.js / SSR: app phải đăng nhập, không cần SEO, chạy sau nginx + WebSocket |
| Router | Tự viết, tách ra `src/routing.ts` + unit test | Không dùng TanStack Router — lý do ở §5 |
| Dữ liệu từ server | **TanStack Query** cho danh sách chat và dự án; WebSocket chat tự quản (`runtime.ts`) | §5 |
| State client | zustand (canvas) | Giữ |
| Style | `theme.css` / `style.css` + 2 bản Tailwind 3 có phạm vi, như cũ | Đổi sang Tailwind v4 + shadcn: §8, chưa làm |
| Test | **Vitest** (`pnpm test`), `scripts/ui-parity.mjs`, `scripts/ui-flows.mjs` (Playwright, Chrome có sẵn) | §3 |
| Lint | **Biome** (`pnpm lint`) | Formatter tắt (không đổi định dạng toàn repo) |
| Ngân sách kích thước | `scripts/bundle-size.mjs`, chạy cuối `pnpm run build` | §7 |

## 3. Quy tắc "giữ nguyên giao diện" và cách kiểm

- Không đổi DOM (thẻ, class, id, thứ tự) và không đổi CSS. Đổi nội bộ (build, lazy load, tách file, data layer,
  phiên bản React) thì được.
- Code tải lười phải giữ chỗ đúng kích thước (placeholder cùng khung) và được tải trước khi trình duyệt rảnh.
- Mỗi bước xong phải qua 3 lớp kiểm:
  1. `pnpm check` — typecheck, Biome, Vitest.
  2. `scripts/ui-parity.mjs` — chụp cùng các trang trên **bản gốc** (build trước giai đoạn 1) và bản mới, cùng
     backend, cùng tài khoản; so từng pixel và so `#root` DOM (thuộc tính được sắp xếp, id của `useId` được chuẩn
     hoá — hai thứ không ảnh hưởng hiển thị mà React 18 và 19 viết khác nhau). **Phải ra `identical`.**
  3. `scripts/ui-flows.mjs` — 10 luồng điều hướng: deep link qua màn đăng nhập, reload ở mọi trang, đường dẫn
     sai về `/`, mở chat (push URL + socket đúng chat), Back/Forward, reload trong chat, trang mở từ chat quay lại
     chat, khu dữ liệu và Back, Chat mới, đăng xuất.

Cách chạy (bản gốc là build của commit trước giai đoạn 1, phục vụ bằng một nginx tạm cùng network với backend):

```sh
# 1. build bản gốc ra thư mục tạm (git worktree của commit cũ, pnpm install && pnpm run bundle) rồi:
docker run -d --name fh-old-web --network fox-harness_default -e BACKEND_URL=http://backend:4000 \
  -v <public cũ>:/usr/share/nginx/html:ro -v <nginx.conf.template cũ>:/etc/nginx/templates/default.conf.template:ro \
  -p 127.0.0.1:18081:80 nginx:1.27-alpine
# 2. bản mới: docker compose up -d --build --no-deps web  (cổng 8080)
# 3. so và chạy luồng:
cd app
OLD_URL=http://localhost:18081 NEW_URL=http://localhost:8080 PARITY_EMAIL=<tk> PARITY_PASSWORD=<mk> node scripts/ui-parity.mjs
APP_URL=http://localhost:8080 PARITY_EMAIL=<tk> PARITY_PASSWORD=<mk> node scripts/ui-flows.mjs
```

Trang được chụp, desktop 1440×900 và mobile 390×844: đăng nhập, trang chủ, `/data`, `/data-studio`, `/my-skills`,
`/admin/usage`, một cuộc chat (markdown, bảng, code) và modal xác nhận xoá. Tài khoản test cần là admin (trang
Usage) và có ít nhất một cuộc chat thường. Ảnh và DOM của trang khác nhau nằm ở `app/.parity/`. Một lần chụp chat
dài trên mobile từng lệch 1px rồi không lặp lại khi chạy lại — chạy lại trước khi kết luận.

## 4. Giai đoạn 1 — build và phân phối (xong 2026-10-30)

| Việc | Cách |
| --- | --- |
| Vite thay esbuild tự viết | `app/vite.config.ts`; `index.html` chuyển ra `app/`, nạp `/src/main.tsx`; build ra `app/dist/`. Xoá `scripts/build.mjs`, `scripts/serve.mjs` |
| Minify, React production, tên file có hash | mặc định của Vite (`dist/assets/<tên>-<hash>.js`) |
| CSS giữ nguyên | 5 file trong `public/` (`theme`, `sonner`, `style`, `ref`, `tw`) link theo đúng thứ tự cũ, chép nguyên. `ref.css` / `tw.css` vẫn là 2 bản Tailwind riêng, do plugin `fh-static-css` trong `vite.config.ts` tạo (dev: tự tạo lại khi sửa file) |
| Dev server | `pnpm dev` = Vite (HMR); proxy API + WebSocket tới `BACKEND_URL`, danh sách đường dẫn đọc từ `nginx.conf.template` như trước |
| Tải lười, giữ chỗ | biểu đồ: `ChartView.tsx` → `chartSpec.ts` (kiểu + hàm phụ) + `ChartPlot.tsx` (recharts, tải lười, placeholder cùng khung); sql-formatter (`useSqlFormatter`, `src/lazyLoad.ts`); trang Usage và Data Profile (`lazy` trong `App.tsx`) |
| Tải trước khi rảnh | sau đăng nhập, `preloadWhenIdle` tải biểu đồ, sql-formatter, Data Profile (và Usage nếu là admin) |
| nginx | `gzip` cho text; `/assets/` cache 1 năm `immutable` (thiếu file → 404, không trả trang SPA); `index.html` và CSS `no-cache` (304 khi không đổi) |
| Docker | `COPY --from=build /app/dist` |

Kết quả (cùng cách đo ở §1):

| | Trước | Sau |
| --- | --- | --- |
| Mở lần đầu (tới form đăng nhập) | 2.284 ms, 5.069 KB | **216 ms, 287 KB** |
| Tải lại | 113 ms, 7 KB | 78 ms, 4 KB |
| JS trang đầu | 2,87 MB + 2 MB, không nén | **779 KB, gzip 233 KB** |
| Kiểm giao diện (`ui-parity.mjs`) | | **15/15 trang giống hệt (0 pixel, DOM trùng)** |

Chưa làm trong giai đoạn này (cố ý): highlight.js (~380 KB trước minify) vẫn ở bundle chính — tải lười thì code trong
cuộc chat mở lại sẽ hiện chưa tô màu một lúc, tức là đổi giao diện (xem §5.1).

## 5. Giai đoạn 2 — nền tảng code (xong 2026-10-30)

| Việc | Kết quả |
| --- | --- |
| Vitest + Biome | `pnpm test` (38 test), `pnpm lint`, `pnpm check` (cả ba + typecheck). Biome: các rule mà sửa sẽ đổi hành vi (`useExhaustiveDependencies` — nhiều effect cố ý thiếu deps, có comment) hoặc đổi DOM (a11y) để `off` / `warn`; 4 lỗi thật đã sửa (shadow `escape` / `valueOf`, `forEach` trả giá trị, `return` trong hàm void) |
| Test hành vi | `scripts/ui-flows.mjs` (§3), chạy qua trên bản gốc trước khi refactor |
| TanStack Query | `src/queries.ts`: `useMySessions()` (`GET /sessions/mine`), `useProjects()` (`GET /projects`) dùng chung cho lịch sử chat, dự án ở sidebar, trang dự án và thanh dự án trên chat. `runtime.bumpSessionsVersion()` giữ nguyên tên, giờ là invalidate; đăng xuất / hết hạn token xoá cache |
| Số request | Mở app: `/sessions/mine` 5 → 1, `/projects` 2 → 1. Đổi chat: 3 → 1 và 1 → 1 |
| Tách file | `routing.ts` (+ test), `auth.ts`, `layout.ts` (+ test) ra khỏi `App.tsx` (1.261 → 1.090 dòng); `logEntries.ts` (dữ liệu log, không JSX) và `LogParts.tsx` (các view) ra khỏi `Conversation.tsx` (1.901 → 1.149 dòng). Code chuyển nguyên văn (đã so: cùng 1.595 dòng) |

Quyết định không làm:

- **TanStack Router.** URL ở app này một phần do kết nối chat quyết định: `/` chỉ thành `/chat/<id>` lúc gửi tin đầu
  (`replaceState`), Back/Forward phải đóng socket cũ và nối lại chat theo URL, đường dẫn sai được sửa về `/`. Đặt
  một router vào giữa là thêm một nguồn sự thật phải đồng bộ hai chiều, trong khi lợi ích chính (mỗi trang một
  chunk) đã có bằng `lazy`. Thay vào đó routing thành hàm thuần có test (`routing.test.ts`) và các luồng có
  `ui-flows.mjs` canh.
- **Cắt bớt ngôn ngữ highlight.js.** `rehype-highlight` tự đoán ngôn ngữ cho khối code không ghi ngôn ngữ, trong
  37 ngôn ngữ của bộ `common`; bớt ngôn ngữ thì khối code đó có thể tô màu khác. Tải lười thì chat mở lại hiện
  code chưa tô màu một lúc. Cả hai đổi giao diện.

## 6. Giai đoạn 3 — hiệu năng khi chạy (xong 2026-10-30)

| Việc | Kết quả |
| --- | --- |
| `LogEntryView` memo; props ổn định (`isExpanded`, `onToggleExpanded`, `onFollowUp`, danh sách đã lọc qua `useMemo`); giá trị `useLocale()` memo theo ngôn ngữ | Khi stream, các tin đã xong không render lại |
| Đo stream (chat ~20–40 tin, mỗi bản 3 lần xen kẽ, CPU JS chia theo độ dài trả lời) | Không khác biệt đo được: ~345–412 ms / 1.000 ký tự ở cả hai bản |
| Đo mở một chat dài (~40 tin, trung vị 5 lần) | 250 → 227 ms tới khi hiện; JS 91 → 78 ms |

Chi phí khi stream nằm ở chính tin đang chạy: `StreamedMarkdown` hiện dần chữ mỗi frame và `Markdown` parse lại cả
tin + tô màu code mỗi lần (Markdown.tsx giải thích). Giảm được thì phải parse theo khối (khối xong giữ nguyên, chỉ
parse khối cuối) — nhưng parse từng khối riêng có thể ra khác parse cả tin (danh sách / bảng / tham chiếu tách đôi),
tức là đổi giao diện; để lại, cần quyết định riêng.

Không làm: **virtualization** (react-virtuoso). Chat hiện tại vài chục tin; render chỉ phần đang thấy thì Ctrl+F
của trình duyệt không tìm thấy tin cũ. Xem lại khi có chat hàng trăm tin.

## 7. Giai đoạn 4 — nâng cấp (xong 2026-10-30)

| Việc | Kết quả |
| --- | --- |
| **React 19** (+ `@types/react` 19) | Typecheck không cần sửa gì; tất cả thư viện có peer React 19. DOM khác React 18 chỉ ở thứ tự thuộc tính và dạng id `useId` (§3) |
| **React Compiler** | **Đã thử và bỏ**: biên dịch 140 hàm, bỏ qua 60 (component có tắt rule hooks, `try/finally`); không đo được nhanh hơn (mở chat dài 236/79 ms bật so với 233/77 ms tắt), mà bundle đầu nặng thêm 17 KB gzip |
| Bớt bundle đầu | `remarkGfmParse.ts`: nửa *parse* của remark-gfm (cùng 2 gói nó dùng), bỏ serializer markdown không bao giờ dùng (−5 KB gzip); `remarkGfmParse.test.ts` so HTML ra với remark-gfm thật trên 7 mẫu |
| Đo lại cuối giai đoạn 4 (cách đo §1) | Mở lần đầu **237 ms, 314 KB** (gốc 2.297 ms, 5.069 KB); tải lại 77 ms, 4 KB |
| Ngân sách | `scripts/bundle-size.mjs` cuối `pnpm run build`: JS trang đầu ≤ **260 KB gzip** (hiện 255,6). 233 KB sau giai đoạn 1; +~11 KB React 19, +~12 KB TanStack Query |

## 8. Giai đoạn 5 — style sang hệ thống chung (chưa làm, đề xuất gộp với thiết kế lại)

Không làm lúc này: không nhanh hơn chút nào, chuyển dở dang thì có hai hệ style song song (khó hơn bây giờ), và nếu
sắp thiết kế lại giao diện thì chuyển 150 KB CSS sang Tailwind *giống từng pixel* rồi thiết kế lại là làm hai lần.
Khi làm (cùng đợt thiết kế lại, hoặc riêng nếu không thiết kế lại):

1. Token trong `theme.css` → theme của Tailwind v4 (cùng tên biến CSS, cùng giá trị).
2. Từng nhóm component từ class trong `style.css` sang Tailwind / shadcn; nếu giữ giao diện thì `ui-parity.mjs`
   phải ra 0 pixel (DOM class sẽ khác — so pixel); xong nhóm nào xoá CSS cũ của nhóm đó.
3. Hai bản Tailwind 3 (`ref.css`, `tw.css`) gộp vào một khi các component đó đã chuyển.
4. Khi `style.css` hết, bỏ plugin `fh-static-css`; CSS do Vite build và có hash.

## 9. Rủi ro và quay lại

| Rủi ro | Cách giữ |
| --- | --- |
| Tab cũ còn mở sau khi deploy xin chunk của build trước | `/assets/` của build mới không còn file cũ → 404 → trang báo lỗi tải; tải lại là xong. Về sau: bắt lỗi import động và tự reload |
| Tải lười gây chớp / nhảy layout | placeholder cùng khung + tải trước khi rảnh; `ui-parity.mjs` bắt được nếu khác |
| Proxy dev khác nginx | cả hai đọc chung `nginx.conf.template` |
| Quay lại giai đoạn 1 | `git revert` commit Vite: `build.mjs` / `serve.mjs` / `public/index.html` trở lại, Dockerfile chép `public/` như trước |
