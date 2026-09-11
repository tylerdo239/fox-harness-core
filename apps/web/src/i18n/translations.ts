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
  // Technical event-log lines — only the English SCAFFOLDING words are
  // translated (`ended:`); turn numbers and reason codes stay exactly as
  // the wire sends them — they're identifiers/data, not English prose,
  // translating them would be meaningless (and wrong). No turn/{n}
  // divider anymore (removed 2026-09-10, see Conversation.tsx's own
  // comment on `turn/start`).
  "conversation.turnEnded": "lượt {n} kết thúc: {reason}",
  // Collapsed tool-call pill (2026-09-10, "làm UI UX lại cho casual như
  // các platform ai agent" — replaces the old always-expanded
  // `→ tool(args)` / `← result` technical cards, and the old
  // `conversation.toolError` key that went with them). `{name}` is the
  // real tool name (identifier, not translated, same reasoning as above).
  "conversation.toolRunning": "Đang dùng {name}…",
  "conversation.toolUsed": "Đã dùng {name}",
  "conversation.toolFailed": "Lỗi khi dùng {name}",
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
  "conversation.turnEnded": "turn {n} ended: {reason}",
  "conversation.toolRunning": "Using {name}…",
  "conversation.toolUsed": "Used {name}",
  "conversation.toolFailed": "Failed to use {name}",

  "settings.title": "Settings",
  "settings.generalTab": "General",
  "settings.profileTab": "Profile",
  "settings.theme": "Theme",
  "settings.themeLight": "Light",
  "settings.themeDark": "Dark",
  "settings.language": "Language",
  "settings.profileEmail": "Email address",

  "theme.switchToDark": "Switch to dark theme",
  "theme.switchToLight": "Switch to light theme",
};
