# Nhật ký thay đổi — chuyển skill từ agent-core sang fox

Theo kế hoạch `docs/skill-transfer-plan.md`. Nhánh: `feat/skill-transfer`
(tách từ `dev`). **Chưa commit.**

Ký hiệu: **[mới]** file tạo mới · **[sửa]** file có sẵn bị sửa.

---

## Giai đoạn 1 — Skill có sẵn ✅

### File

| File | Loại | Sửa gì |
|---|---|---|
| `packages/skills/package.json` | [mới] | Package `@fox-harness/skills`, chỉ chứa file, không có code |
| `packages/skills/README.md` | [mới] | Cách DeepSeek nạp skill, các trường khai báo được đọc, bẫy viết `userInvocable` kiểu chữ hoa, quy ước tên tool |
| `packages/skills/report-writing/SKILL.md` | [mới] | Chép từ agent-core, bỏ `drivers` |
| `packages/skills/web-research/SKILL.md` + `references/` | [mới] | Chép từ agent-core. Bỏ `drivers`, `triggers` (ý đưa vào `description`). Ghi rõ tool `duckduckgo_web_search`. Sửa câu "lấy năm từ ghi chú Environment" vì fox không đưa ngày hôm nay cho model |
| `packages/skills/sql-to-insights/SKILL.md` | [mới] | Chép từ agent-core. Bỏ câu nhắc `DuckDB`, `explore-data`, `data-scientist` (fox không có) |
| `packages/skills/support-tone/SKILL.md` | [mới] | Viết lại từ code `bundles/skills/skill-support-tone/index.ts` thành file Markdown. 6 trigger đưa vào `description` |
| `packages/skills/business-case-builder/` (SKILL.md + references, templates, checklists, scripts) | [mới] | Chép từ agent-core, sửa: đổi 19 chỗ `web_search` → `duckduckgo_web_search`; bỏ `triggers`; bỏ đoạn "2 loại session / RLM / dropdown"; phần script đổi sang chạy bằng tool `bash` với `python3 <thư mục skill>/…`; bỏ mọi chỗ trỏ sang skill fox không có (`statistical-analysis`, `time-series-analysis`, `cohort-analysis`, `data-scientist`); sửa câu "hệ thống có sẵn ngày hôm nay" |
| `infra/docker/worker/Dockerfile` | [sửa] | Thêm `ENV DSH_BUNDLED_SKILL_DIR=/repo/packages/skills` |
| `pnpm-lock.yaml` | [sửa] | +2 dòng khai báo package `packages/skills` (bắt buộc, vì Dockerfile chạy `pnpm install --frozen-lockfile`) |

### Phát hiện trong lúc làm

- **Fox không đưa ngày hôm nay vào lời nhắc hệ thống** (đã xem nguyên văn
  system prompt gửi LLM: không có ngày, không có phần "Environment"). Skill
  không được giả định model biết năm hiện tại. Chưa sửa ở tầng hệ thống — ngoài
  phạm vi kế hoạch.

---

## Giai đoạn 2 — Skill riêng: tab Kỹ năng và menu "/"

### Luồng

```
tab Kỹ năng ─► gateway: POST/PUT/DELETE /custom-skills ─► MariaDB custom_skills
                   │
                   └─► orchestrator: PUT /skills-sync {sessionIds, skills}
                                        └─► <dshHomeDir>/skills/<tên>/SKILL.md ─► DeepSeek tự thấy (~30ms)
mở hội thoại  ─► gateway: sau ensureSession, trước khi nối WebSocket ─► /skills-sync cho đúng hội thoại đó
```

### File — phía server

| File | Loại | Sửa gì |
|---|---|---|
| `infra/migrations/002_custom_skills.sql` | [mới] | Bảng `custom_skills` (khoá chính `owner_id` + `name`, xoá user thì xoá skill) |
| `packages/contracts/src/index.ts` | [sửa] | Thêm kiểu `SkillFile`, `SkillsSyncRequest`, `SkillsSyncResponse` |
| `services/gateway/src/skills.ts` | [mới] | Đọc danh sách skill có sẵn từ `packages/skills/*/SKILL.md` lúc khởi động; hàm `validateSkill` (tên, mô tả ≤ 280, nội dung ≤ 64 KB, cấm trùng tên skill có sẵn); giới hạn 50 skill/user |
| `services/gateway/src/db.ts` | [sửa] | Thêm `listCustomSkills`, `countCustomSkills`, `createCustomSkill`, `updateCustomSkill`, `deleteCustomSkill`, `listSessionIdsForOwner` |
| `services/gateway/src/orchestrator-client.ts` | [sửa] | Thêm `syncSkills()` gọi `PUT /skills-sync` |
| `services/gateway/src/index.ts` | [sửa] | Route `GET /skills` (menu "/"), `GET/POST /custom-skills`, `PUT/DELETE /custom-skills/:name`; hàm `pushSkills` đồng bộ xuống orchestrator; đồng bộ lúc mở WebSocket; thêm `PUT` vào CORS. Lỗi trả kèm `code` để giao diện dịch |
| `services/orchestrator/src/skills-sync.ts` | [mới] | Ghi skill vào `<dshHomeDir>/skills/` cho hội thoại `running`/`hibernated`: ghi file mới, xoá thư mục thừa, bỏ qua file không đổi. `description` ghi dạng chuỗi JSON để `:`/`#` không làm hỏng file |
| `services/orchestrator/src/index.ts` | [sửa] | Route nội bộ `PUT /skills-sync` |

### File — giao diện

| File | Loại | Sửa gì |
|---|---|---|
| `apps/web/src/components/features/skills/skillsApi.ts` | [mới] | Gọi API skill; giữ danh sách cho menu "/" dùng chung toàn app (`refreshSkillMenu`) |
| `apps/web/src/components/features/skills/SkillsDialog.tsx` | [mới] | Hộp thoại Kỹ năng: danh sách "Skill của tôi" + "Skill có sẵn" (chỉ xem); form Tên / Mô tả (đếm 280 ký tự) / Nội dung; nút Mở rộng; Lưu, Xoá; Esc thu gọn rồi đóng |
| `apps/web/src/components/features/conversation/SkillMenu.tsx` | [mới] | Menu "/" phía trên ô chat; mở khi cả tin nhắn chỉ là `/…` |
| `apps/web/src/components/features/conversation/Conversation.tsx` | [sửa] | Gắn menu "/": ↑↓ chọn, Enter/Tab chèn `/tên `, Esc đóng |
| `apps/web/src/components/features/sidebar/Sidebar.tsx` | [sửa] | Nút "Kỹ năng" dưới "Trò chuyện mới" |
| `apps/web/src/App.tsx` | [sửa] | Mở/đóng hộp thoại Kỹ năng |
| `apps/web/src/i18n/translations.ts` | [sửa] | Chữ tiếng Việt/Anh cho Kỹ năng, menu "/", 7 mã lỗi skill |
| `apps/web/src/icons.tsx` | [sửa] | Thêm icon `SkillIcon`, `ExpandIcon`, `CollapseIcon` |
| `apps/web/public/style.css` | [sửa] | Thêm khối CSS "Skills" ở cuối file |
| `apps/web/public/main.js` | [sửa] | File build ra từ `pnpm run build` |

---

## Giai đoạn 3 — Tạo skill ngay trong chat

| File | Loại | Sửa gì |
|---|---|---|
| `packages/tool/create-skill/` (`package.json`, `cordis.patch.yml`, `tsconfig.json`, `README.md`, `src/index.ts`) | [mới] | Tool `create_skill`: **chỉ kiểm tra** (tên, độ dài, trùng skill đang có trong hội thoại, quá 50 skill riêng), không lưu. Mô tả tool mang quy tắc "lượt đầu chỉ đề xuất, lượt sau user đồng ý mới gọi" |
| `packages/profile-template/template/profile.package.json` | [sửa] | Thêm `@fox-harness/dsh-tool-create-skill` vào `bundles` |
| `package.json` (gốc) | [sửa] | Thêm `@fox-harness/dsh-tool-create-skill` vào `dependencies` (bắt buộc, code-rules §10 mục 4) |
| `tsconfig.json` (gốc) | [sửa] | Thêm `packages/tool/create-skill` vào `references` |
| `pnpm-lock.yaml` | [sửa] | Khai báo package tool mới |
| `apps/web/src/components/features/conversation/Conversation.tsx` | [sửa] | **Lưu hộ**: giữ `arguments` của `tool/call` tên `create_skill` theo `callId`; khi `tool/result` cùng `callId` thành công **và là sự kiện đang diễn ra** (không phải phát lại trong `snapshot`) → `POST /custom-skills` → thông báo "Đã lưu skill", làm mới menu "/". Lỗi 409 `skill_exists` bỏ qua (tab khác đã lưu) |
| `packages/skills/skill-creator/SKILL.md` | [mới] | Viết lại từ bản agent-core: 3 trường, quy trình đề xuất → duyệt → lưu, mẫu trình bày 2 vùng (nội dung luôn trong khối ` ```markdown `), chỉ hứa khả năng fox có |

### Lỗi tìm ra khi thử bằng trình duyệt thật, đã sửa

| File | Loại | Sửa gì |
|---|---|---|
| `apps/web/src/components/features/conversation/Conversation.tsx` | [sửa] | Khung chat hiện nguyên khối `<system-reminder>` (danh sách skill) và nội dung skill nạp bằng `/tên` thành bong bóng của user. DeepSeek chèn chúng dưới dạng tin nhắn user **cho model đọc**; trước đây fox chưa có skill nên không lộ. Giờ chỉ vẽ tin nhắn có `source.kind = "user"` (người dùng tự gõ) |
| `apps/web/src/i18n/locale.tsx` | [sửa] | Hàm `t()` dùng `replace` nên chỉ thay tham số **lần đầu** — chuỗi có `{name}` hai lần hiện sót chữ `{name}`. Đổi sang `replaceAll` |

### Kiểm tra

Chạy thật trên bộ fox đầy đủ (MariaDB, Redis, gateway, orchestrator, container
worker), model Qwen từ `.env`, bằng Chrome headless điều khiển qua CDP, tài
khoản thử `smoke-test@fox.local`:

| Kiểm tra | Kết quả |
|---|---|
| API: tạo / trùng tên (409) / tên skill có sẵn (400) / tên sai dạng (400) / thiếu nội dung (400) / sửa / xoá / xoá lần 2 (404) | ✅ |
| Tài khoản khác không thấy skill riêng | ✅ |
| File `SKILL.md` trên đĩa đổi theo khi sửa, biến mất khi xoá | ✅ |
| Chat `/bao-cao-tuan …` dùng đúng skill riêng | ✅ |
| Tab Kỹ năng: tạo qua form, thông báo, Mở rộng, Esc thu gọn rồi đóng | ✅ |
| Menu "/": hiện skill có sẵn + skill riêng (nhãn "của tôi"); gõ `/bao` + Enter chèn `/bao-cao-tuan ` | ✅ |
| Tạo skill trong chat — lượt 1 chỉ đề xuất, **không lưu** | ✅ |
| Lượt 2 "oke tạo đi" → `create_skill` → trình duyệt lưu → có trong API và menu "/" | ✅ |
| Tải lại trang (phát lại lịch sử) không lưu thêm lần nữa | ✅ |

### Lưu ý khi triển khai

- Profile của hội thoại được chép **một lần** lúc tạo thư mục hội thoại
  (`materialize.ts` không ghi đè). Hội thoại tạo **trước** khi có tool
  `create_skill` sẽ không có tool này — mở **Trò chuyện mới** để dùng.
- Sau khi build lại image worker phải thay container dựng sẵn (xoá container
  trong `fh:warmpool` + `DEL fh:warmpool`, rồi bật lại orchestrator), vì danh
  sách này nằm trong Redis, bật lại orchestrator không tự xoá.
- Gateway đọc danh sách skill có sẵn lúc khởi động — thêm skill vào
  `packages/skills` thì phải khởi động lại gateway.

---

## Dựng bộ fox trên máy này

Không sửa file nào của repo cho việc dựng máy. Các file dưới đây nằm trong
`data/`, là thư mục git bỏ qua.

| Việc | Chi tiết |
|---|---|
| Redis + MariaDB | `docker compose -p fox-harness -f infra/docker/docker-compose.dev.yml -f data/compose.local.yml up -d`. Container `fox-harness-redis-1` (cổng **6390**), `fox-harness-mariadb-1` (cổng 3307) |
| `data/compose.local.yml` | Đổi cổng Redis sang 6390, vì cổng 6379 đã bị Redis của dự án khác (`nghechuanai-backend-redis-1`) chiếm |
| `REDIS_URL` | Truyền từ dòng lệnh `redis://127.0.0.1:6390` khi chạy gateway và orchestrator. **Không sửa `.env`** — biến dòng lệnh thắng giá trị trong `.env` (đã thử) |
| Migration | `infra/migrations/001_init.sql` và `002_custom_skills.sql` đã chạy |
| Image worker | `docker build -f infra/docker/worker/Dockerfile -t fox-harness-worker:dev .` |
| `data/fox-run.sh` | Bật/tắt/khởi động lại service, tự truyền `REDIS_URL`. Tìm tiến trình theo dòng lệnh thật (không dùng file PID) |
| Log | `data/logs/orchestrator.log`, `gateway.log`, `web.log`, `worker-build.log` |

### Lệnh hay dùng

```bash
cd fox-harness-core
data/fox-run.sh status                 # xem 3 service
data/fox-run.sh restart gateway        # sau khi sửa services/gateway
data/fox-run.sh restart orchestrator   # sau khi sửa services/orchestrator
pnpm run build                         # sau khi sửa apps/web — web tự đọc file mới, chỉ cần tải lại trang
```

Sửa `packages/*` (tool, skill có sẵn) thì phải build lại image worker và thay
container dựng sẵn (xem "Lưu ý khi triển khai" ở giai đoạn 3).

### Vào xem

Mở `http://localhost:5173`. Đang dùng máy qua SSH thì chuyển tiếp **cả 2 cổng
5173 và 4000** (web gọi gateway ở `localhost:4000`).
