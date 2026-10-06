// Copied from bot-data-studio-web-main/src/components/profile/sql-preview.tsx by scripts/sync-ref-profile.mjs — edit there, not here.
import { SqlCode } from "@/components/sql/sql-code";

/** Generated SQL, pretty-printed and highlighted, with a Copy button (see components/sql/sql-code). */
export function SqlPreview({ sql }: { sql: string }) {
  return <SqlCode sql={sql} />;
}
