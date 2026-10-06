// Copied from bot-data-studio-web-main/src/components/sql/sql-code.tsx by scripts/sync-ref-profile.mjs — edit there, not here.
import { useMemo, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { PrismLight as SyntaxHighlighter } from "react-syntax-highlighter";
import sqlLanguage from "react-syntax-highlighter/dist/esm/languages/prism/sql";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { format } from "sql-formatter";
import { cn } from "@/lib/utils";

// The one way SQL is shown in the app (chat, metric / glossary test runs, SQL console): pretty-printed
// with sql-formatter and syntax-highlighted with Prism.

SyntaxHighlighter.registerLanguage("sql", sqlLanguage);

/** One clause per line, indented, keywords upper case; the text as given when it does not parse. */
export function formatSql(sql: string): string {
  try {
    // Dremio SQL is close to Trino's, including TRY_CONVERT_FROM(... AS ROW(...))
    return format(sql, { language: "trino", keywordCase: "upper", tabWidth: 2 });
  } catch {
    return sql;
  }
}

// shared by the read-only block and the editor, so the editor's text lines up with its highlighting
const CODE_FONT: React.CSSProperties = {
  fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)",
  fontSize: "0.75rem",
  lineHeight: "1.25rem",
};

function Highlighted({ code, style, className }: { code: string; style?: React.CSSProperties; className?: string }) {
  return (
    <SyntaxHighlighter
      language="sql"
      style={oneDark}
      className={className}
      customStyle={{ margin: 0, borderRadius: "0.375rem", padding: "0.75rem", ...CODE_FONT, ...style }}
      codeTagProps={{ style: CODE_FONT }}
    >
      {/* a trailing newline keeps the last line's height when it is empty (editor) */}
      {code.endsWith("\n") ? `${code} ` : code}
    </SyntaxHighlighter>
  );
}

/** Read-only SQL, pretty-printed and highlighted, with a Copy button. */
export function SqlCode({ sql, pretty = true, maxHeight = "32rem", className }: {
  sql: string;
  pretty?: boolean;            // false: show the text exactly as given
  maxHeight?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const code = useMemo(() => (pretty ? formatSql(sql) : sql), [sql, pretty]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className={cn("relative mt-1", className)}>
      <button
        type="button"
        onClick={copy}
        className="absolute right-1.5 top-1.5 z-10 inline-flex items-center gap-1 rounded border border-white/20 bg-black/40 px-1.5 py-0.5 text-[11px] text-white/70 hover:text-white"
        aria-label="Copy SQL"
      >
        {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
        {copied ? "Copied" : "Copy"}
      </button>
      <Highlighted code={code} className="no-scrollbar" style={{ maxHeight, overflow: "auto", paddingRight: "4.5rem" }} />
    </div>
  );
}

/** An editable SQL box, highlighted as you type: a transparent textarea over the highlighted text
 *  (same font, padding and scroll position), so typing, selection and the caret work as usual. */
export function SqlEditor({ value, onChange, onKeyDown, placeholder, minHeight = "180px" }: {
  value: string;
  onChange: (value: string) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  placeholder?: string;
  minHeight?: string;
}) {
  const under = useRef<HTMLDivElement>(null);
  return (
    <div className="relative overflow-hidden rounded-md border" style={{ background: "#282c34" }}>
      <div ref={under} aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <Highlighted code={value} style={{ minHeight: "100%", borderRadius: 0, whiteSpace: "pre", overflow: "visible" }} />
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onScroll={(e) => {
          if (under.current) {
            under.current.scrollTop = e.currentTarget.scrollTop;
            under.current.scrollLeft = e.currentTarget.scrollLeft;
          }
        }}
        spellCheck={false}
        wrap="off"
        placeholder={placeholder}
        className="no-scrollbar relative block w-full resize-y bg-transparent text-transparent caret-white outline-none selection:bg-white/25 selection:text-transparent placeholder:text-white/40"
        style={{ ...CODE_FONT, padding: "0.75rem", minHeight, whiteSpace: "pre" }}
      />
    </div>
  );
}
