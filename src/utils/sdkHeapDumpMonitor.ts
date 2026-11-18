/**
 * SDK Memory Heap Dump Monitor
 *
 * This module is intentionally stubbed in the flash repository.
 *
 * Why stubbed:
 * 1. Heap dump capture is an internal Ant development/debug feature
 * 2. It requires specialized internal tooling and infrastructure
 * 3. Only conditionally loaded in main.tsx when process.env.USER_TYPE === 'ant'
 *
 * The stub maintains API compatibility while clearly indicating the
 * feature is not enabled in this repository.
 */

export type SdkMemoryMonitorStatus = { enabled: false }

/**
 * Start the SDK memory heap dump monitor.
 *
 * @returns A status indicating the monitor is not enabled in this build.
 */
export function startSdkMemoryMonitor(): SdkMemoryMonitorStatus {
  return { enabled: false }
}
