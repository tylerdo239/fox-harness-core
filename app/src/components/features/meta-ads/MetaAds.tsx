// docs/meta-ads-mcp-plan.md D7 — the confirmation card of a Meta Ads write (create / update / activate) and the banner
// of a Meta Ads chat whose user has not connected Meta yet. The gateway holds the write until the conversation's
// owner answers this card; nothing reaches Meta before that.
import { useEffect, useState } from "react";

import type { TranslationKey } from "../../../i18n/translations.ts";
import { useRuntime } from "../../../runtime.ts";
import { Button } from "../../primitives/Button.tsx";
import { decideMetaAction, listMetaActions, useMetaConnection, type MetaAdsAction } from "./metaAdsApi.ts";

type T = (key: TranslationKey, params?: Record<string, string>) => string;

export function MetaAdsActionCard({ callId, toolStatus, t }: { callId: string; toolStatus: "running" | "done" | "error"; t: T }) {
  const runtime = useRuntime();
  const [action, setAction] = useState<MetaAdsAction>();
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const sessionId = runtime.sessionId;

  // Poll while the call runs (the row appears a moment after the tool call; it then waits for the click),
  // once when it has finished (a reopened chat shows how it ended).
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      const found = (await listMetaActions(runtime, sessionId).catch(() => [])).find((a) => a.callId === callId);
      if (stopped) return;
      if (found) setAction(found);
      if (toolStatus === "running") timer = setTimeout(() => void load(), found?.status === "pending" ? 3000 : 1000);
    };
    void load();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callId, sessionId, toolStatus]);

  useEffect(() => {
    if (action?.status !== "pending") return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [action?.status]);

  async function answer(decision: "approve" | "reject") {
    setBusy(true);
    const status = await decideMetaAction(runtime, sessionId, callId, decision).catch(() => 0);
    const fresh = (await listMetaActions(runtime, sessionId).catch(() => [])).find((a) => a.callId === callId);
    if (fresh) setAction(fresh);
    else if (status === 200) setAction((a) => (a ? { ...a, status: decision === "approve" ? "approved" : "rejected" } : a));
    setBusy(false);
  }

  if (!action) {
    return toolStatus === "running" ? <div className="fh-meta-action fh-meta-action-wait">{t("metaAds.preparing")}</div> : null;
  }
  const left = Math.max(0, Math.round((Date.parse(action.expiresAt) - now) / 1000));
  const pending = action.status === "pending" && left > 0;
  const [title, ...lines] = action.summary.split("\n");
  return (
    <div className={`fh-meta-action fh-meta-action-${action.status}`}>
      <div className="fh-meta-action-head">
        <strong>{t("metaAds.confirmTitle")}</strong>
        <code>{title}</code>
      </div>
      {lines.length > 0 && (
        <ul className="fh-meta-action-lines">
          {lines.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      )}
      {action.spends && <div className="fh-meta-action-spend">{t("metaAds.spends")}</div>}
      {pending ? (
        <div className="fh-meta-action-buttons">
          <Button variant="raised" disabled={busy} onClick={() => void answer("approve")}>
            {t("metaAds.approve")}
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => void answer("reject")}>
            {t("metaAds.reject")}
          </Button>
          <span className="fh-meta-action-timer">{t("metaAds.timeLeft", { m: String(Math.floor(left / 60)), s: String(left % 60).padStart(2, "0") })}</span>
        </div>
      ) : (
        <div className="fh-meta-action-result">
          {t(`metaAds.status.${action.status === "pending" ? "expired" : action.status}` as TranslationKey)}
          {action.error ? `: ${action.error}` : ""}
        </div>
      )}
    </div>
  );
}

/** Above a Meta Ads chat: the account is not connected (or must be connected again). */
export function MetaAdsBanner({ onOpenConnections, t }: { onOpenConnections: () => void; t: T }) {
  const runtime = useRuntime();
  const { status } = useMetaConnection(runtime);
  if (!status || !status.enabled) return null;
  if (status.connected && !status.problem) return null;
  return (
    <div className="fh-meta-banner">
      <span>{status.connected ? t("metaAds.bannerExpired") : t("metaAds.bannerNotConnected")}</span>
      <Button variant="raised" onClick={onOpenConnections}>
        {t("metaAds.openConnections")}
      </Button>
    </div>
  );
}
