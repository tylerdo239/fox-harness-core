// Ported from local-fox-harness-core (apps/web/components/features/canvas/file-preview.tsx); files are fetched
// through the session's authenticated files route (canvas.ts fetchCanvasFile), PDFs and images shown from blob URLs.
//
// Renderers for kind:"file" canvases (packages/tool/canvas — an .xlsx/.csv/
// .docx/.pdf the agent wrote with python, snapshotted as a canvas version).
// Each one fetches the version's bytes itself, by path, only when shown:
// nothing binary ever goes through the zustand store.
//
// All three document renderers draw on a white "paper" surface regardless
// of the app theme, the same call the HTML preview's `bg-white` iframe
// makes: these files carry their own absolute colors (a yellow header fill,
// black body text), which would be unreadable re-tinted for dark mode.
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { useLocale } from '../../../i18n/locale.tsx'
import { fetchCanvasFile, type CanvasFileFormat } from './canvas.ts'
import { columnLetters } from './formula.ts'
import { computeDisplay, loadCsv, loadXlsx, type DisplayCell, type SheetModel } from './workbook.ts'

// Past this, a sheet stops rendering more rows/columns and says so — a DOM
// table of 100k cells would freeze the tab, and nobody reads that in a side
// panel anyway (the Download button has the full file).
const MAX_ROWS = 2000
const MAX_COLS = 100

type Loaded<T> = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; value: T }

async function fetchBytes(sessionId: string, path: string): Promise<ArrayBuffer> {
  return (await fetchCanvasFile(sessionId, path)).arrayBuffer()
}

/** An object URL for the file, revoked when the component unmounts or the path changes. */
function useBlobUrl(sessionId: string, path: string): Loaded<string> {
  const [loaded, setLoaded] = useState<Loaded<string>>({ state: 'loading' })
  useEffect(() => {
    let cancelled = false
    let url: string | undefined
    setLoaded({ state: 'loading' })
    fetchCanvasFile(sessionId, path)
      .then((response) => response.blob())
      .then((blob) => {
        if (cancelled) return
        url = URL.createObjectURL(blob)
        setLoaded({ state: 'ready', value: url })
      })
      .catch((error: unknown) => { if (!cancelled) setLoaded({ state: 'error', message: error instanceof Error ? error.message : String(error) }) })
    return () => {
      cancelled = true
      if (url !== undefined) URL.revokeObjectURL(url)
    }
  }, [sessionId, path])
  return loaded
}

async function loadSheets(sessionId: string, path: string, format: 'xlsx' | 'csv'): Promise<SheetModel[]> {
  const bytes = await fetchBytes(sessionId, path)
  if (format === 'csv') return loadCsv(new TextDecoder().decode(bytes), path.split('/').pop() ?? 'CSV')
  return loadXlsx(bytes)
}

/** Loads a value from an async source keyed by `key`, dropping stale results when the key changes mid-flight. */
function useLoaded<T>(key: string, load: () => Promise<T>): Loaded<T> {
  const [loaded, setLoaded] = useState<Loaded<T>>({ state: 'loading' })
  useEffect(() => {
    let cancelled = false
    setLoaded({ state: 'loading' })
    load()
      .then((value) => { if (!cancelled) setLoaded({ state: 'ready', value }) })
      .catch((error: unknown) => { if (!cancelled) setLoaded({ state: 'error', message: error instanceof Error ? error.message : String(error) }) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return loaded
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex h-full items-center justify-center p-6 text-center text-[0.85em] text-muted">{children}</div>
}

function LoadError({ message }: { message: string }) {
  const { t } = useLocale()
  return (
    <Centered>
      <span className="flex max-w-md flex-col items-center gap-2 text-error">
        <AlertTriangle size={18} />
        <span>{t('canvas.fileLoadError')}</span>
        <span className="break-all font-mono text-[0.85em] text-muted">{message}</span>
      </span>
    </Centered>
  )
}

// ── Spreadsheet ────────────────────────────────────────────────────────────

function SheetTabs({ names, active, onPick }: { names: readonly string[]; active: number; onPick: (index: number) => void }) {
  if (names.length < 2) return null
  return (
    <div className="flex flex-none gap-0.5 overflow-x-auto border-t border-neutral-300 bg-neutral-100 px-2 py-1 text-[0.8em]">
      {names.map((name, index) => (
        <button
          key={name}
          type="button"
          onClick={() => { onPick(index) }}
          className={`flex-none cursor-pointer whitespace-nowrap rounded px-2.5 py-1 ${index === active ? 'bg-white font-medium text-emerald-700 shadow-sm' : 'text-neutral-600 hover:bg-neutral-200'}`}
        >
          {name}
        </button>
      ))}
    </div>
  )
}

function SheetGrid({ sheet, display }: { sheet: SheetModel; display: ReadonlyMap<string, DisplayCell> }) {
  const { t } = useLocale()
  const rows = Math.min(sheet.rowCount, MAX_ROWS)
  const cols = Math.min(sheet.colCount, MAX_COLS)

  // Merged ranges: the top-left cell spans, every other covered cell is skipped.
  const { spans, covered } = useMemo(() => {
    const spanMap = new Map<string, { rowSpan: number; colSpan: number }>()
    const coveredSet = new Set<string>()
    for (const m of sheet.merges) {
      spanMap.set(`${columnLetters(m.left)}${String(m.top)}`, { rowSpan: m.bottom - m.top + 1, colSpan: m.right - m.left + 1 })
      for (let r = m.top; r <= m.bottom; r += 1) {
        for (let c = m.left; c <= m.right; c += 1) if (r !== m.top || c !== m.left) coveredSet.add(`${columnLetters(c)}${String(r)}`)
      }
    }
    return { spans: spanMap, covered: coveredSet }
  }, [sheet])

  const colIndexes = Array.from({ length: cols }, (_, i) => i + 1)
  // Excel's width unit is "characters of the default font"; ~7px each plus
  // cell padding matches Calibri 11 closely. 8.43 is Excel's own default. A
  // column with no stored width (pandas/CSV output) is fitted to its longest
  // shown value, capped at 40 characters, like Excel's autofit.
  const fitted = (c: number): number => {
    let longest = 8.43
    for (let r = 1; r <= rows; r += 1) {
      const text = display.get(`${columnLetters(c)}${String(r)}`)?.text
      if (text !== undefined) longest = Math.max(longest, text.length + 1)
    }
    return Math.min(longest, 40)
  }
  const widths = colIndexes.map(c => Math.round((sheet.colWidths[c] ?? fitted(c)) * 7 + 10))

  if (rows === 0 || cols === 0) return <Centered><span className="text-neutral-500">{t('canvas.sheetEmpty')}</span></Centered>

  // Excel's text overflow: a non-wrapping text cell spills into the empty
  // cells beside it (right for left-aligned text, left for right-aligned,
  // both ways for centered),
  // stopping at the first cell that has content or belongs to a merge.
  // Without it every note/subtitle line of a generated report ("Ghi chú: …",
  // "Đơn giá: VND …") was cut to a few characters in a narrow column A.
  const emptyAt = (col: number, row: number): boolean => {
    const address = `${columnLetters(col)}${String(row)}`
    return col >= 1 && col <= cols && display.get(address) === undefined && !covered.has(address) && !spans.has(address)
  }
  const spillFor = (col: number, row: number, align: CSSProperties['textAlign']): { width: number; marginLeft?: number } | undefined => {
    const own = widths[col - 1]! - 12
    let extra = 0
    if (align === 'right') {
      for (let c = col - 1; emptyAt(c, row); c -= 1) extra += widths[c - 1]!
      return extra === 0 ? undefined : { width: own + extra, marginLeft: -extra }
    }
    if (align === 'center') {
      // Centered text claims the empty cells on both sides and stays centered
      // across all of them — at column A (no left neighbours) that reads as
      // spilling right, which is still readable where Excel would clip.
      let left = 0
      for (let c = col - 1; emptyAt(c, row); c -= 1) left += widths[c - 1]!
      for (let c = col + 1; emptyAt(c, row); c += 1) extra += widths[c - 1]!
      return left + extra === 0 ? undefined : { width: own + left + extra, marginLeft: -left }
    }
    if (align !== 'left' && align !== undefined) return undefined
    for (let c = col + 1; emptyAt(c, row); c += 1) extra += widths[c - 1]!
    return extra === 0 ? undefined : { width: own + extra }
  }

  const rowHeaderWidth = 44
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      {/* table-layout: fixed — the sheet's own column widths are the layout,
          exactly like Excel. With the browser's auto layout a long
          non-wrapping merged title row (the usual first row of a generated
          report) stretched arbitrary columns: a 12-char "STT" column rendered
          ~400px wide and pushed the money columns out of view. */}
      <table
        className="border-separate border-spacing-0 text-[13px] leading-snug text-neutral-900"
        style={{ tableLayout: 'fixed', width: rowHeaderWidth + widths.reduce((a, b) => a + b, 0) }}
      >
        <colgroup>
          <col style={{ width: rowHeaderWidth }} />
          {widths.map((width, i) => <col key={colIndexes[i]} style={{ width }} />)}
        </colgroup>
        <thead>
          <tr>
            <th className="sticky left-0 top-0 z-20 border-b border-r border-neutral-300 bg-neutral-100" />
            {colIndexes.map(c => (
              <th key={c} className="sticky top-0 z-10 border-b border-r border-neutral-300 bg-neutral-100 px-1 py-0.5 text-center text-[11px] font-normal text-neutral-500">
                {columnLetters(c)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }, (_, i) => i + 1).map(r => (
            <tr key={r}>
              <th className="sticky left-0 z-10 border-b border-r border-neutral-300 bg-neutral-100 px-1 text-center text-[11px] font-normal text-neutral-500">{r}</th>
              {colIndexes.map(c => {
                const address = `${columnLetters(c)}${String(r)}`
                if (covered.has(address)) return null
                const span = spans.get(address)
                const cell = sheet.cells.get(address)
                const shown = display.get(address)
                const style: CSSProperties = {
                  textAlign: shown?.numeric === true ? 'right' : 'left',
                  whiteSpace: 'nowrap',
                  ...cell?.style,
                }
                const spill = span === undefined && shown !== undefined && !shown.numeric && style.whiteSpace === 'nowrap'
                  ? spillFor(c, r, style.textAlign)
                  : undefined
                return (
                  <td
                    key={c}
                    rowSpan={span?.rowSpan}
                    colSpan={span?.colSpan}
                    title={cell?.formula !== undefined ? `=${cell.formula}` : (spill !== undefined ? shown?.text : undefined)}
                    style={style}
                    className={`${spill === undefined ? 'overflow-hidden text-ellipsis' : 'overflow-visible'} border-b border-r border-neutral-200 px-1.5 py-0.5 align-bottom ${shown?.formulaFallback === true ? 'font-mono text-[11px] italic text-neutral-500' : ''} ${shown?.error === true ? 'text-red-600' : ''}`}
                  >
                    {spill === undefined ? (shown?.text ?? '') : (
                      <span
                        className="block overflow-hidden text-ellipsis whitespace-nowrap"
                        style={{ width: spill.width, marginLeft: spill.marginLeft }}
                      >
                        {shown?.text}
                      </span>
                    )}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {sheet.rowCount > rows || sheet.colCount > cols ? (
        <p className="m-0 px-3 py-2 text-[12px] text-neutral-500">{t('canvas.sheetTruncated', { rows: String(rows), cols: String(cols) })}</p>
      ) : null}
    </div>
  )
}

function SpreadsheetPreview({ sessionId, path, format }: { sessionId: string; path: string; format: 'xlsx' | 'csv' }) {
  const loaded = useLoaded(path, () => loadSheets(sessionId, path, format))
  const [active, setActive] = useState(0)
  const display = useMemo(() => (loaded.state === 'ready' ? computeDisplay(loaded.value) : undefined), [loaded])
  if (loaded.state === 'loading') return <Centered><Loader2 size={20} className="animate-spin" /></Centered>
  if (loaded.state === 'error') return <LoadError message={loaded.message} />
  const sheets = loaded.value
  const index = Math.min(active, Math.max(0, sheets.length - 1))
  const sheet = sheets[index]
  return (
    <div className="flex h-full flex-col bg-white">
      {sheet === undefined ? null : <SheetGrid key={sheet.name} sheet={sheet} display={display?.get(sheet.name) ?? new Map()} />}
      <SheetTabs names={sheets.map(s => s.name)} active={index} onPick={setActive} />
    </div>
  )
}

// ── Word ───────────────────────────────────────────────────────────────────

/** Only plain web/mail links survive from a rendered .docx — anything else (javascript:, file:, …) is dropped, and every link opens outside the app. */
function neutralizeLinks(root: HTMLElement): void {
  for (const anchor of root.querySelectorAll('a[href]')) {
    const href = anchor.getAttribute('href') ?? ''
    if (href.startsWith('#')) continue
    if (!/^(https?:|mailto:)/i.test(href)) {
      anchor.removeAttribute('href')
      continue
    }
    anchor.setAttribute('target', '_blank')
    anchor.setAttribute('rel', 'noopener noreferrer')
  }
}

// Bullets that Word stores as private-use code points of the Symbol /
// Wingdings fonts. Browsers don't ship those fonts, so each rendered as an
// empty box — and python-docx's own default "List Bullet" style is exactly
// U+F0B7 in Symbol, i.e. every bulleted list the agent writes. Mapped to
// the Unicode character each one depicts.
const SYMBOL_FONT_BULLETS: Record<string, string> = {
  '\uF0B7': '•', '\uF0A7': '▪', '\uF06E': '■', '\uF071': '❑', '\uF076': '❖',
  '\uF0D8': '➢', '\uF0E0': '→', '\uF0FC': '✓', '\uF0FE': '☑', '\uF0A8': '◆', '\uF06F': '○',
}
const SYMBOL_FONT_RE = new RegExp(`[${Object.keys(SYMBOL_FONT_BULLETS).join('')}]`, 'g')

function remapSymbolBullets(styles: HTMLElement, body: HTMLElement): void {
  for (const style of styles.querySelectorAll('style')) {
    const text = style.textContent ?? ''
    if (SYMBOL_FONT_RE.test(text)) style.textContent = text.replace(SYMBOL_FONT_RE, ch => SYMBOL_FONT_BULLETS[ch] ?? ch)
    SYMBOL_FONT_RE.lastIndex = 0
  }
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node.textContent ?? ''
    if (SYMBOL_FONT_RE.test(text)) node.textContent = text.replace(SYMBOL_FONT_RE, ch => SYMBOL_FONT_BULLETS[ch] ?? ch)
    SYMBOL_FONT_RE.lastIndex = 0
  }
}

function DocxPreview({ sessionId, path }: { sessionId: string; path: string }) {
  const bodyRef = useRef<HTMLDivElement>(null)
  const styleRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<Loaded<true>>({ state: 'loading' })

  useEffect(() => {
    let cancelled = false
    setStatus({ state: 'loading' })
    void (async () => {
      try {
        const [bytes, docx] = await Promise.all([fetchBytes(sessionId, path), import('docx-preview')])
        const body = bodyRef.current
        const styles = styleRef.current
        if (cancelled || body === null || styles === null) return
        body.replaceChildren()
        styles.replaceChildren()
        await docx.renderAsync(bytes, body, styles, {
          className: 'docx',
          inWrapper: true,
          breakPages: true,
          ignoreLastRenderedPageBreak: true,
          experimental: true,
          useBase64URL: true,
        })
        if (cancelled) return
        neutralizeLinks(body)
        remapSymbolBullets(styles, body)
        setStatus({ state: 'ready', value: true })
      } catch (error) {
        if (!cancelled) setStatus({ state: 'error', message: error instanceof Error ? error.message : String(error) })
      }
    })()
    return () => { cancelled = true }
  }, [sessionId, path])

  return (
    <div className="relative h-full overflow-auto bg-neutral-200">
      {status.state === 'loading' ? <div className="absolute inset-0"><Centered><Loader2 size={20} className="animate-spin" /></Centered></div> : null}
      {status.state === 'error' ? <div className="absolute inset-0 bg-bg"><LoadError message={status.message} /></div> : null}
      <div ref={styleRef} />
      <div ref={bodyRef} className="text-neutral-900 [&_.docx-wrapper]:bg-neutral-200 [&_.docx-wrapper]:p-4" />
    </div>
  )
}

// ── PDF ────────────────────────────────────────────────────────────────────

// The browser's own PDF viewer, on a blob URL of the file (served as application/pdf). Deliberately no `sandbox`
// attribute: Chrome refuses to run its PDF viewer inside a sandboxed frame. It is the browser's viewer on the
// file's bytes, not model-authored HTML — the HTML preview keeps its sandbox.
function PdfPreview({ sessionId, path, title }: { sessionId: string; path: string; title: string }) {
  const url = useBlobUrl(sessionId, path)
  if (url.state === 'loading') return <Centered><Loader2 size={20} className="animate-spin" /></Centered>
  if (url.state === 'error') return <LoadError message={url.message} />
  return <iframe src={url.value} title={title} className="h-full w-full border-0 bg-white" />
}

// Images (workspace list only): the file itself, fitted to the panel. SVG
// goes through <img> too, which never runs a script inside it.
function ImagePreview({ sessionId, path, title }: { sessionId: string; path: string; title: string }) {
  const url = useBlobUrl(sessionId, path)
  if (url.state === 'loading') return <Centered><Loader2 size={20} className="animate-spin" /></Centered>
  if (url.state === 'error') return <LoadError message={url.message} />
  return (
    <div className="flex h-full items-center justify-center overflow-auto bg-neutral-100 p-4">
      <img src={url.value} alt={title} className="max-h-full max-w-full object-contain shadow-sm" />
    </div>
  )
}

export function FilePreview({ sessionId, path, format, title }: { sessionId: string; path: string; format: CanvasFileFormat | undefined; title: string }) {
  const { t } = useLocale()
  if (format === 'xlsx' || format === 'csv') return <SpreadsheetPreview key={path} sessionId={sessionId} path={path} format={format} />
  if (format === 'docx') return <DocxPreview key={path} sessionId={sessionId} path={path} />
  if (format === 'pdf') return <PdfPreview sessionId={sessionId} path={path} title={title} />
  if (format === 'image') return <ImagePreview sessionId={sessionId} path={path} title={title} />
  return <Centered>{t('canvas.fileUnsupported')}</Centered>
}

// ── Spreadsheet version diff ───────────────────────────────────────────────

interface CellChange { readonly sheet: string; readonly address: string; readonly before: string; readonly after: string }

function diffSheets(before: SheetModel[], after: SheetModel[]): { changes: CellChange[]; added: string[]; removed: string[] } {
  const beforeDisplay = computeDisplay(before)
  const afterDisplay = computeDisplay(after)
  const changes: CellChange[] = []
  const added = after.map(s => s.name).filter(name => !beforeDisplay.has(name))
  const removed = before.map(s => s.name).filter(name => !afterDisplay.has(name))
  for (const sheet of after) {
    const a = beforeDisplay.get(sheet.name)
    const b = afterDisplay.get(sheet.name)
    if (a === undefined || b === undefined) continue
    const addresses = new Set([...a.keys(), ...b.keys()])
    const sorted = [...addresses].sort((x, y) => {
      const px = /^([A-Z]+)(\d+)$/.exec(x)!
      const py = /^([A-Z]+)(\d+)$/.exec(y)!
      return Number(px[2]) - Number(py[2]) || px[1]!.length - py[1]!.length || px[1]!.localeCompare(py[1]!)
    })
    for (const address of sorted) {
      const was = a.get(address)?.text ?? ''
      const now = b.get(address)?.text ?? ''
      if (was !== now) changes.push({ sheet: sheet.name, address, before: was, after: now })
    }
  }
  return { changes, added, removed }
}

/** Cell-level diff between two spreadsheet versions — computed values, not raw XML, so a restyle with the same numbers reads as "no change". */
export function SpreadsheetDiff({ sessionId, beforePath, afterPath, format }: { sessionId: string; beforePath: string; afterPath: string; format: 'xlsx' | 'csv' }) {
  const { t } = useLocale()
  const loaded = useLoaded(`${beforePath}→${afterPath}`, async () => {
    const [before, after] = await Promise.all([loadSheets(sessionId, beforePath, format), loadSheets(sessionId, afterPath, format)])
    return diffSheets(before, after)
  })
  if (loaded.state === 'loading') return <Centered><Loader2 size={20} className="animate-spin" /></Centered>
  if (loaded.state === 'error') return <LoadError message={loaded.message} />
  const { changes, added, removed } = loaded.value
  if (changes.length === 0 && added.length === 0 && removed.length === 0) return <Centered>{t('canvas.diffNoChanges')}</Centered>
  return (
    <div className="h-full overflow-auto p-4 text-[0.85em]">
      {added.map(name => <div key={`+${name}`} className="mb-1 rounded bg-status-success/15 px-2 py-1">{t('canvas.diffSheetAdded', { name })}</div>)}
      {removed.map(name => <div key={`-${name}`} className="mb-1 rounded bg-status-danger/15 px-2 py-1">{t('canvas.diffSheetRemoved', { name })}</div>)}
      {changes.length > 0 ? (
        <table className="mt-2 w-full border-collapse">
          <thead>
            <tr className="text-left text-muted">
              <th className="border-b border-border px-2 py-1 font-medium">{t('canvas.diffSheet')}</th>
              <th className="border-b border-border px-2 py-1 font-medium">{t('canvas.diffCell')}</th>
              <th className="border-b border-border px-2 py-1 font-medium">{t('canvas.diffBefore')}</th>
              <th className="border-b border-border px-2 py-1 font-medium">{t('canvas.diffAfter')}</th>
            </tr>
          </thead>
          <tbody>
            {changes.slice(0, 1000).map(change => (
              <tr key={`${change.sheet}!${change.address}`} className="align-top">
                <td className="border-b border-border-subtle px-2 py-1 text-muted">{change.sheet}</td>
                <td className="border-b border-border-subtle px-2 py-1 font-mono">{change.address}</td>
                <td className="border-b border-border-subtle bg-status-danger/10 px-2 py-1 text-muted line-through decoration-error/40">{change.before}</td>
                <td className="border-b border-border-subtle bg-status-success/10 px-2 py-1 text-fg">{change.after}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {changes.length > 1000 ? <p className="mt-2 text-muted">{t('canvas.diffTruncated', { count: String(changes.length) })}</p> : null}
    </div>
  )
}
