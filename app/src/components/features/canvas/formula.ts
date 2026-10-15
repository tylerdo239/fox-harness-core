// Ported unchanged from local-fox-harness-core (apps/web/lib/formula.ts).
// A small spreadsheet formula evaluator for the canvas's .xlsx preview.
//
// Why it exists: the agent writes workbooks with openpyxl, which stores a
// formula's TEXT but never its computed value (only Excel/LibreOffice
// compute on save). Measured on a real canvas — a quote sheet with 9
// `=C4*D4`-style line totals: every one of them had no cached result, so a
// preview that only showed stored values rendered the totals column blank.
//
// Scope is deliberately "what a generated report/quote/budget uses":
// arithmetic, comparison, `&`, cell refs and ranges (optionally sheet-
// qualified), and a handful of common functions. Anything else throws
// `Unsupported`, and the preview falls back to showing the formula text —
// honest, never a made-up number.

export type FormulaValue = number | string | boolean | null

export class Unsupported extends Error {}

/** Excel-style error value (#DIV/0!, #REF!, #VALUE!, …) — displayed as-is, like Excel does. */
export class FormulaError {
  constructor(readonly code: string) {}
  toString(): string { return this.code }
}

export type EvalResult = FormulaValue | FormulaError

/** Looks up one cell's evaluated value: `sheet` is already resolved (the current sheet when the ref had no prefix). */
export type CellResolver = (sheet: string, address: string) => EvalResult

type Token =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'bool'; v: boolean }
  | { t: 'ref'; sheet?: string; a: string; b?: string }
  | { t: 'fn'; v: string }
  | { t: 'op'; v: string }
  | { t: '('; } | { t: ')'; } | { t: ','; }

const CELL = String.raw`\$?[A-Za-z]{1,3}\$?\d+`
const SHEET = String.raw`(?:'((?:[^']|'')+)'|([A-Za-z_][\w.]*))!`
const REF_RE = new RegExp(`^(?:${SHEET})?(${CELL})(?::(${CELL}))?`)

function tokenize(src: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < src.length) {
    const rest = src.slice(i)
    const ch = src[i]!
    if (/\s/.test(ch)) { i += 1; continue }
    const num = /^(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?/.exec(rest)
    if (num !== null) { tokens.push({ t: 'num', v: Number(num[0]) }); i += num[0].length; continue }
    if (ch === '"') {
      let j = i + 1
      let value = ''
      for (;;) {
        if (j >= src.length) throw new Unsupported('unterminated string')
        if (src[j] === '"') {
          if (src[j + 1] === '"') { value += '"'; j += 2; continue }
          break
        }
        value += src[j]
        j += 1
      }
      tokens.push({ t: 'str', v: value })
      i = j + 1
      continue
    }
    const ref = REF_RE.exec(rest)
    // A ref must not be the start of a longer name (e.g. "LOG10(" is a function, not cell LOG10).
    if (ref !== null && !/^[\w(]/.test(rest.slice(ref[0].length))) {
      const sheet = ref[1] !== undefined ? ref[1].replace(/''/g, "'") : ref[2]
      tokens.push({ t: 'ref', ...(sheet === undefined ? {} : { sheet }), a: ref[3]!.replace(/\$/g, '').toUpperCase(), ...(ref[4] === undefined ? {} : { b: ref[4].replace(/\$/g, '').toUpperCase() }) })
      i += ref[0].length
      continue
    }
    const name = /^[A-Za-z_][\w.]*/.exec(rest)
    if (name !== null) {
      const upper = name[0].toUpperCase()
      if (upper === 'TRUE' || upper === 'FALSE') tokens.push({ t: 'bool', v: upper === 'TRUE' })
      else if (src[i + name[0].length] === '(') tokens.push({ t: 'fn', v: upper.replace(/^_XLFN\./, '') })
      else throw new Unsupported(`named range ${name[0]}`)
      i += name[0].length
      continue
    }
    const two = rest.slice(0, 2)
    if (two === '<=' || two === '>=' || two === '<>') { tokens.push({ t: 'op', v: two }); i += 2; continue }
    if ('+-*/^&=<>%'.includes(ch)) { tokens.push({ t: 'op', v: ch }); i += 1; continue }
    if (ch === '(' || ch === ')' || ch === ',' || ch === ';') { tokens.push({ t: ch === ';' ? ',' : ch }); i += 1; continue }
    throw new Unsupported(`unexpected "${ch}"`)
  }
  return tokens
}

// ── A1 helpers ─────────────────────────────────────────────────────────────
export function columnIndex(letters: string): number {
  let n = 0
  for (const c of letters.toUpperCase()) n = n * 26 + (c.charCodeAt(0) - 64)
  return n
}

export function columnLetters(index: number): string {
  let s = ''
  for (let n = index; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s
  return s
}

export function splitAddress(address: string): { col: number; row: number } {
  const m = /^([A-Z]+)(\d+)$/.exec(address)
  if (m === null) throw new Unsupported(`bad address ${address}`)
  return { col: columnIndex(m[1]!), row: Number(m[2]) }
}

const MAX_RANGE_CELLS = 100_000

function expandRange(a: string, b: string): string[] {
  const p = splitAddress(a)
  const q = splitAddress(b)
  const [c1, c2] = [Math.min(p.col, q.col), Math.max(p.col, q.col)]
  const [r1, r2] = [Math.min(p.row, q.row), Math.max(p.row, q.row)]
  if ((c2 - c1 + 1) * (r2 - r1 + 1) > MAX_RANGE_CELLS) throw new Unsupported('range too large')
  const out: string[] = []
  for (let r = r1; r <= r2; r += 1) for (let c = c1; c <= c2; c += 1) out.push(`${columnLetters(c)}${String(r)}`)
  return out
}

// ── Evaluation ─────────────────────────────────────────────────────────────
type Operand = EvalResult | { range: EvalResult[] }

function isRange(v: Operand): v is { range: EvalResult[] } {
  return typeof v === 'object' && v !== null && !(v instanceof FormulaError) && 'range' in v
}

function scalar(v: Operand): EvalResult {
  if (isRange(v)) {
    if (v.range.length === 1) return v.range[0]!
    throw new Unsupported('range used as a single value')
  }
  return v
}

function toNumber(v: EvalResult): number | FormulaError {
  if (v instanceof FormulaError) return v
  if (v === null) return 0
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'number') return v
  const trimmed = v.trim()
  if (trimmed === '') return 0
  const n = Number(trimmed)
  return Number.isFinite(n) ? n : new FormulaError('#VALUE!')
}

function toText(v: EvalResult): string {
  if (v === null) return ''
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  return String(v)
}

function toBool(v: EvalResult): boolean | FormulaError {
  if (v instanceof FormulaError) return v
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  if (v === null) return false
  const upper = v.toUpperCase()
  if (upper === 'TRUE') return true
  if (upper === 'FALSE') return false
  return new FormulaError('#VALUE!')
}

/** Numbers pulled out of function args the way SUM & co. do: ranges skip text/blank/bool, direct args coerce. */
function numbersOf(args: Operand[]): number[] | FormulaError {
  const out: number[] = []
  for (const arg of args) {
    if (isRange(arg)) {
      for (const cell of arg.range) {
        if (cell instanceof FormulaError) return cell
        if (typeof cell === 'number') out.push(cell)
      }
    } else {
      const n = toNumber(arg)
      if (n instanceof FormulaError) return n
      out.push(n)
    }
  }
  return out
}

function roundTo(value: number, digits: number, mode: 'nearest' | 'up' | 'down'): number {
  const factor = 10 ** digits
  const scaled = Math.abs(value) * factor
  const r = mode === 'nearest' ? Math.round(scaled + 1e-9) : mode === 'up' ? Math.ceil(scaled - 1e-9) : Math.floor(scaled + 1e-9)
  return Math.sign(value) * r / factor
}

function compare(a: EvalResult, b: EvalResult, op: string): boolean {
  const norm = (v: EvalResult): number | string | boolean => (v === null ? 0 : v instanceof FormulaError ? v.code : typeof v === 'string' ? v.toLowerCase() : v)
  const x = norm(a)
  const y = norm(b)
  switch (op) {
    case '=': return x === y
    case '<>': return x !== y
    case '<': return x < y
    case '>': return x > y
    case '<=': return x <= y
    default: return x >= y
  }
}

class Parser {
  private pos = 0
  constructor(private readonly tokens: Token[], private readonly sheet: string, private readonly resolve: CellResolver) {}

  run(): EvalResult {
    const value = scalar(this.comparison())
    if (this.pos !== this.tokens.length) throw new Unsupported('trailing tokens')
    return value
  }

  private peek(): Token | undefined { return this.tokens[this.pos] }
  private isOp(...ops: string[]): string | undefined {
    const tok = this.peek()
    return tok?.t === 'op' && ops.includes(tok.v) ? tok.v : undefined
  }

  private comparison(): Operand {
    let left = this.concat()
    for (let op = this.isOp('=', '<>', '<', '>', '<=', '>='); op !== undefined; op = this.isOp('=', '<>', '<', '>', '<=', '>=')) {
      this.pos += 1
      const a = scalar(left)
      const b = scalar(this.concat())
      if (a instanceof FormulaError) return a
      if (b instanceof FormulaError) return b
      left = compare(a, b, op)
    }
    return left
  }

  private concat(): Operand {
    let left = this.additive()
    while (this.isOp('&') !== undefined) {
      this.pos += 1
      const a = scalar(left)
      const b = scalar(this.additive())
      if (a instanceof FormulaError) return a
      if (b instanceof FormulaError) return b
      left = toText(a) + toText(b)
    }
    return left
  }

  private arith(next: () => Operand, ops: string[]): Operand {
    let left = next()
    for (let op = this.isOp(...ops); op !== undefined; op = this.isOp(...ops)) {
      this.pos += 1
      const a = toNumber(scalar(left))
      const b = toNumber(scalar(next()))
      if (a instanceof FormulaError) return a
      if (b instanceof FormulaError) return b
      if (op === '+') left = a + b
      else if (op === '-') left = a - b
      else if (op === '*') left = a * b
      else if (op === '/') left = b === 0 ? new FormulaError('#DIV/0!') : a / b
      else left = a ** b
    }
    return left
  }

  private additive(): Operand { return this.arith(() => this.term(), ['+', '-']) }
  private term(): Operand { return this.arith(() => this.power(), ['*', '/']) }
  private power(): Operand { return this.arith(() => this.unary(), ['^']) }

  private unary(): Operand {
    const op = this.isOp('-', '+')
    if (op !== undefined) {
      this.pos += 1
      const n = toNumber(scalar(this.unary()))
      if (n instanceof FormulaError) return n
      return op === '-' ? -n : n
    }
    let value = this.primary()
    while (this.isOp('%') !== undefined) {
      this.pos += 1
      const n = toNumber(scalar(value))
      value = n instanceof FormulaError ? n : n / 100
    }
    return value
  }

  private expect(t: '(' | ')' | ','): void {
    if (this.peek()?.t !== t) throw new Unsupported(`expected ${t}`)
    this.pos += 1
  }

  private primary(): Operand {
    const tok = this.peek()
    if (tok === undefined) throw new Unsupported('unexpected end')
    this.pos += 1
    switch (tok.t) {
      case 'num': return tok.v
      case 'str': return tok.v
      case 'bool': return tok.v
      case '(': {
        const inner = this.comparison()
        this.expect(')')
        return inner
      }
      case 'ref': {
        const sheet = tok.sheet ?? this.sheet
        if (tok.b === undefined) return this.resolve(sheet, tok.a)
        return { range: expandRange(tok.a, tok.b).map(address => this.resolve(sheet, address)) }
      }
      case 'fn': return this.call(tok.v)
      default: throw new Unsupported(`unexpected token ${tok.t}`)
    }
  }

  /** Parses call args lazily so IF/IFERROR only evaluate the branch they take (matches Excel, and avoids spurious errors). */
  private call(name: string): Operand {
    this.expect('(')
    const thunks: Array<() => Operand> = []
    if (this.peek()?.t !== ')') {
      for (;;) {
        const start = this.pos
        this.skipArg()
        const end = this.pos
        thunks.push(() => {
          const saved = this.pos
          this.pos = start
          const v = this.comparison()
          if (this.pos !== end) throw new Unsupported('bad argument')
          this.pos = saved
          return v
        })
        if (this.peek()?.t === ',') { this.pos += 1; continue }
        break
      }
    }
    this.expect(')')
    const all = (): Operand[] => thunks.map(f => f())
    const num = (i: number): number | FormulaError => {
      const f = thunks[i]
      return f === undefined ? 0 : toNumber(scalar(f()))
    }

    switch (name) {
      case 'SUM': {
        const ns = numbersOf(all())
        return ns instanceof FormulaError ? ns : ns.reduce((a, b) => a + b, 0)
      }
      case 'AVERAGE': {
        const ns = numbersOf(all())
        if (ns instanceof FormulaError) return ns
        return ns.length === 0 ? new FormulaError('#DIV/0!') : ns.reduce((a, b) => a + b, 0) / ns.length
      }
      case 'MIN':
      case 'MAX': {
        const ns = numbersOf(all())
        if (ns instanceof FormulaError) return ns
        return ns.length === 0 ? 0 : (name === 'MIN' ? Math.min(...ns) : Math.max(...ns))
      }
      case 'COUNT': {
        const ns = numbersOf(all())
        return ns instanceof FormulaError ? ns : ns.length
      }
      case 'COUNTA': {
        let n = 0
        for (const arg of all()) {
          for (const v of isRange(arg) ? arg.range : [arg]) if (v !== null && v !== '') n += 1
        }
        return n
      }
      case 'ROUND':
      case 'ROUNDUP':
      case 'ROUNDDOWN': {
        const v = num(0)
        const d = num(1)
        if (v instanceof FormulaError) return v
        if (d instanceof FormulaError) return d
        return roundTo(v, Math.trunc(d), name === 'ROUND' ? 'nearest' : name === 'ROUNDUP' ? 'up' : 'down')
      }
      case 'ABS': {
        const v = num(0)
        return v instanceof FormulaError ? v : Math.abs(v)
      }
      case 'IF': {
        const cond = toBool(scalar(thunks[0]?.() ?? false))
        if (cond instanceof FormulaError) return cond
        const branch = cond ? thunks[1] : thunks[2]
        return branch === undefined ? cond : scalar(branch())
      }
      case 'IFERROR': {
        const v = scalar(thunks[0]?.() ?? null)
        return v instanceof FormulaError ? scalar(thunks[1]?.() ?? '') : v
      }
      case 'AND':
      case 'OR': {
        const bools: boolean[] = []
        for (const arg of all()) {
          for (const v of isRange(arg) ? arg.range : [arg]) {
            if (isRange(arg) && typeof v !== 'boolean' && typeof v !== 'number') continue
            const b = toBool(v)
            if (b instanceof FormulaError) return b
            bools.push(b)
          }
        }
        return name === 'AND' ? bools.every(Boolean) : bools.some(Boolean)
      }
      case 'NOT': {
        const b = toBool(scalar(thunks[0]?.() ?? false))
        return b instanceof FormulaError ? b : !b
      }
      case 'CONCATENATE':
      case 'CONCAT': {
        let out = ''
        for (const arg of all()) {
          for (const v of isRange(arg) ? arg.range : [arg]) {
            if (v instanceof FormulaError) return v
            out += toText(v)
          }
        }
        return out
      }
      default:
        throw new Unsupported(`function ${name}`)
    }
  }

  /** Advances past one argument expression without evaluating it (balanced parentheses, stops at `,` or `)`). */
  private skipArg(): void {
    let depth = 0
    while (this.pos < this.tokens.length) {
      const tok = this.tokens[this.pos]!
      if (depth === 0 && (tok.t === ',' || tok.t === ')')) return
      if (tok.t === '(') depth += 1
      if (tok.t === ')') depth -= 1
      this.pos += 1
    }
  }
}

/** Evaluates one formula (without its leading "="). Throws `Unsupported` for anything outside the supported subset. */
export function evaluateFormula(formula: string, sheet: string, resolve: CellResolver): EvalResult {
  return new Parser(tokenize(formula.replace(/^=/, '')), sheet, resolve).run()
}
