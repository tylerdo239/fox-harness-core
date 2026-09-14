import { useRef, useState } from "react";

import {
  BrandIcon,
  DataAnalysisIcon,
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
  onNewDataAnalysisSession,
  newSessionDisabled,
  onOpenSettings,
  onOpenSkills,
  onLogout,
}: {
  collapsed: boolean;
  onToggleCollapse: () => void;
  onNewSession: () => void;
  // docs/data-analysis-flow-plan.md: opens a new session on the
  // "data-analysis" flow (a different agent loop) instead of the default
  // one — same new-session semantics/guard as `onNewSession` otherwise.
  onNewDataAnalysisSession: () => void;
  // Real bug fixed 2026-09-10: already on a fresh, never-chatted session
  // -> clicking this used to close the socket and open ANOTHER new one
  // for nothing (see App.tsx's `startNewSession` for the actual guard;
  // this just disables the button so it's not silently inert either).
  newSessionDisabled: boolean;
  onOpenSettings: () => void;
  onOpenSkills: () => void;
  onLogout: () => void;
}) {
  const { t } = useLocale();
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  return (
    <div
      id="sidebar-col"
      className={`fh-sidebar-col${collapsed ? " fh-sidebar-rail" : ""}`}
    >
      <div className="fh-sidebar-logo-row">
        <div className="fh-sidebar-brand">
          <span className="fh-sidebar-brand-mark">
            <BrandIcon size={24} />
          </span>
          <span className="fh-sidebar-brand-name">Fox Harness</span>
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
        <div className="fh-sidebar-search-row">
          <Input
            ref={searchInputRef}
            id="session-search-input"
            className="fh-history-chat-search"
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
        className="fh-sidebar-new-session"
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
        className="fh-sidebar-skills"
        onClick={onOpenSkills}
        title={t("sidebar.skills")}
      >
        <SkillIcon size={16} />
        <span className="fh-sidebar-skills-label">{t("sidebar.skills")}</span>
      </MenuItem>

      <MenuItem
        variant="nav"
        className="fh-sidebar-data-analysis"
        onClick={onNewDataAnalysisSession}
        disabled={newSessionDisabled}
        title={t("sidebar.dataAnalysis")}
      >
        <DataAnalysisIcon size={16} />
        <span className="fh-sidebar-data-analysis-label">
          {t("sidebar.dataAnalysis")}
        </span>
      </MenuItem>

      <div className="fh-sidebar-region">
        <HistoryChat query={query} />
      </div>

      <div className="fh-sidebar-foot">
        <AccountMenu onOpenSettings={onOpenSettings} onLogout={onLogout} />
      </div>
    </div>
  );
}
