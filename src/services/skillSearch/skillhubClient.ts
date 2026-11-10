import { createCombinedAbortSignal } from '../../utils/combinedAbortSignal.js'

const REQUEST_TIMEOUT_MS = 10_000
const MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024

export type SkillHubSearchItem = {
  namespace: string
  slug: string
  name: string
  description: string
  version?: string
  shortId?: string
}

export type SkillHubResolveResult = {
  version?: string
  [key: string]: unknown
}

export function getSkillHubRegistryUrl(): string | undefined {
  const value = process.env.CLAUDE_SKILL_REGISTRY_URL?.trim()
  return value ? value.replace(/\/+$/, '') : undefined
}

export class SkillHubClient {
  constructor(
    private readonly options: {
      baseUrl: string
      token?: string
      fetchImpl?: typeof fetch
    },
  ) {}

  private get fetchImpl(): typeof fetch {
    return this.options.fetchImpl ?? fetch
  }

  private async request(
    path: string,
    signal: AbortSignal | undefined,
    json: true,
  ): Promise<unknown>
  private async request(
    path: string,
    signal: AbortSignal | undefined,
    json: false,
  ): Promise<Uint8Array>
  private async request(
    path: string,
    signal: AbortSignal | undefined,
    json: boolean,
  ): Promise<unknown | Uint8Array> {
    const { signal: combined, cleanup } = createCombinedAbortSignal(signal, {
      timeoutMs: REQUEST_TIMEOUT_MS,
    })
    try {
      const response = await this.fetchImpl(`${this.options.baseUrl}${path}`, {
        headers: {
          Accept: json ? 'application/json' : 'application/zip',
          ...(this.options.token
            ? { Authorization: `Bearer ${this.options.token}` }
            : {}),
        },
        signal: combined,
      })
      if (!response.ok) throw new Error(`SkillHub request failed (${response.status})`)
      if (json) {
        const payload = await response.json() as {
          code?: number | null
          msg?: string
          data?: unknown
        }
        if (payload && typeof payload === 'object' && 'code' in payload && 'data' in payload) {
          if (payload.code !== 0 && payload.code !== null && payload.code !== undefined) {
            throw new Error(payload.msg || 'SkillHub returned an error')
          }
          return payload.data
        }
        return payload
      }
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (bytes.byteLength > MAX_DOWNLOAD_BYTES) {
        throw new Error('SkillHub package exceeds the 10 MB download limit')
      }
      return bytes
    } finally {
      cleanup()
    }
  }

  async search(
    keyword: string,
    options: { limit?: number; namespace?: string; signal?: AbortSignal } = {},
  ): Promise<SkillHubSearchItem[]> {
    const limit = Math.max(1, Math.min(options.limit ?? 5, 20))
    const params = new URLSearchParams({
      keyword,
      page: '1',
      size: String(limit),
    })
    if (options.namespace) params.set('namespace', options.namespace)
    const data = await this.request(`/api/v1/skills?${params}`, options.signal, true)
    const records = Array.isArray(data)
      ? data
      : ((data as { items?: unknown[]; skills?: unknown[]; results?: unknown[] })
          .items ??
        (data as { skills?: unknown[] }).skills ??
        (data as { results?: unknown[] }).results ??
        [])
    return records.slice(0, limit).flatMap(raw => {
      const value = raw as Record<string, unknown>
      const slug = typeof value.slug === 'string' ? value.slug : value.name
      if (typeof slug !== 'string' || !slug) return []
      const namespace =
        typeof value.namespace === 'string' && value.namespace
          ? value.namespace
          : 'default'
      const version =
        typeof value.version === 'string'
          ? value.version
          : typeof value.latestVersion === 'string'
            ? value.latestVersion
            : undefined
      return [{
        namespace,
        slug,
        name: typeof value.name === 'string' ? value.name : slug,
        description:
          typeof value.description === 'string' ? value.description : '',
        ...(version ? { version } : {}),
        ...(typeof value.id === 'string' || typeof value.shortId === 'string'
          ? { shortId: String(value.id ?? value.shortId) }
          : {}),
      }]
    })
  }

  async resolve(
    namespace: string,
    slug: string,
    options: { version?: string; signal?: AbortSignal } = {},
  ): Promise<SkillHubResolveResult> {
    const params = new URLSearchParams()
    if (options.version) params.set('version', options.version)
    else params.set('tag', 'latest')
    return (await this.request(
      `/api/v1/skills/${encodeURIComponent(namespace)}/${encodeURIComponent(slug)}/resolve?${params}`,
      options.signal,
      true,
    )) as SkillHubResolveResult
  }

  async download(
    namespace: string,
    slug: string,
    version: string | undefined,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const path = version
      ? `/api/v1/skills/${encodeURIComponent(namespace)}/${encodeURIComponent(slug)}/versions/${encodeURIComponent(version)}/download`
      : `/api/v1/skills/${encodeURIComponent(namespace)}/${encodeURIComponent(slug)}/download`
    return this.request(path, signal, false)
  }
}
