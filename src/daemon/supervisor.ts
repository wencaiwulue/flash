import { sleep } from '../utils/sleep.js'

export type DaemonWorkerProcess = {
  readonly pid?: number
  kill(signal?: NodeJS.Signals): boolean
  once(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): void
  once(event: 'error', listener: (error: Error) => void): void
}

type SupervisorOptions = {
  spawn: (kind: string) => DaemonWorkerProcess
  maxRestarts?: number
  baseDelayMs?: number
  maxDelayMs?: number
  wait?: (ms: number) => Promise<void>
}

export class DaemonSupervisor {
  private active: DaemonWorkerProcess | undefined
  private stopping = false
  private running = false
  private restarts = 0

  constructor(private readonly options: SupervisorOptions) {}

  getState(): { running: boolean; restarts: number; pid?: number } {
    return {
      running: this.running,
      restarts: this.restarts,
      ...(this.active?.pid !== undefined ? { pid: this.active.pid } : {}),
    }
  }

  async run(kind: string): Promise<number> {
    if (this.running) throw new Error('Daemon supervisor is already running')
    this.running = true
    this.stopping = false
    this.restarts = 0
    const maxRestarts = this.options.maxRestarts ?? 5
    try {
      for (;;) {
        const child = this.options.spawn(kind)
        this.active = child
        const result = await new Promise<{
          code: number | null
          error?: Error
        }>(resolve => {
          child.once('error', error => resolve({ code: null, error }))
          child.once('exit', code => resolve({ code }))
        })
        this.active = undefined
        if (this.stopping) return result.code ?? 0
        if (result.code === 0) return 0
        if (this.restarts >= maxRestarts) {
          throw new Error(
            `Daemon worker ${kind} failed after ${this.restarts} restarts: ${result.error?.message ?? `exit ${result.code ?? 'unknown'}`}`,
          )
        }

        const base = this.options.baseDelayMs ?? 1_000
        const maximum = this.options.maxDelayMs ?? 30_000
        const delay = Math.min(maximum, base * 2 ** this.restarts)
        this.restarts++
        await (this.options.wait ?? sleep)(delay)
      }
    } finally {
      this.running = false
      this.active = undefined
    }
  }

  stop(): void {
    this.stopping = true
    this.active?.kill('SIGTERM')
  }
}
