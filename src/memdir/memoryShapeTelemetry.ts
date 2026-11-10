import type { MemoryScope } from '../utils/memoryFileDetection.js'
import type { MemoryHeader } from './memoryScan.js'

export function logMemoryWriteShape(
  _toolName: string,
  _toolInput: unknown,
  _filePath: string,
  _scope: MemoryScope,
): void {
  // Memory-shape telemetry is disabled in this build.
}

export function logMemoryRecallShape(
  _candidates: MemoryHeader[],
  _selected: MemoryHeader[],
): void {
  // Memory-shape telemetry is disabled in this build.
}
