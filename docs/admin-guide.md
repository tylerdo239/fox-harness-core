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

### Từ điển thuật ngữ, Quan hệ dữ liệu, Chỉ số

| Màn                     | Dùng để                                                                         |
| ----------------------- | ------------------------------------------------------------------------------- |
| **Từ điển thuật ngữ**   | Định nghĩa thuật ngữ nghiệp vụ (vd. "khách hàng active") và từ đồng nghĩa       |
| **Quan hệ dữ liệu**     | Khai báo cách nối hai bảng (cột nối, 1:1 / 1:N / N:N, left / inner)             |
| **Chỉ số**              | Định nghĩa chỉ số chuẩn (bảng, cột đo, phép tổng hợp); đánh dấu **Đã xác minh** |

> Xoá thuật ngữ, quan hệ hay chỉ số **không hỏi lại**.

### Hồ sơ dữ liệu

Màn **Hồ sơ dữ liệu** (giao diện tiếng Anh) dùng để mô tả kỹ từng bảng và cột của một nguồn, có gợi ý bằng AI, chạy thử
SQL, xuất / nhập hồ sơ dạng JSON và xuất tài liệu `.docx` cho đội dữ liệu.

Đồng bộ, import, gợi ý AI và chạy SQL bị giới hạn 10 lần mỗi phút cho mỗi loại việc.
