// Ported unchanged from local-fox-harness-core (apps/web/lib/workbook.ts).
// Spreadsheet model behind the canvas's .xlsx/.csv preview and its
// version diff (components/features/canvas/file-preview.tsx). Loading is
// split from rendering so the diff view can compare two versions' computed
// values without rendering either one.
//
// ExcelJS rather than SheetJS: the community SheetJS build does not read
// cell styles (fills, bold, borders are what make a generated quote/report
// look like one), and the SheetJS release on the npm registry is years old
// with open advisories. ExcelJS is loaded with a dynamic import — it is
// ~1 MB and only a spreadsheet canvas ever needs it.
import type { CSSProperties } from 'react'
import { columnIndex, columnLetters, evaluateFormula, FormulaError, Unsupported, type EvalResult } from './formula.ts'

export interface CellModel {
  readonly value: string | number | boolean | Date | null
  readonly formula?: string
  // Present when the file stored a computed result for `formula` (Excel,
  // LibreOffice). openpyxl-written files never have it — see lib/formula.ts.
  readonly result?: string | number | boolean | Date | null
  readonly numFmt?: string
  readonly style?: CSSProperties
}

export interface MergeModel { readonly top: number; readonly left: number; readonly bottom: number; readonly right: number }

export interface SheetModel {
  readonly name: string
  readonly rowCount: number
  readonly colCount: number
  readonly cells: ReadonlyMap<string, CellModel>
  readonly merges: readonly MergeModel[]
  // Excel's character-based widths, index = column number (1-based).
  readonly colWidths: ReadonlyArray<number | undefined>
}

export interface DisplayCell {
  readonly text: string
  readonly numeric: boolean
  // True when the formula could not be evaluated here and `text` is the
  // formula itself — the preview styles it differently so it never reads
  // as a real number.
  readonly formulaFallback: boolean
  readonly error: boolean
}

// ── Loading ────────────────────────────────────────────────────────────────

function argbToCss(argb: unknown): string | undefined {
  if (typeof argb !== 'string' || !/^[0-9a-fA-F]{8}$/.test(argb)) return undefined
  return `#${argb.slice(2)}`
}

// Loose structural types for the bits of ExcelJS's cell model read here —
// kept local so the rest of the app never depends on ExcelJS's types.
interface XColor { argb?: string }
interface XStyle {
  font?: { bold?: boolean; italic?: boolean; underline?: unknown; size?: number; color?: XColor }
  fill?: { type?: string; pattern?: string; fgColor?: XColor }
  alignment?: { horizontal?: string; vertical?: string; wrapText?: boolean; indent?: number }
  border?: Partial<Record<'top' | 'left' | 'bottom' | 'right', { style?: string; color?: XColor }>>
}

function styleToCss(style: XStyle | undefined): CSSProperties | undefined {
  if (style === undefined) return undefined
  const css: Record<string, string | number> = {}
  const font = style.font
  if (font?.bold === true) css.fontWeight = 600
  if (font?.italic === true) css.fontStyle = 'italic'
  if (font?.underline !== undefined && font.underline !== false) css.textDecoration = 'underline'
  if (typeof font?.size === 'number' && font.size !== 11) css.fontSize = `${String(font.size)}pt`
  const color = argbToCss(font?.color?.argb)
  if (color !== undefined) css.color = color
  if (style.fill?.type === 'pattern' && style.fill.pattern !== 'none') {
    const fill = argbToCss(style.fill.fgColor?.argb)
    if (fill !== undefined) css.backgroundColor = fill
  }
  const align = style.alignment
  if (align?.horizontal !== undefined && ['left', 'center', 'right', 'justify'].includes(align.horizontal)) css.textAlign = align.horizontal
  if (align?.horizontal === 'centerContinuous') css.textAlign = 'center'
  if (align?.vertical !== undefined) css.verticalAlign = align.vertical === 'middle' ? 'middle' : align.vertical === 'top' ? 'top' : 'bottom'
  if (align?.wrapText === true) css.whiteSpace = 'pre-wrap'
  if (typeof align?.indent === 'number' && align.indent > 0) css.paddingLeft = `${String(0.5 + align.indent * 0.75)}em`
  for (const side of ['top', 'left', 'bottom', 'right'] as const) {
    const border = style.border?.[side]
    if (border?.style === undefined) continue
    const width = border.style === 'medium' || border.style === 'thick' || border.style === 'double' ? 2 : 1
    const key = `border${side[0]!.toUpperCase()}${side.slice(1)}`
    css[key] = `${String(width)}px solid ${argbToCss(border.color?.argb) ?? '#8a8a8a'}`
  }
  return Object.keys(css).length === 0 ? undefined : (css as CSSProperties)
}

function plainValue(raw: unknown): string | number | boolean | Date | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean' || raw instanceof Date) return raw
  if (typeof raw === 'object') {
    const o = raw as { richText?: Array<{ text?: string }>; text?: unknown; error?: string; result?: unknown }
    if (Array.isArray(o.richText)) return o.richText.map(r => r.text ?? '').join('')
    if (typeof o.error === 'string') return o.error
    if (o.text !== undefined) return plainValue(o.text)
  }
  return String(raw)
}

export async function loadXlsx(data: ArrayBuffer): Promise<SheetModel[]> {
  const ExcelJS = (await import('exceljs')).default
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(data)
  const sheets: SheetModel[] = []
  workbook.eachSheet((worksheet) => {
    if (worksheet.state === 'hidden' || worksheet.state === 'veryHidden') return
    const cells = new Map<string, CellModel>()
    let rowCount = 0
    let colCount = 0
    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        const raw = cell.value as unknown
        const formula = typeof cell.formula === 'string' && cell.formula !== '' ? cell.formula : undefined
        const style = styleToCss(cell.style as XStyle)
        if (raw === null && style === undefined) return
        rowCount = Math.max(rowCount, rowNumber)
        colCount = Math.max(colCount, colNumber)
        const resultRaw = formula !== undefined ? (raw as { result?: unknown } | null)?.result : undefined
        cells.set(`${columnLetters(colNumber)}${String(rowNumber)}`, {
          value: formula !== undefined ? null : plainValue(raw),
          ...(formula === undefined ? {} : { formula }),
          ...(resultRaw === undefined ? {} : { result: plainValue(resultRaw) }),
          ...(typeof cell.numFmt === 'string' && cell.numFmt !== '' ? { numFmt: cell.numFmt } : {}),
          ...(style === undefined ? {} : { style }),
        })
      })
    })
    const merges: MergeModel[] = []
    const mergeRanges = (worksheet.model as { merges?: string[] }).merges ?? []
    for (const range of mergeRanges) {
      const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(range)
      if (m === null) continue
      const merge = { left: columnIndex(m[1]!), top: Number(m[2]), right: columnIndex(m[3]!), bottom: Number(m[4]) }
      merges.push(merge)
      rowCount = Math.max(rowCount, merge.bottom)
      colCount = Math.max(colCount, merge.right)
    }
    const colWidths: Array<number | undefined> = []
    for (let c = 1; c <= colCount; c += 1) colWidths[c] = worksheet.getColumn(c).width
    sheets.push({ name: worksheet.name, rowCount, colCount, cells, merges, colWidths })
  })
  return sheets
}

/** RFC 4180-ish CSV parse with delimiter sniffing (`,` `;` or tab — Vietnamese Excel exports use `;`). */
export function loadCsv(text: string, name: string): SheetModel[] {
  const source = text.replace(/^﻿/, '')
  const firstLine = source.split(/\r?\n/, 1)[0] ?? ''
  const delimiter = [',', ';', '\t'].reduce((best, d) => (firstLine.split(d).length > firstLine.split(best).length ? d : best), ',')
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]!
    if (quoted) {
      if (ch === '"' && source[i + 1] === '"') { field += '"'; i += 1 }
      else if (ch === '"') quoted = false
      else field += ch
      continue
    }
    if (ch === '"' && field === '') quoted = true
    else if (ch === delimiter) { row.push(field); field = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source[i + 1] === '\n') i += 1
      row.push(field); rows.push(row); row = []; field = ''
    } else field += ch
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row) }
  const cells = new Map<string, CellModel>()
  let colCount = 0
  rows.forEach((r, ri) => {
    colCount = Math.max(colCount, r.length)
    r.forEach((v, ci) => {
      if (v === '') return
      const n = /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : undefined
      cells.set(`${columnLetters(ci + 1)}${String(ri + 1)}`, { value: n ?? v })
    })
  })
  return [{ name, rowCount: rows.length, colCount, cells, merges: [], colWidths: [] }]
}

// ── Display values ─────────────────────────────────────────────────────────

const LOCALE = 'vi-VN'

/** Best-effort Excel number format → text: decimals, thousands grouping, %, quoted/currency literals. Not a full format engine — enough for generated reports. */
export function formatNumber(value: number, numFmt: string | undefined): string {
  if (numFmt === undefined || numFmt === 'General' || numFmt === '@') {
    return value.toLocaleString(LOCALE, { useGrouping: false, maximumFractionDigits: 10 })
  }
  const section = (value < 0 ? numFmt.split(';')[1] : undefined) ?? numFmt.split(';')[0] ?? ''
  const negativeInSection = value < 0 && numFmt.split(';')[1] !== undefined
  let prefix = ''
  let suffix = ''
  // Literal text: "…", \x, and [$₫-42A]-style currency tags; drop [Red]-style tags and _x / *x padding.
  const tokens = section
    .replace(/\[\$([^\]-]*)[^\]]*\]/g, (_m, symbol: string) => `"${symbol}"`)
    .replace(/\[[^\]]*\]/g, '')
    .replace(/_./g, '')
    .replace(/\*./g, '')
  const numberPart = /[#0?][#0?,.]*/.exec(tokens.replace(/"[^"]*"|\\./g, m => ' '.repeat(m.length)))
  if (numberPart === null) return value.toLocaleString(LOCALE)
  const unquote = (s: string): string => s.replace(/"([^"]*)"/g, '$1').replace(/\\(.)/g, '$1')
  prefix = unquote(tokens.slice(0, numberPart.index))
  suffix = unquote(tokens.slice(numberPart.index + numberPart[0].length))
  const pattern = numberPart[0].trim()
  const percent = suffix.includes('%') || prefix.includes('%')
  const decimals = (/\.([0#?]*)/.exec(pattern)?.[1] ?? '').length
  const minDecimals = (/\.(0*)/.exec(pattern)?.[1] ?? '').length
  const grouping = /[#0?],[#0?]/.test(pattern)
  const scaled = (percent ? value * 100 : value) * (negativeInSection ? -1 : 1)
  const text = scaled.toLocaleString(LOCALE, { useGrouping: grouping, minimumFractionDigits: minDecimals, maximumFractionDigits: decimals })
  return `${prefix}${text}${suffix}`.trim()
}

function formatDate(value: Date, numFmt: string | undefined): string {
  const withTime = numFmt !== undefined && /h|s/i.test(numFmt.replace(/"[^"]*"/g, ''))
  return withTime ? value.toLocaleString(LOCALE) : value.toLocaleDateString(LOCALE)
}

function displayOf(value: string | number | boolean | Date | null, numFmt: string | undefined): Omit<DisplayCell, 'formulaFallback'> {
  if (value === null) return { text: '', numeric: false, error: false }
  if (typeof value === 'number') return { text: formatNumber(value, numFmt), numeric: true, error: false }
  if (typeof value === 'boolean') return { text: value ? 'TRUE' : 'FALSE', numeric: false, error: false }
  if (value instanceof Date) return { text: formatDate(value, numFmt), numeric: true, error: false }
  return { text: value, numeric: false, error: /^#[A-Z/0!?]+[!?]?$/.test(value) }
}

/**
 * Every non-empty cell's display text, per sheet. Formula cells use the
 * file's cached result when there is one, otherwise lib/formula.ts; a
 * formula it can't handle (or one depending on such a cell) shows as its own
 * text with `formulaFallback` set.
 */
export function computeDisplay(sheets: readonly SheetModel[]): Map<string, Map<string, DisplayCell>> {
  const bySheet = new Map(sheets.map(sheet => [sheet.name, sheet]))
  const memo = new Map<string, EvalResult | Unsupported>()
  const visiting = new Set<string>()

  // Dates enter formulas as Excel serial numbers (days since 1899-12-30), so
  // `=B2-A2` on two dates gives a day count, same as in Excel.
  const serial = (d: Date): number => d.getTime() / 86_400_000 + 25_569

  function valueOf(sheetName: string, address: string): EvalResult {
    const key = `${sheetName}!${address}`
    const known = memo.get(key)
    if (known instanceof Unsupported) throw known
    if (known !== undefined) return known
    const sheet = bySheet.get(sheetName)
    if (sheet === undefined) return new FormulaError('#REF!')
    const cell = sheet.cells.get(address)
    let result: EvalResult
    if (cell === undefined) result = null
    else if (cell.formula === undefined) result = cell.value instanceof Date ? serial(cell.value) : cell.value
    else if (cell.result !== undefined && cell.result !== null) result = cell.result instanceof Date ? serial(cell.result) : cell.result
    else {
      if (visiting.has(key)) return new FormulaError('#REF!')
      visiting.add(key)
      try {
        result = evaluateFormula(cell.formula, sheetName, valueOf)
      } catch (error) {
        const unsupported = error instanceof Unsupported ? error : new Unsupported(String(error))
        memo.set(key, unsupported)
        throw unsupported
      } finally {
        visiting.delete(key)
      }
    }
    memo.set(key, result)
    return result
  }

  const out = new Map<string, Map<string, DisplayCell>>()
  for (const sheet of sheets) {
    const display = new Map<string, DisplayCell>()
    for (const [address, cell] of sheet.cells) {
      if (cell.formula === undefined) {
        const d = displayOf(cell.value, cell.numFmt)
        if (d.text !== '') display.set(address, { ...d, formulaFallback: false })
        continue
      }
      if (cell.result !== undefined && cell.result !== null) {
        display.set(address, { ...displayOf(cell.result, cell.numFmt), formulaFallback: false })
        continue
      }
      try {
        const v = valueOf(sheet.name, address)
        if (v instanceof FormulaError) display.set(address, { text: v.code, numeric: false, formulaFallback: false, error: true })
        else display.set(address, { ...displayOf(v, cell.numFmt), formulaFallback: false })
      } catch {
        display.set(address, { text: `=${cell.formula}`, numeric: false, formulaFallback: true, error: false })
      }
    }
    out.set(sheet.name, display)
  }
  return out
}
