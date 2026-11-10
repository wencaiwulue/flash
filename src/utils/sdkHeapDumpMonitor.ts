export type SdkMemoryMonitorStatus = { enabled: false }

export function startSdkMemoryMonitor(): SdkMemoryMonitorStatus {
  return { enabled: false }
}
