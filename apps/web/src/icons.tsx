// Phase 14 follow-up (2026-09-08): the 4 emoji this app used as button
// glyphs (⚙ ✕ ☰ ✎) — first replaced with hand-drawn inline SVG, then asked
// to use a real icon library instead. dsh's own real icon set
// (`dsh-client-ui-primitives`'s real `Icon*` components) is confirmed NOT
// installed anywhere on this machine (Phase 14's research), so it can't be
// used directly — `lucide-react` (MIT, a maintained fork of Feather Icons,
// one of the most widely used free React icon sets) fills the same real
// need: single-color stroked line icons, `currentColor` by default (so
// they inherit whatever color the surrounding button already has), a real
// `size` prop. Kept as a thin re-export layer under this project's own
// names so the 4 call sites (Sidebar/SettingsDialog/App/HistoryChat) never
// needed to change.

export {
  Settings as GearIcon,
  X as CloseIcon,
  Menu as MenuIcon,
  Pencil as PencilIcon,
  Sun as SunIcon,
  Moon as MoonIcon,
  // Phase 15 (2026-09-08) — sidebar rebuild. `Bot` is a generic, neutral
  // brand mark (this project has no real logo asset, and dsh's own is
  // explicitly off-limits — same "same genre, not their brand" rule
  // followed for the whole palette). `PanelLeftClose`/`PanelLeftOpen` map
  // directly to dsh's real `toggle`/`panelIcon` sidebar-collapse control.
  Bot as BrandIcon,
  Plus as PlusIcon,
  Search as SearchIcon,
  PanelLeftClose as PanelLeftCloseIcon,
  PanelLeftOpen as PanelLeftOpenIcon,
  // Account menu (2026-09-10) — `MoreIcon` is the "..." affordance on the
  // sidebar's account row (hints it opens a menu, not a direct action);
  // `LogOutIcon` is the popup's own Logout item.
  MoreHorizontal as MoreIcon,
  LogOut as LogOutIcon,
  // Settings dialog's Profile tab nav item (2026-09-10).
  User as ProfileIcon,
  // Settings dialog's Language dropdown trigger (2026-09-10) — replaces
  // the bare native `<select>` with a real styled dropdown matching the
  // Theme picker's own polish right above it.
  ChevronDown as ChevronDownIcon,
  // HistoryChat.tsx's per-row "..." menu (2026-09-10) — `MoreIcon` (already
  // exists, reused) is the row's trigger; `TrashIcon` is the popup's Delete
  // item, next to the existing `PencilIcon` Rename item.
  Trash2 as TrashIcon,
  // Conversation.tsx's collapsed tool-call pill (2026-09-10, "làm UI UX
  // lại cho casual như các platform ai agent") — `ToolIcon` is generic on
  // purpose (search/bash/fs/... tools all share this one glyph, matching
  // real consumer AI platforms' own generic "used a tool" affordance
  // rather than a different icon per tool name); `ChevronDownIcon`
  // (already exists, reused) rotates to show expanded/collapsed state.
  Wrench as ToolIcon,
  // Skills (docs/skill-transfer-plan.md): sidebar entry, Skills dialog list
  // and its expand/collapse control for the content editor.
  Sparkles as SkillIcon,
  Maximize2 as ExpandIcon,
  Minimize2 as CollapseIcon,
  // docs/data-analysis-flow-plan.md: sidebar entry and history-row marker for
  // the "data-analysis" flow (same agent loop, its own profile).
  BarChart3 as DataAnalysisIcon,
  Paperclip as PaperclipIcon,
  Folder as FolderIcon,
  // Project hub (docs/rlm-transfer-plan.md 9.1) — same glyphs as agent-core's ui-projects.
  ArrowLeft as ArrowLeftIcon,
  FileOutput as FileOutputIcon,
  FileSpreadsheet as FileSpreadsheetIcon,
  FileText as FileTextIcon,
  MessageSquare as MessageSquareIcon,
  Share2 as ShareIcon,
} from 'lucide-react'
