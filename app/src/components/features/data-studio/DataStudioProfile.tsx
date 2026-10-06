// docs/data-studio-update-plan.md GĐ3 — the data profile (hồ sơ dữ liệu), admin only. The screens are the
// reference web's own (src/ref/, copied by scripts/sync-ref-profile.mjs, styled by public/ref.css under .fh-ref);
// this component only hosts them: a tab bar, the source list, and the reference's in-page links
// (/data-sources/<id>, /data-sources/<id>/entities/<entityId>, /data-sources/relationships, /metrics, /glossary)
// mapped onto view state. Their API calls go to services/gateway /data-studio/profile/* (src/ref/shims/fetch.ts).
//
// Metrics and terms here are the profile's (Mongo profile_metrics / profile_glossary, read by pipeline v4);
// the "Chỉ số" / "Thuật ngữ" sections stay the v3 ones (metrics / business_glossary).
import { useCallback, useEffect, useState } from "react";

import { useLocale } from "../../../i18n/locale.tsx";
import type { TranslationKey } from "../../../i18n/translations.ts";
import { useRuntime } from "../../../runtime.ts";
import EntityProfilePage from "../../../ref/pages/entity-profile.tsx";
import GlossaryPage from "../../../ref/pages/glossary.tsx";
import MetricsPage from "../../../ref/pages/metrics.tsx";
import RelationshipsPage from "../../../ref/pages/relationships.tsx";
import DataSourceDetailPage from "../../../ref/pages/source-profile.tsx";
import { setRefFetcher } from "../../../ref/shims/fetch.ts";
import { RefNavContext } from "../../../ref/shims/link.tsx";

type View =
  | { kind: "sources" }
  | { kind: "source"; id: string }
  | { kind: "entity"; id: string; entityId: string }
  | { kind: "relationships" }
  | { kind: "metrics" }
  | { kind: "glossary" };

interface SourceRow {
  id: string;
  name: string;
  source_type: string;
  is_exposed_to_agent: 0 | 1;
}

function viewOf(href: string): View {
  const path = href.split(/[?#]/)[0];
  if (path === "/data-sources/relationships") return { kind: "relationships" };
  if (path === "/metrics") return { kind: "metrics" };
  if (path === "/glossary") return { kind: "glossary" };
  const entity = /^\/data-sources\/([^/]+)\/entities\/([^/]+)$/.exec(path);
  if (entity) return { kind: "entity", id: decodeURIComponent(entity[1]), entityId: decodeURIComponent(entity[2]) };
  const source = /^\/data-sources\/([^/]+)$/.exec(path);
  if (source) return { kind: "source", id: decodeURIComponent(source[1]) };
  return { kind: "sources" };
}

const TABS: { kind: "sources" | "relationships" | "metrics" | "glossary"; labelKey: TranslationKey }[] = [
  { kind: "sources", labelKey: "dataStudio.profileTables" },
  { kind: "relationships", labelKey: "dataStudio.profileRelationships" },
  { kind: "metrics", labelKey: "dataStudio.profileMetrics" },
  { kind: "glossary", labelKey: "dataStudio.profileGlossary" },
];

export function DataStudioProfile() {
  const runtime = useRuntime();
  const { t } = useLocale();
  const [view, setView] = useState<View>({ kind: "sources" });
  const [sources, setSources] = useState<SourceRow[] | null>(null);

  // during render, so it is set before the reference pages' effects fetch
  setRefFetcher(runtime.authedFetch);

  const loadSources = useCallback(async () => {
    const res = await runtime.authedFetch("/data-studio/sources");
    if (res.ok) setSources(await res.json());
  }, [runtime]);

  useEffect(() => {
    if (view.kind === "sources") void loadSources();
  }, [view.kind, loadSources]);

  const navigate = useCallback((href: string) => setView(viewOf(href)), []);
  const activeTab = view.kind === "source" || view.kind === "entity" ? "sources" : view.kind;

  return (
    <div className="fh-data-studio-admin">
      <div className="fh-data-studio-admin-header">
        <h2>{t("dataStudio.sectionProfile")}</h2>
      </div>
      <div className="fh-data-studio-relationship-form">
        {TABS.map((tab) => (
          <button
            key={tab.kind}
            type="button"
            className={`fh-data-studio-tab${activeTab === tab.kind ? " fh-data-studio-tab-active" : ""}`}
            onClick={() => setView({ kind: tab.kind })}
          >
            {t(tab.labelKey)}
          </button>
        ))}
      </div>

      <RefNavContext.Provider value={navigate}>
        <div className="fh-ref">
          {view.kind === "sources" && (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">{t("dataStudio.profilePickSource")}</p>
              {sources === null ? (
                <p className="text-sm text-muted-foreground">{t("dataStudio.loading")}</p>
              ) : sources.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("dataStudio.profileNoSources")}</p>
              ) : (
                <ul className="divide-y rounded-md border">
                  {sources.map((s) => (
                    <li key={s.id}>
                      <button
                        type="button"
                        className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-accent"
                        onClick={() => setView({ kind: "source", id: s.id })}
                      >
                        <span className="font-medium">{s.name}</span>
                        <span className="text-xs text-muted-foreground">
                          {s.source_type}
                          {s.is_exposed_to_agent ? "" : ` · ${t("dataStudio.profileSourceOff")}`}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {view.kind === "source" && <DataSourceDetailPage key={view.id} params={{ id: view.id }} />}
          {view.kind === "entity" && (
            <EntityProfilePage key={view.entityId} params={{ id: view.id, entityId: view.entityId }} />
          )}
          {view.kind === "relationships" && <RelationshipsPage />}
          {view.kind === "metrics" && <MetricsPage />}
          {view.kind === "glossary" && <GlossaryPage />}
        </div>
      </RefNavContext.Provider>
    </div>
  );
}
