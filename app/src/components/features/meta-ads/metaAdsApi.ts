// docs/meta-ads-mcp-plan.md: the user's ad platform connections (GET /connections, Meta's OAuth popup, disconnect)
// and the write confirmations of a Meta Ads chat (/meta-ads/actions). Mirrors services/gateway's ads/meta.ts shapes —
// app doesn't import api/, same "mirrored, not imported" rule as wire.ts.

import { useCallback, useEffect, useState } from "react";

import type { Runtime } from "../../../runtime.ts";

export interface ConnectionStatus {
  provider: "meta";
  enabled: boolean;
  connected: boolean;
  name?: string;
  scopes?: string[];
  expiresAt?: string;
  connectedAt?: string;
  /** expired | revoked: connect again */
  problem?: string;
}

export interface MetaAdsAction {
  callId: string;
  tool: string;
  summary: string;
  spends: boolean;
  status: "pending" | "approved" | "rejected" | "expired" | "done" | "error";
  error?: string;
  askedAt: string;
  expiresAt: string;
}

/** Tools whose call the user confirms first (the gateway's ads/tools.ts `write` tier). */
export const META_ADS_WRITE_TOOLS = new Set([
  "ads_create_campaign",
  "ads_create_ad_set",
  "ads_create_creative",
  "ads_create_ad",
  "ads_update_entity",
  "ads_activate_entity",
]);

export const isMetaAdsTool = (name: string) => name.startsWith("ads_");

export async function getMetaConnection(runtime: Runtime): Promise<ConnectionStatus | undefined> {
  const res = await runtime.authedFetch("/connections");
  if (!res.ok) return undefined;
  const body = (await res.json()) as { connections?: ConnectionStatus[] };
  return body.connections?.find((c) => c.provider === "meta");
}

/**
 * Opens Facebook Login in a popup and resolves once the gateway's callback page reports back (postMessage from the
 * same origin), or the popup closes. The popup is opened before the request so the browser treats it as part of
 * the click and does not block it.
 */
export async function connectMeta(runtime: Runtime): Promise<{ ok: boolean; reason?: string }> {
  const popup = window.open("about:blank", "fox-meta-connect", "width=620,height=760");
  const res = await runtime.authedFetch("/connections/meta/start", { method: "POST" });
  if (!res.ok) {
    popup?.close();
    const body = (await res.json().catch(() => ({}))) as { code?: string };
    return { ok: false, reason: body.code ?? `http_${res.status}` };
  }
  const { url } = (await res.json()) as { url: string };
  if (!popup) {
    // popup blocked: go there in this tab; the callback page then only says it is done
    window.location.assign(url);
    return { ok: false, reason: "redirected" };
  }
  popup.location.href = url;
  return new Promise((resolve) => {
    const done = (result: { ok: boolean; reason?: string }) => {
      window.removeEventListener("message", onMessage);
      clearInterval(closedTimer);
      resolve(result);
    };
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data as { type?: string; provider?: string; ok?: boolean; reason?: string } | null;
      if (data?.type !== "fox-connection" || data.provider !== "meta") return;
      done({ ok: data.ok === true, ...(data.reason ? { reason: data.reason } : {}) });
    };
    window.addEventListener("message", onMessage);
    const closedTimer = setInterval(() => {
      if (popup.closed) done({ ok: false, reason: "closed" });
    }, 500);
  });
}

export async function disconnectMeta(runtime: Runtime): Promise<boolean> {
  const res = await runtime.authedFetch("/connections/meta", { method: "DELETE" });
  return res.ok;
}

export async function listMetaActions(runtime: Runtime, sessionId: string): Promise<MetaAdsAction[]> {
  const res = await runtime.authedFetch(`/meta-ads/actions?sessionId=${encodeURIComponent(sessionId)}`);
  if (!res.ok) return [];
  return ((await res.json()) as { actions?: MetaAdsAction[] }).actions ?? [];
}

export async function decideMetaAction(runtime: Runtime, sessionId: string, callId: string, decision: "approve" | "reject"): Promise<number> {
  const res = await runtime.authedFetch("/meta-ads/actions/decision", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, callId, decision }),
  });
  return res.status;
}

/** The Meta connection, reloaded on demand (and when another component connects or disconnects). */
export function useMetaConnection(runtime: Runtime): { status: ConnectionStatus | undefined; reload: () => Promise<void> } {
  const [status, setStatus] = useState<ConnectionStatus>();
  const reload = useCallback(async () => {
    setStatus(await getMetaConnection(runtime).catch(() => undefined));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime.authedFetch]);
  useEffect(() => {
    void reload();
    const onChange = () => void reload();
    window.addEventListener("fox-meta-connection", onChange);
    return () => window.removeEventListener("fox-meta-connection", onChange);
  }, [reload]);
  return { status, reload };
}

export const announceMetaConnectionChange = () => window.dispatchEvent(new Event("fox-meta-connection"));
