import { useRef, useState } from "react";

import {
  BrandIcon,
  DataAnalysisIcon,
  DataStudioIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  PlusIcon,
  SearchIcon,
  SkillIcon,
} from "../../../icons.tsx";
import { useLocale } from "../../../i18n/locale.tsx";
import { Button } from "../../primitives/Button.tsx";
import { IconButton } from "../../primitives/IconButton.tsx";
import { Input } from "../../primitives/Input.tsx";
import { MenuItem } from "../../primitives/MenuItem.tsx";
import { AccountMenu } from "./AccountMenu.tsx";
import { HistoryChat } from "./HistoryChat.tsx";
import { SidebarProjects } from "./SidebarProjects.tsx";

// Phase 15 (2026-09-08) — rebuilt against dsh-client-ui-sidebar's real
// structure. Follow-up the same day: user shared a real screenshot of the
// live chat.deepseek.com (compiled-source research alone hadn't fully
// closed the gap) — 2 corrections from that ground truth, both applied
// here: (1) the search toggle sits IN the logo row next to brand/collapse,
// not scoped inside the session-list header the way Phase 15 first built
// it — `searchOpen`/`query` state moved up from HistoryChat.tsx (then
// SessionList.tsx) into this component; (2) the footer is a real account
// row (avatar + email), not a plain "Settings" button. `fox-harness` is
// this project's own name, not
// dsh's — `BrandIcon` is a neutral lucide glyph, not a copied logo asset
// (same "same genre, not their brand" rule used for every other
// palette/icon choice this project has made).
//
// Follow-up (2026-09-10): the account row itself moved into its own
// `AccountMenu` component — it no longer opens the Settings dialog
// directly, it opens a popup (Settings/Logout) above itself instead. See
// AccountMenu.tsx for why. Same day, follow-up: search/collapse toggles,
// the search input, and the New Chat button now render through the shared
// `IconButton`/`Input`/`Button` primitives (docs/code-rules.md §67)
// instead of each hand-rolling its own button/input markup — `className`
// still carries each control's own distinguishing class (`fh-sidebar-
// search-toggle`, etc.) for the rail-mode hide/collapse rules that are
// specific to THIS component, not part of the shared primitive.
//
// Phase 13's `PluginUiArea` (conditional UI for an enabled backend plugin)
// is REMOVED, Phase 16 (2026-09-08, docs/agent-core-architecture-roadmap.md)
// — along with the whole per-user/session plugin catalog it depended on.
// Real need turned out to be "every user gets the same fixed capability
// set", so there's no more per-user "enabled" state for a piece of UI to
// condition on.
export function Sidebar({
  collapsed,
  onToggleCollapse,
  onNewSession,
  onOpenDataAnalysis,
  onOpenProject,
  dataAnalysisActive,
  onOpenDataStudio,
  newSessionDisabled,
  onOpenSettings,
  onOpenUsage,
  onOpenSkills,
  skillsActive = false,
  onLogout,
}: {
  collapsed: boolean;
  onToggleCollapse: () => void;
  onNewSession: () => void;
  // docs/rlm-transfer-plan.md 9.1: shows the data-analysis project hub in the
  // center column — data chats live inside projects, as in agent-core.
  onOpenDataAnalysis: () => void;
  onOpenProject: (projectId: string | null) => void;
  dataAnalysisActive: boolean;
  // docs/data-studio-agent-transfer-plan.md: `analyze_data` is a plain tool
  // in every session's default profile already — no flow/hub to open, so
  // this just starts a fresh chat (same action as "New chat"). A separate,
  // discoverable entry point rather than reusing onNewSession's button
  // directly, so the sidebar names the capability explicitly.
  onOpenDataStudio: () => void;
  // Real bug fixed 2026-09-10: already on a fresh, never-chatted session
  // -> clicking this used to close the socket and open ANOTHER new one
  // for nothing (see App.tsx's `startNewSession` for the actual guard;
  // this just disables the button so it's not silently inert either).
  newSessionDisabled: boolean;
  onOpenSettings: () => void;
  /** admins: the usage dashboard (/admin/usage) */
  onOpenUsage?: () => void;
  onOpenSkills: () => void;
  /** the skills page is what the main column shows */
  skillsActive?: boolean;
  onLogout: () => void;
}) {
  const { t } = useLocale();
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  return (
    <div
      id="sidebar-col"
      className={`[#sidebar-col&]:[padding:6px_12px] [#sidebar-col&]:[background:var(--surface)] [#sidebar-col&]:[border-right:1px_solid_var(--border)] [#sidebar-col&]:min-w-0 [#sidebar-col&]:overflow-hidden [#sidebar-col&]:flex [#sidebar-col&]:flex-col fh-sidebar-col${collapsed ? " fh-sidebar-rail [#sidebar-col&]:items-center [#sidebar-col&&]:[padding:6px] [#sidebar-col&_.fh-sidebar-brand-mark]:hidden [#sidebar-col&_.fh-sidebar-brand-name]:hidden [#sidebar-col&_.fh-sidebar-search-toggle]:hidden [#sidebar-col&_.fh-sidebar-region]:hidden [#sidebar-col&_.fh-sidebar-new-session-label]:hidden [#sidebar-col&_.fh-sidebar-account-email]:hidden [#sidebar-col&_.fh-sidebar-account-more]:hidden [#sidebar-col&_.fh-sidebar-logo-row]:[height:36px] [#sidebar-col&_.fh-sidebar-logo-row]:[margin-bottom:12px] [#sidebar-col&_.fh-sidebar-logo-row]:p-0 [#sidebar-col&_.fh-sidebar-logo-row]:justify-center [#sidebar-col&_.fh-sidebar-brand]:flex-none [#sidebar-col&_.fh-sidebar-new-session]:[width:36px] [#sidebar-col&_.fh-sidebar-new-session]:[height:36px] [#sidebar-col&_.fh-sidebar-new-session]:[margin:0_0_12px] [#sidebar-col&_.fh-sidebar-new-session]:p-0 [#sidebar-col&_.fh-sidebar-new-session]:[border-color:transparent] [#sidebar-col&_.fh-sidebar-new-session]:[background:transparent] [#sidebar-col&_.fh-sidebar-skills]:[width:36px] [#sidebar-col&_.fh-sidebar-skills]:justify-center [#sidebar-col&_.fh-sidebar-skills]:[margin:0_0_12px] [#sidebar-col&_.fh-sidebar-skills]:p-0 [#sidebar-col&_.fh-sidebar-skills-label]:hidden [#sidebar-col&_.fh-sidebar-data-analysis]:[width:36px] [#sidebar-col&_.fh-sidebar-data-analysis]:justify-center [#sidebar-col&_.fh-sidebar-data-analysis]:[margin:0_0_12px] [#sidebar-col&_.fh-sidebar-data-analysis]:p-0 [#sidebar-col&_.fh-sidebar-data-analysis-label]:hidden [#sidebar-col&_.fh-sidebar-data-studio]:[width:36px] [#sidebar-col&_.fh-sidebar-data-studio]:justify-center [#sidebar-col&_.fh-sidebar-data-studio]:[margin:0_0_12px] [#sidebar-col&_.fh-sidebar-data-studio]:p-0 [#sidebar-col&_.fh-sidebar-data-studio-label]:hidden [#sidebar-col&_.fh-data-studio-nav-item]:flex-none [#sidebar-col&_.fh-data-studio-nav-item]:[width:36px] [#sidebar-col&_.fh-data-studio-nav-item]:justify-center [#sidebar-col&_.fh-data-studio-nav-item]:[margin:0_0_4px] [#sidebar-col&_.fh-data-studio-nav-item]:p-0 [#sidebar-col&_.fh-data-studio-nav-label]:hidden [#sidebar-col&.fh-data-studio-sidebar_.fh-sidebar-logo-row]:flex-col [#sidebar-col&.fh-data-studio-sidebar_.fh-sidebar-logo-row]:[height:auto] [#sidebar-col&.fh-data-studio-sidebar_.fh-sidebar-logo-row]:[gap:8px] [#sidebar-col&.fh-data-studio-sidebar_.fh-sidebar-brand]:hidden" : ""}`}
    >
      <div className="fh-sidebar-logo-row flex-none flex items-center justify-end [gap:8px] [height:60px] [margin-bottom:8px] [padding:8px_0_8px_4px] overflow-hidden">
        <div className="fh-sidebar-brand inline-flex items-center [gap:8px] min-w-0 [flex:1] overflow-hidden">
          <span className="fh-sidebar-brand-mark inline-flex flex-none items-center justify-center [color:var(--accent)]">
            <BrandIcon size={24} />
          </span>
          <span className="fh-sidebar-brand-name [font-size:18px] font-semibold [letter-spacing:0.04em] whitespace-nowrap overflow-hidden text-ellipsis [color:var(--accent)]">Fox Agent</span>
        </div>
        <IconButton
          className="fh-sidebar-search-toggle"
          onClick={() => {
            setSearchOpen(true);
            setTimeout(() => searchInputRef.current?.focus(), 0);
          }}
          title={t("sidebar.searchSessions")}
        >
          <SearchIcon size={14} />
        </IconButton>
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

      {searchOpen && (
        <div className="fh-sidebar-search-row flex-none [padding:0_2px_8px]">
          <Input
            ref={searchInputRef}
            id="session-search-input"
            className="fh-history-chat-search [input[type=text]&]:w-full [input[type=text]&]:[height:30px] [input[type=text]&]:[padding:0_0.6em] [input[type=text]&]:[border:1px_solid_var(--border)] [input[type=text]&:focus]:[border-color:var(--accent)] [input[type=text]&]:[border-radius:10px] [input[type=text]&]:[background:transparent] [input[type=text]&]:[color:var(--fg)] [input[type=text]&]:[font-size:0.85em]"
            type="text"
            placeholder={t("sidebar.searchPlaceholder")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onBlur={() => {
              if (!query) setSearchOpen(false);
            }}
          />
        </div>
      )}

      <Button
        variant="raised"
        className="fh-sidebar-new-session flex-none [margin:0_2px_8px]"
        onClick={onNewSession}
        disabled={newSessionDisabled}
      >
        <PlusIcon size={16} />
        <span className="fh-sidebar-new-session-label">
          {t("sidebar.newSession")}
        </span>
      </Button>

      <MenuItem
        variant="nav"
        className="fh-sidebar-skills flex-none [margin:0_2px_8px]"
        active={skillsActive}
        onClick={onOpenSkills}
        title={t("sidebar.skills")}
      >
        <SkillIcon size={16} />
        <span className="fh-sidebar-skills-label">{t("sidebar.skills")}</span>
      </MenuItem>

      <MenuItem
        variant="nav"
        className="fh-sidebar-data-analysis flex-none [margin:0_2px_8px]"
        active={dataAnalysisActive}
        onClick={onOpenDataAnalysis}
        title={t("sidebar.dataAnalysis")}
      >
        <DataAnalysisIcon size={16} />
        <span className="fh-sidebar-data-analysis-label">
          {t("sidebar.dataAnalysis")}
        </span>
      </MenuItem>

      <MenuItem
        variant="nav"
        className="fh-sidebar-data-studio flex-none [margin:0_2px_8px]"
        onClick={onOpenDataStudio}
        title={t("sidebar.dataStudio")}
      >
        <DataStudioIcon size={16} />
        <span className="fh-sidebar-data-studio-label">
          {t("sidebar.dataStudio")}
        </span>
      </MenuItem>

      <div className="fh-sidebar-region [flex:1] min-h-0 overflow-y-auto [scrollbar-width:thin] [scrollbar-color:var(--border)_transparent] [&::-webkit-scrollbar]:[width:8px] [&::-webkit-scrollbar-thumb]:[background:var(--border)] [&::-webkit-scrollbar-thumb]:[border-radius:999px] [&::-webkit-scrollbar-thumb:hover]:[background:var(--muted)] [&::-webkit-scrollbar-track]:[background:transparent]">
        <SidebarProjects onOpenProject={onOpenProject} />
        <HistoryChat query={query} />
      </div>

      <div className="fh-sidebar-foot flex-none flex flex-col [margin-top:auto]">
        <AccountMenu onOpenSettings={onOpenSettings} onLogout={onLogout} onOpenUsage={onOpenUsage} />
      </div>
    </div>
  );
}
