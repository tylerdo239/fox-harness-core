# docs-site — hướng dẫn sử dụng (`/docs/`)

Starlight (Astro), build ra trang tĩnh; image web (`app/Dockerfile`) chép vào `/usr/share/nginx/html/docs/`, nginx phục vụ
công khai (không cần đăng nhập). Trang dành cho người dùng thường (role user): không mô tả màn chỉ admin thấy —
hướng dẫn quản trị nằm ở `docs/admin-guide.md`. App mở nó từ menu tài khoản → **Hướng dẫn sử dụng**.

| Việc        | Lệnh                                                          |
| ----------- | ------------------------------------------------------------- |
| Viết, xem   | `pnpm install && pnpm dev` → http://localhost:4321/docs/      |
| Build       | `pnpm build` → `dist/` (kèm chỉ mục tìm kiếm Pagefind)        |

Hai ngôn ngữ: tiếng Việt ở `/docs/` (`src/content/docs/<nhóm>/<trang>.md`), tiếng Anh ở `/docs/en/`
(`src/content/docs/en/<nhóm>/<trang>.md`, cùng đường dẫn trang). App mở bản theo ngôn ngữ đang dùng. Màu cam theo theme
app: `src/styles/theme.css`.

Nội dung: `src/content/docs/<nhóm>/<trang>.md` — nhóm = mục ở thanh bên (`astro.config.mjs`), thứ tự trong nhóm bằng
`sidebar.order` ở đầu trang. Nhãn nút / thông báo trích đúng chữ trong `app/src/i18n/translations.ts`; đổi UI thì sửa
trang tương ứng.

## Ảnh chụp màn hình

`src/assets/screens/*.png` (tiếng Việt) và `src/assets/screens/en/*.png` (tiếng Anh, `DOCS_LOCALE=en`), chụp tự động bằng `scripts/screenshots.mjs` (Playwright) từ một Fox Harness đang chạy, bằng
một tài khoản demo **role user** cho mỗi ngôn ngữ, không có dữ liệu thật (email người khác bị che). Xem đầu file script để biết cách chạy; chụp lại
một phần: `pnpm screenshots skills dataStudio`. Phần Data Studio cần Dremio có dữ liệu và câu hỏi ra được biểu đồ
(`DOCS_DS_QUESTION`).
