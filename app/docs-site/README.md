# docs-site — hướng dẫn sử dụng (`/docs/`)

Starlight (Astro), build ra trang tĩnh; image web (`app/Dockerfile`) chép vào `/usr/share/nginx/html/docs/`, nginx phục vụ
công khai (không cần đăng nhập). App mở nó từ menu tài khoản → **Hướng dẫn sử dụng**.

| Việc        | Lệnh                                                          |
| ----------- | ------------------------------------------------------------- |
| Viết, xem   | `pnpm install && pnpm dev` → http://localhost:4321/docs/      |
| Build       | `pnpm build` → `dist/` (kèm chỉ mục tìm kiếm Pagefind)        |

Nội dung: `src/content/docs/<nhóm>/<trang>.md` — nhóm = mục ở thanh bên (`astro.config.mjs`), thứ tự trong nhóm bằng
`sidebar.order` ở đầu trang. Nhãn nút / thông báo trích đúng chữ trong `app/src/i18n/translations.ts`; đổi UI thì sửa
trang tương ứng.

## Ảnh chụp màn hình

`src/assets/screens/*.png`, chụp tự động bằng `scripts/screenshots.mjs` (Playwright) từ một Fox Harness đang chạy, bằng
một tài khoản demo admin không có dữ liệu thật (email người khác bị che). Xem đầu file script để biết cách chạy; chụp lại
một phần: `pnpm screenshots skills dataStudio`. Phần Data Studio cần Dremio có dữ liệu và câu hỏi ra được biểu đồ
(`DOCS_DS_QUESTION`).
