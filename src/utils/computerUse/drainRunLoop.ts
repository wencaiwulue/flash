import { logForDebugging } from '../debug.js'
import { withResolvers } from '../withResolvers.js'
import { requireComputerUseSwift } from './swiftLoader.js'

/**
 * Bounded compatibility pump for native executor calls. The open helper has
 * its own main RunLoop; each drain request is independently capped in cycles
 * and time, and this TypeScript pump exists only while an action is pending.
 */

let pump: ReturnType<typeof setInterval> | undefined
let pending = 0

let drainInFlight = false
function drainTick(cu: ReturnType<typeof requireComputerUseSwift>): void {
  if (drainInFlight) return
  drainInFlight = true
  void cu
    ._drainMainRunLoop()
    .catch(() => {
      // The actual action request reports helper failures. A bounded pump
      // failure must not become an unhandled rejection or mask that error.
    })
    .finally(() => {
      drainInFlight = false
    })
}

function retain(cu: ReturnType<typeof requireComputerUseSwift>): void {
  pending++
  if (pump === undefined) {
    pump = setInterval(drainTick, 1, cu)
    logForDebugging('[drainRunLoop] pump started', { level: 'verbose' })
  }
}

function release(): void {
  pending--
  if (pending <= 0 && pump !== undefined) {
    clearInterval(pump)
    pump = undefined
    logForDebugging('[drainRunLoop] pump stopped', { level: 'verbose' })
    pending = 0
  }
}

const TIMEOUT_MS = 30_000

function timeoutReject(reject: (e: Error) => void): void {
  reject(new Error(`computer-use native call exceeded ${TIMEOUT_MS}ms`))
}

/**
 * Await `fn()` with the shared drain pump running. Safe to nest — multiple
 * concurrent drainRunLoop() calls share one setInterval.
 */
export async function drainRunLoop<T>(
  fn: () => Promise<T>,
  cu: ReturnType<typeof requireComputerUseSwift> = requireComputerUseSwift(),
): Promise<T> {
  retain(cu)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    // If the timeout wins the race, fn()'s promise is orphaned — a late
    // rejection from the native layer would become an unhandledRejection.
    // Attaching a no-op catch swallows it; the timeout error is what surfaces.
    // fn() sits inside try so a synchronous throw (e.g. NAPI argument
    // validation) still reaches release() — otherwise the pump leaks.
    const work = fn()
    work.catch(() => {})
    const timeout = withResolvers<never>()
    timer = setTimeout(timeoutReject, TIMEOUT_MS, timeout.reject)
    return await Promise.race([work, timeout.promise])
  } finally {
    clearTimeout(timer)
    release()
  }
}
