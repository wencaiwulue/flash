import type { MCPServerConnection } from '../../services/mcp/types.js'
import type { ConfigScope } from '../../services/mcp/types.js'
import type { LoadedPlugin, PluginError } from '../../types/plugin.js'
import type { PersistablePluginScope } from '../../utils/plugins/pluginIdentifier.js'

type PluginDisplayScope = PersistablePluginScope | 'builtin'

type UnifiedMcpItem = {
  type: 'mcp'
  id: string
  name: string
  description: string | undefined
  scope: ConfigScope | 'managed' | 'builtin'
  status: 'connected' | 'disabled' | 'pending' | 'needs-auth' | 'failed'
  client: MCPServerConnection
  indented?: boolean
}

type UnifiedPluginItem = {
  type: 'plugin'
  id: string
  name: string
  description: string | undefined
  marketplace: string
  scope: PluginDisplayScope
  isEnabled: boolean
  errorCount: number
  errors: PluginError[]
  plugin: LoadedPlugin
  pendingEnable?: boolean
  pendingUpdate?: boolean
  pendingToggle?: 'will-enable' | 'will-disable'
}

type UnifiedFailedPluginItem = {
  type: 'failed-plugin'
  id: string
  name: string
  marketplace: string
  scope: PersistablePluginScope
  errorCount: number
  errors: PluginError[]
}

type UnifiedFlaggedPluginItem = {
  type: 'flagged-plugin'
  id: string
  name: string
  marketplace: string
  scope: 'flagged'
  reason: string
  text: string
  flaggedAt: string
}

export type UnifiedInstalledItem =
  | UnifiedPluginItem
  | UnifiedFailedPluginItem
  | UnifiedFlaggedPluginItem
  | UnifiedMcpItem
