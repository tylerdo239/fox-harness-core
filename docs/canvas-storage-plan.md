# Canvas: giới hạn dung lượng và cho user xoá (plan, 2026-10-16)

Trạng thái: **xong 2026-10-16** (mục "Đã làm" cuối file). Ba điểm "Chưa quyết" được chốt theo đề xuất. Nối tiếp `storage-quota-plan.md` (quota 200 MB/user, tab Dung lượng, dọn file) và
`workspace-symlink-isolation-plan.md` (mọi đọc/ghi file đi qua `runtime/safe-fs.ts`).

**Không đổi DB.** Không có bảng mới, không có migration MariaDB, không có key Redis mới. Lý do ở mục "Vì sao không dùng
DB".

## Hiện trạng (đọc code sau khi merge `feat/data-analysis`)

Canvas tạo ra hai loại file:

| Loại | Đường dẫn | Ai tạo | Có gì trỏ tới nó | Tab Dung lượng |
|---|---|---|---|---|
| **A. Phiên bản do model tạo** | `generated/<chat>/canvas-<id>-vN.<ext>` (chat không thuộc dự án: ở gốc thư mục, rồi reconcile dời vào `generated/<chat>/`) | tool `canvas_write` (runtime) | Marker `<!--fox-canvas:…-->` trong log chat | Hiện, xoá được từng file |
| **B. Snapshot và bản user sửa** | `.canvas/canvas-<id>-<Date.now()>.<ext>` (ẩn) | FE: `uploadCanvasSnapshot` (`purpose=canvas`) | **Chỉ bộ nhớ của tab** (zustand `useCanvasStore`) | **Không hiện, không xoá được, nhưng tính vào quota** |

Ba lỗi của loại B (`app/src/components/features/canvas/canvas.ts`):

1. **Mất khỏi lịch sử sau reload.** `applyCanvasMarker` dựng lại danh sách phiên bản chỉ từ marker của model. Bản user
   bấm Lưu (`saveCanvasEdit`) và snapshot file biến mất khỏi panel sau F5, trong khi byte vẫn nằm trên đĩa và S3. Đó là
   rác vĩnh viễn, và user cũng mất luôn bản đã sửa.
2. **Chép lặp lại.** `openWorkspaceFileInCanvas`, với xlsx/docx/pdf/ảnh: store trống sau reload, nên
   `latest?.modified !== file.modified`. FE tải cả file về rồi upload lại dưới một tên mới (`Date.now()`). Một file
   Excel 10 MB mở lại 20 lần là 200 MB, tức hết quota của một user, mà user không thấy file nào.
3. **Hết quota thì lỗi câm.** `uploadCanvasSnapshot` throw một `Error('HTTP 507')` chung chung, không phải
   `StorageFullError`. Lúc tự mở canvas cuối lượt thì lỗi bị nuốt hẳn (`WorkspaceFiles.tsx`).

Ngoài ra, `clearWorkspace` ("Xoá tất cả file") và lệnh dọn chỉ xoá file **nhìn thấy được** (`visible()`), nên bỏ qua
`.canvas/`.

## Thiết kế

### 1. Snapshot chép ở phía server, đặt tên cố định, không lặp

`POST /(sessions|projects)/:id/files/<path>?snapshot=1`, không có body:
- Gateway mở `<path>` bằng `openInside` (file nguồn phải là file nhìn thấy được, như `GET`).
- Tên đích **tính từ file**: `.canvas/s-<sha1(path):12>-<mtimeMs>-<size>.<ext>`. Cùng file và cùng trạng thái thì
  cùng tên.
- Tên đích đã có thì trả `200 {path}` và không chép. Chưa có thì `checkUpload(owner, size)`, chép bằng
  `createInside` (stream từ fd nguồn), rồi trả `201 {path}`.
- Bỏ được việc trình duyệt tải về rồi upload lại (một file 20 MB đi hai chiều), và bỏ được bản sao lặp.

FE `openWorkspaceFileInCanvas` gọi route này thay cho `fetch` + `uploadCanvasSnapshot`.

### 2. Chỉ mục lịch sử: `.canvas/index.json` (mỗi thư mục một file)

```json
{
  "v": 1,
  "canvases": {
    "bao-cao": [
      { "version": 4, "path": ".canvas/u-bao-cao-1739.md", "source": "user", "at": "2026-10-16T09:00:00Z", "bytes": 1200 }
    ],
    "ws-doanh-thu-3fa1": [
      { "version": 1, "path": ".canvas/s-ab12cd34ef56-1739000-10485760.xlsx", "source": "snapshot", "at": "…", "bytes": 10485760, "of": "doanh_thu.xlsx" }
    ]
  }
}
```

- **Chỉ gateway ghi**, qua `writeFileInside` (ghi file tạm rồi đổi tên), một lần ghi cho mỗi thư mục tại một thời
  điểm (cùng kiểu với `updateSources`).
- Ghi khi:
  - tạo snapshot (mục 1);
  - lưu bản sửa (`purpose=canvas`, thêm tham số `canvas=<id>`);
  - xoá (mục 4).
- **Chỉ gồm loại B.** Phiên bản model (A) vẫn lấy từ marker, nên không trùng.
- `GET /(sessions|projects)/:id/canvas` trả nội dung chỉ mục. Khi mở chat, FE gộp danh sách này với marker, nên bản
  user sửa còn nguyên sau reload.
- Là **nguồn sự thật duy nhất** cho `.canvas/`: file nào trong `.canvas/` không có trong chỉ mục (gồm cả bản do code cũ
  để lại) thì bị dọn, xem mục 3.
- Python của model ghi được vào `.canvas/`, vì thư mục làm việc được mount đọc-ghi trong sandbox, nên có thể sửa chỉ
  mục. Chuyện này không nguy hiểm: mọi đường dẫn trong chỉ mục đều được kiểm lại bằng `resolveInside({canvas: true})`
  và mở qua `safe-fs`, nên chỉ trỏ được vào chính thư mục đó. Tệ nhất là model làm mất lịch sử canvas của chính chat
  đó, giống như nó vốn xoá được file của chính nó.

### 3. Giới hạn

| Giới hạn | Mặc định (env) | Khi vượt |
|---|---|---|
| Số bản loại B cho mỗi canvas | 10 (`CANVAS_HISTORY_MAX`) | Khi thêm bản mới: xoá bản cũ nhất (đĩa, S3, stamp Redis) và bỏ khỏi chỉ mục |
| File trong `.canvas/` không có trong chỉ mục | — | Xoá ngay trong lần ghi chỉ mục kế tiếp, và trong lượt dọn theo lịch |
| Quota user | `USER_FILE_QUOTA_BYTES` (đã có) | Snapshot hoặc bản sửa bị 507 `storage_quota` (FE xử lý ở mục 5) |
| Bucket đầy | `STORAGE_BLOCK_PERCENT` (đã có) | 507 `storage_full` |
| Phiên bản model (A) | Không xoá tự động: chat cũ có marker trỏ tới | User tự xoá (mục 4) |

`.canvas/` **vẫn tính vào quota**, như hiện tại, nhưng **không tính là "dùng gần đây"** khi xét file không dùng: mở
một file là sinh snapshot, giống cách `.fox/` được bỏ qua.

### 4. User thấy được và xoá được

`GET /storage` thêm cho mỗi thư mục:

```json
{
  "kind": "project", "id": "…", "bytes": 50331648,
  "files": [ … file nhìn thấy, như hiện tại; phiên bản canvas loại A được tách sang `canvases` … ],
  "canvases": [ { "id": "bao-cao", "title": "Báo cáo", "versions": 7, "bytes": 12582912, "latest": "generated/<chat>/canvas-bao-cao-v7.md" } ],
  "canvasHistory": { "files": 17, "bytes": 17825792 }
}
```

Tab Dung lượng:

```
📁 Dự án Doanh thu Q3                          48 MB
   don_hang_2025.csv                           19 MB   [Xoá]
   Báo cáo (canvas) — 7 phiên bản              12 MB   [Giữ bản mới nhất] [Xoá hết]
   Lịch sử canvas (snapshot, bản đã sửa)       17 MB   [Xoá lịch sử]
   [Xoá tất cả file]
```

| Nút | Route | Xoá gì |
|---|---|---|
| Giữ bản mới nhất | `DELETE /storage/(sessions\|projects)/:id/canvases/:canvasId?keep=latest` | `canvas-<id>-v1…v(N-1)` (loại A) |
| Xoá hết (một canvas) | `DELETE …/canvases/:canvasId` | mọi phiên bản A của canvas đó, cùng các bản B của nó trong chỉ mục |
| Xoá lịch sử | `DELETE /storage/(sessions\|projects)/:id/canvas-history` | toàn bộ `.canvas/` và chỉ mục. File gốc và phiên bản A giữ nguyên |
| Xoá tất cả file | (đã có) | file nhìn thấy, **thêm `.canvas/`** |
| Xoá một bản trong panel | `DELETE …/files/.canvas/<name>` | một bản B. `resolveInside` cho phép `.canvas/` với cả `DELETE` |

- Lệnh dọn của admin và lệnh dọn theo lịch (`cleanupOldFiles`) cũng xoá `.canvas/` của thư mục bị dọn.
- Mọi lệnh xoá:
  - đi qua `removeInside`;
  - xoá cả bản trên S3 và stamp Redis (như `clearWorkspace`), và dừng lượt quét archive trong lúc xoá;
  - gọi `noteFreed`;
  - ghi log `canvas_deleted {owner, what, files, bytes}`.
- Thư mục đã rời đĩa (evicted): xoá thẳng trên S3, như xoá file hiện nay. Riêng chỉ mục thì phải tải `index.json` về
  trước, hoặc khôi phục cả thư mục. Bản đầu chọn cách khôi phục thư mục rồi xoá, vì đơn giản hơn.

### 5. Luồng ở FE

```
Mở file Excel/Word/PDF/ảnh trong canvas
  └─ POST …/files/<path>?snapshot=1
       ├─ 200/201 → hiện bản snapshot, có trong lịch sử (index.json)
       └─ 507 → vẫn mở FILE GỐC, chỉ xem (không lưu lịch sử, không so sánh phiên bản)
                + toast "Hết dung lượng" có nút [Quản lý dung lượng]   (showNoSpace)

Bấm Lưu bản sửa
  └─ POST …/files?name=…&purpose=canvas&canvas=<id>
       ├─ 201 → phiên bản mới (đã ghi chỉ mục; còn sau reload)
       └─ 507 → nội dung giữ nguyên trong panel (chưa lưu)
                + toast "Hết dung lượng" + [Quản lý dung lượng]

Mở chat
  └─ GET …/canvas → gộp với marker → panel có đủ phiên bản (model + user + snapshot)

Một phiên bản đã bị xoá (marker cũ, hoặc chỉ mục trỏ tới file không còn)
  └─ 404 → panel ghi "Phiên bản này đã bị xoá", không báo lỗi chung, vẫn chuyển được sang các bản khác
```

`uploadCanvasSnapshot` và `fetchCanvasFile` dùng `storageCodeOf` / `StorageFullError` (`settings/storageApi.ts`),
giống phần upload đính kèm.

## Vì sao không dùng DB

Có thể làm bảng MariaDB `canvas_versions(dir_key, canvas_id, version, path, source, bytes, created_at)`. Chọn file
`index.json` vì:
- **File và chỉ mục đi cùng nhau.** `index.json` nằm trong thư mục, nên được đẩy lên S3, khôi phục, rời đĩa
  (evict) và bị xoá khi purge chat/dự án đúng như các file mà nó mô tả. Dùng bảng DB thì phải giữ hai nơi khớp nhau ở
  mọi đường: archive, restore, purge, cleanup, xoá dự án, cùng các trường hợp lỗi giữa chừng.
- **Cách làm sẵn có.** `.fox/sources.json` (file user upload) và `.fox/datasets.json` (dataset card) đã là chỉ mục dạng
  file theo đúng mẫu này. Ghi qua `writeFileInside`, đọc qua `readTextInside`.
- **Không cần truy vấn chéo.** Tab Dung lượng và lệnh dọn vốn đã duyệt theo từng thư mục (`dirUsage`). Không có câu
  hỏi nào kiểu "mọi canvas của mọi user".
- **Không cần migration**, nên deploy staging không thêm bước nào.

Đổi lại: thư mục đã rời đĩa thì phải khôi phục mới đọc được chỉ mục. Việc này chỉ xảy ra khi user xoá lịch sử canvas
của một chat lâu không mở, chấp nhận được.

Redis: không thêm key. Các file trong `.canvas/` vẫn có stamp `fh:workspace-archive:<dirKey>` như mọi file khác. Regex
`TEMPORARY` của archive thêm tên file tạm của `index.json` (`index.json.<pid>.<rand>`).

## Thứ tự làm

1. **Gateway**: `?snapshot=1` (mục 1), chỉ mục và `GET …/canvas` (mục 2), `CANVAS_HISTORY_MAX` và dọn file ngoài chỉ
   mục (mục 3).
2. **Gateway**: `GET /storage` thêm `canvases` và `canvasHistory`. Các route xoá ở mục 4. `clearWorkspace` và lệnh
   dọn có xoá `.canvas/`.
3. **FE**:
   - canvas dùng `?snapshot=1`, `GET …/canvas` và `canvas=<id>` khi lưu;
   - xử lý 507 và 404 (mục 5);
   - tab Dung lượng hiện nhóm canvas và lịch sử, có các nút xoá;
   - i18n vi/en.
4. Docs: `storage-quota-plan.md` (API, log), user manual `data-and-limits.md` (lịch sử canvas tính vào dung lượng,
   cách xoá).

Bước 1–2 làm xong là đã chặn được đà phình. Bước 3 cho user nhìn thấy và xoá được.

## Kiểm thử (e2e, mở rộng `storageQuota`)

1. Mở cùng một file xlsx 3 lần (3 lần gọi `?snapshot=1`): chỉ có 1 file trong `.canvas/`; lần 2 và lần 3 trả 200 với
   cùng `path`.
2. Model ghi đè file (mtime đổi) rồi mở lại: thêm đúng 1 bản. Chỉ mục có 2 mục.
3. Lưu 12 bản sửa cho một canvas (`CANVAS_HISTORY_MAX=10`): còn 10 file và 10 mục trong chỉ mục. Hai bản cũ nhất mất
   cả trên S3.
4. Có một file lạ trong `.canvas/` (không nằm trong chỉ mục): mất ở lần ghi chỉ mục kế tiếp.
5. `GET /storage`: `canvasHistory.bytes` khớp tổng cỡ, `usedBytes` gồm cả nó. "Xoá lịch sử" trả 200, sau đó
   `.canvas/` rỗng và `usedBytes` giảm đúng bằng đó.
6. "Giữ bản mới nhất": còn `v7`, các bản `v1–v6` mất trên đĩa và S3. Mở lại chat thì panel báo bản cũ "đã bị xoá",
   không lỗi.
7. Hết quota: `?snapshot=1` trả 507 `storage_quota`, không ghi byte nào. FE mở file gốc và hiện toast.
8. "Xoá tất cả file" và lệnh dọn của admin: `.canvas/` cũng mất.
9. Symlink: `.canvas` là link sang thư mục khác thì snapshot, lưu và xoá đều bị từ chối (chạy lại
   `canvasSymlinkIsolation` với các route mới).

## Đã chốt (2026-10-16, theo đề xuất)

- Bản cũ nhất bị xoá khi vượt `CANVAS_HISTORY_MAX` có cần báo cho user không? Đề xuất: không báo, chỉ ghi log.
- Phiên bản model (A) có cần giới hạn tự động không, ví dụ chỉ giữ 20 bản mới nhất cho mỗi canvas? Đề xuất: chưa làm.
  Để user xoá bằng tay, vì chúng được nhắc tới trong log chat.
- Chat data-analysis không thuộc dự án: canvas ghi ở gốc thư mục rồi bị reconcile dời đi (đường dẫn trong marker có
  thể sai sau lượt). Nên sửa cùng đợt này: cho canvas ghi thẳng vào `generated/<chat>/` khi không có `outputDir`.

## Đã làm (2026-10-16)

**Gateway:**
- `runtime/canvas-history.ts` (mới):
  - chỉ mục: đọc lọc chặt các mục, chỉ nhận đường dẫn trong `.canvas/`; mỗi thư mục ghi một lần một lúc;
  - `snapshotFile` (tên file tính từ đường dẫn, mtime và cỡ), `recordEdit`;
  - giới hạn theo `CANVAS_HISTORY_MAX`, dọn file không có trong chỉ mục (cũ hơn 10 phút);
  - `clearHistory`, `deleteHistoryFile`, `deleteCanvas({keepLatest})`, `modelCanvases`, `historyUsage`.
- `workspace-archive.ts`: thêm `deleteFiles(dir, select)` (đĩa, S3 và stamp, dừng lượt quét trong lúc xoá).
  `clearWorkspace` giờ dùng hàm này và xoá cả `.canvas/`.
- `storage.ts`:
  - `GET /storage` có thêm `canvases` và `canvasHistory`; phiên bản canvas không còn nằm trong `files`;
  - lệnh dọn xoá cả `.canvas/`, nhưng mốc "dùng lần cuối" chỉ tính file nhìn thấy được.
- `index.ts`:
  - `POST …/files/<path>?snapshot=1&canvas=<id>`;
  - `GET …/canvas`;
  - `POST …/files?purpose=canvas&canvas=<id>&version=<n>` (ghi vào chỉ mục);
  - `DELETE …/files/.canvas/<name>`;
  - `DELETE /storage/…/canvas-history`, `DELETE /storage/…/canvases/:id[?keep=latest]`;
  - log `canvas_deleted`, và `canvas_history_pruned` khi tự xoá bản cũ.
- Biến mới `CANVAS_HISTORY_MAX` (mặc định 10, có trong `api/.env.example`). Regex `TEMPORARY` thêm tên file tạm của
  `index.json`.

**Tool canvas:**
- Chat không thuộc dự án ghi thẳng vào `generated/<chat>/`.
- Số phiên bản kế tiếp luôn lớn hơn số lớn nhất của các bản user đã lưu trong chỉ mục.

**FE:**
- `canvas.ts`:
  - `?snapshot=1` thay cho tải về rồi upload lại;
  - `loadCanvasHistory` chạy sau khi nhận snapshot của chat (`Conversation.tsx`);
  - 507 thành `StorageFullError`: mở file gốc, chỉ xem, và hiện toast "Quản lý dung lượng";
  - 404 thành "Phiên bản này đã bị xoá".
- `CanvasPanel`: hết chỗ khi Lưu thì bản đang sửa vẫn ở trong trình sửa, kèm toast.
- Tab Dung lượng: dòng cho từng canvas (Giữ bản mới nhất, Xoá hết) và dòng "Lịch sử canvas" (Xoá lịch sử). i18n vi/en.

**Không đổi DB.**

**Kiểm chứng:**
- e2e `canvasStorage`: 27 check qua, trong môi trường e2e `CANVAS_HISTORY_MAX=3`. Đủ 9 bước của mục Kiểm thử, thêm
  bước 10: canvas ở chat không thuộc dự án vẫn còn đúng đường dẫn sau khi lượt kết thúc.
- Toàn bộ suite: **30/30** qua (chế độ `strict`). Typecheck backend và FE sạch.
- Canvas cũ (tạo trước 2026-10-16, chat không thuộc dự án): marker còn trỏ tới gốc thư mục, `canvas-<id>-vN.<ext>`.
  `canvas.ts` `resolveCanvasPath` lấy danh sách file một lần (giữ 30 giây) và đi theo file tới `generated/<chat>/`, nơi
  reconcile đã dời nó tới. File không còn ở đâu cả thì panel ghi "đã bị xoá". Trước khi sửa, các lần ghi đều đánh số
  lại thành v1 và đè lên nhau trong `generated/<chat>/`, nên chỉ cứu được bản cuối cùng. Kiểm bằng script phát lại
  marker với một files route giả lập: 6/6 trường hợp đúng.
- **Chưa xem UI trên trình duyệt**: tab Dung lượng và panel canvas mới chỉ được kiểm qua API và typecheck.
