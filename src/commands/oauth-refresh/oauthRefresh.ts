import { refreshOAuthToken } from '../../services/oauth/client.js'
import type { OAuthTokens } from '../../services/oauth/types.js'
import type { LocalCommandCall } from '../../types/command.js'
import {
  clearOAuthTokenCache,
  getClaudeAIOAuthTokensAsync,
  saveOAuthTokensIfNeeded,
} from '../../utils/auth.js'
import { errorMessage } from '../../utils/errors.js'

export type OAuthRefreshDependencies = {
  getTokens: () => Promise<OAuthTokens | null>
  refresh: (refreshToken: string) => Promise<OAuthTokens>
  save: (tokens: OAuthTokens) => { success: boolean; warning?: string }
  clearCache: () => void
}

const dependencies: OAuthRefreshDependencies = {
  getTokens: getClaudeAIOAuthTokensAsync,
  refresh: refreshToken => refreshOAuthToken(refreshToken),
  save: saveOAuthTokensIfNeeded,
  clearCache: clearOAuthTokenCache,
}

function formatStatus(tokens: OAuthTokens | null): string {
  if (!tokens) return 'No Claude.ai OAuth token is available.'
  const expiry = tokens.expiresAt && Number.isFinite(tokens.expiresAt)
    ? new Date(tokens.expiresAt).toISOString()
    : 'unknown'
  const scopes = tokens.scopes.length > 0 ? tokens.scopes.join(' ') : 'none'
  return `OAuth token status:\nExpires: ${expiry}\nScopes: ${scopes}`
}

function safeRefreshError(error: unknown, tokens: OAuthTokens): string {
  let message = errorMessage(error)
  for (const secret of [tokens.accessToken, tokens.refreshToken]) {
    if (secret) message = message.replaceAll(secret, '<redacted>')
  }
  return message
}

export async function runOauthRefresh(
  args: string,
  deps: OAuthRefreshDependencies = dependencies,
): Promise<string> {
  const option = args.trim()
  if (option !== '' && option !== '--status') {
    return 'Usage: /oauth-refresh [--status]'
  }

  const tokens = await deps.getTokens()
  if (option === '--status') return formatStatus(tokens)
  if (!tokens?.refreshToken) {
    return 'No refreshable Claude.ai OAuth token is available. Existing credentials were not changed.'
  }

  try {
    const refreshed = await deps.refresh(tokens.refreshToken)
    const saved = deps.save(refreshed)
    if (!saved.success) {
      return `OAuth token refresh succeeded, but the new credentials could not be saved. Existing in-memory credentials were retained.${saved.warning ? ` ${saved.warning}` : ''}`
    }
    deps.clearCache()
    return `OAuth token refreshed and saved.\n${formatStatus(refreshed)}`
  } catch (error) {
    return `OAuth token refresh failed. Existing credentials were not changed: ${safeRefreshError(error, tokens)}`
  }
}

export const call: LocalCommandCall = async args => ({
  type: 'text',
  value: await runOauthRefresh(args),
})
