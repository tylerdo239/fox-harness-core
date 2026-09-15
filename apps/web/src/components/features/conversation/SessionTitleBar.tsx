// 2026-09-15 (user: "Ở góc trái đầu chat conversation kế sidebar nên có 1
// chỗ show tên đoạn chat... đây là input... đổi tên tên trên đây cũng file
// sync khi đổi từ trên sidebar") — click-to-edit title bar at the top of
// the chat column. Rename UX (empty-cancels, >255-chars toast, IME
// `isComposing` guard for Vietnamese, Escape cancels, blur commits) is a
// deliberate copy of `HistoryChat.tsx`'s own inline rename — that file's
// own comments have the full "why" for each of those; not repeated here.
// Sync with the sidebar goes through `runtime.ts`'s `sessionTitle`/
// `sessionsVersion` — see that file's own comment for the full design.
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { useLocale } from "../../../i18n/locale.tsx";
import { useRuntime } from "../../../runtime.ts";
import { Input } from "../../primitives/Input.tsx";

const TITLE_MAX_LENGTH = 255;

export function SessionTitleBar() {
  const runtime = useRuntime();
  const { t } = useLocale();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  // Escape hides the input (`setEditing(false)`), which the browser treats
  // as losing focus — that fires `onBlur` right after, which would
  // otherwise re-commit the very thing Escape just cancelled. Set right
  // before the state change, consumed (and cleared) by the `onBlur` this
  // triggers.
  const skipNextBlurRef = useRef(false);

  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  function startEditing(): void {
    setValue(runtime.sessionTitle ?? "");
    setEditing(true);
  }

  // `viaKeyboard`: true only when called while the input still HAS focus
  // (the Enter handler below) — closing it there is what triggers the
  // synthetic blur `skipNextBlurRef` needs to swallow. `onBlur`'s own call
  // (`viaKeyboard: false`) must NOT set that flag: the input has already
  // lost focus by the time `onBlur` fires, so removing it triggers no
  // further blur — setting the flag here anyway would leak `true` across
  // to the NEXT edit session with nothing left to clear it, silently
  // dropping a real future commit.
  async function commit(viaKeyboard: boolean): Promise<void> {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      if (viaKeyboard) skipNextBlurRef.current = true;
      setEditing(false);
      return;
    }
    if (trimmed.length > TITLE_MAX_LENGTH) {
      toast.error(t("historyChat.titleTooLong"));
      return;
    }
    if (viaKeyboard) skipNextBlurRef.current = true;
    setEditing(false);
    await runtime.authedFetch(`/sessions/${runtime.sessionId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: trimmed }),
    });
    runtime.setSessionTitle(trimmed);
    runtime.bumpSessionsVersion();
  }

  return (
    <div className="fh-session-title-bar">
      {editing ? (
        <Input
          ref={inputRef}
          type="text"
          className="fh-session-title-bar-input"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              if (event.nativeEvent.isComposing) return;
              event.preventDefault();
              void commit(true);
            } else if (event.key === "Escape") {
              skipNextBlurRef.current = true;
              setEditing(false);
            }
          }}
          onBlur={() => {
            if (skipNextBlurRef.current) {
              skipNextBlurRef.current = false;
              return;
            }
            void commit(false);
          }}
        />
      ) : (
        <button
          type="button"
          className="fh-session-title-bar-display"
          onClick={startEditing}
        >
          {runtime.sessionTitle ?? t("conversation.untitledSession")}
        </button>
      )}
    </div>
  );
}
