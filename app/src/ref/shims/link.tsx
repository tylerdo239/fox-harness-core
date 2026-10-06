// Ours: `next/link` for the copied reference pages. Their hrefs are the reference's routes
// (/data-sources/<id>, /data-sources/<id>/entities/<entityId>, /data-sources/relationships, /metrics, /glossary);
// DataStudioProfile maps them onto its own view state through RefNavContext.
import { createContext, useContext, type AnchorHTMLAttributes, type ReactNode } from "react";

export const RefNavContext = createContext<(href: string) => void>(() => {});

export default function Link({
  href,
  children,
  ...rest
}: { href: string; children?: ReactNode } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href">) {
  const navigate = useContext(RefNavContext);
  return (
    <a
      href={href}
      {...rest}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(href);
      }}
    >
      {children}
    </a>
  );
}
