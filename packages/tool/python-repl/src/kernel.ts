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
const RESTARTED_NOTE = 'Note: the Python session was restarted, so variables from earlier calls are gone. Files in the working directory are still there.'

interface CellReply {
  ok: boolean
  output: string
  figures: string[]
}

export class PythonKernel {
  private process: ChildProcessWithoutNullStreams | undefined
  private reply: ((reply: CellReply | undefined) => void) | undefined
  private stderrTail = ''

  async run(code: string, cwd: string, timeoutMs: number, signal: AbortSignal): Promise<string> {
    const note = this.process ? '' : this.start(cwd)
    const process = this.process!

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

    let text = reply.output.length > MAX_OUTPUT_CHARS
      ? `${reply.output.slice(0, MAX_OUTPUT_CHARS)}\n… [truncated ${reply.output.length - MAX_OUTPUT_CHARS} characters]`
      : reply.output
    if (reply.figures.length > 0) text += `\nSaved figures: ${reply.figures.join(', ')}`
    if (note) text = `${note}\n${text}`
    if (!reply.ok) throw new Error(text)
    return text.trim() || '(no output)'
  }

  stop(): void {
    this.process?.kill('SIGKILL')
    this.process = undefined
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
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-2000)
    })
    createInterface({ input: child.stdout }).on('line', (line) => {
      this.reply?.(JSON.parse(line) as CellReply)
    })
    child.on('exit', () => {
      if (this.process === child) this.process = undefined
      this.reply?.(undefined)
    })
    this.process = child
    return restarted ? RESTARTED_NOTE : ''
  }
}
