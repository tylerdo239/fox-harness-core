// Shared dashboard header — 4 variants, port of the reference UI's dashboard-header.tsx. Used by the report view
// and by the builder's live preview.
export function DashboardHeader({ title, description, variant, banner }: { title: string; description: string; variant: string; banner: string }) {
  if (variant === "gradient") {
    return (
      <div className="ds-dash-header ds-dash-header-gradient">
        <div className="ds-dash-header-inner">
          <h1>{title}</h1>
          {description && <p>{description}</p>}
        </div>
      </div>
    );
  }
  if (variant === "two-tone") {
    return (
      <div className="ds-dash-header ds-dash-header-two-tone">
        <div className="ds-dash-header-inner">
          <h1>{title}</h1>
          {description && <p>{description}</p>}
        </div>
      </div>
    );
  }
  if (variant === "minimal") {
    return (
      <div className="ds-dash-header ds-dash-header-minimal">
        <div className="ds-dash-header-inner">
          <h1>{title}</h1>
          {description && <p>{description}</p>}
        </div>
      </div>
    );
  }
  // kpi-banner (default)
  return (
    <div className="ds-dash-header ds-dash-header-kpi">
      <div className="ds-dash-header-inner">
        <div className="ds-dash-header-eyebrow">{banner}</div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
    </div>
  );
}
