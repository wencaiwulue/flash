import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { randomUUID } from 'crypto'
import { existsSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { createInterface, type Interface } from 'readline'

export type ComputerUseHelper = {
  request<T>(
    method: string,
    params?: Record<string, unknown>,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<T>
  onEvent(event: 'escape', listener: () => void): () => void
  close(): Promise<void>
}

type PendingRequest = {
  method: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  abortListener?: () => void
  signal?: AbortSignal
}

function helperPath(): string {
  const configured = process.env.CLAUDE_COMPUTER_USE_HELPER
  if (configured) return configured
  const relative = join('build', 'computer-use', 'open-computer-use-helper')
  const candidates = [
    join(process.cwd(), relative),
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', relative),
  ]
  return candidates.find(candidate => existsSync(candidate)) ?? candidates[0]!
}

function abortError(): Error {
  const error = new Error('Computer Use native helper call aborted')
  error.name = 'AbortError'
  return error
}

/**
 * JSON-lines transport for the public macOS helper. No shell is involved:
 * requests are data on stdin and desktop work is performed only by the helper.
 */
export class NativeHelperClient implements ComputerUseHelper {
  private readonly pending = new Map<string, PendingRequest>()
  private readonly listeners = new Set<() => void>()
  private readonly lines: Interface
  private closed = false
  private closePromise: Promise<void> | undefined

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.lines = createInterface({ input: child.stdout })
    this.lines.on('line', line => this.onLine(line))
    child.stderr.on('data', () => {
      // The protocol never puts clipboard text, typed text, or images on stderr.
      // Consume diagnostics without logging potentially sensitive desktop data.
    })
    child.once('error', error => this.failAll(error))
    child.once('exit', (code, signal) => {
      this.closed = true
      if (this.pending.size > 0) {
        this.failAll(
          new Error(
            `Computer Use native helper exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`,
          ),
        )
      }
    })
  }

  async request<T>(
    method: string,
    params: Record<string, unknown> = {},
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<T> {
    if (this.closed || this.child.exitCode !== null) {
      throw new Error('Computer Use native helper is not running')
    }
    if (options.signal?.aborted) throw abortError()

    const id = randomUUID()
    return new Promise<T>((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? 30_000
      const request: PendingRequest = {
        method,
        resolve: value => resolve(value as T),
        reject,
        signal: options.signal,
        timer: setTimeout(() => {
          this.pending.delete(id)
          cleanup()
          reject(
            new Error(
              `Computer Use native helper call timed out: ${method} (${timeoutMs}ms)`,
            ),
          )
        }, timeoutMs),
      }
      const cleanup = (): void => {
        clearTimeout(request.timer)
        if (request.abortListener) {
          options.signal?.removeEventListener('abort', request.abortListener)
          request.abortListener = undefined
        }
      }
      if (options.signal) {
        request.abortListener = () => {
          this.pending.delete(id)
          cleanup()
          reject(abortError())
        }
        options.signal.addEventListener('abort', request.abortListener, {
          once: true,
        })
      }
      this.pending.set(id, request)
      this.child.stdin.write(
        `${JSON.stringify({ id, method, params })}\n`,
        error => {
          if (!error) return
          const current = this.pending.get(id)
          if (!current) return
          this.pending.delete(id)
          clearTimeout(current.timer)
          if (current.abortListener) {
            options.signal?.removeEventListener('abort', current.abortListener)
          }
          reject(error)
        },
      )
    })
  }

  onEvent(event: 'escape', listener: () => void): () => void {
    if (event !== 'escape') throw new Error(`Unsupported helper event: ${event}`)
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closed = true
    this.failAll(new Error('Computer Use native helper closed'))
    this.closePromise = new Promise<void>(resolve => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        this.lines.close()
        resolve()
        return
      }
      this.child.once('exit', () => {
        this.lines.close()
        resolve()
      })
      this.child.stdin.end()
      const timer = setTimeout(() => this.child.kill('SIGTERM'), 250)
      timer.unref()
    })
    return this.closePromise
  }

  private onLine(line: string): void {
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (
      typeof message === 'object' &&
      message !== null &&
      (message as { event?: unknown }).event === 'escape'
    ) {
      for (const listener of [...this.listeners]) listener()
      return
    }
    if (typeof message !== 'object' || message === null) return
    const response = message as {
      id?: unknown
      ok?: unknown
      result?: unknown
      error?: unknown
    }
    if (typeof response.id !== 'string') return
    const request = this.pending.get(response.id)
    if (!request) return
    this.pending.delete(response.id)
    clearTimeout(request.timer)
    if (request.abortListener) {
      request.signal?.removeEventListener('abort', request.abortListener)
      request.abortListener = undefined
    }
    if (response.ok === true) {
      request.resolve(response.result)
    } else {
      request.reject(
        new Error(
          typeof response.error === 'string'
            ? response.error
            : `Computer Use native helper call failed: ${request.method}`,
        ),
      )
    }
  }

  private failAll(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      if (request.abortListener) {
        request.signal?.removeEventListener('abort', request.abortListener)
      }
      request.reject(error)
    }
    this.pending.clear()
  }
}

let cached: ComputerUseHelper | undefined

export function getComputerUseHelper(): ComputerUseHelper {
  if (cached) return cached
  if (process.platform !== 'darwin') {
    throw new Error('Open Computer Use native helper is available only on macOS')
  }
  const executable = helperPath()
  if (!existsSync(executable)) {
    throw new Error(
      `Computer Use native helper is not built at ${executable}. Run src/utils/computerUse/native/build.sh or set CLAUDE_COMPUTER_USE_HELPER.`,
    )
  }
  const child = spawn(executable, [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
  })
  const client = new NativeHelperClient(child)
  child.once('exit', () => {
    if (cached === client) cached = undefined
  })
  cached = client
  return client
}

export async function closeComputerUseHelper(): Promise<void> {
  const current = cached
  cached = undefined
  await current?.close()
}
