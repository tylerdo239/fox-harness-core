import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const RUNNER = fileURLToPath(new URL('../python/runner.py', import.meta.url))
const MAX_OUTPUT_CHARS = 20_000
// Lives in the working directory (under /data, survives the container) so a
// fresh process can tell the model that earlier variables are gone.
const SESSION_MARKER = '.python-session'
// After a restart the model tended to write a new method and contradict its own earlier answer
// (docs/rlm-transfer-changes.md, H3): both notes send it back to the stated results and the old code.
const RESTARTED_NOTE = 'Note: the Python session was restarted, so variables from earlier calls are gone; files in the working directory are still there. Results already stated in the conversation still hold. To rebuild a variable, rerun the same code as before (print(history(n)) shows turn n).'
const VARIABLES_HEADER = 'Python variables in memory from earlier calls — reuse them instead of reloading files or recomputing:'
const VARIABLES_GONE = 'The Python session restarted: variables from earlier turns are gone; files are still there. Results already stated in the conversation still hold — reuse them. To rebuild a variable, rerun the same code as before (print(history(n)) shows turn n) instead of writing a new method.'
const MAX_NOTED_VARIABLES = 30

interface CellReply {
  ok: boolean
  output: string
  figures: string[]
  variables: Array<[name: string, description: string, changed: boolean]>
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
    this.reply = undefined
    this.host = undefined

    if (reply === 'timeout' || reply === 'aborted') {
      this.stop()
      throw new Error(
        reply === 'timeout'
          ? `The code ran longer than ${timeoutMs / 1000} seconds, so the Python session was stopped. Variables are gone; files in the working directory are still there.`
          : 'Cancelled; the Python session was stopped.',
      )
    }
    if (reply === undefined) {
      throw new Error(`The Python process exited unexpectedly. Variables are gone; files in the working directory are still there.\n${this.stderrTail}`.trim())
    }
    this.noteVariables(reply.variables, turn)

    let text = reply.output.length > MAX_OUTPUT_CHARS
      ? `${reply.output.slice(0, MAX_OUTPUT_CHARS)}\n… [truncated ${reply.output.length - MAX_OUTPUT_CHARS} characters]`
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
  variablesNote(usedPythonBefore: boolean): string {
    if (this.process === undefined) return usedPythonBefore ? VARIABLES_GONE : ''
    if (this.variables.size === 0) return ''
    const lines = [...this.variables]
      .sort((a, b) => a[1].turn - b[1].turn)
      .slice(-MAX_NOTED_VARIABLES)
      .map(([name, { description, turn }]) => `- ${name}: ${description} (turn ${turn})`)
    return [VARIABLES_HEADER, ...lines].join('\n')
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
