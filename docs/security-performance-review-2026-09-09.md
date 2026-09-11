# Review bảo mật/performance/bug — source thật, 2026-09-09

Review thật toàn bộ source code hiện tại (không dựa trí nhớ, đọc lại từng
dòng), chia 3 mảng: control plane (`services/gateway` + `services/orchestrator`),
worker-side (`packages/core`, `agent-driver`, `transport`, `llm/openai-compat`,
`tool/duckduckgo-web-search`, `profile-template`), và frontend (`apps/web`).
Mỗi finding có file:line cụ thể để tra lại nhanh, không phải suy đoán chung
chung.

**Cập nhật (2026-09-09, cùng ngày):** 6/8 finding bảo mật đã sửa thật —
#1, #3, #4, #5, #6, #7 (đánh dấu ✅ bên dưới, verify thật, xem
`docs/code-rules.md` §53 để biết chi tiết cách sửa + verify). Giữ nguyên
CHƯA làm: **#2** (`OPENAI_API_KEY` dùng chung — cần quyết định kiến trúc
LLM-call proxy riêng trước, effort lớn hơn hẳn 6 finding kia) và **#8**
(`--expose-internals` có thể thừa — cần điều tra/test trước khi dám xoá).

**Cập nhật thêm (2026-09-09, cùng ngày):** 8/12 finding Performance đã sửa
thật — #1, #2, #3, #4, #6, #7, #8 (trọn vẹn), #5 (chỉ phần độ dài/`maxPayload`,
chưa rate-limit theo tần suất) — đánh dấu ✅ bên dưới, xem `docs/code-rules.md`
§54 (7 finding đầu) và §55 (#8, làm riêng sau khi user chọn từ nhóm 3).
Giữ nguyên CHƯA làm: #9, #10, #11, #12.

## 1. Bảo mật

### Nghiêm trọng

1. **✅ ĐÃ SỬA (2026-09-09, §53).** **`services/orchestrator` không có auth ở BẤT KỲ route nào**
   (`services/orchestrator/src/index.ts` — `ensure`, `touch`, `DELETE` purge,
   `models`). Chỉ dựa vào network boundary (port 4100 không public). Nếu
   port đó lỡ bị expose (misconfig firewall/security group) thì **ai cũng
   xoá được bất kỳ session nào**, chỉ cần biết sessionId — không cần biết gì
   thêm. Điểm rủi ro nặng nhất trong toàn bộ review vì hệ quả lớn (mất data
   vĩnh viễn) trong khi điều kiện khai thác chỉ là 1 lỗi cấu hình mạng.

2. **`OPENAI_API_KEY` dùng chung, forward vào MỌI container**
   (`services/orchestrator/src/config.ts:63`, `workerEnvPassthrough`). Vì
   Phase 0 đã chốt "plugin chạy code tuỳ ý" (mỗi user 1 container riêng
   nhưng KHÔNG sandbox nội dung chạy bên trong), 1 session bị compromise
   (tool/plugin độc hại) đọc thẳng `process.env.OPENAI_API_KEY` là lộ đúng
   key dùng chung cho **toàn bộ tenant**, không phải chỉ session đó.

3. **✅ ĐÃ SỬA (2026-09-09, §53).** **Container worker không giới hạn resource nào**
   (`services/orchestrator/src/docker.ts:82-94`, `createContainer`'s
   `HostConfig` chỉ có `Binds`+`PortBindings`, không `Memory`/`NanoCpus`/
   `PidsLimit`). Mô hình "mỗi user 1 container vì code chạy tuỳ ý" mới cô
   lập process, chưa cô lập tài nguyên — 1 session ngốn hết CPU/RAM/PID có
   thể làm nghẽn container khác cùng host.

### Trung bình

4. **✅ ĐÃ SỬA (2026-09-09, §53).** **Timing side-channel ở login** (`services/gateway/src/auth.ts:29-32`) —
   email không tồn tại trả lời NGAY (bỏ qua scrypt hoàn toàn); email tồn
   tại nhưng sai password thì chạy đủ scrypt rồi mới fail. Đo thời gian
   response phân biệt được "email có tồn tại hay không" — user-enumeration
   qua timing.

5. **✅ ĐÃ SỬA (2026-09-09, §53).** **Không rate-limit `/auth/login`, `/auth/register`** — grep toàn bộ
   `services/gateway/src` không có middleware giới hạn tần suất nào.
   Brute-force password hoặc dò email hàng loạt không bị chặn ở tầng code.

6. **✅ ĐÃ SỬA (2026-09-09, §53).** **`sessionId` không được validate format ở bất kỳ đâu.** Gateway lấy
   thẳng từ URL path (`index.ts:407,423`); nhánh admin bỏ qua check tồn tại
   DB row (`index.ts:87`) → sessionId lạ (chứa `../`) chưa từng có trong
   Redis rơi vào nhánh "brand new" (`ensure.ts:115`,
   `join(config.dataDir, sessionId)`) — `path.join` resolve `..` thật, có
   thể ghi ra ngoài `dataDir`. Chỉ khai thác được qua tài khoản `admin`
   (không phải user thường), nhưng vẫn thiếu validate input cơ bản (chưa
   check UUID format ở tầng nào).

7. **✅ ĐÃ SỬA (2026-09-09, §53).** **Lỗi DB thô trả thẳng ra client** (`services/gateway/src/index.ts:134-138`,
   nhánh `register`'s catch) — trả `String(error)` nguyên văn, có thể lộ
   chi tiết driver/DB nội bộ cho request CHƯA xác thực.

8. **`entrypoint.sh`'s `--expose-internals`** (`infra/docker/worker/entrypoint.sh:9-15`)
   — comment ghi rõ flag này chỉ cần cho HMR live-reload phục vụ Phase 5's
   live plugin toggle, nhưng Phase 5 (kho plugin + toggle) đã bị xoá HẲN ở
   Phase 16. Chưa xác nhận lại flag này còn cần thật không — có thể là
   attack-surface thừa không còn lý do tồn tại.

### Không phát hiện gì đáng kể

- SQL injection: toàn bộ 8 hàm trong `db.ts` dùng placeholder `?`, không
  nối string bao giờ.
- Command injection qua tool: `duckduckgo-web-search` dùng `execFile` với
  args dạng mảng (không phải shell string) — miễn nhiễm.
- SSRF qua tool: đích URL luôn hardcode, `query` chỉ nằm trong body
  `--data-urlencode`, không phải host.
- XSS ở FE: **0 kết quả** `dangerouslySetInnerHTML`/`innerHTML`/`eval`/
  `new Function` trong toàn bộ `apps/web/src/**` (grep xác nhận) — mọi nội
  dung render qua JSX text con, React tự escape.
- Secret leak: `OPENAI_API_KEY` chỉ dùng trong header `Authorization`,
  không log ra đâu (`llm/openai-compat/src/adapter.ts`).
- Token FE lưu `sessionStorage` (không phải `localStorage`) — tự xoá khi
  đóng tab, đúng chủ đích. (Lưu ý cố hữu, không phải bug: vẫn đọc được bởi
  JS bất kỳ chạy trên page nếu có XSS — giới hạn chung của Web Storage,
  không riêng dự án này.)

## 2. Performance

Quan trọng nhất ở quy mô mục tiêu (roadmap đã chốt 1.000–10.000 session
đồng thời):

1. **✅ ĐÃ SỬA (2026-09-09, §54).** **`KEYS fh:session:*`** (`services/orchestrator/src/redis.ts:82-91`,
   `listSessionIdsByStatus`) — lệnh O(n) block Redis (single-thread), chạy
   mỗi 60s (sweep, `sweep.ts:29-30`) VÀ mỗi lần tạo session mới nếu bật
   `MAX_CONCURRENT_SESSIONS` (`ensure.ts:89-94`). Quét cả key `:lastActive`
   rồi lọc phía client (quét dư gấp đôi) + tới 3N round-trip GET riêng lẻ.
   Đây là bottleneck thật ở quy mô mục tiêu, không phải lo xa — nên đổi
   `KEYS`→`SCAN` hoặc dùng `SET`/`HSET` để tra O(1)/O(log n).

2. **✅ ĐÃ SỬA (2026-09-09, §54).** **N+1 Redis GET ở `GET /sessions/mine`**
   (`services/gateway/src/index.ts:291-294`) — gọi `getLiveSessionStatus`
   riêng cho từng session (dù `Promise.all` song song, vẫn N round-trip).
   Nên gộp bằng `MGET`.

3. **✅ ĐÃ SỬA (2026-09-09, §54).** **`fetch()` gateway→orchestrator không có timeout**
   (`orchestrator-client.ts` — `ensureSession`, `fetchModels`,
   `purgeSession`, `touchSession`), không `AbortController`. Orchestrator
   treo → WS upgrade handler ở gateway treo vô thời hạn theo.

4. **✅ ĐÃ SỬA (2026-09-09, §54).** **Gọi LLM không có timeout riêng** (`llm/openai-compat/src/adapter.ts:79-97`)
   — chỉ có `signal: options.signal` (abort thủ công khi cancel turn). LLM
   server treo (network hang, không đóng stream, không gửi `[DONE]`) →
   `parseSse` `await reader.read()` vô thời hạn — turn đứng im, chiếm 1
   container mà idle-TTL không phát hiện được (dựa vào kết nối WS, không
   phải trạng thái turn).

5. **✅ ĐÃ SỬA (2026-09-09, §54 — riêng phần độ dài/`maxPayload`; chưa
   rate-limit theo tần suất frame/giây, chỉ mới chặn kích thước).**
   **Không giới hạn độ dài/tần suất frame `followup`/`steer`**
   (`packages/transport/src/server.ts:139-155`) — không giới hạn độ dài
   `text`, không rate-limit số frame/giây, `WebSocketServer` không set
   `maxPayload`. Vector cost-abuse thật: 1 user hợp lệ vẫn gọi LLM cost cao
   liên tục qua nhiều turn nhỏ mà không tầng nào (transport, gateway,
   agent-driver) chặn trước khi chạm LLM thật.

6. **✅ ĐÃ SỬA (2026-09-09, §54).** **MariaDB pool không set `connectionLimit`**
   (`services/gateway/src/db.ts:16`, `mariadb.createPool(config.databaseUrl)`
   không truyền option) — dùng default driver, chưa tính cho tải mục tiêu.

7. **✅ ĐÃ SỬA (2026-09-09, §54).** **`replenishWarmPool` spawn tuần tự, không song song**
   (`warmpool.ts:28-40`) — vòng `for` await từng container 1 (mỗi cái tốn
   tới 15s timeout readiness). Chấp nhận được ở `WARM_POOL_SIZE=2` mặc
   định, sẽ chậm nếu operator tăng pool lớn.

8. **✅ ĐÃ SỬA (2026-09-09, §55 — tiện tay sửa luôn gateway's own
   `WebSocketServer` cũng thiếu `maxPayload`, cùng loại gap #5 đã đóng ở
   phía worker-facing).** **`proxy.ts:21`** — buffer `pending` không giới hạn kích thước — worker
   socket chậm mở thì browser có thể gửi nhiều frame liên tiếp tích luỹ
   không giới hạn trước khi có cơ chế đóng.

9. **`duckduckgo-web-search`** không rate-limit tần suất gọi trong 1 session
   lẫn giữa các session — rủi ro vận hành: IP server prod có thể bị
   DuckDuckGo rate-limit/chặn, ảnh hưởng chung mọi user (không phải lỗ hổng
   riêng lẻ nhưng là rủi ro thật).

### Frontend

10. **`frameHistoryRef.current` tích luỹ vô hạn trong 1 session dài**
    (`App.tsx:140,144-146`) — chỉ reset khi có frame `'snapshot'` mới (đổi
    session). `onFrame()` (App.tsx:239-243) replay TOÀN BỘ history đồng bộ
    cho bất kỳ listener mới nào subscribe.

11. **`GET /sessions/mine` fetch toàn bộ 1 lần, không phân trang/virtualize**
    (`SessionList.tsx:64-70,111-146`) — user có vài trăm/nghìn session sẽ
    làm DOM phình to.

12. Mỗi text-delta chunk khi model đang stream trigger
    `setLiveBubbles(new Map(prev))` mới hoàn toàn + `useEffect` scroll
    chạy lại mỗi lần (`Conversation.tsx:150-163,243-246`) — nhiều
    re-render+reflow liên tục khi stream nhanh. Chưa vấn đề ở quy mô hiện
    tại, đáng biết nếu sau này thấy giật.

## 3. Bug cần chú ý

1. **✅ ĐÃ SỬA (2026-09-09, §56 — lưu ý: có 1 lần ghi nhầm là đã sửa qua
   §50 trước đó, KHÔNG đúng — §50 sửa 1 bug khác, bug này thật ra tới §56
   mới sửa; xem §56 ghi rõ sự nhầm lẫn này).** **[Đáng sửa nhất] FE — lẫn
   message giữa 2 session khi đổi session nhanh.** `switchSession()`/`startNewSession()` (`App.tsx:219-226,247-253`)
   gọi `wsRef.current?.close()` rồi mở socket mới NGAY, ghi đè
   `wsRef.current`. Nhưng `.close()` chỉ khởi động closing handshake —
   socket CŨ vẫn có thể nhận thêm `message` event (frame đang bay trên
   mạng) trước khi thật sự đóng, và listener của socket cũ vẫn gọi thẳng
   `handleFrame()`/`publishFrame()` — hàm này ghi vào `frameHistoryRef`/
   phát cho listener dùng chung, KHÔNG kiểm tra frame có thuộc socket đang
   active hay không (`App.tsx:179-188` thiếu gate theo `ev.target`/
   sessionId — pattern guard này ĐÃ có đúng cho `close` handler ở dòng 174,
   chỉ thiếu áp dụng cho `message`). Hệ quả: đổi session rất nhanh trong
   lúc response cũ đang stream có thể khiến message/tool-result của session
   A lẫn vào session B vừa mở. **Cách sửa:** thêm y hệt guard
   `if (wsRef.current !== socket) return` vào message listener bên trong
   `connect()`.

2. **✅ ĐÃ SỬA (2026-09-09, §56).** **Register có race TOCTOU trên email trùng**
   (`services/gateway/src/auth.ts:17-19`) — check `getUserByEmail` rồi mới
   `createUser`; 2 request đồng thời cùng email đều pass check, 1 trong 2
   fail ở unique constraint DB nhưng rơi vào catch chung → trả
   `String(error)` khó hiểu thay vì "email already registered" nhất quán.

3. **✅ ĐÃ SỬA (2026-09-09, §56).** **LLM SSE parser nuốt lỗi im lặng** (`llm/openai-compat/src/translate.ts:100-105`,
   `catch { continue }`) khi parse JSON của 1 SSE payload lỗi — không log
   gì cả. Server LLM gửi frame hỏng thỉnh thoảng → mất nội dung không dấu
   vết để debug.

4. **✅ ĐÃ SỬA MỘT PHẦN (2026-09-09, §56 — chỉ thêm observability/log khi
   0 kết quả, KHÔNG sửa được độ fragile của regex/không phân biệt được
   "bị chặn" thật với "0 kết quả thật" — chưa có mẫu HTML trang bị chặn để
   verify).** **`duckduckgo-web-search` parse HTML bằng regex cố định**
   (`RESULT_LINK_RE`/`SNIPPET_RE`) — nếu DuckDuckGo đổi markup HOẶC chặn IP
   server (trả trang challenge) → `titles` rỗng → trả về y hệt "No results
   for..." như trường hợp thật sự 0 kết quả. Không phân biệt được "0 kết
   quả thật" với "tool hỏng ngầm" — đã tự ghi nhận rủi ro fragile trong
   comment đầu file, nhưng thiếu observability khi việc đó xảy ra.

5. **✅ ĐÃ SỬA (từ §52, tiện tay lúc làm sliding-token-expiration — trước
   cả review này).** `PluginInventory.tsx:27-28` — `fetch(...).then(res => res.json())` không
   check `res.ok` trước — lỗi 403/404/500 vẫn cố `.json()` body lỗi, bị
   nuốt vào `.catch` chung (chỉ log console, không hiện gì cho user).

6. **✅ ĐÃ SỬA (lúc dọn `packages/profile-template`, trước cả review này).**
   Doc/comment lệch thực tế (vô hại, chỉ gây hiểu nhầm khi đọc):
   `packages/profile-template/template/cordis.patch.yml:2` còn nhắc "per-user
   patches from plugin-registry" (service đã xoá ở Phase 16);
   `profile.package.json:14`'s `"patchReload": "live"` không tồn tại thật
   trong `DshProfileManifest` type hiện cài, vô hại nhưng dễ hiểu nhầm là
   có tác dụng thật.

### Đã biết trước, xác nhận lại (không phải phát hiện mới)

- `quota.ts`'s in-memory counter reset khi hibernate/rehydrate — đúng như
  đã ghi trong comment, không có gì khác thường.
- `SessionList.tsx`'s empty-state hiện `<></>` (không thông báo gì khi
  danh sách rỗng) — quyết định có chủ đích của user, giữ nguyên không sửa.

## 4. Thiết kế tốt đáng giữ

- Readiness probe bằng WS handshake thật (`docker.ts:38-59`), không phải
  TCP connect suông — tránh đúng race Docker Desktop's vpnkit accept trước
  khi listener thật sẵn sàng.
- Spawn lock + poll (`ensure.ts:18-33,43-44`) — 2 request đồng thời cho
  cùng session không bao giờ tạo 2 container.
- Password: scrypt + `timingSafeEqual` (`password.ts:21-28`) — đúng chuẩn,
  không so sánh string thường.
- Toàn bộ SQL dùng placeholder `?`, `INSERT IGNORE` cho `createSession`
  idempotent thật.
- Rehydrate luôn spawn container MỚI, không bao giờ restart container cũ
  — buộc state phải sống lại từ log, đúng invariant §0.4.
- Tool duckduckgo dùng `execFile` array-args — chống command injection.
  System prompt tự dặn model coi kết quả search là data, không phải
  instruction — phòng prompt-injection-qua-tool-result chủ động.
- `packages/transport` WS server bind mặc định `127.0.0.1` — chỉ nghe
  loopback trong container, lớp phòng thủ hợp lý dù gateway đã auth.
- FE: 0 XSS sink (không `dangerouslySetInnerHTML`/`eval` ở đâu cả), token
  lưu `sessionStorage`, `useTheme.ts`/`ResizeObserver` cleanup đúng cách,
  guard chống stale WS event đã đúng hướng cho `close` handler (chỉ thiếu
  áp dụng cho `message`, xem bug #1).

## Đề xuất thứ tự xử lý

1. ~~Auth cho route của `services/orchestrator`~~ **✅ ĐÃ SỬA (§53).**
2. ~~Resource limit cho container worker~~ **✅ ĐÃ SỬA (§53).**
3. ~~Fix race FE đổi session nhanh~~ **✅ ĐÃ SỬA (§56).** **Sửa lại
   (2026-09-09): dòng này TRƯỚC ĐÂY ghi nhầm là đã sửa qua §50 — SAI, §50
   sửa 1 bug khác (retry logic khi handshake bị từ chối). Bug message-race
   thật ra chưa từng sửa cho tới lúc user yêu cầu "tiếp tục check bug" và
   phát hiện lại — xem §56.**
4. ~~`KEYS`→index cho session listing~~ **✅ ĐÃ SỬA (§54)** — làm hẳn SET
   index O(1), không chỉ đổi sang `SCAN`.
5. ~~Timeout cho fetch gateway→orchestrator và LLM call~~ **✅ ĐÃ SỬA (§54).**
6. Bảo mật #2 (`OPENAI_API_KEY` dùng chung) và #8 (`--expose-internals`) —
   CHƯA làm, cố ý để lại (xem ghi chú đầu file).
7. ~~Performance nhóm 3 — #8 proxy buffer~~ **✅ ĐÃ SỬA (§55).** #9
   (duckduckgo rate-limit), #10 (`frameHistoryRef`), #11 (session-list
   pagination), #12 (FE re-render) — CHƯA làm, cố ý để lại (xem ghi chú
   đầu file).
