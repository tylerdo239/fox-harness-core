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
      className={`[#sidebar-col&]:[padding:6px_12px] [#sidebar-col&]:[background:var(--surface)] [#sidebar-col&]:[border-right:1px_solid_var(--border)] [#sidebar-col&]:min-w-0 [#sidebar-col&]:overflow-hidden [#sidebar-col&]:flex [#sidebar-col&]:flex-col fh-sidebar-col fh-data-studio-sidebar${collapsed ? " fh-sidebar-rail [#sidebar-col&]:items-center [#sidebar-col&&]:[padding:6px] [#sidebar-col&_.fh-sidebar-brand-mark]:hidden [#sidebar-col&_.fh-sidebar-brand-name]:hidden [#sidebar-col&_.fh-sidebar-search-toggle]:hidden [#sidebar-col&_.fh-sidebar-region]:hidden [#sidebar-col&_.fh-sidebar-new-session-label]:hidden [#sidebar-col&_.fh-sidebar-account-email]:hidden [#sidebar-col&_.fh-sidebar-account-more]:hidden [#sidebar-col&_.fh-sidebar-logo-row]:[height:36px] [#sidebar-col&_.fh-sidebar-logo-row]:[margin-bottom:12px] [#sidebar-col&_.fh-sidebar-logo-row]:p-0 [#sidebar-col&_.fh-sidebar-logo-row]:justify-center [#sidebar-col&_.fh-sidebar-brand]:flex-none [#sidebar-col&_.fh-sidebar-new-session]:[width:36px] [#sidebar-col&_.fh-sidebar-new-session]:[height:36px] [#sidebar-col&_.fh-sidebar-new-session]:[margin:0_0_12px] [#sidebar-col&_.fh-sidebar-new-session]:p-0 [#sidebar-col&_.fh-sidebar-new-session]:[border-color:transparent] [#sidebar-col&_.fh-sidebar-new-session]:[background:transparent] [#sidebar-col&_.fh-sidebar-skills]:[width:36px] [#sidebar-col&_.fh-sidebar-skills]:justify-center [#sidebar-col&_.fh-sidebar-skills]:[margin:0_0_12px] [#sidebar-col&_.fh-sidebar-skills]:p-0 [#sidebar-col&_.fh-sidebar-skills-label]:hidden [#sidebar-col&_.fh-sidebar-data-analysis]:[width:36px] [#sidebar-col&_.fh-sidebar-data-analysis]:justify-center [#sidebar-col&_.fh-sidebar-data-analysis]:[margin:0_0_12px] [#sidebar-col&_.fh-sidebar-data-analysis]:p-0 [#sidebar-col&_.fh-sidebar-data-analysis-label]:hidden [#sidebar-col&_.fh-sidebar-data-studio]:[width:36px] [#sidebar-col&_.fh-sidebar-data-studio]:justify-center [#sidebar-col&_.fh-sidebar-data-studio]:[margin:0_0_12px] [#sidebar-col&_.fh-sidebar-data-studio]:p-0 [#sidebar-col&_.fh-sidebar-data-studio-label]:hidden [#sidebar-col&_.fh-data-studio-nav-item]:flex-none [#sidebar-col&_.fh-data-studio-nav-item]:[width:36px] [#sidebar-col&_.fh-data-studio-nav-item]:justify-center [#sidebar-col&_.fh-data-studio-nav-item]:[margin:0_0_4px] [#sidebar-col&_.fh-data-studio-nav-item]:p-0 [#sidebar-col&_.fh-data-studio-nav-label]:hidden [#sidebar-col&.fh-data-studio-sidebar_.fh-sidebar-logo-row]:flex-col [#sidebar-col&.fh-data-studio-sidebar_.fh-sidebar-logo-row]:[height:auto] [#sidebar-col&.fh-data-studio-sidebar_.fh-sidebar-logo-row]:[gap:8px] [#sidebar-col&.fh-data-studio-sidebar_.fh-sidebar-brand]:hidden" : ""}`}
    >
      <div className="fh-sidebar-logo-row flex-none flex items-center justify-end [gap:8px] [height:60px] [margin-bottom:8px] [padding:8px_0_8px_4px] overflow-hidden">
        <IconButton
          className="fh-data-studio-back"
          onClick={onBackToMain}
          title={t("dataStudio.backToMain")}
        >
          <ArrowLeftIcon size={16} />
        </IconButton>
        <div className="fh-sidebar-brand inline-flex items-center [gap:8px] min-w-0 [flex:1] overflow-hidden">
          <span className="fh-sidebar-brand-mark inline-flex flex-none items-center justify-center [color:var(--accent)]">
            <BrandMarkIcon size={22} />
          </span>
          <span className="fh-sidebar-brand-name [font-size:18px] font-semibold [letter-spacing:0.04em] whitespace-nowrap overflow-hidden text-ellipsis [color:var(--accent)]">{t("dataStudio.title")}</span>
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
        className="fh-sidebar-new-session flex-none [margin:0_2px_8px]"
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
      <div className="fh-sidebar-region [flex:1] min-h-0 overflow-y-auto [scrollbar-width:thin] [scrollbar-color:var(--border)_transparent] [&::-webkit-scrollbar]:[width:8px] [&::-webkit-scrollbar-thumb]:[background:var(--border)] [&::-webkit-scrollbar-thumb]:[border-radius:999px] [&::-webkit-scrollbar-thumb:hover]:[background:var(--muted)] [&::-webkit-scrollbar-track]:[background:transparent]">
        {activeSection === "chat" && <HistoryChat query="" flowFilter="data-studio" />}
      </div>

      {/* the same account row as the main sidebar (Settings, Logout) */}
      <div className="fh-sidebar-foot flex-none flex flex-col [margin-top:auto]">
        <AccountMenu onOpenSettings={onOpenSettings} onLogout={onLogout} onOpenUsage={onOpenUsage} />
      </div>
    </div>
  );
}
