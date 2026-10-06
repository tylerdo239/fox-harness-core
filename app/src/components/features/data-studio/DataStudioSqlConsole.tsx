// docs/data-studio-update-plan.md — SQL console (Phase 2, admin only). Runs one read-only statement against Dremio
// through services/gateway's POST /data-studio/sql (bridge/admin_runner.py `sql` op: check_read_only_sql, then at
// most 500 rows). Every run, ok or not, is written to Mongo `sql_audit` and listed below from /data-studio/sql/history.
import { useCallback, useEffect, useState } from "react";
import { format } from "sql-formatter";

import { useLocale } from "../../../i18n/locale.tsx";
import { useRuntime } from "../../../runtime.ts";
import { Button } from "../../primitives/Button.tsx";

interface SqlResult {
  columns: { name: string; type: string }[];
  rows: unknown[][] | Record<string, unknown>[];
  row_count: number;
  elapsed_ms: number;
}

interface SqlRun {
  id: string;
  email: string;
  sql: string;
  ok: boolean;
  row_count: number | null;
  elapsed_ms: number | null;
  error: string | null;
  at: string;
}

const LIMIT_OPTIONS = [50, 100, 200, 500];

function cell(row: SqlResult["rows"][number], index: number, column: string): string {
  const value = Array.isArray(row) ? row[index] : (row as Record<string, unknown>)[column];
  if (value === null || value === undefined) return "NULL";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

export function DataStudioSqlConsole() {
  const runtime = useRuntime();
  const { t } = useLocale();
  const [sql, setSql] = useState("");
  const [limit, setLimit] = useState(100);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<SqlResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runs, setRuns] = useState<SqlRun[]>([]);

  const loadHistory = useCallback(async () => {
    const res = await runtime.authedFetch("/data-studio/sql/history?limit=50");
    if (res.ok) setRuns((await res.json()).runs ?? []);
  }, [runtime]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  async function run(): Promise<void> {
    if (!sql.trim()) return;
    setRunning(true);
    setError(null);
    setResult(null);
    const res = await runtime.authedFetch("/data-studio/sql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sql, limit }),
    });
    const body = await res.json().catch(() => ({}));
    setRunning(false);
    if (res.ok) setResult(body as SqlResult);
    else setError(body.error ?? `HTTP ${res.status}`);
    await loadHistory();
  }

  function formatSql(): void {
    try {
      setSql(format(sql, { language: "trino" }));
    } catch {
      // Unparseable SQL stays as typed; the run reports the real error.
    }
  }

  return (
    <div className="fh-data-studio-admin">
      <div className="fh-data-studio-admin-header">
        <h2>{t("dataStudio.sectionSql")}</h2>
      </div>
      <p className="fh-data-studio-note">{t("dataStudio.sqlHint")}</p>

      <textarea
        className="fh-data-studio-sql-editor"
        rows={10}
        spellCheck={false}
        placeholder="SELECT * FROM source.schema.table"
        value={sql}
        onChange={(e) => setSql(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            void run();
          }
        }}
      />
      <div className="fh-data-studio-relationship-form">
        <label>
          {t("dataStudio.sqlLimit")}{" "}
          <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
            {LIMIT_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <Button variant="outline" onClick={formatSql} disabled={!sql.trim()}>
          {t("dataStudio.sqlFormat")}
        </Button>
        <Button variant="primary" onClick={() => void run()} disabled={running || !sql.trim()}>
          {running ? t("dataStudio.sqlRunning") : t("dataStudio.sqlRun")}
        </Button>
      </div>

      {error && <p className="data-studio-error">{error}</p>}

      {result && (
        <>
          <p className="fh-data-studio-note">
            {t("dataStudio.sqlResultSummary", { rows: String(result.row_count), ms: String(result.elapsed_ms) })}
          </p>
          <div style={{ overflowX: "auto" }}>
            <table className="fh-data-studio-table">
              <thead>
                <tr>
                  {result.columns.map((column) => (
                    <th key={column.name} title={column.type}>
                      {column.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row, r) => (
                  <tr key={r}>
                    {result.columns.map((column, c) => (
                      <td key={column.name} className="fh-data-studio-mono">
                        {cell(row, c, column.name)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <h3>{t("dataStudio.sqlHistory")}</h3>
      <table className="fh-data-studio-table">
        <thead>
          <tr>
            <th>{t("dataStudio.sqlAt")}</th>
            <th>{t("dataStudio.sqlBy")}</th>
            <th>SQL</th>
            <th>{t("dataStudio.sqlOutcome")}</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id}>
              <td>{new Date(r.at).toLocaleString()}</td>
              <td>{r.email}</td>
              <td>
                <Button variant="link" onClick={() => setSql(r.sql)} title={t("dataStudio.sqlReuse")}>
                  <span className="fh-data-studio-mono">{r.sql.length > 120 ? `${r.sql.slice(0, 120)}…` : r.sql}</span>
                </Button>
              </td>
              <td>{r.ok ? `${r.row_count ?? 0} · ${r.elapsed_ms ?? 0} ms` : r.error}</td>
            </tr>
          ))}
          {runs.length === 0 && (
            <tr>
              <td colSpan={4} className="fh-data-studio-empty">
                {t("dataStudio.sqlNoHistory")}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
