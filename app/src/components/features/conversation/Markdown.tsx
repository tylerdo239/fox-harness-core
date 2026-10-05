// Real markdown rendering for assistant messages (2026-09-15) — replaces
// Conversation.tsx's old `linkify()` (plain text + a link-only regex) for
// the 2 call sites that actually show model output (the live streaming
// bubble and a finished assistant bubble). `tool-pill-result` keeps using
// `linkify()` — out of scope here, and not broken.
//
// Library choice over dsh's real approach: the installed reference bundle
// (node_modules/@deepseek-ai/dsh-web-frontend's built JS — its markdown
// component isn't installed as a standalone source package) uses Shiki
// (lazy-loaded per-language grammars) plus a hand-written incremental
// parser that freezes finished blocks into cached React elements so a
// streaming update only re-renders the one still-open "tail" block.
// Deliberately NOT replicated here — `react-markdown` + `remark-gfm` +
// `rehype-highlight`/`highlight.js` is the standard, far simpler combo for
// this exact need (docs/code-rules.md's "don't write new core when a
// library already does it" applies the same way `sonner` replaced a
// hand-rolled toast). Real cost this simpler choice pays: `rehype-highlight`
// re-tokenizes EVERY code block in a message on every re-parse (it's a
// rehype plugin running inside `<ReactMarkdown>`'s own pipeline, before any
// React component — `React.memo` below cannot skip that work, only the
// React-reconciliation cost after it). Mitigated at the call site
// (Conversation.tsx) by batching rapid `text-delta` chunks into at most one
// state update per animation frame instead of one per network chunk, which
// bounds how often the whole pipeline re-runs regardless of message size —
// the same "don't do expensive work more often than the screen can show it"
// idea, applied where the actual cost lives instead of where it doesn't.
import { isValidElement, memo, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";

import { useLocale } from "../../../i18n/locale.tsx";
import { CopiedIcon, CopyIcon } from "../../../icons.tsx";
import { IconButton } from "../../primitives/IconButton.tsx";

// `rehype-highlight`'s `code` nodes hand React a tree of already-highlighted
// `<span className="hljs-...">` elements as `children`, not a plain string —
// this walks that tree to recover plain text for the copy button (clipboard
// content must be plain text, not JSX).
function extractText(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (isValidElement(node))
    return extractText((node.props as { children?: ReactNode }).children);
  return "";
}

const CodeBlock = memo(
  function CodeBlock({
    language,
    className,
    plainText,
    children,
  }: {
    language: string;
    className: string;
    plainText: string;
    children: ReactNode;
  }) {
    const { t } = useLocale();
    const [copied, setCopied] = useState(false);

    async function handleCopy() {
      try {
        await navigator.clipboard.writeText(plainText);
        toast.success(t("conversation.codeCopied"));
        // Real per-button confirmation (the icon itself flips), separate
        // from the toast — matches Claude/ChatGPT's own code-block copy
        // affordance, not just a global notification.
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      } catch {
        // Clipboard API can throw (insecure context, denied permission) —
        // the button just silently doesn't confirm; not worth surfacing an
        // error toast for a convenience action.
      }
    }

    return (
      <div className="md-code-block">
        <div className="md-code-block-header">
          <span className="md-code-block-lang">{language || "text"}</span>
          <IconButton
            size="sm"
            variant="plain"
            onClick={handleCopy}
            title={t("conversation.copyCode")}
          >
            {copied ? <CopiedIcon size={14} /> : <CopyIcon size={14} />}
          </IconButton>
        </div>
        <pre>
          <code className={className}>{children}</code>
        </pre>
      </div>
    );
  },
  // Custom comparator keyed on the extracted plain text (not `children`,
  // which react-markdown reconstructs as a fresh element tree on every
  // parse even when the underlying text hasn't changed) — this DOES let
  // React skip reconciling a code block whose content is byte-identical to
  // last render (e.g. a finished block earlier in the same message, while a
  // later paragraph is still streaming); it does NOT skip `rehype-highlight`
  // re-tokenizing it, since that already happened earlier in the pipeline
  // by the time this component sees its props — see this file's header
  // comment.
  (prev, next) =>
    prev.plainText === next.plainText && prev.language === next.language,
);

// `undefined` on a malformed/relative `href` — callers fall back to the raw
// string (Conversation.tsx's `SearchSourcesPill` has the same small helper;
// not shared across files on purpose, see that file's own comment on why a
// 5-line pure function isn't worth a cross-file import here).
function hostnameOf(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

const markdownComponents = {
  // `title` (2026-09-15, user: "các text hay số có link khi hover sẽ hiện
  // tên bằng tool tip") — a citation-style link (`[[1]](url)`) or any bare
  // "click here"-style label doesn't reveal what site it points to until
  // hovered; the native browser tooltip from `title` fixes that for free,
  // no extra UI needed.
  a({ href, children }: { href?: string; children?: ReactNode }) {
    return (
      <a
        className="fh-link"
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        title={href ? (hostnameOf(href) ?? href) : undefined}
      >
        {children}
      </a>
    );
  },
  // `pre` is a plain passthrough — `CodeBlock` below renders its OWN
  // `<pre>` (with the header row above it), so react-markdown's default
  // `pre` wrapper around a fenced code block's `code` child is skipped
  // here rather than nesting a second `<pre>`.
  pre({ children }: { children?: ReactNode }) {
    return <>{children}</>;
  },
  code({
    className,
    children,
  }: {
    className?: string;
    children?: ReactNode;
  }) {
    // `rehype-highlight` only adds the `hljs` class to a CODE node that's
    // inside a fenced/indented block (with `detect: true`, even one with no
    // declared language) — inline `` `code` `` spans never get it. This is
    // the one reliable inline-vs-block signal available (react-markdown v9
    // dropped the old `inline` prop some earlier versions had).
    if (!className?.includes("hljs")) {
      return <code className="md-inline-code">{children}</code>;
    }
    const language = /language-(\w+)/.exec(className)?.[1] ?? "";
    return (
      <CodeBlock
        language={language}
        className={className}
        plainText={extractText(children)}
      >
        {children}
      </CodeBlock>
    );
  },
  table({ children }: { children?: ReactNode }) {
    return (
      <div className="md-table-wrap">
        <table>{children}</table>
      </div>
    );
  },
};

// `React.memo` on `text` — a finished message's text never changes again,
// so this stops it from re-parsing/re-highlighting every time a SIBLING
// message (the one actually still streaming) updates and forces a re-render
// of the whole message list. The streaming message's own bubble still
// re-parses every update (see the batching note above for why that's fine).
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[[rehypeHighlight, { detect: true }]]}
      components={markdownComponents}
    >
      {text}
    </ReactMarkdown>
  );
});
