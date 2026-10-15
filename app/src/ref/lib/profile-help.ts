// Copied from bot-data-studio-web-main/src/lib/profile-help.ts by scripts/sync-ref-profile.mjs — edit there, not here.
/**
 * Hover help for every data-profile field: what it means and how to fill it.
 * Written in Vietnamese for the DA/DE who fill the profile; the full guide is
 * backend/docs/huong-dan-ho-so-du-lieu.md.
 */

export interface FieldHelpText {
  title: string;
  body: string;
  example?: string;
  level?: "required" | "recommended" | "optional";
}

export const PROFILE_HELP = {
  // ── table ──
  table_display_name: {
    title: "Tên hiển thị",
    body: "Tên dễ đọc của bảng, dùng trong câu trả lời.",
    example: "FACT_ORDERS_V2 → Đơn hàng",
    level: "recommended",
  },
  table_synonyms: {
    title: "Tên gọi khác",
    body: "Các cách người dùng gọi bảng này, cách nhau bằng dấu phẩy. Giúp agent tìm đúng bảng khi câu hỏi không nhắc tên bảng.",
    example: "đơn hàng, hóa đơn, order",
    level: "optional",
  },
  table_description: {
    title: "Mô tả",
    body: "Bảng chứa gì, dùng trả lời câu hỏi nào, và không chứa gì.",
    example:
      "Mọi đơn bán lẻ tại cửa hàng, app, web từ 01/2024. Không gồm đơn bán sỉ.",
    level: "required",
  },
  grain_description: {
    title: "Một dòng là gì",
    body: "Thông tin quan trọng nhất của bảng. Kiểm tra: nếu hai dòng có thể trùng mã đơn thì một dòng không phải là một đơn.",
    example:
      "1 dòng = 1 đơn hàng · 1 dòng = 1 sản phẩm trong 1 đơn · 1 dòng = 1 SKU × 1 chi nhánh × 1 ngày",
    level: "required",
  },
  table_visible: {
    title: "Cho agent dùng",
    body: "Tắt nếu bảng không nên dùng để trả lời câu hỏi: bảng tạm, bảng lỗi, bảng trùng với bảng khác.",
    level: "optional",
  },
  table_kind: {
    title: "Loại bảng",
    body: "fact: mỗi dòng là một sự kiện/giao dịch có thời điểm. dim: danh sách đối tượng để tra cứu, mỗi đối tượng một dòng. snapshot: trạng thái được chụp lại mỗi ngày/tháng (không cộng qua các ngày). scd2: danh sách đối tượng có lưu lịch sử thay đổi (nhiều dòng một đối tượng, có ngày hiệu lực).",
    example:
      "Đơn hàng → fact · Chi nhánh, cấu hình agent → dim · Tồn kho cuối ngày → snapshot",
    level: "required",
  },
  trust: {
    title: "Mức tin cậy",
    body: "certified: đã đối chiếu với báo cáo chính thức, dùng báo cáo được. raw: dữ liệu thô, chưa kiểm. Agent ưu tiên bảng certified.",
    level: "required",
  },
  label_column: {
    title: "Cột tên",
    body: "Cột gọi tên một dòng, hiển thị thay cho mã. Bắt buộc với bảng dim và scd2; nếu thiếu, kết quả sẽ hiện mã thay vì tên.",
    example: "Chi nhánh → branch_name · Cấu hình agent → agent_name",
    level: "required",
  },
  grain_keys: {
    title: "Cột xác định một dòng",
    body: "Các cột mà ghép lại thì không có hai dòng nào trùng nhau. Phải khớp với “Một dòng là gì”. Chọn thiếu cột là lỗi nguy hiểm: agent sẽ cộng trùng. Không chắc thì hỏi DE phụ trách bảng.",
    example:
      "Đơn hàng → order_id · Dòng sản phẩm → order_id, line_no · Tồn kho ngày → snapshot_date, branch_id, product_id",
    level: "required",
  },
  time_column: {
    title: "Cột thời gian chính",
    body: "Cột dùng khi người dùng nói “tháng trước”, “năm 2025”. Có nhiều cột ngày thì chọn cột báo cáo chính thức dùng, ghi các cột khác vào Caveats. Bắt buộc với fact và snapshot.",
    example: "order_date (ngày đặt), không phải delivered_at",
    level: "required",
  },
  business_tz: {
    title: "Múi giờ nghiệp vụ",
    body: "Múi giờ người dùng dùng để tính ngày, tháng.",
    example: "Asia/Ho_Chi_Minh",
    level: "required",
  },
  storage_tz: {
    title: "Múi giờ lưu trữ",
    body: "Múi giờ của giá trị trong bảng. Bắt buộc khi cột thời gian có giờ (TIMESTAMP). Kiểm tra: một đơn tạo lúc 08:00 giờ VN mà bảng ghi 01:00 → lưu theo UTC. Hỏi DE nếu không chắc.",
    example: "UTC",
    level: "required",
  },
  snapshot_column: {
    title: "Cột ngày chụp",
    body: "Chỉ với bảng snapshot. Agent luôn lấy đúng một ngày chụp (mặc định ngày cuối của kỳ hỏi), không cộng nhiều ngày.",
    example: "snapshot_date",
    level: "required",
  },
  coverage_start: {
    title: "Ngày bắt đầu có dữ liệu",
    body: "Ngày đầu tiên có dữ liệu. Agent dùng để trả lời “không có dữ liệu trước ngày …” thay vì trả về 0.",
    example: "2024-01-01",
    level: "recommended",
  },
  coverage_end: {
    title: "Ngày kết thúc dữ liệu",
    body: "Để trống nếu bảng vẫn còn dữ liệu mới. Chỉ điền khi bảng đã ngừng có dữ liệu (bảng cũ, hệ thống đã thay thế).",
    level: "optional",
  },
  coverage_gaps: {
    title: "Khoảng thời gian thiếu dữ liệu",
    body: "Những khoảng không có hoặc thiếu dữ liệu, kèm lý do nếu biết.",
    example: "10/02–14/02/2024 (POS tắt dịp Tết)",
    level: "optional",
  },
  default_filters: {
    title: "Bộ lọc mặc định",
    body: "Điều kiện để GIỮ LẠI dòng: chỉ dòng thỏa mọi điều kiện mới được đếm hoặc cộng. Agent tự thêm vào mọi câu truy vấn, trừ khi người dùng nói rõ muốn bỏ. Muốn BỎ dòng đã xóa thì giữ dòng chưa xóa: deleted_at is empty (không phải is not empty).",
    example: "status = DONE (chỉ đơn hoàn tất) · is_test = 0 (bỏ đơn test)",
    level: "recommended",
  },
  default_filters_confirmed: {
    title: "Đã kiểm tra bộ lọc mặc định",
    body: "Tích khi đã kiểm tra. Nếu bảng không cần bộ lọc nào, vẫn tích để xác nhận là “không cần”, không phải “chưa điền”.",
    level: "recommended",
  },
  list_filters: {
    title: "Bộ lọc khi liệt kê dòng",
    body: "Áp dụng khi người dùng xem danh sách từng dòng (“20 đơn gần nhất của khách X”). Thường nhẹ hơn bộ lọc mặc định: người dùng muốn thấy cả đơn hủy, chỉ bỏ dữ liệu test. Để trống thì danh sách dùng bộ lọc mặc định; chỉ điền khi cần bộ lọc khác.",
    example: "is_test = 0",
    level: "optional",
  },
  filter_column: {
    title: "Cột lọc",
    body: "Cột của bảng này dùng trong điều kiện.",
  },
  filter_op: {
    title: "Phép so sánh",
    body: "Điều kiện mô tả dòng được GIỮ LẠI. = bằng · ≠ khác · in: một trong các giá trị · not in: không thuộc · >, ≥, <, ≤ · is empty: không có giá trị (vd deleted_at is empty = dòng chưa bị xóa) · is not empty: có giá trị (vd deleted_at is not empty = CHỈ dòng đã xóa).",
  },
  filter_value: {
    title: "Giá trị",
    body: "Nếu cột có danh sách giá trị thì chọn từ danh sách. Nếu chưa, gõ đúng như lưu trong dữ liệu (kể cả hoa/thường); với in / not in cách nhau bằng dấu phẩy.",
    example: "DONE · 0 · MB, MN",
  },
  filter_reason: {
    title: "Lý do",
    body: "Vì sao cần điều kiện này, để người sau hiểu và không xóa nhầm.",
    example: "Doanh thu chỉ tính đơn hoàn tất",
  },
  caveats: {
    title: "Lưu ý cho người dùng",
    body: "Mỗi dòng một lưu ý. Agent đưa vào phần giả định của câu trả lời khi dùng bảng, nên viết cho người dùng cuối đọc.",
    example: "branch_id trống với đơn trước 03/2024 (hệ thống POS cũ).",
    level: "optional",
  },
  table_notes: {
    title: "Ghi chú nội bộ",
    body: "Ghi chú cho người điền hồ sơ, không hiện cho người dùng.",
    level: "optional",
  },

  // ── column ──
  column_display_name: {
    title: "Tên hiển thị",
    body: "Tên dễ đọc của cột. Để trống thì dùng tên vật lý.",
    example: "net_amount → Doanh thu thuần",
    level: "recommended",
  },
  column_synonyms: {
    title: "Tên gọi khác",
    body: "Các cách người dùng gọi cột, cách nhau bằng dấu phẩy.",
    example: "doanh thu, doanh số, revenue",
    level: "optional",
  },
  column_description: {
    title: "Mô tả",
    body: "Cột chứa gì, tính thế nào, theo lời người dùng hay nói.",
    example: "Tiền khách trả sau chiết khấu, chưa gồm VAT.",
    level: "recommended",
  },
  role: {
    title: "Vai trò",
    body: "Hỏi lần lượt, dừng ở câu “có” đầu tiên. 1) Xác định một dòng hoặc trỏ tới bảng khác? → key (kể cả khi là số). 2) Người dùng sẽ cộng/lấy trung bình qua nhiều dòng và con số có ý nghĩa? → measure. 3) Còn lại (lọc, nhóm, hiển thị) → dimension. Tham số cấu hình dạng số (temperature, max_tokens) là dimension.",
    example:
      "order_id, branch_id → key · net_amount, quantity → measure · status, region, order_date → dimension",
    level: "required",
  },
  semantic_type: {
    title: "Kiểu ý nghĩa",
    body: "category: tập giá trị cố định, ít (phải điền danh sách giá trị) · text: tên, văn bản · id: mã · number: số là tham số hoặc thứ tự, để so sánh/sắp xếp, không cộng (temperature, max_tokens, dependency_order) · date / datetime: ngày / ngày giờ · currency: tiền · count: số lượng để cộng · percent: tỷ lệ · boolean: có/không (phải điền danh sách giá trị) · pii: dữ liệu cá nhân.",
    level: "required",
  },
  column_visible: {
    title: "Cho agent dùng",
    body: "Tắt với cột kỹ thuật, cột lỗi, cột trùng nghĩa, văn bản dài hoặc JSON (prompt, config_json). Cột ẩn không cần điền thêm gì.",
    level: "optional",
  },
  pii: {
    title: "Dữ liệu cá nhân",
    body: "Bật với số điện thoại, email, CMND/CCCD, họ tên, địa chỉ nhà. Agent không bao giờ đưa cột PII vào kết quả. Không điền danh sách giá trị cho cột PII.",
    level: "optional",
  },
  aggregation: {
    title: "Cách gộp",
    body: "Cách gộp tự nhiên của cột số: sum (tổng), avg (trung bình), count, count_distinct (đếm không trùng), min, max.",
    example: "Doanh thu → sum · Đơn giá → avg",
    level: "required",
  },
  unit: {
    title: "Đơn vị",
    body: "Đơn vị của giá trị.",
    example: "VND · USD · cái · phút · % · kg",
    level: "required",
  },
  scale: {
    title: "Hệ số",
    body: "Điền khi cột lưu theo đơn vị lớn hơn. Để trống nếu lưu đúng đơn vị.",
    example: "Cột lưu nghìn đồng → 1000",
    level: "optional",
  },
  additive: {
    title: "Cộng được không",
    body: "Tự hỏi: giá trị tháng 1 + tháng 2 có ra giá trị của cả hai tháng? Có → yes (all). Cộng qua chi nhánh được nhưng qua các ngày thì không → not across time (tồn kho, số dư). Không bao giờ cộng → never (đơn giá, tỷ lệ, số khách không trùng).",
    example: "Doanh thu → yes · Tồn kho → not across time · Đơn giá → never",
    level: "required",
  },
  normal_range: {
    title: "Khoảng giá trị bình thường",
    body: "Giá trị ngoài khoảng này bị đánh dấu nghi ngờ trong câu trả lời. Để trống nếu không biết.",
    example: "Giá trị một đơn: 0 đến 200000000",
    level: "optional",
  },
  sign_convention: {
    title: "Quy ước dấu",
    body: "Giá trị âm có nghĩa gì, hoặc cột có luôn không âm.",
    example: "luôn ≥ 0 · hoàn tiền ghi số âm",
    level: "optional",
  },
  values: {
    title: "Danh sách giá trị",
    body: "Mọi giá trị cột có thể nhận, ý nghĩa và cách gọi khác. Bắt buộc với category và boolean. Đây là thông tin agent dùng nhiều nhất để lọc đúng (“miền Nam” → MN).",
    level: "required",
  },
  values_complete: {
    title: "Danh sách đã đủ",
    body: "Bật khi danh sách có tất cả giá trị cột có thể nhận. Khi bật, ứng dụng từ chối bộ lọc dùng giá trị ngoài danh sách. Cột có quá nhiều giá trị (hàng trăm hãng) thì chỉ liệt kê giá trị thường gặp và không bật.",
    level: "recommended",
  },
  values_ordered: {
    title: "Giá trị có thứ tự",
    body: "Bật khi các giá trị có thứ tự tự nhiên, rồi dùng mũi tên để xếp từ đầu đến cuối. Biểu đồ và bảng kết quả sẽ xếp theo thứ tự này.",
    example: "Bronze → Silver → Gold · Thấp → Trung bình → Cao",
    level: "optional",
  },
  value_value: {
    title: "Giá trị (như lưu trong dữ liệu)",
    body: "Ghi đúng như trong dữ liệu, kể cả hoa/thường và số 0 đứng đầu. Không ghi nhãn ở đây.",
    example: "DONE · MN · 01",
  },
  value_label: {
    title: "Nhãn",
    body: "Tên người dùng hiểu.",
    example: "Hoàn tất · Miền Nam",
  },
  value_synonyms: {
    title: "Tên gọi khác của giá trị",
    body: "Các cách người dùng gọi giá trị này, cách nhau bằng dấu phẩy.",
    example: "hoàn thành, thành công, completed",
  },
  value_count: {
    title: "Số dòng",
    body: "Số dòng xấp xỉ có giá trị này. Không bắt buộc.",
    example: "16900000",
  },
  date_format: {
    title: "Định dạng ngày",
    body: "Bắt buộc khi cột là ngày nhưng lưu dạng chữ hoặc số. Cột kiểu DATE/TIMESTAMP thật thì để trống.",
    example:
      "20240115 → YYYYMMDD · 2024-01 → YYYY-MM · 15/01/2024 → DD/MM/YYYY · 1705276800 → EPOCH_SECONDS",
    level: "required",
  },
  parent_column: {
    title: "Cột cấp trên",
    body: "Với phân cấp trong cùng bảng: cột ở cấp cao hơn. Agent dùng để trả lời theo cấp cao hơn khi cần. Không được tạo vòng lặp.",
    example: "province_name → region · product_name → category",
    level: "optional",
  },
  null_meaning: {
    title: "Giá trị rỗng nghĩa là gì",
    body: "Giúp agent quyết định coi rỗng là 0, bỏ qua, hay nhóm thành “Không xác định”.",
    example: "đơn bị hủy, không có tiền · khách vãng lai, không có mã",
    level: "recommended",
  },
  pattern: {
    title: "Ví dụ định dạng",
    body: "Ví dụ cách viết mã, để agent nhận ra mã trong câu hỏi (“chi nhánh BR-0412 thế nào?”).",
    example: "BR-0001 · CUS-00012345",
    level: "recommended",
  },
  json_fields: {
    title: "Trường JSON",
    body: "Khi cột chứa JSON (vd config), khai báo các trường bên trong để dùng như một cột: lọc, đếm, tính chỉ số. Ứng dụng tự viết phần đọc JSON (TRY_CONVERT_FROM) khi chạy; không cần sửa dữ liệu hay view.",
    example: "config → is_intent_node (BOOLEAN) · config → limits.max_tokens (INTEGER)",
    level: "optional",
  },
  json_path: {
    title: "Đường dẫn trong JSON",
    body: "Tên trường đúng như trong JSON, phân biệt hoa/thường. Trường lồng nhau nối bằng dấu chấm. Bấm Check để xem bao nhiêu dòng có trường này; 0 dòng thường là gõ sai tên hoặc sai kiểu.",
    example: "is_intent_node · limits.max_tokens",
    level: "required",
  },
  json_type: {
    title: "Kiểu dữ liệu",
    body: "Kiểu của giá trị trong JSON: BOOLEAN (true/false), VARCHAR (chữ), INTEGER/BIGINT (số nguyên), DOUBLE (số thực), DATE, TIMESTAMP. Sai kiểu thì giá trị đọc ra sẽ rỗng.",
    level: "required",
  },
  column_notes: {
    title: "Ghi chú nội bộ",
    body: "Ghi chú cho người điền hồ sơ, không hiện cho người dùng.",
    level: "optional",
  },

  // ── glossary ──
  glossary_term: {
    title: "Thuật ngữ",
    body: "Từ hoặc cụm từ người dùng nói trong câu hỏi mà cần một nghĩa cố định. Viết đúng như người dùng hay nói. Không trùng với thuật ngữ khác.",
    example: "khách VIP · hội thoại đang mở · tăng trưởng · doanh số",
    level: "required",
  },
  glossary_kind: {
    title: "Loại thuật ngữ",
    body: "Segment: một nhóm dòng của một bảng, định nghĩa bằng điều kiện (khách VIP, đơn online). Metric: tên gọi khác của một chỉ số đã có (doanh số → net_revenue). Convention: quy ước viết bằng lời cho agent làm theo (tăng trưởng = % so với kỳ trước).",
    level: "required",
  },
  glossary_definition: {
    title: "Định nghĩa",
    body: "Thuật ngữ nghĩa là gì, như trong từ điển nghiệp vụ. Với loại Convention, đây là quy ước agent sẽ làm theo nên viết rõ và đầy đủ.",
    example: "Khách VIP: khách có hạng VIP trong hệ thống CRM, không gồm khách thử nghiệm.",
    level: "required",
  },
  glossary_synonyms: {
    title: "Cách nói khác",
    body: "Các cách khác người dùng nói cùng ý, cách nhau bằng dấu phẩy.",
    example: "khách thân thiết, khách hạng VIP, VIP customer",
    level: "recommended",
  },
  glossary_table: {
    title: "Bảng",
    body: "Bảng chứa các dòng thuộc nhóm này. Điều kiện bên dưới dùng cột của bảng này.",
    example: "Khách VIP → bảng khách hàng · Hội thoại đang mở → bảng hội thoại",
    level: "required",
  },
  glossary_filters: {
    title: "Điều kiện",
    body: "Dòng thuộc thuật ngữ (được giữ lại) khi thỏa mọi điều kiện. Chọn giá trị từ danh sách giá trị của cột nếu có. Bộ lọc mặc định của bảng vẫn được áp thêm khi đếm.",
    example: "segment = VIP · channel in APP, WEB · is_active = 1",
    level: "required",
  },
  glossary_metric: {
    title: "Chỉ số",
    body: "Chỉ số mà thuật ngữ này chỉ tới. Nếu chỉ số chưa có, tạo ở trang Metrics trước.",
    example: "doanh số → net_revenue",
    level: "required",
  },
  glossary_related_tables: {
    title: "Bảng liên quan",
    body: "Các bảng mà quy ước này áp dụng, giúp agent tìm ra quy ước khi câu hỏi dùng các bảng đó. Không bắt buộc.",
    level: "optional",
  },
  glossary_examples: {
    title: "Câu hỏi mẫu",
    body: "Vài câu người dùng hay hỏi có dùng thuật ngữ này, mỗi dòng một câu.",
    example: "Có bao nhiêu hội thoại đang mở theo từng agent?",
    level: "recommended",
  },
  glossary_notes: {
    title: "Ghi chú nội bộ",
    body: "Ghi chú cho người quản lý thuật ngữ, không hiện cho người dùng.",
    level: "optional",
  },

  // ── metric ──
  metric_name: {
    title: "Mã metric",
    body: "Tên kỹ thuật, duy nhất, viết thường không dấu, nối bằng dấu gạch dưới. Agent và câu truy vấn dùng tên này. Tự điền theo tên hiển thị; nên giữ ổn định sau khi đã dùng.",
    example: "net_revenue · conversation_count · returning_customer_rate",
    level: "required",
  },
  metric_display_name: {
    title: "Tên hiển thị",
    body: "Tên người dùng gọi chỉ số, hiện trong câu trả lời và biểu đồ.",
    example: "Doanh thu thuần · Số hội thoại · Tỷ lệ khách quay lại",
    level: "required",
  },
  metric_description: {
    title: "Mô tả",
    body: "Chỉ số đo gì, tính thế nào, gồm và không gồm gì. Viết như định nghĩa trong báo cáo chính thức.",
    example: "Tổng tiền khách trả của đơn hoàn tất, đã trừ chiết khấu, chưa gồm VAT. Không gồm đơn test.",
    level: "required",
  },
  metric_synonyms: {
    title: "Tên gọi khác",
    body: "Các cách người dùng gọi chỉ số này trong câu hỏi, cách nhau bằng dấu phẩy. Giúp agent nhận ra chỉ số.",
    example: "doanh thu, doanh số, revenue, tiền bán hàng",
    level: "recommended",
  },
  metric_kind: {
    title: "Cách tính",
    body: "Gộp trên một bảng: SUM/COUNT/AVG… một cột của một bảng (doanh thu, số đơn). Tỷ lệ: chia hai chỉ số đã có (giá trị đơn trung bình = doanh thu / số đơn; tỷ lệ = số khách quay lại / số khách × 100).",
    level: "required",
  },
  metric_table: {
    title: "Bảng tính",
    body: "Bảng chứa dữ liệu để tính chỉ số, thường là bảng fact (đơn hàng, hội thoại). Bộ lọc mặc định, cột thời gian và loại bảng của bảng này được dùng khi tính.",
    example: "agents_db.workflows_db.conversations",
    level: "required",
  },
  metric_aggregation: {
    title: "Phép gộp",
    body: "sum: cộng · count: đếm dòng (không cần cột) · count_distinct: đếm giá trị khác nhau (vd số khách) · avg: trung bình · min / max. avg, min, max, count_distinct không cộng dồn được giữa các nhóm.",
    example: "Doanh thu → sum(net_amount) · Số đơn → count · Số khách → count_distinct(customer_id)",
    level: "required",
  },
  metric_column: {
    title: "Cột đo",
    body: "Cột được gộp. sum và avg cần cột số. Với count để trống để đếm số dòng.",
    example: "net_amount · duration_seconds · customer_id (với count_distinct)",
    level: "required",
  },
  metric_filters: {
    title: "Bộ lọc riêng của chỉ số",
    body: "Điều kiện để GIỮ LẠI dòng khi tính chỉ số này, thêm vào bộ lọc mặc định của bảng. Chỉ dòng thỏa mọi điều kiện mới được tính.",
    example: "Số đơn hủy: status = CANCELLED · Doanh thu online: channel in APP, WEB",
    level: "optional",
  },
  metric_use_defaults: {
    title: "Dùng bộ lọc mặc định của bảng",
    body: "Bật (mặc định): áp bộ lọc mặc định của bảng (vd chỉ đơn hoàn tất, bỏ đơn test). Tắt khi chỉ số cố tình đo phần bị loại, vd số đơn hủy (bảng mặc định lọc status = DONE nên phải tắt).",
    level: "optional",
  },
  metric_time_column: {
    title: "Cột thời gian",
    body: "Cột ngày dùng khi hỏi “tháng trước”, “năm nay”. Để trống thì dùng cột thời gian chính của bảng. Chỉ đổi khi chỉ số tính theo ngày khác.",
    example: "Doanh thu theo ngày thanh toán → paid_at (thay vì order_date)",
    level: "optional",
  },
  metric_numerator: {
    title: "Tử số",
    body: "Chỉ số ở trên dấu chia. Phải là chỉ số đã tạo.",
    example: "Giá trị đơn trung bình: tử số = net_revenue",
    level: "required",
  },
  metric_denominator: {
    title: "Mẫu số",
    body: "Chỉ số ở dưới dấu chia. Khi mẫu số bằng 0, kết quả để trống (không lỗi).",
    example: "Giá trị đơn trung bình: mẫu số = order_count",
    level: "required",
  },
  metric_scale: {
    title: "Hệ số nhân",
    body: "Nhân kết quả với số này. 100 để ra phần trăm; 1 nếu giữ nguyên.",
    example: "Tỷ lệ khách quay lại (%) → 100",
    level: "optional",
  },
  metric_unit: {
    title: "Đơn vị",
    body: "Đơn vị hiển thị của kết quả.",
    example: "VND · đơn · khách · % · phút",
    level: "required",
  },
  metric_additive: {
    title: "Cộng được không",
    body: "yes: tổng các nhóm bằng tổng chung (doanh thu, số đơn). not across time: cộng qua nhóm được nhưng không qua các ngày (tồn kho). never: không cộng (trung bình, tỷ lệ, đếm không trùng) — tự đặt cho avg, min, max, count_distinct và tỷ lệ.",
    level: "required",
  },
  metric_decimals: {
    title: "Số chữ số thập phân",
    body: "Số chữ số sau dấu phẩy khi hiển thị. Để trống thì tự chọn.",
    example: "Doanh thu → 0 · Tỷ lệ % → 1",
    level: "optional",
  },
  metric_direction: {
    title: "Chiều tốt",
    body: "Tăng là tốt hay giảm là tốt. Agent dùng để nhận xét đúng (doanh thu tăng là tốt, tỷ lệ hủy tăng là xấu).",
    example: "Doanh thu → up · Tỷ lệ hủy đơn → down · Số phiên bản → none",
    level: "recommended",
  },
  metric_examples: {
    title: "Câu hỏi mẫu",
    body: "Một vài câu người dùng hay hỏi về chỉ số này, mỗi dòng một câu. Giúp agent tìm đúng chỉ số.",
    example: "Doanh thu tháng trước theo miền? · Top 5 chi nhánh doanh thu cao nhất năm nay",
    level: "recommended",
  },
  metric_references: {
    title: "Giá trị tham chiếu",
    body: "Con số đã biết chắc cho một kỳ (từ báo cáo chính thức). Agent so kết quả với số này để phát hiện câu trả lời sai. Kỳ dạng YYYY, YYYY-MM hoặc YYYY-MM-DD.",
    example: "2026-08 · 125400000000 · Báo cáo tài chính tháng 8",
    level: "recommended",
  },
  metric_notes: {
    title: "Ghi chú nội bộ",
    body: "Ghi chú cho người quản lý chỉ số, không hiện cho người dùng.",
    level: "optional",
  },

  // ── relationship ──
  rel_from_table: {
    title: "Bảng From",
    body: "Bảng ở phía “một” khi quan hệ là 1 → nhiều: bảng tra cứu hoặc bảng cha. Có thể thuộc bất kỳ nguồn dữ liệu nào. Gõ tên để tìm, lọc theo nguồn.",
    example:
      "Agent (một agent có nhiều hội thoại) · Chi nhánh (một chi nhánh có nhiều đơn)",
    level: "required",
  },
  rel_to_table: {
    title: "Bảng To",
    body: "Bảng ở phía “nhiều”: bảng con hoặc bảng sự kiện có cột trỏ về bảng From. Có thể ở nguồn khác với bảng From. Chọn nhầm chiều thì bấm ⇄ để đổi.",
    example: "Hội thoại (có agent_id) · Đơn hàng (có branch_id)",
    level: "required",
  },
  rel_keys: {
    title: "Cột khóa",
    body: "Các cặp cột có giá trị bằng nhau khi nối: bên trái là cột của bảng From, bên phải là cột của bảng To. Thường là khóa của bảng From = cột mã trỏ tới nó ở bảng To. Khóa gồm nhiều cột thì thêm nhiều cặp. Hai nguồn khác nhau thì kiểm tra giá trị viết giống hệt nhau (kiểu, hoa/thường, số 0 đứng đầu).",
    example:
      "agents.id = conversations.agent_id · orders.order_id = order_items.order_id, orders.region = order_items.region",
    level: "required",
  },
  cardinality: {
    title: "Số dòng khớp",
    body: "1 → nhiều: một dòng From ứng với nhiều dòng To (phổ biến nhất). 1 → 1: mỗi dòng From ứng với nhiều nhất một dòng To (bảng tách thêm thông tin). Nhiều → nhiều: cả hai bên đều lặp, thường là dấu hiệu thiếu bảng trung gian. Agent dùng thông tin này để tránh cộng trùng khi nối.",
    example:
      "Agent → Hội thoại: 1 → nhiều · Khách hàng → Hồ sơ khách hàng: 1 → 1",
    level: "required",
  },
  join_type: {
    title: "Kiểu nối mặc định",
    body: "left: giữ cả những dòng From không có dòng khớp (vd agent chưa có hội thoại nào vẫn hiện, với số 0). inner: chỉ giữ dòng khớp ở cả hai bên. Không chắc thì chọn left để không mất dòng một cách âm thầm.",
    example:
      "Đếm hội thoại theo agent, muốn thấy cả agent chưa có hội thoại → left",
    level: "required",
  },
  match_rate: {
    title: "Tỷ lệ khớp (%)",
    body: "Tỷ lệ dòng của bảng bên trái tìm được dòng khớp ở bảng bên phải. Dưới 99,5% thì agent nối kiểu LEFT để không mất dòng. Để trống nếu chưa ai kiểm tra.",
    example: "97,8% đơn có chi nhánh",
    level: "optional",
  },
  fanout: {
    title: "Hệ số nhân dòng",
    body: "Số dòng sau khi nối chia số dòng trước khi nối. Lớn hơn 1 nghĩa là nối sẽ nhân bản dòng; agent sẽ gộp trước khi nối. Để trống thì agent dựa vào kiểu quan hệ.",
    example: "Đơn hàng → dòng sản phẩm: 2.7",
    level: "optional",
  },
  relationship_notes: {
    title: "Ghi chú",
    body: "Điều cần biết khi nối hai bảng.",
    example: "đơn trước 03/2024 không có chi nhánh",
    level: "optional",
  },
} satisfies Record<string, FieldHelpText>;

export type ProfileHelpKey = keyof typeof PROFILE_HELP;
