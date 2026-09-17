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
  GlossaryIcon,
  MessageSquareIcon,
  MetricsIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  PlusIcon,
  RelationshipsIcon,
} from "../../../icons.tsx";
import { useLocale } from "../../../i18n/locale.tsx";
import type { TranslationKey } from "../../../i18n/translations.ts";
import { Button } from "../../primitives/Button.tsx";
import { IconButton } from "../../primitives/IconButton.tsx";
import { MenuItem } from "../../primitives/MenuItem.tsx";
import { HistoryChat } from "../sidebar/HistoryChat.tsx";

export type DataStudioSection =
  | "chat"
  | "dashboards"
  | "data-sources"
  | "glossary"
  | "relationships"
  | "metrics";

// Order: Chat first (the real feature), Dashboards right under it (user:
// "dashboard move lên dưới chat"), then the semantic-layer admin sections —
// Relationships sits right under Glossary (user: "thiếu relationships dưới
// Glossary") since both describe how entities relate/are named, mirroring
// example-data-studio-agent's own route set (src/apis/routes/relationships.py,
// a real route this nav had missed).
const SECTIONS: { key: DataStudioSection; icon: typeof MessageSquareIcon; labelKey: TranslationKey }[] = [
  { key: "chat", icon: MessageSquareIcon, labelKey: "dataStudio.sectionChat" },
  { key: "dashboards", icon: DashboardsIcon, labelKey: "dataStudio.sectionDashboards" },
  { key: "data-sources", icon: DataSourcesIcon, labelKey: "dataStudio.sectionDataSources" },
  { key: "glossary", icon: GlossaryIcon, labelKey: "dataStudio.sectionGlossary" },
  { key: "relationships", icon: RelationshipsIcon, labelKey: "dataStudio.sectionRelationships" },
  { key: "metrics", icon: MetricsIcon, labelKey: "dataStudio.sectionMetrics" },
];

export function DataStudioSidebar({
  collapsed,
  onToggleCollapse,
  activeSection,
  onSelectSection,
  onNewChat,
  newChatDisabled,
  onBackToMain,
}: {
  collapsed: boolean;
  onToggleCollapse: () => void;
  activeSection: DataStudioSection;
  onSelectSection: (section: DataStudioSection) => void;
  onNewChat: () => void;
  newChatDisabled: boolean;
  onBackToMain: () => void;
}) {
  const { t } = useLocale();

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

      {SECTIONS.map(({ key, icon: Icon, labelKey }) => (
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

      {activeSection === "chat" && (
        <div className="fh-sidebar-region">
          <HistoryChat query="" flowFilter="data-studio" />
        </div>
      )}
    </div>
  );
}
