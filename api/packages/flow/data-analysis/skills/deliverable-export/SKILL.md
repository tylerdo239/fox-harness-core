---
name: deliverable-export
description: "Xuất kết quả thành tệp để tải về hoặc gửi đi: Excel nhiều sheet, CSV/Parquet, Word, ảnh biểu đồ, báo cáo Markdown."
---

# deliverable-export — biến kết quả thành tệp bàn giao được

Người dùng tải dữ liệu lên rồi thường muốn nhận lại **một tệp**, không phải
một đoạn văn. Skill này lo chặng cuối đó.

## Công cụ có sẵn trong sandbox

`openpyxl` (Excel), `pandas` (`to_excel`/`to_csv`/`to_parquet`),
`matplotlib`/`seaborn` (ảnh biểu đồ), `pyarrow`, `python-docx` (Word `.docx`:
tiêu đề, đoạn văn, bảng, chèn ảnh biểu đồ). PDF: `pypdf` chỉ để **đọc**; xuất
`.pdf` được với một hình matplotlib (`savefig("x.pdf")`), nhưng **không có**
thư viện dựng PDF văn bản — người dùng cần báo cáo dạng văn bản thì xuất
`.docx` và nói thẳng là PDF văn bản chưa hỗ trợ.

## Kỷ luật

1. **Ghi vào workspace**, đặt tên tệp nói được nội dung và mốc thời gian
   (`doanh-thu-theo-thang-2026-09.xlsx`), không phải `output.xlsx`.
2. **Đưa tệp lên canvas** bằng `canvas_write` với `kind:"file"` và `path` là
   tệp vừa ghi, để người dùng xem ngay trong panel bên phải (có nút tải về),
   và nêu đường dẫn tệp trong câu trả lời. Dùng `id` riêng cho mỗi định dạng
   của cùng nội dung (vd. `bao-cao-xlsx`, `bao-cao-csv`).
3. **Excel nhiều sheet có trật tự**: sheet đầu là tóm tắt đọc được ngay,
   các sheet sau là dữ liệu chi tiết. Đặt tiêu đề cột rõ ràng, định dạng số
   đúng kiểu (tiền tệ, phần trăm, ngày), cố định hàng tiêu đề.
4. **Số trong tệp phải khớp số trong câu trả lời.** Sinh tệp từ chính
   DataFrame đã dùng để kết luận, đừng gõ lại bằng tay.
5. **Không nói đã xuất xong trước khi ghi xong.** Kiểm tra tệp tồn tại và có
   kích thước hợp lý rồi mới báo.

## Trước khi xuất

Hỏi (hoặc suy ra) ba điều: người dùng sẽ **mở bằng gì**, cần **mức chi tiết
nào**, và có cần **dữ liệu thô kèm theo** hay chỉ cần bảng đã tổng hợp.
