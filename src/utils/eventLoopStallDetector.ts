export type EventLoopStallDetectorStatus = { enabled: false }

export function startEventLoopStallDetector(): EventLoopStallDetectorStatus {
  return { enabled: false }
}
