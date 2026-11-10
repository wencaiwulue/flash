import type { OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthTokens } from '../../services/oauth/types.js'

export type McpOAuthTokenData = {
  serverName: string
  serverUrl: string
  accessToken: string
  refreshToken?: string
  expiresAt: number
  scope?: string
  clientId?: string
  clientSecret?: string
  stepUpScope?: string
  discoveryState?: OAuthDiscoveryState
}

export type McpOAuthClientConfig = {
  clientSecret?: string
}

export type McpXaaIdpData = {
  idToken: string
  expiresAt: number
}

export type McpXaaIdpConfig = {
  clientSecret: string
}

export type SecureStorageData = {
  claudeAiOauth?: OAuthTokens
  trustedDeviceToken?: string
  pluginSecrets?: Record<string, Record<string, string>>
  mcpOAuth?: Record<string, McpOAuthTokenData>
  mcpOAuthClientConfig?: Record<string, McpOAuthClientConfig>
  mcpXaaIdp?: Record<string, McpXaaIdpData>
  mcpXaaIdpConfig?: Record<string, McpXaaIdpConfig>
}

export type SecureStorageUpdateResult = {
  success: boolean
  warning?: string
}

export type SecureStorage = {
  name: string
  read: () => SecureStorageData | null
  readAsync: () => Promise<SecureStorageData | null>
  update: (data: SecureStorageData) => SecureStorageUpdateResult
  delete: () => boolean
}
