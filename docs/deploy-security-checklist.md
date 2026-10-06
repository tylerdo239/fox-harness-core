# Checklist bảo mật khi deploy (proxy / ingress trước app)

Phần trong code gateway đã làm (2026-10-06): rate limit đăng nhập theo email, trần body, vé WebSocket một lần
thay cho token trên URL, không nhận `?token=`, CORS theo danh sách, giới hạn chat và các thao tác tốn tiền theo user.
Phần dưới đây thuộc tầng deploy.

| #   | Việc                         | Chi tiết                                                                                                                                                      |
| --- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | TLS                          | Chỉ phục vụ HTTPS/WSS; HTTP chuyển hướng sang HTTPS                                                                                                           |
| 2   | HSTS                         | `Strict-Transport-Security: max-age=31536000; includeSubDomains`                                                                                              |
| 3   | Chống nhúng iframe           | `Content-Security-Policy: frame-ancestors 'none'` (hoặc `X-Frame-Options: DENY`)                                                                              |
| 4   | CSP cho trang                | Ít nhất `default-src 'self'; connect-src 'self' wss://<domain>; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'` — thử trên staging trước        |
| 5   | Header khác                  | `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`                                                                                             |
| 6   | `X-Forwarded-For`            | Proxy **ghi đè** bằng IP thật của client (không nối thêm giá trị client gửi). Khi đã đúng, đặt `TRUST_PROXY=<số proxy>` cho backend để bật rate limit theo IP |
| 7   | Access log                   | Không ghi query string (lớp phòng thủ thêm; app không còn đặt token trên URL)                                                                                 |
| 8   | Kích thước body              | Giới hạn ~80 MB (upload dữ liệu); backend tự từ chối JSON > 1 MB và import hồ sơ > 20 MB                                                                      |
| 9   | WebSocket                    | Bật Upgrade cho `/sessions/*`; timeout đọc/ghi ≥ 1 giờ (một lượt trả lời có thể chạy vài phút)                                                                |
| 10  | Không lộ backend             | Port gateway (4000) chỉ trong mạng nội bộ; ra ngoài chỉ qua proxy                                                                                             |
| 11  | Rate limit ở edge (tuỳ chọn) | Theo IP cho `/auth/login`, bổ sung cho giới hạn theo email của app                                                                                            |
| 12  | `ALLOWED_ORIGINS`            | Để trống nếu app và API cùng domain; chỉ điền khi FE ở domain khác                                                                                            |

Biến môi trường backend liên quan: `TRUST_PROXY`, `ALLOWED_ORIGINS`, `AUTH_RATE_LIMIT_MAX`, `AUTH_IP_RATE_LIMIT_MAX`,
`MAX_JSON_BODY_BYTES`, `MAX_IMPORT_BODY_BYTES`, `CHAT_RATE_LIMIT_PER_MIN` (20), `COSTLY_RATE_LIMIT_PER_MIN` (10).
