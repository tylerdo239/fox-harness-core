---
name: report-writing
description: "Viết văn bản dài có bố cục cho người ra quyết định — báo cáo, tóm tắt, đề xuất: kết luận trước, nêu rõ giả định."
---

# report-writing — viết cho người phải ra quyết định

## Trước khi viết, chốt ba điều

1. **Người đọc là ai** và họ sẽ **quyết định gì** sau khi đọc.
2. **Câu hỏi trung tâm** — một câu. Không chốt được câu này thì bố cục sẽ
   lan man.
3. **Bằng chứng đang có** và bằng chứng đang thiếu.

## Bố cục mặc định

- **Kết luận trước.** Đoạn đầu trả lời thẳng câu hỏi trung tâm. Người đọc
  bận chỉ đọc đoạn này.
- **Cơ sở.** Mỗi luận điểm một mục, mỗi mục nêu bằng chứng của nó.
- **Giả định và giới hạn.** Viết ra, không giấu. Chỗ nào là suy luận thì gọi
  đúng tên là suy luận.
- **Việc tiếp theo.** Ai làm gì, hoặc cần thêm dữ liệu gì để chắc chắn hơn.

## Kỷ luật

- Không có số nào xuất hiện mà không nói được nó từ đâu ra.
- Không viết dài để trông đầy đủ. Mỗi đoạn phải trả lời một câu hỏi thật của
  người đọc; đoạn nào không trả lời gì thì bỏ.
- Dùng bảng khi so sánh nhiều chiều, dùng văn xuôi khi lập luận. Đừng dùng
  bảng để né việc lập luận.
- Viết bằng ngôn ngữ của người dùng.
- Nếu tài liệu cần dữ kiện hiện tại, dùng skill `web-research` để lấy bằng
  chứng trước, đừng viết từ trí nhớ rồi trang trí bằng con số.
- Báo cáo dài (quá ~600 từ) **không** viết trong một lần trả lời hay một lần gọi
  `canvas_write`: một lần sinh quá dài có thể làm tràn context. Dựng nó trong
  `python` vài mục mỗi lần (`report = "..."`, rồi `report += "..."`), lưu bằng
  `save_artifact("<ten>.md", report)` và hiển thị bằng `canvas_write` với `path`.
