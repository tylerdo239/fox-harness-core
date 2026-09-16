# Bộ đo cố định (benchmark)

Mục đích: trả lời được câu "sửa harness xong có tốt lên không" bằng số, không bằng cảm giác.
Trước file này, mọi bài đo nằm trong thư mục tạm của một phiên làm việc rồi mất.

## Câu hỏi lấy ở đâu

Không tự nghĩ ra. 10 câu được lấy mẫu từ **InfiAgent-DABench** (bộ đo phân tích dữ liệu công khai,
`github.com/InfiAgent/InfiAgent`, nhánh `da-dev`): mỗi câu có đáp án là con số hoặc chuỗi chính xác,
nên máy chấm được, không cần model khác đi chấm.

**Dữ liệu không nằm trong repo.** `.gitignore` bỏ qua `scripts/bench/fixtures/` (dữ liệu của bên thứ ba)
và `scripts/bench/reports/` (kết quả sinh ra mỗi lần chạy). Lấy lại dữ liệu bằng một lệnh:

```bash
node scripts/bench/fetch-fixtures.mjs
```

Lệnh này tải 10 bảng của DABench, viết ra 4 bảng nhỏ tự dựng (nội dung nằm ngay trong script, vì chúng
là một phần của đề bài), và dựng file Excel 2 sheet bằng cách chạy pandas trong image worker — nên máy
không cần cài Python.

Cách chọn 10 câu: chỉ lấy câu có bảng dữ liệu dưới 400 KB, mỗi câu một file khác nhau, trải đều
3 dễ / 3 vừa / 4 khó và trải đều các nhóm kỹ năng (thống kê mô tả, phân phối, tương quan,
phát hiện ngoại lai, tạo đặc trưng, tiền xử lý, học máy). Bảng dữ liệu nằm trong `fixtures/`,
tổng cộng khoảng 110 KB.

| Bài | Mức | Nhóm | Dữ liệu |
|---|---|---|---|
| da-683 | dễ | thống kê mô tả | ravenna_250715.csv |
| da-019 | dễ | phân phối | unemployement_industry.csv |
| da-351 | dễ | tương quan | test_x.csv |
| da-254 | vừa | ngoại lai | gapminder_gdp_asia.csv |
| da-589 | vừa | tạo đặc trưng | 20170413_000000_group_statistics.csv |
| da-721 | vừa | tương quan | auto-mpg.csv |
| da-376 | khó | tạo đặc trưng + thống kê | 2014_q4.csv |
| da-077 | khó | tiền xử lý + thống kê | microsoft.csv |
| da-419 | khó | thống kê + phân phối | bitconnect_price.csv |
| da-118 | khó | tương quan + học máy | 2015.csv |

Ngoài 10 bài trên còn **5 bài `hard` tự dựng**, mỗi bài nhắm đúng một lỗi đã ghi trong
`docs/qa-report-2026-09-15.md` mà DABench không có. Dữ liệu nhỏ, đáp án tính tay và ghi rõ cách
tính trong trường `source` của từng bài.

| Bài | Nhắm lỗi | Đáp án |
|---|---|---|
| hard-excel-sheet | V5: workbook nhiều sheet, chỉ đọc sheet đầu | tổng cả 2 sheet = 150 |
| hard-csv-chau-au | V6: CSV dấu `;` và dấu phẩy thập phân | trung bình = 1333,33 |
| hard-cot-khong-co | V6: hỏi cột không tồn tại, model đoán mò hết giới hạn bước | trả lời "Khong", 8 cột |
| hard-bay-thieu-file | N6: bỏ qua file 2024 rồi kết luận "giảm 100%" | tăng 25,0% |
| hard-khong-luu-file | V6: tự lưu file khi bị dặn không lưu | không tạo file nào |
| hard-bang-rong | N6: lọc ra bảng rỗng, phải nói không có chứ đừng bịa | 0 xe, không xác định |
| hard-cot-toan-nan | N6: cột trống hoàn toàn, pandas trả `sum() = 0` rất dễ tin | "Khong", không xác định |
| hard-nho-so-cu | Nhớ số cũ sau nhiều lượt (8 lượt, hỏi lại số của lượt 1) | 14,9631 |

Sáu bài `smoke` (da-683, da-019, da-351, da-254, da-721, da-077) là bộ chạy nhanh sau mỗi thay đổi;
cả 10 là bộ đầy đủ, chạy trước khi kết luận một nâng cấp có tác dụng hay không.

## Chạy

Cần hệ thống đang chạy sẵn (gateway cổng 4000). Script này **không** build, không deploy gì cả.
Chạy bằng Node 22 trở lên (như `package.json` yêu cầu); Node 20 không có `WebSocket` sẵn.

```bash
# một lần: tạo tài khoản riêng cho việc đo
node scripts/create-admin.mjs            # hoặc đăng ký thường qua giao diện

FOX_BENCH_EMAIL=bench@local FOX_BENCH_PASSWORD=... node scripts/bench/run.mjs
FOX_BENCH_EMAIL=... FOX_BENCH_PASSWORD=... node scripts/bench/run.mjs --suite full --repeat 3
node scripts/bench/run.mjs --only da-683,da-351
node scripts/bench/run.mjs --suite full --baseline scripts/bench/reports/<file cũ>.json
```

| Cờ | Ý nghĩa |
|---|---|
| `--suite smoke` (mặc định) / `--suite hard` / `--suite full` | 6 bài nhanh / 5 bài khó / tất cả |
| `--repeat N` | chạy mỗi bài N lần — **quan trọng**: xem mục "đọc kết quả" |
| `--only a,b` | chỉ chạy vài bài |
| `--baseline <file>` | so với một báo cáo cũ, in ra bài nào tốt lên / xấu đi |
| `FOX_BENCH_KEEP=1` | giữ lại các dự án bench để mở ra xem tay (mặc định xoá sau khi chạy) |

Mỗi bài tự tạo một dự án riêng, tải đúng một file CSV lên, mở một đoạn chat mới trong dự án đó,
gửi câu hỏi, rồi nghe tới `turn/end`. Chạy **lần lượt**, không song song: mỗi đoạn chat là một
container, mà máy này giới hạn số container chạy cùng lúc (`fs.inotify.max_user_instances`) —
chạy song song là đo cái máy chứ không đo harness.

## Chấm điểm

Mỗi bài yêu cầu model kết thúc bằng một dòng đúng mẫu `@tên[giá trị]` (đúng luật của DABench).
Bộ đo đọc dòng đó và kiểm:

| Kiểm tra | Nghĩa |
|---|---|
| `answer` | Giá trị đúng; số thì cho sai lệch 1%, chuỗi thì so sau khi chuẩn hoá hoa thường |
| `noUnknownTool` | Không có lần gọi công cụ nào lỗi `UNKNOWN_TOOL` |
| `toolErrorsAtMost` | Tối đa 2 lần công cụ báo lỗi |
| `maxSteps` | Tối đa 10 bước |
| `maxSeconds` | Tối đa 7 phút |
| `mustContain` / `mustNotContain` | Biểu thức chính quy bắt buộc có / cấm có trong câu trả lời |
| `toolNotUsed` | Không được gọi công cụ này |
| `filesWrittenAtMost` | Số file chat tự tạo ra không vượt quá N |
| `lastTurnToolNotUsed` | Lượt cuối không được gọi công cụ này (dùng để biết model nhớ hay tính lại) |

Đỗ = tất cả kiểm tra đều đạt. Báo cáo ghi ra `scripts/bench/reports/` (không commit).

## Đọc kết quả: phân biệt lỗi harness với lỗi model

Đây là lý do nên chạy `--repeat 3`:

- **Rớt đều 3/3 lần, cùng một kiểu** → gần như chắc là harness giăng bẫy (môi trường thiếu thứ gì đó,
  công cụ trả về thông tin sai hoặc thiếu). Sửa được dứt điểm.
- **Rớt lúc được lúc không** → hành vi model. Harness không chặn được lần sai đầu tiên, nhưng vẫn
  chịu trách nhiệm phần "sai rồi thì sửa lại mất mấy bước" — nhìn cột `bước TB` và `lỗi công cụ TB`.

## Bài nhiều lượt

Một bài có thể là một câu (`prompt`) hoặc nhiều câu gửi lần lượt (`prompts: [...]`), mỗi câu một lượt,
đúng như người dùng gõ. Các kiểm tra áp lên **câu trả lời của lượt cuối**. Báo cáo ghi lại từng lượt
(số bước, công cụ đã gọi) trong trường `turns`, nên đọc báo cáo là biết lượt cuối model nhớ lại
hay đi tính lại từ đầu.

## Thêm bài mới

Thêm một file vào `cases/`, dữ liệu vào `fixtures/`. Đừng tự bịa đáp án: lấy từ một bộ đo có sẵn,
hoặc tính bằng tay trên một file nhỏ rồi ghi rõ cách tính trong trường `source`.
