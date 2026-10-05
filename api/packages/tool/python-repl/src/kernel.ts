import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
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

  /** A cell is running (or queued): not a candidate for eviction. */
  get busy(): boolean {
    return this.inflight > 0
  }

  get alive(): boolean {
    return this.process !== undefined
  }

  private confined = false
  private inflight = 0
  private tail: Promise<unknown> = Promise.resolve()

  /**
   * One cell at a time per kernel: `reply`/`host` are single slots, and an agent that runs two tool
   * calls concurrently (or a retry racing a timeout) would overwrite them.
   */
  run(code: string, cwd: string, timeoutMs: number, signal: AbortSignal, turn: number, host: HostHandler, outputDir?: string): Promise<string> {
    this.inflight += 1
    const result = this.tail.then(() => this.runExclusive(code, cwd, timeoutMs, signal, turn, host, outputDir))
    const settled = result.catch(() => undefined)
    this.tail = settled
    void settled.then(() => { this.inflight -= 1 })
    return result
  }

  private async runExclusive(code: string, cwd: string, timeoutMs: number, signal: AbortSignal, turn: number, host: HostHandler, outputDir?: string): Promise<string> {
    const note = this.process ? '' : this.start(cwd, outputDir)
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
      // Confined, the spawned process is bwrap, which does not relay a signal to the interpreter in
      // its PID namespace (measured: the over-limit cell was never interrupted and the whole kernel
      // got SIGKILLed, taking every variable with it). The interpreter shares bwrap's process group,
      // so signal the group.
      if (this.confined && child.pid !== undefined) globalThis.process.kill(-child.pid, 'SIGINT')
      else child.kill('SIGINT')
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

  private start(cwd: string, outputDir?: string): string {
    const marker = join(cwd, SESSION_MARKER)
    const restarted = existsSync(marker)
    writeFileSync(marker, `${new Date().toISOString()}\n`)

    // Minimal environment: model-written code must not be able to read the
    // runtime's API keys.
    //
    // FOX_CONFINE_RUNNER (docs/single-backend-architecture-plan.md §7.2): when set, the interpreter
    // runs under that bwrap-compatible runner (docker/fox-confine.sh) so it sees only
    // its own workspace — without it the process can read every other user's files, because it
    // shares the runtime's filesystem. The runner mounts nothing but a minimal system, the venv,
    // the workspace (read-write) and, read-only, the directory FOX_CONFINE_RO names (this
    // package's runner.py + helpers).
    const python = globalThis.process.env.FOX_PYTHON ?? 'python3'
    const confine = globalThis.process.env.FOX_CONFINE_RUNNER
    const [program, ...programArgs] = confine
      ? [confine, '--ro-bind', '/', '/', '--bind', cwd, cwd, '--tmpfs', '/tmp', '--', python, '-u', RUNNER]
      : [python, '-u', RUNNER]
    this.confined = confine !== undefined && confine !== ''
    const child = spawn(program!, programArgs, {
      cwd,
      // Own process group when confined, so an interrupt can reach the interpreter (see interrupt()).
      detached: this.confined,
      env: {
        PATH: globalThis.process.env.PATH,
        HOME: confine ? '/tmp' : globalThis.process.env.HOME,
        LANG: 'C.UTF-8',
        PYTHONIOENCODING: 'utf-8',
        MPLBACKEND: 'Agg',
        ...(confine ? { MPLCONFIGDIR: '/tmp/mpl', FOX_CONFINE_RO: dirname(RUNNER), FOX_PYTHON: python } : {}),
        // Output folder for figures and save_artifact(): a project chat's own subfolder. Per
        // SESSION now (agentOptions.outputDir, set by packages/transport from what the gateway
        // passes) — the process-wide env var only remains as the fallback for one-session-per-process use.
        ...((outputDir ?? globalThis.process.env.FOX_OUTPUT_DIR) ? { FOX_OUTPUT_DIR: (outputDir ?? globalThis.process.env.FOX_OUTPUT_DIR)! } : {}),
      },
    })
    this.stderrTail = ''
    this.variables.clear()
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-2000)
    })
    createInterface({ input: child.stdout }).on('line', (line) => {
      // Same rule as the data-studio kernel: a stray non-JSON line on the protocol channel must never throw out of
      // this handler (it would take the whole runtime down, not just this conversation).
      let message: CellReply | { host: HostRequest }
      try {
        message = JSON.parse(line) as CellReply | { host: HostRequest }
        if (message === null || typeof message !== 'object') throw new Error('not an object')
      } catch {
        this.stderrTail = (this.stderrTail + line + '\n').slice(-2000)
        return
      }
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
