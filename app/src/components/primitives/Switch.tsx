// An on/off switch (the `.fh-ds-switch` look from Data Studio's sources page, shared): the change shows at once and
// is corrected by whatever the caller reloads after saving.
import { useEffect, useState } from "react";

export function Switch({ checked, onChange, label, disabled, hideLabel }: { checked: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean; hideLabel?: boolean }) {
  const [on, setOn] = useState(checked);
  useEffect(() => setOn(checked), [checked]);
  return (
    <label className={`fh-ds-switch${disabled ? " fh-ds-switch-disabled" : ""}`} title={hideLabel ? label : undefined}>
      <input
        type="checkbox"
        role="switch"
        checked={on}
        disabled={disabled}
        aria-label={label}
        onChange={(event) => {
          setOn(event.target.checked);
          onChange(event.target.checked);
        }}
      />
      <span className="fh-ds-switch-track" aria-hidden="true">
        <span className="fh-ds-switch-thumb" />
      </span>
      {!hideLabel && <span className="fh-ds-switch-label">{label}</span>}
    </label>
  );
}
