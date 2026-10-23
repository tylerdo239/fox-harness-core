// Settings → Memory (docs/memory-plugin-plan.md §8): what the agent remembers about the member — lasting conventions
// ("About you, every chat") and per chat — with edit, delete, delete all and the member's own switch. Admins also get
// the organization switch. Numbers and text the member said; never another member's.
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { useLocale } from "../../../i18n/locale.tsx";
import { MemoryIcon, PencilIcon, TrashIcon } from "../../../icons.tsx";
import { useRuntime } from "../../../runtime.ts";
import { Button } from "../../primitives/Button.tsx";
import { Switch } from "../../primitives/Switch.tsx";
import {
  clearMemory, deleteMemory, editMemory, getMemory, getOrgMemory, setMyMemory, setOrgMemory, type MemoryItem, type MemoryState,
} from "./memoryApi.ts";

function MemoryRow({ item, onChanged }: { item: MemoryItem; onChanged: () => void }) {
  const runtime = useRuntime();
  const { t } = useLocale();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  // edit the value, not the "label: value (trước: …)" line
  const value = item.text.replace(/^\[[^\]]*\]\s*/, "").replace(/\s*\(trước:.*\)$/, "").replace(/^[^:]*:\s*/, "");
  const [draft, setDraft] = useState(value);

  async function save(): Promise<void> {
    if (!draft.trim()) return;
    setBusy(true);
    try {
      await editMemory(runtime, item.id, draft.trim());
      setEditing(false);
      onChanged();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function remove(): Promise<void> {
    setBusy(true);
    try {
      await deleteMemory(runtime, item.id);
      onChanged();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
      setBusy(false);
    }
  }

  return (
    <li className="fh-memory-row">
      {editing ? (
        <div className="fh-memory-edit">
          <textarea value={draft} maxLength={2000} rows={2} onChange={(event) => setDraft(event.target.value)} aria-label={t("memory.editLabel")} />
          <div className="fh-memory-edit-actions">
            <Button variant="outline" disabled={busy} onClick={() => setEditing(false)}>{t("memory.cancel")}</Button>
            <Button variant="primary" disabled={busy || !draft.trim()} onClick={() => void save()}>{t("memory.save")}</Button>
          </div>
        </div>
      ) : (
        <>
          <span className="fh-memory-text">{item.text}</span>
          <span className="fh-memory-actions">
            <button type="button" className="fh-memory-icon" title={t("memory.edit")} aria-label={t("memory.edit")} disabled={busy} onClick={() => { setDraft(value); setEditing(true); }}>
              <PencilIcon size={14} />
            </button>
            <button type="button" className="fh-memory-icon fh-memory-danger" title={t("memory.delete")} aria-label={t("memory.delete")} disabled={busy} onClick={() => void remove()}>
              <TrashIcon size={14} />
            </button>
          </span>
        </>
      )}
    </li>
  );
}

export function MemoryTab() {
  const runtime = useRuntime();
  const { t } = useLocale();
  const isAdmin = runtime.userRole === "admin";
  const [state, setState] = useState<MemoryState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [org, setOrg] = useState<{ enabled: boolean; locked?: boolean } | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const load = useCallback(async () => {
    try {
      setState(await getMemory(runtime));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    if (isAdmin) setOrg(await getOrgMemory(runtime).catch(() => null));
  }, [runtime, isAdmin]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <p className="fh-memory-error">{error}</p>;
  if (!state) return <p className="fh-memory-muted">{t("memory.loading")}</p>;

  const lasting = state.memories.filter((m) => m.layer === "user");
  const chats = new Map<string, { title: string; items: MemoryItem[] }>();
  for (const item of state.memories.filter((m) => m.layer === "chat")) {
    const key = item.sessionId ?? "";
    const group = chats.get(key) ?? { title: item.chatTitle || t("memory.untitledChat"), items: [] };
    group.items.push(item);
    chats.set(key, group);
  }

  return (
    <div className="fh-memory">
      <div className="fh-memory-head">
        <span className="fh-memory-head-icon"><MemoryIcon size={18} /></span>
        <div>
          <div className="fh-settings-section-title">{t("memory.title")}</div>
          <p className="fh-memory-muted">{t("memory.hint")}</p>
        </div>
      </div>

      {!state.configured && <p className="fh-memory-notice">{t("memory.notConfigured")}</p>}
      {state.configured && !state.orgEnabled && <p className="fh-memory-notice">{t("memory.orgOff")}</p>}

      {isAdmin && org !== null && (
        <div className="fh-memory-switch-row">
          <Switch
            checked={org.enabled}
            label={t("memory.orgSwitch")}
            disabled={!state.configured || org.locked === true}
            onChange={(next) => void setOrgMemory(runtime, next).then(load, (e: unknown) => toast.error(String(e)))}
          />
          {org.locked && <span className="fh-memory-muted fh-memory-locked">{t("memory.orgLocked")}</span>}
        </div>
      )}
      <div className="fh-memory-switch-row">
        <Switch
          checked={state.enabled}
          label={t("memory.mySwitch")}
          onChange={(next) => void setMyMemory(runtime, next).then(load, (e: unknown) => toast.error(String(e)))}
        />
      </div>

      <section className="fh-memory-section">
        <h4>{t("memory.lasting")}</h4>
        {lasting.length === 0 ? <p className="fh-memory-muted">{t("memory.emptyLasting")}</p> : (
          <ul className="fh-memory-list">{lasting.map((item) => <MemoryRow key={item.id} item={item} onChanged={() => void load()} />)}</ul>
        )}
      </section>

      <section className="fh-memory-section">
        <h4>{t("memory.perChat")}</h4>
        {chats.size === 0 ? <p className="fh-memory-muted">{t("memory.emptyChats")}</p> : [...chats.entries()].map(([sessionId, group]) => (
          <div key={sessionId} className="fh-memory-chat">
            <div className="fh-memory-chat-head">
              <span className="fh-memory-chat-title">{group.title}</span>
              <button type="button" className="fh-memory-link" onClick={() => void clearMemory(runtime, { sessionId }).then(load, (e: unknown) => toast.error(String(e)))}>
                {t("memory.clearChat")}
              </button>
            </div>
            <ul className="fh-memory-list">{group.items.map((item) => <MemoryRow key={item.id} item={item} onChanged={() => void load()} />)}</ul>
          </div>
        ))}
      </section>

      {state.memories.length > 0 && (
        <div className="fh-memory-clear">
          {confirmClear ? (
            <>
              <span>{t("memory.clearConfirm")}</span>
              <Button variant="outline" onClick={() => setConfirmClear(false)}>{t("memory.cancel")}</Button>
              <Button variant="primary" onClick={() => void clearMemory(runtime).then(() => { setConfirmClear(false); return load(); }, (e: unknown) => toast.error(String(e)))}>
                {t("memory.clearAll")}
              </Button>
            </>
          ) : (
            <Button variant="outline" onClick={() => setConfirmClear(true)}><TrashIcon size={14} />{t("memory.clearAll")}</Button>
          )}
        </div>
      )}
    </div>
  );
}
