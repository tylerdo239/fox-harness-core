// Copied from bot-data-studio-web-main/src/components/profile-transfer.tsx by scripts/sync-ref-profile.mjs — edit there, not here.
import { useRef, useState } from "react";
import { Download, Loader2, Upload } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { downloadFile, importProfileFile } from "@/lib/api";
import type { ImportItem, ImportReport } from "@/lib/types";

const ACTION_LABEL: Record<ImportItem["action"], string> = { create: "new", update: "update", skip: "skipped" };
const ACTION_VARIANT: Record<ImportItem["action"], "default" | "secondary" | "destructive"> = {
  create: "default",
  update: "secondary",
  skip: "destructive",
};

/** Export the profile items of a page to a JSON file, and import such a file (from this or another
 *  installation). Import first checks the file (nothing saved) and shows what would happen; Import
 *  saves it. Imported items are added to the agents' search index like a save in the UI. */
export function ProfileTransfer({
  what,
  exportPath,
  importPath,
  fileName,
  onImported,
}: {
  what: string; // "tables and columns", "metrics"…
  exportPath: string;
  importPath: string;
  fileName: string; // fallback download name
  onImported: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [exporting, setExporting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<{ name: string; data: unknown } | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);

  async function exportFile() {
    setExporting(true);
    setError(null);
    try {
      await downloadFile(exportPath, fileName);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed");
    } finally {
      setExporting(false);
    }
  }

  async function check(picked: File) {
    setError(null);
    setReport(null);
    let data: unknown;
    try {
      data = JSON.parse(await picked.text());
    } catch {
      setFile({ name: picked.name, data: null });
      setError("This file is not valid JSON.");
      return;
    }
    setFile({ name: picked.name, data });
    setBusy(true);
    try {
      setReport(await importProfileFile(importPath, data, true));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not check the file");
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      setReport(await importProfileFile(importPath, file.data, false));
      onImported();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setBusy(false);
    }
  }

  function close() {
    if (busy) return;
    setFile(null);
    setReport(null);
    setError(null);
  }

  const done = report !== null && !report.dry_run;
  const toSave = report ? report.created + report.updated : 0;

  return (
    <>
      <Button variant="outline" onClick={() => void exportFile()} disabled={exporting} title={error ?? `Download the ${what} as a JSON file`}>
        {exporting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
        Export
      </Button>
      <Button variant="outline" onClick={() => input.current?.click()} title={`Load the ${what} from an exported JSON file`}>
        <Upload className="mr-2 h-4 w-4" />
        Import
      </Button>
      <input
        ref={input}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={(e) => {
          const picked = e.target.files?.[0];
          e.target.value = ""; // the same file can be picked again
          if (picked) void check(picked);
        }}
      />

      <Dialog open={file !== null} onOpenChange={(open) => !open && close()}>
        <DialogContent className="flex max-h-[90vh] flex-col sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{done ? "Import finished" : `Import ${what}`}</DialogTitle>
            <DialogDescription className="break-all">{file?.name}</DialogDescription>
          </DialogHeader>

          {busy && !report && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Checking the file…
            </p>
          )}
          {error && <p className="whitespace-pre-wrap text-sm text-destructive">{error}</p>}

          {report && (
            <>
              <p className="text-sm">
                {done ? "Saved: " : "Nothing is saved yet. This file would give: "}
                <b>{report.created}</b> new, <b>{report.updated}</b> updated, <b>{report.skipped}</b> skipped.
                {!done && report.skipped > 0 && " Skipped items keep their current state; the others can still be imported."}
              </p>
              {done && report.not_indexed.length > 0 && (
                <p className="text-sm text-destructive">
                  Saved, but not added to the search index (is Meilisearch running?): {report.not_indexed.join(", ")}.
                  Rebuild the search index later so the agents can find them.
                </p>
              )}
              <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto rounded-md border p-2 text-sm">
                {report.items.map((item, i) => (
                  <li key={i} className="flex flex-col gap-0.5 py-0.5">
                    <span className="flex items-center gap-2">
                      <Badge variant={ACTION_VARIANT[item.action]} className="shrink-0">
                        {ACTION_LABEL[item.action]}
                      </Badge>
                      <span className="break-all">{item.name}</span>
                    </span>
                    {item.problems.map((p, j) => (
                      <span key={j} className={`pl-4 text-xs ${item.action === "skip" ? "text-destructive" : "text-muted-foreground"}`}>
                        {p}
                      </span>
                    ))}
                  </li>
                ))}
                {report.items.length === 0 && <li className="text-muted-foreground">The file is empty.</li>}
              </ul>
            </>
          )}

          <DialogFooter>
            {done ? (
              <Button onClick={close}>Close</Button>
            ) : (
              <>
                <Button variant="outline" onClick={close} disabled={busy}>
                  Cancel
                </Button>
                <Button onClick={() => void save()} disabled={busy || !report || toSave === 0}>
                  {busy && report && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Import {toSave > 0 ? toSave : ""}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
