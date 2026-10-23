# Hướng dẫn quản trị Fox Harness (2026-10-08)

Dành cho tài khoản role **admin**. Không nằm trong trang hướng dẫn `/docs` của app: trang đó dành cho người dùng
thường (role user), những người không thấy các màn dưới đây.

## Quản lý người dùng

Mở menu tài khoản → **Cài đặt** → tab **Người dùng**.

### Vai trò

| Vai trò                     | Được làm                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------ |
| **Người dùng (user)**       | Chat, dự án, skill, hỏi dữ liệu trên các bảng/cột được cho phép, dashboard riêng            |
| **Quản trị viên (admin)**   | Mọi thứ của user, thêm: quản lý người dùng, cấu hình nguồn dữ liệu, xem mọi bảng đã bật     |

### Tạo người dùng

Điền **Email**, **Mật khẩu** (ít nhất 8 ký tự), chọn **Vai trò** → **Tạo**. Gửi email và mật khẩu cho người đó qua kênh an
toàn; họ đăng nhập ngay được.

### Đổi vai trò, đặt lại mật khẩu

Trong **Danh sách người dùng**:

- Đổi **vai trò** bằng ô chọn trên dòng của người đó.
- **Đặt lại mật khẩu:** nhập mật khẩu mới (ít nhất 8 ký tự) → **Lưu**.

Cả hai việc đều **đăng xuất người đó khỏi mọi thiết bị**. Bạn không thể tự gỡ vai trò admin của chính mình.

Hiện chưa có chức năng xoá hay khoá tài khoản.

## Thống kê sử dụng agent

Menu tài khoản (góc dưới sidebar) → **Thống kê sử dụng**, hoặc mở `/admin/usage`. Chỉ admin xem được; người dùng
thường bị đưa về trang chủ và API trả 403.

- **Chọn khoảng thời gian:** 7 / 30 / 90 ngày, tháng này, tháng trước, hoặc tự chọn từ – đến (tối đa 366 ngày); gộp theo
  ngày, tuần (bắt đầu thứ Hai) hoặc tháng. Ngày tính theo giờ Việt Nam (+07:00). Mỗi số có mũi tên so với kỳ trước cùng độ dài.
- **Thẻ số liệu:** người dùng hoạt động, cuộc chat, lượt chat, token (vào · ra · cache), thời gian phản hồi trung bình và
  trung vị, tỉ lệ thành công, số lần gọi công cụ (và lỗi), file đính kèm.
- **Biểu đồ:** token, lượt chat, người dùng, thời gian phản hồi theo thời gian; lượt chat theo giờ và theo thứ.
- **Kết quả lượt chat**, **theo chế độ** (Chat / Phân tích dữ liệu / Data Studio), **theo model**, **công cụ dùng nhiều
  nhất** (tô đỏ khi lỗi từ 5%).
- **Data Studio:** số câu hỏi, token của pipeline, token embedding, token dựng hồ sơ dữ liệu (tác vụ của admin).
- **Theo người dùng:** bảng sắp xếp được, xuất CSV; bấm một dòng để xem các cuộc chat của người đó trong kỳ.

Chỉ có số liệu: không lưu nội dung tin nhắn. Số liệu bắt đầu từ khi bản cập nhật chạy (không có số liệu cũ), làm mới mỗi
phút, giữ 400 ngày (`USAGE_RETENTION_DAYS`). Cần chạy `api/migrations/002_usage.sql` một lần trên DB đã có.

## Bộ nhớ dài hạn

Trợ lý nhớ điều người dùng nói để dùng lại ở các lượt sau: trong một chat (số liệu hiện hành, điều đã chốt, việc dở,
mục tiêu) và ở mọi chat của chính người đó (vai trò, quy ước họ dặn "từ nay…"). Mỗi người chỉ thấy bộ nhớ của mình.

- **Bật/tắt cho cả tổ chức:** biến môi trường `MEMORY_ORG=1` (bật) / `0` (tắt) khi triển khai; khi đã đặt, công tắc
  trong Cài đặt chỉ để xem. Không đặt thì admin bật trong Cài đặt → Bộ nhớ → "Bật bộ nhớ cho cả tổ chức" (mặc định tắt).
  Tắt thì trợ lý không ghi và không dùng bộ nhớ; dữ liệu đã có vẫn giữ.
- **Người dùng** tự tắt cho mình (Cài đặt → Bộ nhớ) hoặc cho một chat (nút "Bộ nhớ" trên thanh tiêu đề chat), xem,
  sửa, xoá từng ký ức hoặc xoá hết. Admin không xem được bộ nhớ của người khác.
- **Xoá một chat** xoá bộ nhớ của chat đó; điều người dùng dặn áp dụng lâu dài vẫn giữ.
- **Không áp dụng** cho Data Studio (trả lời từ dữ liệu công ty) và cho subagent.
- **Chi phí** (trích ký ức, embedding, nén): trên `/admin/usage`, ô "token bộ nhớ dài hạn" (`purpose` `memory-*`).
- **Hạ tầng:** MariaDB (`003_memory.sql`) và Qdrant ≥ 1.10 (`QDRANT_URL`). Chi tiết: `docs/memory-plugin-plan.md`.

## Nguồn dữ liệu Data Studio

Các màn này nằm trong thanh bên Data Studio, chỉ admin thấy. Chúng quyết định Data Studio **hỏi được dữ liệu nào** và
**hiểu dữ liệu ra sao**.

### Nguồn dữ liệu

1. **Import từ Dremio:** chọn nguồn → **Đồng bộ đã chọn** (lấy cả nguồn), hoặc **Chọn bảng…** để chỉ import một số bảng.
2. Bật **Cho phép agent dùng** cho nguồn.
3. **Xem bảng/view →** để mô tả từng bảng:

| Cột                       | Ý nghĩa                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------- |
| Tên hiển thị, Mô tả       | Giúp agent tìm đúng bảng — viết như giải thích cho người mới                                |
| Từ đồng nghĩa             | Các cách gọi khác, ngăn cách bằng dấu phẩy                                                  |
| Hiển thị                  | Tắt để agent bỏ qua bảng                                                                    |
| Dữ liệu nhạy cảm (PII)    | Cột PII không bao giờ hiển thị cho user                                                     |
| **Cho phép role user**    | Mặc định chỉ admin hỏi được. Bật để user hỏi được bảng/cột này (bật cho bảng sẽ mở mọi cột không PII của nó) |

**Xem cột →** để mô tả cột: vai trò (dimension / measure / key), kiểu ngữ nghĩa, phép tổng hợp. Thay đổi được lưu khi rời
khỏi ô.

### Hồ sơ dữ liệu

Màn **Hồ sơ dữ liệu** (giao diện tiếng Anh) dùng để mô tả kỹ từng bảng và cột của một nguồn, có gợi ý bằng AI, chạy thử
SQL, xuất / nhập hồ sơ dạng JSON và xuất tài liệu `.docx` cho đội dữ liệu.

Các tab trong Hồ sơ dữ liệu: **Bảng**, **Quan hệ**, **Chỉ số**, **Thuật ngữ**. Chỉ số và thuật ngữ ở đây được đưa lên chỉ
mục tìm kiếm ngay khi lưu, và là thứ pipeline **v4** đọc (`DATA_STUDIO_PIPELINE=v4`). Ba màn riêng Từ điển thuật ngữ,
Quan hệ dữ liệu, Chỉ số ở sidebar (của pipeline v3) đã bỏ từ 2026-10-19.

Đồng bộ, import, gợi ý AI và chạy SQL bị giới hạn 10 lần mỗi phút cho mỗi loại việc.
