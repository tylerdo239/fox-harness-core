---
name: skill-creator
description: Thiết kế và lưu một skill riêng cho người dùng — chọn phạm vi không chồng lấn skill sẵn có, viết description để model chọn đúng lúc, rồi lưu bằng tool create_skill sau khi người dùng duyệt. Dùng khi người dùng muốn tạo skill mới, ví dụ "tạo skill", "viết skill", "skill mới".
---

# skill-creator — viết một skill được chọn đúng lúc

Một skill là **gói hướng dẫn tĩnh**, không phải tool. Nó không tự làm gì cả;
nó thay đổi cách model làm việc khi được nạp.

## Quy trình — đề xuất trước, tạo sau

Skill tồn tại lâu dài và **được dùng lại ở những cuộc trò chuyện sau**, kể cả
khi người dùng đã quên là mình có nó. Một skill viết ẩu sẽ âm thầm bẻ lái các
câu trả lời về sau. Vì vậy nó phải được người dùng đọc tận mắt và duyệt trước
khi lưu.

**Không bao giờ gọi `create_skill` ở lượt đầu tiên** — kể cả khi người dùng
viết "tạo luôn đi". Lúc đó họ mới đồng ý với *ý tưởng*, chưa đọc *nội dung*
sắp lưu.

1. Soạn đủ 3 trường, trình bày cho người dùng đọc theo mẫu dưới đây.
2. Kết bằng một câu hỏi chốt, ví dụ: *"Duyệt bản này chứ, hay cần sửa chỗ nào?"*
3. **Dừng lượt tại đó, không gọi tool.**
4. Người dùng đồng ý ở lượt sau (*"oke tạo đi"*, *"duyệt"*, *"đồng ý"*) → gọi
   `create_skill` **ngay**, với đúng nội dung đã trình bày, rồi báo đã lưu.
   Không hỏi lại, không trình bày lại — họ đã đọc và đã duyệt rồi.
5. Người dùng yêu cầu sửa → sửa, trình bày lại bản mới, chờ duyệt lần nữa.

Nội dung đem lưu mà khác bản người dùng đã duyệt thì coi như chưa được duyệt.

Không tự tạo skill khi người dùng không hề yêu cầu.

## Mẫu trình bày để duyệt

Trình bày đủ 3 trường, không giấu trường nào — nhất là nội dung, vì đó mới là
thứ điều khiển hành vi về sau. Chia làm **hai vùng**:

**Vùng 1 — tên và mô tả.** Viết thẳng ra, mỗi trường một dòng, không bọc trong
rào code.

**Vùng 2 — nội dung skill.** LUÔN đặt trong một khối rào ` ```markdown `.

Lý do vùng 2 phải có rào: nội dung skill chứa `#`, `##`, `-`, `**`. Không rào
thì khung chat hiển thị chúng thành tiêu đề và chữ đậm thật — người dùng không
nhận ra đó là chuỗi sắp được lưu. Có rào thì họ đọc đúng từng ký tự.

Xuất ra chính xác dạng này (dấu rào là một phần của output):

````text
**Tên:** bao-cao-tuan
**Mô tả:** Dùng khi người dùng cần viết báo cáo tuần cho quản lý trực tiếp.

**Nội dung:**

```markdown
# Báo cáo tuần

1. Việc đã xong trong tuần, mỗi việc một dòng, có số liệu nếu có.
2. Việc đang dở kèm phần trăm hoàn thành.
3. Vướng mắc cần quản lý quyết định.
```
````

Rồi hỏi duyệt.

Đến lượt gọi `create_skill`, truyền vào `content` đúng phần **bên trong** rào —
không kèm dòng ` ```markdown `, không kèm dòng ` ``` ` đóng, không kèm vùng 1.

Lưu xong, người dùng dùng được skill từ tin nhắn tiếp theo bằng cách gõ
`/tên-skill`, và sửa hoặc xoá được trong mục **Kỹ năng** ở thanh bên. Skill
riêng tư với chính người dùng đó.

## Ba trường

| Trường | Ràng buộc |
|---|---|
| `name` | chữ thường, số, gạch ngang; không dấu, không khoảng trắng. Không trùng skill nào đang có, kể cả skill có sẵn |
| `description` | tối đa 280 ký tự. **Quan trọng nhất** — xem bên dưới |
| `content` | nội dung skill, Markdown, tối đa 64 KB |

Mỗi người dùng tối đa 50 skill. Tool báo trùng tên thì hỏi người dùng tên khác.

## `description` quyết định skill có được chọn hay không

Model chỉ nhìn thấy `name` + `description` trong danh sách skill, không thấy
nội dung. Description phải trả lời **"khi nào dùng"**, không chỉ **"đây là gì"**.

- ✅ *"…Dùng khi người dùng cần X, hoặc khi Y xảy ra."*
- ❌ *"Skill phân tích dữ liệu nâng cao."* — không phân biệt được với skill khác.

Nên đưa vào description vài cụm từ người dùng hay gõ khi cần skill này. Viết
xong hãy tự hỏi: đặt cạnh những skill hiện có, mô tả này có **chồng lấn** cái
nào không? Chồng lấn nhiều thì nên gộp, không nên thêm skill mới.

## Nội dung phải TỰ ĐỦ

`content` là một khối văn bản duy nhất. Không có thư mục con, không có tệp
đính kèm, **không trỏ sang tệp khác được**. Viết `xem references/abc.md` là
tạo ra một chỉ dẫn trỏ vào hư không.

Dài quá thì cắt bớt hoặc tách thành hai skill có phạm vi hẹp hơn.

## Chỉ hứa những gì làm được

Trong cuộc trò chuyện có: tìm web bằng `web_search`, đọc/ghi tệp
trong thư mục làm việc, chạy lệnh `bash` trong sandbox. Không có chế độ phân
tích dữ liệu riêng. Đừng viết skill ra lệnh cho model làm việc nằm ngoài những
khả năng này.

## Viết nội dung

Ngắn. Nêu quy trình từng bước và ranh giới không được vượt. Nêu rõ định dạng
đầu ra mong muốn: bao nhiêu mục, dài bao nhiêu, có bảng không, đơn vị gì. Quy
trình cụ thể cho kết quả ổn định hơn nhiều so với một câu mô tả chung.
