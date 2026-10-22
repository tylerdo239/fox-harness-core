// docs/data-studio-agent-transfer-plan.md — the Data Studio route's own
// sidebar (separate from Sidebar.tsx, which is never rendered while this
// one is). Same shell conventions (logo row, collapse toggle, `MenuItem`
// nav) as Sidebar.tsx, but scoped entirely to this flow: a back link to the
// main app instead of the account menu, a chat list filtered to
// `flow: "data-studio"` (HistoryChat.tsx's `flowFilter` prop), and nav
// entries for the semantic-layer admin sections (Phase 3 — placeholders
// for now, see DataStudioComingSoon.tsx).
import {
  ArrowLeftIcon,
  DashboardsIcon,
  DataSourcesIcon,
  DataStudioIcon as BrandMarkIcon,
  MessageSquareIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  PlusIcon,
  DataProfileIcon,
} from "../../../icons.tsx";
import { useLocale } from "../../../i18n/locale.tsx";
import type { TranslationKey } from "../../../i18n/translations.ts";
import { useRuntime } from "../../../runtime.ts";
import { Button } from "../../primitives/Button.tsx";
import { IconButton } from "../../primitives/IconButton.tsx";
import { MenuItem } from "../../primitives/MenuItem.tsx";
import { AccountMenu } from "../sidebar/AccountMenu.tsx";
import { HistoryChat } from "../sidebar/HistoryChat.tsx";

export type DataStudioSection =
  | "chat"
  | "dashboards"
  | "data-sources"
  | "profile";

// Order: Chat first (the real feature), Dashboards right under it (user: "dashboard move lên dưới chat"), then the
// admin sections. Glossary, Relationships and Metrics are no longer here (2026-10-19): they were pipeline v3's
// (Mongo business_glossary / metrics, edited outside the search index); their v4 versions are tabs of
// "Hồ sơ dữ liệu" (DataStudioProfile.tsx), which is where the pipeline reads them from.
// `adminOnly`: the semantic-layer admin sections — services/gateway 403s their /data-studio/* routes for role
// `user`, who only gets Chat and the read-only Dashboards.
const SECTIONS: { key: DataStudioSection; icon: typeof MessageSquareIcon; labelKey: TranslationKey; adminOnly?: boolean }[] = [
  { key: "chat", icon: MessageSquareIcon, labelKey: "dataStudio.sectionChat" },
  { key: "dashboards", icon: DashboardsIcon, labelKey: "dataStudio.sectionDashboards" },
  { key: "data-sources", icon: DataSourcesIcon, labelKey: "dataStudio.sectionDataSources", adminOnly: true },
  { key: "profile", icon: DataProfileIcon, labelKey: "dataStudio.sectionProfile", adminOnly: true },
];

export function DataStudioSidebar({
  collapsed,
  onToggleCollapse,
  activeSection,
  onSelectSection,
  onNewChat,
  newChatDisabled,
  onBackToMain,
  onOpenSettings,
  onOpenUsage,
  onLogout,
}: {
  collapsed: boolean;
  onToggleCollapse: () => void;
  activeSection: DataStudioSection;
  onSelectSection: (section: DataStudioSection) => void;
  onNewChat: () => void;
  newChatDisabled: boolean;
  onBackToMain: () => void;
  onOpenSettings: () => void;
  /** admins: the usage dashboard (/admin/usage) */
  onOpenUsage?: () => void;
  onLogout: () => void;
}) {
  const { t } = useLocale();
  const { userRole } = useRuntime();
  const sections = SECTIONS.filter((section) => userRole === "admin" || !section.adminOnly);

  return (
    <div
      id="sidebar-col"
      className={`fh-sidebar-col fh-data-studio-sidebar${collapsed ? " fh-sidebar-rail" : ""}`}
    >
      <div className="fh-sidebar-logo-row">
        <IconButton
          className="fh-data-studio-back"
          onClick={onBackToMain}
          title={t("dataStudio.backToMain")}
        >
          <ArrowLeftIcon size={16} />
        </IconButton>
        <div className="fh-sidebar-brand">
          <span className="fh-sidebar-brand-mark">
            <BrandMarkIcon size={22} />
          </span>
          <span className="fh-sidebar-brand-name">{t("dataStudio.title")}</span>
        </div>
        <IconButton
          className="fh-sidebar-collapse-toggle"
          onClick={onToggleCollapse}
          title={
            collapsed
              ? t("sidebar.expandSidebar")
              : t("sidebar.collapseSidebar")
          }
        >
          {collapsed ? (
            <PanelLeftOpenIcon size={16} />
          ) : (
            <PanelLeftCloseIcon size={16} />
          )}
        </IconButton>
      </div>

      <Button
        variant="raised"
        className="fh-sidebar-new-session"
        onClick={onNewChat}
        disabled={newChatDisabled}
      >
        <PlusIcon size={16} />
        <span className="fh-sidebar-new-session-label">{t("sidebar.newSession")}</span>
      </Button>

      {sections.map(({ key, icon: Icon, labelKey }) => (
        <MenuItem
          key={key}
          variant="nav"
          className="fh-data-studio-nav-item"
          active={activeSection === key}
          onClick={() => onSelectSection(key)}
          title={t(labelKey)}
        >
          <Icon size={16} />
          <span className="fh-data-studio-nav-label">{t(labelKey)}</span>
        </MenuItem>
      ))}

      {/* always there, empty outside Chat: it fills the column so the account row stays at the bottom */}
      <div className="fh-sidebar-region">
        {activeSection === "chat" && <HistoryChat query="" flowFilter="data-studio" />}
      </div>

      {/* the same account row as the main sidebar (Settings, Logout) */}
      <div className="fh-sidebar-foot">
        <AccountMenu onOpenSettings={onOpenSettings} onLogout={onLogout} onOpenUsage={onOpenUsage} />
      </div>
    </div>
  );
}
