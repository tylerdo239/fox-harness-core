# Đính kèm file trong chat (2026-10-08)

Tham khảo `examples/core` (composer.tsx, conversation.tsx, bundle-core/gateway.ts). Cách của nó: file được tải lên
**ngay khi chọn/thả**, vào thư mục làm việc của phiên; lúc gửi chỉ thêm một dòng đánh dấu `[Attached: …]` vào cuối tin
nhắn; model đọc file bằng công cụ của nó (fs/bash/python), không có vision. UI đọc dòng đánh dấu để vẽ thẻ file.

## Hiện trạng của ta

| Phần                 | Hiện có                                                                                   |
| -------------------- | ----------------------------------------------------------------------------------------- |
| Tải lên              | `POST /sessions/:id/files?name=` (stream, 70 MB, 10 lần/phút), chỉ chat phân tích dữ liệu |
| Chat thường          | Có thư mục làm việc trên đĩa, nhưng API file trả 404 (`flows.default.workspace=false`)     |
| Composer             | Chỉ chữ; nút "Tải file lên" nằm trong WorkspacePanel; không kéo-thả, không dán             |
| Tin nhắn gửi đi      | `{type:'followup', text}` — chỉ chữ                                                        |
| Model biết file      | Phân tích dữ liệu: `list_datasets()`; chat thường: chỉ biết `{{cwd}}`                     |

## Thiết kế

| Việc                 | Cách                                                                                                            |
| -------------------- | --------------------------------------------------------------------------------------------------------------- |
| Chế độ có đính kèm   | Chat thường và phân tích dữ liệu (cả chat dự án). **Không** cho Data Studio (chỉ có `analyze_data`, không đọc file) |
| Chat thường          | Bật `flows.default.workspace` → API file chạy cho chat thường; model đọc bằng `read`/`grep`/`bash` sẵn có        |
| Khi nào tải          | Ngay khi chọn / kéo-thả / dán (XHR để có tiến trình), vào đúng API hiện có; tối đa 5 file mỗi tin, 70 MB mỗi file |
| Trùng tên            | `?unique=1`: trùng tên thì lưu thành `ten (2).csv` — không ghi đè file tin nhắn trước đã nhắc tới; gateway trả tên thật |
| Tin nhắn             | Chữ người dùng + dòng cuối `[Attached files in the working directory: ["a.csv","b.png"]]` (JSON → tên có dấu phẩy, ngoặc vẫn đúng; một dạng duy nhất, không theo ngôn ngữ) |
| Composer             | Nút kẹp giấy; thẻ chờ gửi: ảnh thu nhỏ / biểu tượng, tên, dung lượng, thanh tiến trình, nút bỏ, lỗi + thử lại; kéo-thả cả khung; dán file từ clipboard; chưa tải xong thì chưa gửi được |
| Bỏ thẻ               | Huỷ việc tải, hoặc xoá file đã tải (`DELETE …/files/<path>`) — file chưa gửi không ở lại trong "Tệp" (sửa 2026-10-09: bản đầu để file lại, người dùng thấy như lỗi "xoá rồi vẫn hiện") |
| Bong bóng đã gửi     | Đọc dòng đánh dấu → thẻ file phía trên chữ (ảnh: thu nhỏ, bấm xem; file khác: bấm tải); mở lại chat vẫn vậy vì dựng từ chữ đã lưu |
| Ảnh                  | Không gửi ảnh cho model (adapter openai-compat chỉ gửi chữ); model xử lý bằng công cụ. Vision là việc riêng       |

## Kiểm thử

- e2e `chatAttachments`: chat thường tải file lên (201, có trong danh sách), trùng tên → tên mới, tin nhắn có dòng đánh
  dấu → model (mock) `cat` được file trong thư mục làm việc; Data Studio vẫn 404; người khác vẫn 404.
- Bấm thử trên trình duyệt: chọn, kéo-thả, dán, bỏ, lỗi quá cỡ, gửi, mở lại chat.

## Kết quả (2026-10-08)

| Phần          | File                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------ |
| Gateway       | `config.ts` (`flows.default.workspace=true`), `runtime/workspace-files.ts` (`?unique=1`, ghi `sources.json` lần lượt + nguyên khối), `index.ts` |
| Runtime       | `agent-core/src/transport/flows.ts`: ẩn `read_image` (adapter chỉ gửi chữ — model thử rồi lỗi)        |
| App           | `conversation/attachments.ts` (tải lên, dòng đánh dấu), `Attachments.tsx` (thẻ), `Conversation.tsx`, `WorkspacePanel.tsx` (chỉ còn danh sách Tệp) |
| Docs          | `/docs/chat/chatting/#đính-kèm-file` (vi, en) có ảnh chụp                                               |

Phát hiện khi làm: hai lần tải lên cùng lúc ghi đè `.fox/sources.json` lẫn nhau → JSON hỏng → mọi lần liệt kê file trả
500. Lỗi có từ trước (WorkspacePanel tải tuần tự nên chưa lộ); đã sửa, e2e tải 3 file song song.

Kiểm thử: e2e `chatAttachments` (9 kiểm tra) và `flowsDiffer` (không còn `read_image`), toàn bộ e2e pass; bấm thử trên
trình duyệt (chọn, kéo-thả, file quá cỡ, bỏ, gửi, tải lại trang, Data Studio không có nút); model thật đọc CSV và lấy
kích thước ảnh bằng bash.
