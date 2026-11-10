export type RemoteSkillLoadedEvent = {
  slug: string
  cacheHit: boolean
  latencyMs: number
  urlScheme: 'gs' | 'http' | 'https' | 's3'
  fileCount?: number
  totalBytes?: number
  fetchMethod?: string
  error?: string
}

export function logRemoteSkillLoaded(_event: RemoteSkillLoadedEvent): void {
  // Remote skill search is disabled; do not emit misleading success telemetry.
}
