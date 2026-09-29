import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const RUNNER = fileURLToPath(new URL('../python/runner.py', import.meta.url))
// Long output keeps its start and its end: a traceback printed last must stay visible.
const HEAD_OUTPUT_CHARS = 14_000
const TAIL_OUTPUT_CHARS = 6_000
// Lives in the working directory (under /data, survives the container) so a
// fresh process can tell the model that earlier variables are gone.
const SESSION_MARKER = '.python-session'
// After a restart the model tended to write a new method and contradict its own earlier answer
// (docs/rlm-transfer-changes.md, H3): both notes send it back to the stated results and the old code.
const RESTARTED_NOTE = 'Note: the Python session was restarted, so variables from earlier calls are gone; files in the working directory are still there. Results already stated in the conversation still hold. To rebuild a variable, rerun the same code as before (print(history(n)) shows turn n).'
// Numbers this conversation has already computed, pushed back to the model the way the variables
// note is. A value computed in turn 3 leaves the model's view when that turn's tool steps are
// collapsed or compacted, and restating it from memory is how a wrong number reaches the user.
// `print(history(n))` is offered at that exact moment and was never once taken across 820 stored
// conversations, so nothing here waits for the model to ask.
const RESULTS_HEADER = 'Values already computed in this conversation — reuse these digits instead of recomputing or recalling them:'
/** Ledger length: enough to carry a conversation's real numbers, short enough to stay cheap. */
const MAX_NOTED_RESULTS = 10
/** How long a cell gets to end itself after the interrupt before the session is killed instead. */
const INTERRUPT_GRACE_MS = 5_000
const VARIABLES_HEADER = 'Python variables in memory from earlier calls — reuse them instead of reloading files or recomputing:'
const VARIABLES_GONE = 'The Python session restarted: variables from earlier turns are gone; files are still there. Results already stated in the conversation still hold — reuse them. To rebuild a variable, rerun the same code as before (print(history(n)) shows turn n) instead of writing a new method.'
const MAX_NOTED_VARIABLES = 30

interface CellReply {
  ok: boolean
  output: string
  figures: string[]
  variables: Array<[name: string, description: string, changed: boolean]>
  /** The cell's last expression when it was a single number or short string: [code line, value]. */
  result?: [label: string, value: string]
}

export interface HostRequest {
  kind: string
  turn?: number
}

/** Answers a running cell's host request (`history(n)`) with text; a throw is reported to the cell. */
export type HostHandler = (request: HostRequest) => string

export class PythonKernel {
  private process: ChildProcessWithoutNullStreams | undefined
  private reply: ((reply: CellReply | undefined) => void) | undefined
  private host: HostHandler | undefined
  private stderrTail = ''
  /** The model's variables: description and the turn they were last assigned or changed in. */
  private readonly variables = new Map<string, { description: string; turn: number }>()
  /** Deliberately NOT cleared when the process restarts: the numbers were computed and stated, and stay true. */
  private readonly results: Array<{ label: string; value: string; turn: number }> = []

  async run(code: string, cwd: string, timeoutMs: number, signal: AbortSignal, turn: number, host: HostHandler): Promise<string> {
    const note = this.process ? '' : this.start(cwd)
    const process = this.process!
    this.host = host

    const reply = await new Promise<CellReply | 'timeout' | 'aborted' | undefined>((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), timeoutMs)
      const onAbort = () => resolve('aborted')
      signal.addEventListener('abort', onAbort, { once: true })
      this.reply = (value) => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      }
      process.stdin.write(JSON.stringify({ code }) + '\n')
    })
    this.host = undefined

    // A cell that runs too long is that cell's problem, not the session's. Interrupt it the way
    // Ctrl-C would and keep everything else alive; SIGKILL stays as the fallback for a cell that
    // ignores the interrupt. Measured on a real chat (2026-09-16, session 485b291d): one cell over
    // the 120-second limit killed the session, and the variables it took with it produced three
    // more failures across the following turns (NameError on perm_v2, KeyError on residual_v2, a
    // missing file) — one slow cell cost four errors.
    const late = reply === 'timeout' ? await this.interrupt() : undefined
    this.reply = undefined
    if (late !== undefined) {
      this.noteVariables(late.variables, turn)
      throw new Error(
        `The code was stopped after ${timeoutMs / 1000} seconds. Variables from earlier calls are still in memory; only this call's own work is lost.\n${late.output}`.trim(),
      )
    }

    if (reply === 'timeout' || reply === 'aborted') {
      this.stop()
      throw new Error(
        reply === 'timeout'
          ? `The code ran longer than ${timeoutMs / 1000} seconds and did not stop, so the Python session was stopped. Variables are gone; files in the working directory are still there.`
          : 'Cancelled; the Python session was stopped.',
      )
    }
    if (reply === undefined) {
      throw new Error(`The Python process exited unexpectedly. Variables are gone; files in the working directory are still there.\n${this.stderrTail}`.trim())
    }
    this.noteVariables(reply.variables, turn)
    if (reply.result) {
      const [label, value] = reply.result
      this.results.push({ label, value, turn })
      if (this.results.length > MAX_NOTED_RESULTS) this.results.shift()
    }

    const omitted = reply.output.length - HEAD_OUTPUT_CHARS - TAIL_OUTPUT_CHARS
    let text = omitted > 0
      ? `${reply.output.slice(0, HEAD_OUTPUT_CHARS)}\n… [${omitted} characters omitted] …\n${reply.output.slice(-TAIL_OUTPUT_CHARS)}`
      : reply.output
    if (reply.figures.length > 0) text += `\nSaved figures: ${reply.figures.join(', ')}`
    if (note) text = `${note}\n${text}`
    if (!reply.ok) throw new Error(text)
    return text.trim() || '(no output)'
  }

  /**
   * Text of the variables note (docs/rlm-transfer-plan.md 12.3 B): the live variables, that
   * they are gone when the conversation used Python before this process, or '' for nothing.
   */
  variablesNote(usedPythonBefore: boolean, turn: number): string {
    const sections: string[] = []
    if (this.process === undefined) {
      if (usedPythonBefore) sections.push(VARIABLES_GONE)
    } else if (this.variables.size > 0) {
      const lines = [...this.variables]
        .sort((a, b) => a[1].turn - b[1].turn)
        .slice(-MAX_NOTED_VARIABLES)
        .map(([name, { description, turn: at }]) => `- ${name}: ${description} (turn ${at})`)
      sections.push([VARIABLES_HEADER, ...lines].join('\n'))
    }
    // Only earlier turns: this turn's own results are still verbatim in its tool output, and a
    // ledger that grew inside a turn would push a fresh note after every cell.
    const earlier = this.results.filter((result) => result.turn < turn)
    if (earlier.length > 0) {
      sections.push([RESULTS_HEADER, ...earlier.map((result) => `- ${result.value} (turn ${result.turn}) <- ${result.label}`)].join('\n'))
    }
    return sections.join('\n')
  }

  /**
   * Ctrl-C the running cell and wait briefly for the process to report the interrupted cell.
   * `undefined` when it does not answer in time — the caller then falls back to killing it.
   */
  private interrupt(): Promise<CellReply | undefined> {
    const child = this.process
    if (child === undefined) return Promise.resolve(undefined)
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(undefined), INTERRUPT_GRACE_MS)
      this.reply = (value) => {
        clearTimeout(timer)
        resolve(value)
      }
      child.kill('SIGINT')
    })
  }

  stop(): void {
    this.process?.kill('SIGKILL')
    this.process = undefined
    this.variables.clear()
  }

  private noteVariables(listed: CellReply['variables'], turn: number): void {
    const names = new Set(listed.map(([name]) => name))
    for (const name of this.variables.keys()) if (!names.has(name)) this.variables.delete(name)
    for (const [name, description, changed] of listed) {
      const known = this.variables.get(name)
      this.variables.set(name, { description, turn: changed || known === undefined ? turn : known.turn })
    }
  }

  // Every path answers: the cell is blocked reading stdin until it gets a line.
  private answerHost(request: HostRequest): { result: string } | { error: string } {
    if (this.host === undefined) return { error: 'no conversation is attached to this call' }
    try {
      return { result: this.host(request) }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }

  private start(cwd: string): string {
    const marker = join(cwd, SESSION_MARKER)
    const restarted = existsSync(marker)
    writeFileSync(marker, `${new Date().toISOString()}\n`)

    // Minimal environment: model-written code must not be able to read the
    // worker's API keys.
    const child = spawn(globalThis.process.env.FOX_PYTHON ?? 'python3', ['-u', RUNNER], {
      cwd,
      env: {
        PATH: globalThis.process.env.PATH,
        HOME: globalThis.process.env.HOME,
        LANG: 'C.UTF-8',
        PYTHONIOENCODING: 'utf-8',
        MPLBACKEND: 'Agg',
        // Output folder for figures and save_artifact(): a project chat's own subfolder.
        ...(globalThis.process.env.FOX_OUTPUT_DIR ? { FOX_OUTPUT_DIR: globalThis.process.env.FOX_OUTPUT_DIR } : {}),
      },
    })
    this.stderrTail = ''
    this.variables.clear()
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-2000)
    })
    createInterface({ input: child.stdout }).on('line', (line) => {
      const message = JSON.parse(line) as CellReply | { host: HostRequest }
      if ('host' in message) child.stdin.write(JSON.stringify(this.answerHost(message.host)) + '\n')
      else this.reply?.(message)
    })
    child.on('exit', () => {
      if (this.process === child) {
        this.process = undefined
        this.variables.clear()
      }
      this.reply?.(undefined)
    })
    this.process = child
    return restarted ? RESTARTED_NOTE : ''
  }
}
