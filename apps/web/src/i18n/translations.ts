// i18n (2026-09-10) — user asked for exactly 2 languages (Vietnamese,
// English), Vietnamese as the ALWAYS default (not derived from
// `navigator.language`/`prefers-color-scheme`-style OS detection like
// `useTheme.ts` does for its own default — a deliberate product choice,
// see `locale.tsx`'s own comment for why locale can't reuse that hook's
// pattern at all). No i18n library — `apps/web/package.json` had exactly 4
// dependencies before this (`lucide-react`, `react`, `react-dom`,
// `sonner`); ~50 short keys, no pluralization/date-formatting complexity
// (HistoryChat's day-bucketing is already hand-rolled) doesn't justify
// pulling in i18next/react-intl/FormatJS.
//
// `en` is typed `Record<TranslationKey, string>` — a REAL compile-time
// guarantee, not a convention: add a key to `vi` and forget it in `en`,
// `pnpm run typecheck` fails immediately (verified by deliberately doing
// exactly that during implementation, see docs/code-rules.md §59).

export type Locale = "vi" | "en";

export const vi = {
  // Auth screen (components/features/auth/ConnectForm.tsx)
  "auth.loginTitle": "Đăng nhập để tiếp tục",
  "auth.registerTitle": "Tạo tài khoản để bắt đầu",
  "auth.email": "Email",
  "auth.password": "Mật khẩu",
  "auth.confirmPassword": "Xác nhận mật khẩu",
  "auth.pleaseWait": "Vui lòng đợi…",
  "auth.login": "Đăng nhập",
  "auth.createAccount": "Tạo tài khoản",
  "auth.switchToRegister": "Chưa có tài khoản? Đăng ký",
  "auth.switchToLogin": "Đã có tài khoản? Đăng nhập",
  "auth.registerSuccess": "Tạo tài khoản thành công — đăng nhập để tiếp tục",
  // Client-side register validation (2026-09-10) — 3 distinct messages
  // instead of the old single combined server message ("email và mật
  // khẩu tối thiểu 8 ký tự"), checked in the FE before ever calling the
  // server, so the right one shows immediately per case.
  "auth.emailRequired": "Vui lòng nhập email",
  "auth.passwordTooShort": "Mật khẩu phải có ít nhất 8 ký tự",
  "auth.passwordMismatch": "Mật khẩu xác nhận không khớp",

  // Gateway auth error `code`s (services/gateway/src/index.ts's
  // `/auth/register`+`/auth/login` — the only 2 routes whose errors are
  // actually shown to a user today). Fallback to the raw `error` string
  // from the gateway is handled in App.tsx when `code` is missing/unknown
  // — these keys are never the only path to an error message.
  "error.rate_limited": "Quá nhiều lần thử, vui lòng thử lại sau",
  "error.invalid_json": "Yêu cầu không hợp lệ",
  "error.invalid_registration_input": "Cần email và mật khẩu tối thiểu 8 ký tự",
  "error.email_taken": "Email đã được đăng ký",
  "error.registration_failed": "Đăng ký thất bại",
  "error.invalid_credentials": "Email hoặc mật khẩu không đúng",
  // Per-user skill `code`s (services/gateway/src/skills.ts + index.ts).
  "error.skill_exists": "Đã có skill trùng tên",
  "error.skill_limit": "Đã đạt tối đa 50 skill",
  "error.skill_name_reserved": "Tên này trùng một skill có sẵn",
  "error.invalid_skill_name": "Tên chỉ gồm chữ thường, số, gạch ngang (2–64 ký tự)",
  "error.invalid_skill_description": "Cần mô tả, tối đa 280 ký tự",
  "error.invalid_skill_content": "Cần nội dung, tối đa 64 KB",
  "error.skill_not_found": "Không tìm thấy skill",

  // App shell (App.tsx)
  "app.logout": "Đăng xuất",
  "app.sessionExpired": "Phiên đăng nhập đã hết hạn — vui lòng đăng nhập lại",
  "app.sessionGoneStartedNew":
    "Phiên trước không còn khả dụng — đã bắt đầu phiên mới",
  "status.connected": "đã kết nối",
  "status.connecting": "đang kết nối",
  "status.disconnected": "mất kết nối",

  // Sidebar.tsx
  "sidebar.searchSessions": "Tìm kiếm phiên",
  "sidebar.searchPlaceholder": "Tìm kiếm trò chuyện…",
  "sidebar.expandSidebar": "Mở rộng thanh bên",
  "sidebar.collapseSidebar": "Thu gọn thanh bên",
  "sidebar.newSession": "Trò chuyện mới",
  "sidebar.settings": "Cài đặt",
  "sidebar.account": "Tài khoản",
  // Account-menu trigger tooltip (2026-09-10) — distinct from
  // `sidebar.settings`: the row itself now opens a menu (Settings +
  // Logout), it isn't a direct Settings shortcut anymore.
  "sidebar.accountMenu": "Menu tài khoản",
  "sidebar.skills": "Kỹ năng",
  // docs/data-analysis-flow-plan.md — opens a new session on the
  // "data-analysis" flow (a different agent loop).
  "sidebar.dataAnalysis": "Phân tích dữ liệu",

  // HistoryChat.tsx (renamed from SessionList.tsx 2026-09-10 — "SessionList"
  // described a backend concept, not what this actually is: the sidebar's
  // chat history)
  "historyChat.untitled": "Chưa đặt tên — {id}",
  "historyChat.groupToday": "Hôm nay",
  "historyChat.groupYesterday": "Hôm qua",
  "historyChat.group7d": "7 ngày trước",
  "historyChat.group30d": "30 ngày trước",
  "historyChat.groupOlder": "Cũ hơn",
  // Per-row "..." menu (2026-09-10) — hover reveals `MoreIcon`, opens a
  // popup with these 2 real actions (Rename was already real; Delete is
  // new, proxies to services/gateway's existing real `DELETE /sessions/:id`
  // — no backend work needed, the route already existed unused by the FE).
  "historyChat.rowActions": "Tuỳ chọn",
  "historyChat.rename": "Đổi tên",
  "historyChat.delete": "Xoá",
  "historyChat.deleteConfirm": "Xoá cuộc trò chuyện này? Hành động này không thể hoàn tác.",
  // Real check the user explicitly asked for (2026-09-10, "nhớ có check
  // lỗi ko quá 255 kí tự") when Rename became an inline input — 255 is the
  // real `sessions.title` column width (`varchar(255)`), shown via a toast
  // before the server is ever called; services/gateway's PATCH handler now
  // enforces the same real limit server-side too (was a stale, mismatched
  // silent `.slice(0, 200)` before this).
  "historyChat.titleTooLong": "Tên đoạn chat tối đa 255 ký tự",
  // Real gap found while wiring this component (then SessionList.tsx):
  // `row.status` ('running'|'hibernated'|'archived', straight from
  // services/gateway's `sessions` table) was rendered as-is into the
  // status-dot's `title` tooltip — missed in the original inventory, caught
  // during implementation.
  "historyChat.statusRunning": "đang chạy",
  "historyChat.statusHibernated": "tạm ngưng",
  "historyChat.statusArchived": "đã lưu trữ",

  // Conversation.tsx
  "conversation.emptyHeading": "Bắt đầu cuộc trò chuyện",
  "conversation.placeholder": "Nhắn cho agent…",
  "conversation.send": "Gửi",
  // Status row and Stop button while a reply runs (Conversation.tsx).
  "conversation.stop": "Dừng",
  "conversation.thinking": "Đang suy nghĩ…",
  "conversation.runningTool": "Đang chạy công cụ…",
  "conversation.elapsedSeconds": "{s} giây",
  "conversation.elapsedMinutes": "{m} phút {s} giây",
  "conversation.disconnectedWhileRunning": "Mất kết nối với agent. Tải lại trang để xem tiếp.",
  "conversation.stopped": "Đã dừng.",
  // Technical event-log lines — only the English SCAFFOLDING words are
  // translated (`ended:`); turn numbers and reason codes stay exactly as
  // the wire sends them — they're identifiers/data, not English prose,
  // translating them would be meaningless (and wrong). No turn/{n}
  // divider anymore (removed 2026-09-10, see Conversation.tsx's own
  // comment on `turn/start`).
  "conversation.turnEnded": "lượt {n} kết thúc: {reason}",
  // Turn ended because the model call failed (after dsh-llm-retry gave up,
  // or a code it does not retry such as AUTH).
  "conversation.modelError": "Không gọi được model ({code}): {message}",
  // Collapsed tool-call pill (2026-09-10, "làm UI UX lại cho casual như
  // các platform ai agent" — replaces the old always-expanded
  // `→ tool(args)` / `← result` technical cards, and the old
  // `conversation.toolError` key that went with them). `{name}` is the
  // real tool name (identifier, not translated, same reasoning as above).
  "conversation.toolRunning": "Đang dùng {name}…",
  "conversation.toolUsed": "Đã dùng {name}",
  "conversation.toolFailed": "Lỗi khi dùng {name}",
  // The `skill` tool / a `/name` invocation, and project rules the model received.
  "conversation.skillLoading": "Đang đọc skill {name}…",
  "conversation.skillLoaded": "Đã đọc skill {name}",
  "conversation.skillFailed": "Không đọc được skill {name}",
  "conversation.rulesApplied": "Đã áp dụng quy tắc dự án",
  "conversation.rulesUpdated": "Đã cập nhật quy tắc dự án",
  "conversation.rulesRemoved": "Đã bỏ quy tắc dự án",
  // Real bug fixed 2026-09-11 (user: "box contain tool-pill vẫn còn mà ko
  // có dữ liệu ... bị shrink") — a tool call whose turn ended without a
  // matching `tool/result` (container hibernated/crashed mid-call, a real,
  // already-documented gap — `docs/core-overview.md`'s own known-gaps list:
  // idle sweep doesn't check turn status before hibernating) used to stay
  // "running" forever: a tiny pill with no result content, no spinner that
  // ever resolves — indistinguishable from a genuinely broken empty box.
  // `handleEvent`'s `turn/end` case now sweeps any still-"running" tool
  // entry from that turn into this labeled state instead of leaving it
  // stuck — honest about what happened rather than silently vanishing (a
  // tool call that really did happen), but no longer a dead, confusing box.
  "conversation.toolInterrupted": "Lượt trò chuyện đã kết thúc trước khi có kết quả.",
  // Markdown code-block copy button (2026-09-15, Markdown.tsx).
  "conversation.copyCode": "Sao chép",
  "conversation.codeCopied": "Đã sao chép",
  // `SearchSourcesPill` (2026-09-15, user: "ghi là Đang tra cứu... show
  // chung các kết quả của mọi lần gọi tool search vào 1") — replaces the
  // generic "Đang dùng web_search" tool label for every `web_search` call.
  "conversation.searching": "Đang tra cứu…",
  "conversation.searched": "Đã tra cứu {n} nguồn",
  "conversation.searchEmpty": "Không tìm thấy kết quả",
  "conversation.searchFailed": "Tra cứu thất bại",
  "conversation.searchStopped": "Đã dừng tra cứu",
  "conversation.searchTruncated": "Danh sách nguồn đã được rút gọn",
  // `SessionTitleBar.tsx` (2026-09-15) — shown before the chat has a title
  // yet (no first message sent, so no auto-title has fired either).
  "conversation.untitledSession": "Đoạn chat mới",

  // WorkspacePanel.tsx — files of a data-analysis chat.
  "workspace.upload": "Tải file lên",
  "workspace.uploading": "Đang tải lên…",
  "workspace.files": "Tệp ({n})",
  "workspace.empty": "Chưa có tệp nào. Tải dữ liệu lên để bắt đầu.",
  "workspace.uploaded": "Đã tải lên {name}",
  "workspace.uploadFailed": "Không tải lên được {name}",
  "workspace.tooLarge": "{name} quá lớn (tối đa 70 MB)",
  "workspace.openFailed": "Không mở được {name}",

  // ProjectHub.tsx (docs/rlm-transfer-plan.md 9.1) — wording from agent-core's
  // packages/ui-projects/src/ProjectHub.tsx.
  "projects.eyebrow": "Phân tích dữ liệu",
  "projects.title": "Dự án",
  "projects.search": "Tìm dự án",
  "projects.create": "Tạo",
  "projects.newName": "Tên dự án mới",
  "projects.createSubmit": "Tạo dự án",
  "projects.cancel": "Huỷ",
  "projects.colName": "Tên",
  "projects.colModified": "Đã sửa đổi",
  "projects.today": "Hôm nay",
  "projects.emptyList": "Chưa có dự án. Tạo một dự án để gom nguồn dữ liệu và các đoạn chat liên quan.",
  "projects.back": "Quay lại danh sách dự án",
  "projects.rename": "Đổi tên dự án",
  "projects.delete": "Xoá dự án",
  "projects.deleteConfirm": "Xoá dự án \"{name}\" cùng mọi đoạn chat và tệp của nó? Không thể hoàn tác.",
  "projects.composer": "Đoạn chat mới trong {name}",
  "projects.start": "Bắt đầu",
  "projects.tabChats": "Đoạn chat",
  "projects.tabSources": "Nguồn",
  "projects.tabOutputs": "Output",
  "projects.noChats": "Chưa có đoạn chat trong dự án này.",
  "projects.dropTitle": "Thêm nguồn cho dự án",
  "projects.dropHint": "CSV, Excel, Parquet, JSON hoặc tài liệu — tối đa 70 MB",
  "projects.sourceDataset": "Nguồn dữ liệu",
  "projects.sourceFile": "Tệp đầu vào",
  "projects.noSources": "Chưa có nguồn đầu vào trong dự án.",
  "projects.outputsProject": "Output dự án",
  "projects.outputsProjectHint": "Kết quả đã được chọn để mọi đoạn chat trong dự án sử dụng.",
  "projects.outputsChats": "Kết quả từ các đoạn chat",
  "projects.outputsChatsHint": "Kết quả nằm riêng theo từng đoạn chat; đưa vào dự án khi muốn dùng chung.",
  "projects.outputsOther": "Tệp khác do model tạo",
  "projects.outputsOtherHint": "Model ghi thẳng vào thư mục dự án thay vì ngăn riêng của đoạn chat, nên không rõ của đoạn chat nào.",
  "projects.sharedInProject": "Dùng chung trong dự án",
  "projects.promote": "Đưa vào dự án",
  "projects.promoted": "Đã đưa {name} vào dự án",
  "projects.promoteFailed": "Không đưa được vào dự án",
  "projects.noOutputs": "Chưa có output.",
  "projects.loadFailed": "Không tải được dự án",
  "projects.saveFailed": "Không lưu được dự án",
  // Project rules tab (ProjectHub.tsx): AGENTS.md read by every new chat of the project.
  "projects.tabRules": "Quy tắc",
  "projects.rulesHint": "Mọi đoạn chat trong dự án sẽ làm theo các quy tắc này — ví dụ đơn vị tiền, dữ liệu cần bỏ qua, cách trình bày. Sửa quy tắc thì đoạn chat đang mở áp dụng từ câu hỏi tiếp theo.",
  "projects.rulesPlaceholder": "- Doanh thu tính bằng triệu VND, làm tròn 1 chữ số thập phân\n- Bỏ qua các đơn đã huỷ\n- Luôn nêu rõ khoảng thời gian của số liệu",
  "projects.rulesSize": "{n}/{max} byte",
  "projects.rulesSave": "Lưu quy tắc",
  "projects.rulesSaved": "Đã lưu quy tắc dự án",
  // `conversation.reasoningRunning`/`.reasoningDone` (the collapsed
  // reasoning toggle) and `conversation.newSessionCmd`/
  // `.renameSessionCmd`/`common.renameSessionPrompt` (the `/`-command
  // palette) all removed 2026-09-10 — reasoning is gone entirely now, not
  // collapsed; `/new`/`/rename` are gone too, both already fully
  // duplicated by real dedicated UI elsewhere (Sidebar's "New chat"
  // button, HistoryChat's own row rename). See Conversation.tsx's own
  // header comment and docs/code-rules.md for the full reasoning.

  // SettingsDialog.tsx — 2 tab thật (2026-09-10, đúng theo reference
  // screenshot claude.ai user share): General (theme+language) và Profile
  // (email thật + nút Logout thật — KHÔNG có Name/Phone/Role/"Log out of
  // all devices"/"Delete account" vì backend chưa có dữ liệu/khả năng
  // thật cho những cái đó; Role bị bỏ lại ngay sau khi thêm, theo yêu cầu
  // sửa lỗi cùng ngày).
  "settings.title": "Cài đặt",
  "settings.generalTab": "Cài đặt",
  "settings.profileTab": "Hồ sơ",
  "settings.theme": "Giao diện",
  "settings.themeLight": "Sáng",
  "settings.themeDark": "Tối",
  "settings.language": "Ngôn ngữ",
  "settings.profileEmail": "Địa chỉ email",

  // SkillsDialog.tsx + the "/" menu (conversation/SkillMenu.tsx).
  "skills.title": "Kỹ năng",
  "skills.new": "Tạo skill mới",
  "skills.mine": "Skill của tôi",
  "skills.emptyMine": "Chưa có skill nào",
  "skills.builtin": "Skill có sẵn",
  "skills.builtinReadonly": "Skill có sẵn dùng chung cho mọi người, không sửa được. Gõ /{name} trong ô chat để dùng.",
  "skills.name": "Tên",
  "skills.namePlaceholder": "vd. bao-cao-tuan",
  "skills.nameHint": "Chữ thường, số, gạch ngang. Không đổi được sau khi tạo. Gõ /tên trong ô chat để dùng.",
  "skills.description": "Mô tả — dùng khi nào",
  "skills.content": "Nội dung",
  "skills.expand": "Mở rộng",
  "skills.collapse": "Thu gọn",
  "skills.save": "Lưu",
  "skills.saving": "Đang lưu…",
  "skills.delete": "Xoá",
  "skills.deleteConfirm": "Xoá skill \"{name}\"? Không thể hoàn tác.",
  "skills.saved": "Đã lưu skill {name}",
  "skills.deleted": "Đã xoá skill {name}",
  "skills.loadFailed": "Không tải được danh sách skill",
  "skills.createdFromChat": "Đã lưu skill {name} — gõ /{name} để dùng",
  "skills.mineBadge": "của tôi",

  // ThemeToggle.tsx
  "theme.switchToDark": "Chuyển sang giao diện tối",
  "theme.switchToLight": "Chuyển sang giao diện sáng",
} as const;

export type TranslationKey = keyof typeof vi;

export const en: Record<TranslationKey, string> = {
  "auth.loginTitle": "Log in to continue",
  "auth.registerTitle": "Create an account to get started",
  "auth.email": "Email",
  "auth.password": "Password",
  "auth.confirmPassword": "Confirm password",
  "auth.pleaseWait": "Please wait…",
  "auth.login": "Log in",
  "auth.createAccount": "Create account",
  "auth.switchToRegister": "Don't have an account? Register",
  "auth.switchToLogin": "Already have an account? Log in",
  "auth.registerSuccess": "Account created — log in to continue",
  "auth.emailRequired": "Email is required",
  "auth.passwordTooShort": "Password must be at least 8 characters",
  "auth.passwordMismatch": "Passwords do not match",

  "error.rate_limited": "Too many attempts, try again shortly",
  "error.invalid_json": "Invalid request",
  "error.invalid_registration_input":
    "Email and a password of at least 8 characters are required",
  "error.email_taken": "Email already registered",
  "error.registration_failed": "Registration failed",
  "error.invalid_credentials": "Invalid email or password",
  "error.skill_exists": "A skill with this name already exists",
  "error.skill_limit": "You've reached the 50-skill limit",
  "error.skill_name_reserved": "This name belongs to a built-in skill",
  "error.invalid_skill_name": "Name: lowercase letters, digits, hyphens (2–64 characters)",
  "error.invalid_skill_description": "Description is required, at most 280 characters",
  "error.invalid_skill_content": "Content is required, at most 64 KB",
  "error.skill_not_found": "Skill not found",

  "app.logout": "Logout",
  "app.sessionExpired": "Session expired — please log in again",
  "app.sessionGoneStartedNew":
    "Previous session is no longer available — started a new one",
  "status.connected": "connected",
  "status.connecting": "connecting",
  "status.disconnected": "disconnected",

  "sidebar.searchSessions": "Search sessions",
  "sidebar.searchPlaceholder": "Search chats…",
  "sidebar.expandSidebar": "Expand sidebar",
  "sidebar.collapseSidebar": "Collapse sidebar",
  "sidebar.newSession": "New chat",
  "sidebar.settings": "Settings",
  "sidebar.account": "Account",
  "sidebar.accountMenu": "Account menu",
  "sidebar.skills": "Skills",
  "sidebar.dataAnalysis": "Data analysis",

  "historyChat.untitled": "Untitled — {id}",
  "historyChat.groupToday": "Today",
  "historyChat.groupYesterday": "Yesterday",
  "historyChat.group7d": "Previous 7 Days",
  "historyChat.group30d": "Previous 30 Days",
  "historyChat.groupOlder": "Older",
  "historyChat.rowActions": "Options",
  "historyChat.rename": "Rename",
  "historyChat.delete": "Delete",
  "historyChat.deleteConfirm": "Delete this chat? This action cannot be undone.",
  "historyChat.titleTooLong": "Title must be at most 255 characters",
  "historyChat.statusRunning": "running",
  "historyChat.statusHibernated": "hibernated",
  "historyChat.statusArchived": "archived",

  "conversation.emptyHeading": "Start a conversation",
  "conversation.placeholder": "Message the agent…",
  "conversation.send": "Send",
  "conversation.stop": "Stop",
  "conversation.thinking": "Thinking…",
  "conversation.runningTool": "Running a tool…",
  "conversation.elapsedSeconds": "{s}s",
  "conversation.elapsedMinutes": "{m}m {s}s",
  "conversation.disconnectedWhileRunning": "Lost connection to the agent. Reload the page to continue.",
  "conversation.stopped": "Stopped.",
  "conversation.turnEnded": "turn {n} ended: {reason}",
  "conversation.modelError": "Model call failed ({code}): {message}",
  "conversation.toolRunning": "Using {name}…",
  "conversation.toolUsed": "Used {name}",
  "conversation.toolFailed": "Failed to use {name}",
  "conversation.skillLoading": "Reading skill {name}…",
  "conversation.skillLoaded": "Read skill {name}",
  "conversation.skillFailed": "Couldn't read skill {name}",
  "conversation.rulesApplied": "Applied project rules",
  "conversation.rulesUpdated": "Updated project rules",
  "conversation.rulesRemoved": "Removed project rules",
  "conversation.toolInterrupted": "The turn ended before a result arrived.",
  "conversation.copyCode": "Copy",
  "conversation.codeCopied": "Copied",
  "conversation.searching": "Searching…",
  "conversation.searched": "Searched {n} sources",
  "conversation.searchEmpty": "No results found",
  "conversation.searchFailed": "Search failed",
  "conversation.searchStopped": "Search stopped",
  "conversation.searchTruncated": "Source list truncated",
  "conversation.untitledSession": "New chat",
  "workspace.upload": "Upload file",
  "workspace.uploading": "Uploading…",
  "workspace.files": "Files ({n})",
  "workspace.empty": "No files yet. Upload data to get started.",
  "workspace.uploaded": "Uploaded {name}",
  "workspace.uploadFailed": "Could not upload {name}",
  "workspace.tooLarge": "{name} is too large (max 70 MB)",
  "workspace.openFailed": "Could not open {name}",

  "projects.eyebrow": "Data analysis",
  "projects.title": "Projects",
  "projects.search": "Search projects",
  "projects.create": "Create",
  "projects.newName": "New project name",
  "projects.createSubmit": "Create project",
  "projects.cancel": "Cancel",
  "projects.colName": "Name",
  "projects.colModified": "Modified",
  "projects.today": "Today",
  "projects.emptyList": "No projects yet. Create one to gather data sources and related chats.",
  "projects.back": "Back to projects",
  "projects.rename": "Rename project",
  "projects.delete": "Delete project",
  "projects.deleteConfirm": "Delete project \"{name}\" with all its chats and files? This cannot be undone.",
  "projects.composer": "New chat in {name}",
  "projects.start": "Start",
  "projects.tabChats": "Chats",
  "projects.tabSources": "Sources",
  "projects.tabOutputs": "Outputs",
  "projects.noChats": "No chats in this project yet.",
  "projects.dropTitle": "Add sources to the project",
  "projects.dropHint": "CSV, Excel, Parquet, JSON or documents — up to 70 MB",
  "projects.sourceDataset": "Data source",
  "projects.sourceFile": "Input file",
  "projects.noSources": "No sources in this project yet.",
  "projects.outputsProject": "Project outputs",
  "projects.outputsProjectHint": "Results chosen for every chat in the project to use.",
  "projects.outputsChats": "Results from chats",
  "projects.outputsChatsHint": "Each chat keeps its own results; add one to the project to share it.",
  "projects.outputsOther": "Other files written by the model",
  "projects.outputsOtherHint": "The model wrote these straight into the project folder instead of a chat's own output folder, so the chat is unknown.",
  "projects.sharedInProject": "Shared in the project",
  "projects.promote": "Add to project",
  "projects.promoted": "Added {name} to the project",
  "projects.promoteFailed": "Couldn't add it to the project",
  "projects.noOutputs": "No outputs yet.",
  "projects.loadFailed": "Couldn't load projects",
  "projects.saveFailed": "Couldn't save the project",
  "projects.tabRules": "Rules",
  "projects.rulesHint": "Every chat in this project follows these rules — e.g. currency units, data to ignore, how to present results. Edited rules apply to open chats from their next question.",
  "projects.rulesPlaceholder": "- Revenue in millions of VND, one decimal place\n- Ignore cancelled orders\n- Always state the period a figure covers",
  "projects.rulesSize": "{n}/{max} bytes",
  "projects.rulesSave": "Save rules",
  "projects.rulesSaved": "Project rules saved",

  "settings.title": "Settings",
  "settings.generalTab": "General",
  "settings.profileTab": "Profile",
  "settings.theme": "Theme",
  "settings.themeLight": "Light",
  "settings.themeDark": "Dark",
  "settings.language": "Language",
  "settings.profileEmail": "Email address",

  "skills.title": "Skills",
  "skills.new": "New skill",
  "skills.mine": "My skills",
  "skills.emptyMine": "No skills yet",
  "skills.builtin": "Built-in skills",
  "skills.builtinReadonly": "Built-in skills are shared by everyone and can't be edited. Type /{name} in the chat to use it.",
  "skills.name": "Name",
  "skills.namePlaceholder": "e.g. weekly-report",
  "skills.nameHint": "Lowercase letters, digits, hyphens. Can't be changed later. Type /name in the chat to use it.",
  "skills.description": "Description — when to use it",
  "skills.content": "Content",
  "skills.expand": "Expand",
  "skills.collapse": "Collapse",
  "skills.save": "Save",
  "skills.saving": "Saving…",
  "skills.delete": "Delete",
  "skills.deleteConfirm": "Delete skill \"{name}\"? This cannot be undone.",
  "skills.saved": "Saved skill {name}",
  "skills.deleted": "Deleted skill {name}",
  "skills.loadFailed": "Couldn't load skills",
  "skills.createdFromChat": "Saved skill {name} — type /{name} to use it",
  "skills.mineBadge": "mine",

  "theme.switchToDark": "Switch to dark theme",
  "theme.switchToLight": "Switch to light theme",
};
