import axios from 'axios'
import { getOauthConfig } from '../constants/oauth.js'
import { getOAuthHeaders, prepareApiRequest } from '../utils/teleport/api.js'

export type AssistantSession = {
  id: string
  title?: string
  machineName?: string
  cwd?: string
  branch?: string
  lastActiveAt?: number
}

export async function discoverAssistantSessions(): Promise<AssistantSession[]> {
  const { accessToken, orgUUID } = await prepareApiRequest()
  const response = await axios.get(`${getOauthConfig().BASE_API_URL}/v1/sessions`, {
    headers: {
      ...getOAuthHeaders(accessToken),
      'anthropic-beta': 'ccr-byoc-2025-07-29',
      'x-organization-uuid': orgUUID,
    },
    params: { limit: 50 },
    timeout: 15_000,
  })
  const records = Array.isArray(response.data?.data)
    ? response.data.data
    : Array.isArray(response.data)
      ? response.data
      : []
  return records
    .flatMap((record: Record<string, unknown>) => {
      const id = record.id ?? record.sessionId ?? record.session_id
      if (typeof id !== 'string' || !id) return []
      const timestamp = record.lastActiveAt ?? record.last_active_at ?? record.updated_at
      const lastActiveAt =
        typeof timestamp === 'number'
          ? timestamp
          : typeof timestamp === 'string'
            ? Date.parse(timestamp)
            : undefined
      return [{
        id,
        title: typeof record.title === 'string' ? record.title : undefined,
        machineName:
          typeof record.machineName === 'string'
            ? record.machineName
            : typeof record.machine_name === 'string'
              ? record.machine_name
              : undefined,
        cwd: typeof record.cwd === 'string' ? record.cwd : undefined,
        branch: typeof record.branch === 'string' ? record.branch : undefined,
        ...(lastActiveAt !== undefined && Number.isFinite(lastActiveAt)
          ? { lastActiveAt }
          : {}),
      }]
    })
    .sort((a: AssistantSession, b: AssistantSession) =>
      (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0),
    )
}
