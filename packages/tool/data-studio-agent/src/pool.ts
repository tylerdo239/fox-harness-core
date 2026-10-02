import { DataStudioKernel, type AnalyzeReply } from './kernel.ts'

// One runtime hosts many users' sessions (docs/single-backend-architecture-plan.md), so
// `analyze_data` can no longer own "the" subprocess: a DataStudioKernel serves ONE question at a
// time (a single `reply` slot) and a question takes minutes. A question is stateless (the pipeline
// takes only the question text; its persisted output goes to Mongo), so any worker can answer any
// session's question. This pool keeps up to `max` warm workers and queues the rest, each with a
// bounded wait so a burst becomes "busy, retry" instead of an unbounded pile-up of 10-minute calls.

interface PooledWorker {
  kernel: DataStudioKernel
  busy: boolean
  lastUsed: number
}

interface Waiter {
  resolve(worker: PooledWorker): void
  reject(error: Error): void
}

export class DataStudioPool {
  private readonly workers: PooledWorker[] = []
  private readonly waiting: Waiter[] = []
  private readonly sweep: NodeJS.Timeout

  constructor(
    private readonly max = Number(process.env.FOX_DS_WORKERS ?? 2),
    private readonly queueTimeoutMs = Number(process.env.FOX_DS_QUEUE_TIMEOUT_MS ?? 120_000),
    private readonly idleMs = Number(process.env.FOX_DS_IDLE_MS ?? 10 * 60_000),
  ) {
    // Idle workers hold the heavy Python imports (agno, sqlglot, chromadb) in RAM: stop them.
    // The object stays, and its kernel restarts lazily on the next question.
    this.sweep = setInterval(() => {
      const now = Date.now()
      for (const worker of this.workers) if (!worker.busy && now - worker.lastUsed > this.idleMs) worker.kernel.stop()
    }, 30_000)
    this.sweep.unref()
  }

  /** Workers currently running a question, and questions waiting for one. */
  get load(): { busy: number; queued: number } {
    return { busy: this.workers.filter((worker) => worker.busy).length, queued: this.waiting.length }
  }

  async ask(question: string, timeoutMs: number, signal: AbortSignal): Promise<AnalyzeReply> {
    const worker = await this.acquire(signal)
    try {
      return await worker.kernel.ask(question, timeoutMs, signal)
    } finally {
      worker.lastUsed = Date.now()
      this.release(worker)
    }
  }

  stop(): void {
    clearInterval(this.sweep)
    for (const waiter of this.waiting.splice(0)) waiter.reject(new Error('data analysis is shutting down'))
    for (const worker of this.workers) worker.kernel.stop()
    this.workers.length = 0
  }

  private acquire(signal: AbortSignal): Promise<PooledWorker> {
    signal.throwIfAborted()
    const idle = this.workers.find((worker) => !worker.busy)
    if (idle) {
      idle.busy = true
      return Promise.resolve(idle)
    }
    if (this.workers.length < this.max) {
      const worker: PooledWorker = { kernel: new DataStudioKernel(), busy: true, lastUsed: Date.now() }
      this.workers.push(worker)
      return Promise.resolve(worker)
    }
    return new Promise<PooledWorker>((resolve, reject) => {
      const waiter: Waiter = {
        resolve: (worker) => { cleanup(); resolve(worker) },
        reject: (error) => { cleanup(); reject(error) },
      }
      const timer = setTimeout(() => {
        this.waiting.splice(this.waiting.indexOf(waiter), 1)
        waiter.reject(new Error(`All ${this.max} data-analysis workers are busy; waited ${this.queueTimeoutMs / 1000} seconds. Try again shortly.`))
      }, this.queueTimeoutMs)
      const onAbort = () => {
        const at = this.waiting.indexOf(waiter)
        if (at >= 0) this.waiting.splice(at, 1)
        waiter.reject(new Error('Cancelled while waiting for a free data-analysis worker.'))
      }
      const cleanup = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      this.waiting.push(waiter)
    })
  }

  private release(worker: PooledWorker): void {
    const next = this.waiting.shift()
    if (next) next.resolve(worker) // hand the still-busy worker straight to the longest waiter
    else worker.busy = false
  }
}
