# Chặn đọc/ghi lọt khỏi thư mục làm việc qua symlink (plan, 2026-10-16)

Trạng thái:
- **Gateway: xong 2026-10-16** (G1–G6, lớp 1). Chi tiết ở mục "Đã làm (gateway)" cuối file.
- **Canvas (C1–C2, lớp 1 và lớp 2) và runtime (R1–R3): xong 2026-10-16**, sau khi merge `feat/data-analysis`. Chi tiết
  ở mục "Đã làm (canvas và runtime)" cuối file.
- Lớp 3 (dọn symlink): để sau.

## Vấn đề

Ở chế độ `FOX_SANDBOX_MODE=strict`, code Python của model chạy trong bubblewrap (`api/docker/fox-confine.sh`) và
chỉ thấy thư mục làm việc của chat. Có điều nó vẫn **tạo được symlink** trong thư mục đó, trỏ tới bất cứ đâu:

```python
os.symlink('/proc/self/environ', 'env.txt')          # biến môi trường của process nào mở nó
os.symlink('/data/users/7/<sid>/luong.xlsx', 'a.xlsx')  # file của user khác
os.symlink('/data/users/7/<sid>', 'dir_link')           # cả thư mục của user khác
```

Trong sandbox thì các link này không mở được, vì chúng trỏ ra ngoài. Nhưng **gateway** và **runtime** chạy ngoài
sandbox. Hai process này kiểm tra đường dẫn **dạng chuỗi** (`resolve` + `relative`), rồi mở file bằng các lệnh có
đi theo symlink (`stat`, `readFile`, `copyFile`, `createReadStream`, `writeFile`, `rm`). Kết quả là chúng đọc, ghi
hoặc xoá **file thật ở ngoài** thay cho model.

Ở chế độ `none` (staging hiện tại), Python vốn đã đọc được mọi thứ, nên lỗi này không làm staging tệ hơn. Plan này
giữ cho chế độ `strict` đúng với lời hứa của nó.

### Những chỗ bị ảnh hưởng

| # | Chỗ | Process | Lọt kiểu gì | Hậu quả |
|---|---|---|---|---|
| G1 | `GET /…/files/<path>` (`index.ts`, `resolveInside` + `stat` + `createReadStream`) | gateway | đọc | User tải `env.txt` là lấy được env của **gateway**: `DATABASE_URL`, `S3_SECRET_ACCESS_KEY`, `REDIS_URL`, key LLM. Hoặc lấy file của user khác. |
| G2 | `DELETE /…/files/<path>` (`deleteWorkspaceFile`, `rm`) | gateway | xoá | `rm` không đi theo symlink ở **tên file**, nhưng có đi theo **thư mục cha**: `DELETE dir_link/luong.xlsx` xoá file của user khác. |
| G3 | Upload (`saveUpload`, `createWriteStream('.<name>.part')`) | gateway | ghi | Python đặt sẵn `.<name>.part` là symlink, upload sẽ ghi đè lên file đích ở ngoài. |
| G4 | `promoteOutput` (`copyFile`) | gateway | đọc và ghi | Nguồn trong `generated/<sid>/` là symlink thì chép file ngoài vào `outputs/`. Đích `outputs/<tên>` là symlink thì ghi ra ngoài. |
| G5 | Khôi phục từ S3 (`workspace-archive.ts` `restore`, `downloadArchiveObject`) | gateway | ghi | Tìm ra khi làm. File tạm `.<tên>.restore` hoặc thư mục cha là symlink, thì nội dung từ S3 bị ghi ra ngoài. Khôi phục chạy cả khi thư mục chỉ còn symlink, vì `filesOf` bỏ qua symlink nên coi thư mục là rỗng. |
| G6 | Lượt quét đẩy lên S3 (`readFile(f.full)`) | gateway | đọc | Tìm ra khi làm. Python tráo file thành symlink sau khi liệt kê, thì file ở ngoài bị đẩy lên S3 dưới thư mục của user này. Lần khôi phục sau sẽ tải nó về. |
| C1 | `canvas_write` đọc nguồn (`kind:"file"`, file văn bản, trường hợp `path` không kèm `content`) | runtime | đọc | Env của runtime: key LLM, `DREMIO_PASSWORD`, `MEILISEARCH_MASTER_KEY`, `MONGODB_URL`, `FOX_INTERNAL_SECRET`. Hoặc file của user khác. |
| C2 | `canvas_write` ghi `canvas-<id>-vN.*` (`writeFile`, `copyFile`, `mkdir`) | runtime | ghi | Python đặt sẵn tên phiên bản kế tiếp là symlink, canvas sẽ ghi đè file ở ngoài. |

G1–G4 nằm trên nhánh hiện tại. C1–C2 nằm trên `feat/data-analysis` (`api/packages/tool/canvas/src/index.ts`).

Tìm thêm khi làm canvas. Các lỗi này nằm trong runtime, ngoài sandbox, và R1, R2 đã có sẵn trước khi có canvas:

| # | Chỗ | Lọt kiểu gì | Hậu quả |
|---|---|---|---|
| R1 | `reconcileWorkspace` cuối lượt (`flow/data-analysis/src/reconcile.ts`, `mkdir` + `rename` vào `generated/<chat>/`) | ghi | Python thay `generated/<chat>` bằng link sang thư mục user B, thì **file của A bị dời sang thư mục của B**. Đã tái hiện trong e2e. |
| R2 | File đánh dấu `.python-session` (`python-repl/src/kernel.ts`, `writeFileSync`) | ghi | Link ở tên này thì mỗi lần Python khởi động lại ghi đè file đích bằng một dòng giờ. |
| R3 | `.fox/sources.json`, `.fox/datasets.json` (gateway `workspace-files.ts`, `dataset-cards.ts`; runtime `datasets.ts`) | đọc và ghi | Python thay `.fox` bằng link, thì gateway ghi danh sách nguồn và dataset card vào thư mục khác, còn runtime đọc card của người khác vào prompt. |

Đã kiểm tra là **không** bị ảnh hưởng:
- `listWorkspaceFiles` và lượt quét archive (`filesOf`): dùng `readdir` với `withFileTypes`, mà symlink có
  `isFile() === false`, nên bị bỏ qua.
- `dataset-cards.ts`: có `stat` đi theo symlink, nhưng việc đọc file là do `dataset_cards.py` làm trong sandbox, nên
  symlink trỏ ra ngoài thành link hỏng.
- Tool `read`/`write` của dsh: `dsh-fs-sandbox` dùng `realpath` để chuẩn hoá đường dẫn. **Cần đọc kỹ để xác nhận**
  (mục Kiểm thử, bước 6).

### Vì sao chỉ thêm `realpath` rồi kiểm tra là chưa đủ

Python của chat sống liên tục giữa các lần gọi tool. Một thread chạy nền có thể đổi `x.txt` qua lại giữa một file
thật và một symlink, đủ nhanh để lọt vào khoảng giữa lúc `realpath` kiểm tra và lúc `open` mở file (lỗi kiểu TOCTOU).
Vì vậy phải **mở file trước, rồi kiểm tra chính file vừa mở**, không kiểm tra theo đường dẫn.

## Lớp 1: mở file an toàn trong thư mục (gateway và canvas)

Một hàm nhỏ, khoảng 60 dòng, dùng cho mọi thao tác file của gateway và canvas trên thư mục làm việc.

```ts
/** Mở `rel` bên trong `root`, hoặc throw. Kết quả là file thường nằm thật sự trong root (đã kiểm trên fd). */
openInside(root: string, rel: string, mode: 'read' | 'create'): Promise<FileHandle>
```

**Đọc** (`mode: 'read'`):
1. `realRoot = realpath(root)`. Gọi 1 lần cho mỗi request.
2. `open(join(root, rel), O_RDONLY | O_NOFOLLOW | O_NONBLOCK)`.
   - `O_NOFOLLOW`: tên file là symlink thì trả `ELOOP`.
   - `O_NONBLOCK`: một FIFO do Python tạo (`os.mkfifo`) không làm request treo mãi khi mở.
3. `real = readlink('/proc/self/fd/' + fd)`. Đây là đường dẫn **thật** của file đã mở, kể cả khi một thư mục cha là
   symlink. Nếu `real` không bắt đầu bằng `realRoot + sep` thì đóng fd và throw.
4. `fh.stat()`: chỉ chấp nhận `isFile()`. Từ chối FIFO, socket, thiết bị. Cỡ file và giới hạn cỡ lấy **từ fd**.
5. Mọi thao tác đọc tiếp theo (stream, `readFile`, chép) đi qua `fh`, không mở lại theo đường dẫn.

**Tạo file mới** (`mode: 'create'`):
1. Mở thư mục cha: `open(parent, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)`, rồi kiểm tra `/proc/self/fd/<dirfd>` nằm
   trong `realRoot`.
2. Tạo file **qua thư mục đã mở**:
   `open('/proc/self/fd/<dirfd>/<tên>', O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o644)`.
   - Đường dẫn `/proc/self/fd/<dirfd>/…` đi qua đúng thư mục đã kiểm, nên đổi thư mục cha sau bước 1 cũng không có tác dụng.
   - `O_EXCL`: tên đã tồn tại thì trả `EEXIST`, kể cả khi tên đó là symlink. Vì vậy không bao giờ ghi xuyên qua một link.
3. Kiểm tra lại `/proc/self/fd/<fd>` của file mới tạo, để chắc thêm.

**Xoá**: mở thư mục cha như bước 1 ở trên, rồi `rm('/proc/self/fd/<dirfd>/<tên>')`. Lệnh này xoá đúng mục trong
thư mục đã kiểm. Nếu mục đó là symlink thì xoá chính cái link, không xoá file đích.

**`/proc` chỉ có trên Linux.** Production, staging và container đều là Linux. Khi chạy trực tiếp trên macOS (dev),
hàm dùng tạm `realpath(fd path)` sau khi mở. Cách này vẫn chặn được symlink đặt sẵn, chỉ không chặn được kiểu đổi
link liên tục. Chế độ `strict` chỉ chạy trong container Linux, nên chỗ hở này không bao giờ xuất hiện ở nơi cần chặn.

### Đặt ở đâu
- Gateway: `api/services/gateway/src/runtime/safe-fs.ts`.
- Canvas: một bản sao nhỏ trong `api/packages/tool/canvas/src/safe-fs.ts`. Package không import code của service
  (`docs/code-rules.md` §1), nên chép nguyên văn, có comment trỏ về bản kia, như cách đã làm với `MAX_FRAME_BYTES`.
  Nếu muốn dùng chung, có thể tách thành một package nhỏ `api/packages/safe-fs`. Quyết định khi làm.

### Áp vào đâu

| Chỗ | Thay đổi |
|---|---|
| G1 GET file | `openInside(dir, path, 'read')` thay cho `resolveInside` + `stat`. Lấy `content-length` từ `fh.stat()`, stream bằng `fh.createReadStream()`. Lỗi `ELOOP` hoặc nằm ngoài thì trả **404**, cùng câu trả lời với file không tồn tại. |
| G2 DELETE | Xoá qua dirfd như trên. `noteFreed` lấy cỡ từ `lstat` qua cùng dirfd. |
| G3 upload | File `.part` được tạo bằng `mode: 'create'`, có `O_EXCL`. Nếu `.part` cũ còn sót, kể cả là symlink, thì xoá nó qua dirfd rồi tạo lại. `rename(partial, target)` giữ nguyên: rename thay thế chính mục đích, không đi theo symlink. |
| G4 `promoteOutput` | Nguồn mở bằng `'read'`, đích tạo bằng `'create'`, chép bằng `pipeline(src.createReadStream(), dst.createWriteStream())`. Đích đã tồn tại thì đặt tên kế tiếp (`freeName`), như hiện nay. |
| C1 canvas đọc nguồn | `'read'` cho cả ba nhánh: `kind:"file"`, file văn bản, `path` không kèm `content`. Giới hạn 4 MB và 20 MB kiểm trên `fh.stat()`. |
| C2 canvas ghi phiên bản | `mkdir(outDir)`, rồi tạo `canvas-<id>-vN.*` bằng `'create'`. Gặp `EEXIST` (Python đặt sẵn tên, hoặc hai lần gọi đua nhau) thì tăng N và thử lại, tối đa vài lần. |

`resolveInside` vẫn được giữ để lọc đường dẫn dạng chuỗi (`..`, file ẩn, `.canvas/`) **trước** khi mở, nhưng không
còn là chốt chặn duy nhất.

Vẫn còn một chỗ chấp nhận: `mkdir(outDir, { recursive: true })` đi theo symlink ở thư mục cha. Nếu `generated` là
một symlink, một thư mục **rỗng** có thể bị tạo ra ở ngoài. Không có nội dung nào được ghi vào đó, vì bước tạo file
qua dirfd sẽ phát hiện và từ chối.

## Lớp 2: canvas đọc file nguồn trong sandbox

Lớp 1 đã chặn được. Lớp 2 thêm một tầng cho C1: **tiến trình đọc file nguồn chỉ thấy đúng những gì Python thấy**.
Nếu Lớp 1 có sai sót, symlink trỏ ra ngoài vẫn chỉ là một link hỏng.

Cách làm giống `dataset-cards.ts`, chỗ đã dùng runner theo kiểu này:

```ts
// runtime có sẵn FOX_CONFINE_RUNNER (runtime/supervisor.ts) khi sandbox bật
spawn(runner, ['--ro-bind', '/', '/', '--bind', cwd, cwd, '--', '/usr/bin/cat', '--', sourceAbs], { env: { PATH } })
```

- Không truyền `--tmpfs`, nên `fox-confine.sh` mount thư mục làm việc **chỉ đọc**. Process có
  `--unshare-net --cap-drop ALL` và env sạch.
- Đọc stdout tới tối đa 4 MB (văn bản) hoặc 20 MB (`kind:"file"`) cộng 1 byte. Vượt quá thì kill và báo lỗi cỡ.
  Timeout 30 giây.
- Exit khác 0 (file không có, link hỏng) thì báo lỗi `no file at "<path>"`, như hiện nay.
- Runtime ghi các byte nhận được vào `canvas-<id>-vN.*` bằng **Lớp 1** (`'create'`). Việc ghi vẫn ở ngoài sandbox,
  vì sandbox mount thư mục chỉ đọc, và vì `O_EXCL` qua dirfd đã chặn việc ghi xuyên link.
- `isFile()` và kích thước: dùng `fh.stat()` của Lớp 1 trước khi spawn, để báo lỗi sớm và rõ (loại file, quá cỡ).
  Sandbox là lớp đọc thật.
- Không có runner (dev không có bwrap): chỉ dùng Lớp 1. Ở chế độ `none`, runner là `fox-noconfine.sh`, chỉ `cd` vào
  thư mục, nên Lớp 2 không thêm gì nhưng cũng không hại.
- Chi phí: một lần spawn, khoảng vài chục ms cho mỗi lần `canvas_write`, so với một lượt model mất vài giây.

**Không áp Lớp 2 cho gateway (G1–G4).** Spawn sandbox cho mỗi lần tải file là quá nặng, mà Lớp 1 đã kiểm trên chính
fd. Nếu sau này muốn chắc hơn nữa, gateway có thể chạy dưới một uid không đọc được thư mục của người khác. Việc đó
ngoài phạm vi plan này.

## Thứ tự làm

1. `safe-fs.ts` của gateway, kèm unit test (mục Kiểm thử, bước 1).
2. G1, G2, G3, G4 trên nhánh hiện tại, kèm e2e. Phần này làm được ngay, không phải chờ merge canvas.
3. Sau khi merge `feat/data-analysis`, hoặc nhờ tác giả làm trên nhánh đó: C1 và C2 bằng Lớp 1, rồi Lớp 2 cho C1.
4. Cập nhật `docs/multi-user-authz.md`, mục cô lập giữa user.

## Kiểm thử

Chạy e2e ở chế độ `strict` (`scripts/e2e-up.sh`, có bwrap). Python của chat A tạo:

| Link | Trỏ tới |
|---|---|
| `env.txt` | `/proc/self/environ` |
| `other.csv` | một file trong thư mục của user B |
| `dir_link/` | thư mục của user B |
| `.up.csv.part` | một file "mồi" ở ngoài thư mục, ghi lại nội dung ban đầu |
| `generated/<sid>/canvas-r-v2.md` | một file "mồi" khác ở ngoài |

Kết quả phải đạt:
1. Unit test `openInside`: symlink ở tên file, symlink ở thư mục cha, FIFO, thư mục (không phải file) đều bị từ chối.
   File thường mở được. Kiểm thêm một vòng đổi link liên tục bằng một tiến trình con trong 2 giây, phải không lần nào
   lọt.
2. `GET /files/env.txt`, `/files/other.csv`, `/files/dir_link/<tên>` đều trả **404**. File thường vẫn trả 200, đúng
   nội dung và cỡ.
3. `DELETE /files/dir_link/<tên>` trả 404, và file của user B vẫn còn. `DELETE /files/env.txt` chỉ xoá cái link.
4. Upload `up.csv` thành công, và file "mồi" không đổi.
5. `promoteOutput` với nguồn là symlink thì bị từ chối. Với đích `outputs/<tên>` là symlink thì file được lưu dưới
   tên khác, và file "mồi" không đổi.
6. Canvas: `canvas_write` với `env.txt`, `other.csv`, `dir_link/x.xlsx` đều báo lỗi. Phiên bản `v2` được ghi thành
   `v3` hoặc báo lỗi, và file "mồi" không đổi. Kiểm thêm tool `read` của dsh với `env.txt`: phải bị từ chối. Nếu không
   bị từ chối, ghi thành một mục riêng, vì đó là package vendored.
7. Hồi quy: suite e2e hiện tại (`storageQuota`, upload, file của chat và project, canvas mở xlsx/docx/pdf) phải vẫn qua.

## Ngoài phạm vi (lớp 3, để sau)
- Bước `reconcile` cuối lượt, hoặc lượt quét archive, xoá các symlink trỏ ra ngoài thư mục.
- Chặn hẳn việc tạo symlink trong sandbox (seccomp chặn `symlink`/`symlinkat`). Python và thư viện gần như không cần
  tạo symlink, nhưng cần đo kỹ trước khi bật.

## Đã làm (gateway, 2026-10-16)

- `api/services/gateway/src/runtime/safe-fs.ts`:
  - `openInside` mở file để đọc, trả `undefined` khi không có file thường: không tồn tại, là link, là FIFO hay thư mục,
    hoặc có thư mục cha là link.
  - `createInside` tạo file mới với `O_EXCL`, tạo luôn thư mục thiếu.
  - `renameInside` đổi tên trong cùng một thư mục, thay chính mục đích chứ không đi theo link.
  - `removeInside` xoá file thường. Với `anyEntry`, xoá cả chính cái link.
  - Trên Linux mọi bước đi qua `/proc/self/fd/<thư mục đã mở>/<tên>`. Trên macOS (dev) dùng `lstat` từng thành phần.
- Đã áp vào:
  - G1: `GET` file trả 404.
  - G2: `deleteWorkspaceFile` trả về số byte, hoặc `undefined` (404). `clearWorkspace` cũng dùng hàm này.
  - G3: `saveUpload` dùng `.part` qua `createInside`, rồi `renameInside`.
  - G4: `promoteOutput` mở nguồn bằng `openInside` và ghi qua `outputs/.<tên>.part` rồi `renameInside`. Hành vi giữ
    như cũ: ghi đè `outputs/<tên>` (một link ở đó bị thay, không bị ghi xuyên qua), thay vì đặt tên mới như plan ban
    đầu.
  - G5: `restore` dùng `lstat` (một link ở đúng tên thì bỏ qua) và `.restore` qua `createInside`.
    `downloadArchiveObject(key, writable)` nhận stream do bên gọi mở.
  - G6: lượt quét đọc file qua `openInside`.
  - `filesOf` và `listWorkspaceFiles` đổi sang `lstat` và chỉ nhận file thường.
- Kiểm chứng:
  - Script kiểm `safe-fs` (19 trường hợp) qua trên macOS và trên Linux (`node:22-slim`).
  - Vòng tráo file/link liên tục trong 3 giây: đọc kiểu cũ (`readFile` theo đường dẫn) lấy được file bí mật 1.751 lần,
    `openInside` 0 lần.
  - e2e `symlinkIsolation` (22 check, chế độ `strict`) qua. Toàn bộ suite: 28/28 qua.
  - Đối chứng chạy cùng test trên code cũ (image build từ HEAD), lỗi lộ ra đúng như mô tả ở trên:
    - `GET` trả 200 với link tới file của user B;
    - `DELETE dir_link/secret.csv` xoá được file của B;
    - upload, khôi phục từ S3 và "Đưa vào dự án" đều ghi đè lên file mồi ở ngoài.
  - Riêng `/proc/self/environ` thì code cũ trả 200 nhưng **body rỗng**, vì `stat` của file trong `/proc` báo cỡ 0 và
    gateway gửi `content-length: 0`. Env của gateway chưa lộ qua đường này là nhờ may mắn, không phải do có chặn.
- Tool `read`/`write` của dsh: e2e `subagentIsolation` cho thấy `workspace-guard` đã từ chối `/proc/self/environ`. Bước
  6 của mục Kiểm thử, phần dsh, coi như đã có.

## Đã làm (canvas và runtime, 2026-10-16)

Làm sau khi merge `origin/feat/data-analysis` vào `feat/new-feature` (bằng `--no-commit`). Conflict gồm:
- dòng import ở `index.ts`;
- GET file: giữ `{ canvas: true }` của nhánh, mở file bằng `openInside`;
- `saveUpload`: thêm tuỳ chọn `canvas`, ghi vào `.canvas/` qua `createInside`/`renameInside`, không ghi đè;
- `deleteWorkspaceFile`: trả về số byte, và vẫn gọi `refreshDatasetCards`.

- `safe-fs.ts` có thêm:
  - `moveInside`: chuyển file sang thư mục khác, giữ cả hai thư mục ở dạng đã mở;
  - `readTextInside`;
  - `writeFileInside`: ghi file tạm rồi đổi tên.

  Bản chép ở `packages/tool/canvas/src/safe-fs.ts` và `packages/flow/data-analysis/src/safe-fs.ts` giống hệt bản của
  gateway (2 dòng đầu ghi chú). Sửa một bản thì phải sửa cả ba.
- Canvas:
  - C1, lớp 1: `readSource` mở file bằng `openInside`, kiểm loại file và cỡ trên fd.
  - C1, lớp 2: các byte được đọc bằng `/usr/bin/cat` chạy dưới `FOX_CONFINE_RUNNER`, thư mục làm việc chỉ đọc. Không
    có runner thì đọc từ fd của lớp 1.
  - C2: `writeVersion` tạo `canvas-<id>-vN` bằng `createInside`. Gặp `EEXIST` thì thử phiên bản kế tiếp, tối đa 5 lần.
- R1: reconcile dùng `moveInside`. Gặp link trên đường đi thì không dời, file ở yên chỗ cũ.
- R2: `writeMarker` dùng `O_NOFOLLOW`. Gặp link thì xoá chính cái link rồi ghi lại.
- R3: mọi chỗ đọc/ghi `.fox/` dùng `readTextInside`/`writeFileInside`. Regex `TEMPORARY` của archive thêm
  `datasets.json.<pid>.<rand>`.
- Kiểm chứng:
  - e2e `canvasSymlinkIsolation` (13 check, chế độ `strict`, chat trong dự án) qua. Toàn bộ suite: **29/29** qua.
  - Script kiểm `safe-fs` trên Linux: 21/21, gồm cả `moveInside`.
  - Upload `purpose=canvas` vẫn trả `.canvas/snap.xlsx`, rồi `.canvas/snap (2).xlsx`, đọc lại được, và không hiện
    trong danh sách file.
  - Đối chứng: cùng test chạy trên image build từ `origin/feat/data-analysis` (chưa sửa) thì lỗi lộ ra:
    - `.python-session` ghi đè file mồi;
    - canvas ghi `canvas-r-v1.md` vào thư mục của B;
    - reconcile dời `stray.txt` và một thư mục của A sang B.
  - Các phép thử **đọc** lén qua tham số `path` của canvas bị `workspace guard` của agent-core chặn sẵn, kể cả trên
    code cũ: guard này kiểm tra đường dẫn thật của tham số trước khi tool chạy. Lớp 1 và lớp 2 là tầng thứ hai, cho
    trường hợp file bị tráo giữa lúc guard kiểm và lúc canvas đọc. Guard không nhìn đường **ghi** (C2, R1, R2), và đó
    chính là những lỗ có thật.

Còn mở (ngoài phạm vi plan này):
- Snapshot `.canvas/` bị tính vào quota, nhưng không hiện trong tab Dung lượng, và lệnh dọn file không xoá chúng
  (`docs/storage-quota-plan.md`).
- Chat data-analysis không thuộc dự án: canvas ghi ở gốc thư mục (`relativeBase` rỗng), rồi reconcile dời file vào
  `generated/<chat>/`. Đường dẫn trong marker vì vậy có thể sai sau khi lượt kết thúc. Chưa kiểm trên UI.
