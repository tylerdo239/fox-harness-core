// Shared dashboard header — 4 variants, port of the reference UI's dashboard-header.tsx. Used by the report view
// and by the builder's live preview.
export function DashboardHeader({ title, description, variant, banner }: { title: string; description: string; variant: string; banner: string }) {
  if (variant === "gradient") {
    return (
      <div className="ds-dash-header [padding:32px_32px] [&_h1]:m-0 [&_h1]:[font-size:1.9em] [&_h1]:font-bold [&_p]:[margin:8px_0_0] ds-dash-header-gradient [background:linear-gradient(135deg,#4f7be8,#9069d8,#d85e72,#e89f4a)] [color:#fff] [&&_p]:[color:rgba(255,255,255,0.85)]">
        <div className="ds-dash-header-inner [max-width:1152px] [margin:0_auto]">
          <h1>{title}</h1>
          {description && <p>{description}</p>}
        </div>
      </div>
    );
  }
  if (variant === "two-tone") {
    return (
      <div className="ds-dash-header [padding:32px_32px] [&_h1]:m-0 [&_h1]:font-bold [&_p]:[margin:8px_0_0] ds-dash-header-two-tone [background:#0a0a0a] [color:#fff] [&&_h1]:[font-size:1.6em] [&&&_p]:[color:#a3a3a3]">
        <div className="ds-dash-header-inner [max-width:1152px] [margin:0_auto]">
          <h1>{title}</h1>
          {description && <p>{description}</p>}
        </div>
      </div>
    );
  }
  if (variant === "minimal") {
    return (
      <div className="ds-dash-header [padding:32px_32px] [&_h1]:m-0 [&_h1]:font-bold [&_p]:[margin:8px_0_0] ds-dash-header-minimal [&&]:[padding-bottom:8px] [&&_h1]:[font-size:1.6em] [&_p]:[color:var(--muted)] [&_p]:[font-size:0.9em]">
        <div className="ds-dash-header-inner [max-width:1152px] [margin:0_auto]">
          <h1>{title}</h1>
          {description && <p>{description}</p>}
        </div>
      </div>
    );
  }
  // kpi-banner (default)
  return (
    <div className="ds-dash-header [padding:32px_32px] [&_h1]:m-0 [&_h1]:[font-size:1.9em] [&_h1]:font-bold [&_p]:[margin:8px_0_0] ds-dash-header-kpi [border-bottom:1px_solid_var(--border)] [background:color-mix(in_srgb,var(--accent)_7%,transparent)] [&_p]:[color:var(--muted)]">
      <div className="ds-dash-header-inner [max-width:1152px] [margin:0_auto]">
        <div className="ds-dash-header-eyebrow [color:var(--accent-text)] [font-size:0.75em] font-semibold [letter-spacing:0.05em] [text-transform:uppercase]">{banner}</div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
    </div>
  );
}
