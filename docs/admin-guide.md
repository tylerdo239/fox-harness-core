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

## Meta Ads (quảng cáo Facebook/Instagram)

Chế độ chat **Meta Ads** cho mỗi người dùng làm việc với tài khoản quảng cáo Meta **của chính họ**
(`docs/meta-ads-mcp-plan.md`). Mặc định tắt.

**Bật (một lần):**
1. Tạo Meta developer app (loại Business, thuộc Business Manager của công ty) ở developers.facebook.com/apps, thêm use
   case **Create & manage ads with ads MCP server**.
2. Facebook Login for Business: tạo cấu hình xin `ads_mcp_management`, `ads_read` (và `ads_management` nếu bật tạo/sửa),
   lấy **config ID**; khai redirect URL `https://<domain>/connections/meta/callback`.
3. Khi app chưa qua App Review, chỉ người có role trên app (admin/developer/tester) đăng nhập được: thêm từng người, hoặc
   gửi App Review để mở cho mọi nhân viên.
4. Chạy `api/migrations/004_ads.sql`; đặt env `META_ADS_ENABLED=true`, `META_APP_ID`, `META_LOGIN_CONFIG_ID`,
   `META_ADS_REDIRECT_URL`, `FOX_TOKEN_ENC_KEY` (32 byte ngẫu nhiên, base64; mất khoá thì mọi người phải kết nối lại).
   Pod backend cần ra được `mcp.facebook.com`, `www.facebook.com`, `graph.facebook.com` (443).
5. `META_ADS_TIERS=read` (mặc định): chỉ đọc báo cáo. `read,write`: thêm tạo campaign/ad set/ad, sửa, bật — **mỗi thay đổi
   chờ người dùng bấm Đồng ý** trên thẻ xác nhận (10 phút, `META_ADS_CONFIRM_TIMEOUT_MS`), không bấm là không làm gì.

**Người dùng:** Cài đặt → **Kết nối** → Meta → **Kết nối**, đăng nhập Facebook, chọn quyền. Sau đó sidebar có mục
**Meta Ads**. Token mã hoá trong `discovery_ads_connections`; **Ngắt kết nối** xoá token và thu hồi quyền phía Meta.

**Kiểm tra:** mọi thao tác ghi (ai, chat nào, công cụ, tóm tắt, Đồng ý/Từ chối/hết giờ, kết quả) nằm ở
`discovery_ads_actions`; log gateway có `meta_ads_call`, `meta_ads_action`, `meta_ads_connected`. Công cụ được phép nằm ở
`api/services/gateway/src/ads/tools.ts` (không có xoá audience, catalog, pixel…).

**Đổi khoá:** `FOX_TOKEN_ENC_KEYS=k2:<khoá mới>,k1:<khoá cũ>` — khoá đầu dùng để mã hoá, các hàng cũ vẫn mở được bằng k1;
bỏ k1 khi mọi người đã kết nối lại hoặc token đã được làm mới.

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
