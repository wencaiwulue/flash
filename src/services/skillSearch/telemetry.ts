import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'

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

const URL_SCHEME_IDS = { gs: 0, http: 1, https: 2, s3: 3 } as const

export function logRemoteSkillLoaded(event: RemoteSkillLoadedEvent): void {
  logEvent('tengu_remote_skill_loaded', {
    slug: event.slug as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    cache_hit: event.cacheHit,
    latency_ms: event.latencyMs,
    url_scheme: URL_SCHEME_IDS[event.urlScheme],
    ...(event.fileCount !== undefined ? { file_count: event.fileCount } : {}),
    ...(event.totalBytes !== undefined ? { total_bytes: event.totalBytes } : {}),
    ...(event.fetchMethod
      ? {
          fetch_method:
            event.fetchMethod as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }
      : {}),
    ...(event.error
      ? {
          error:
            event.error as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }
      : {}),
  })
}
