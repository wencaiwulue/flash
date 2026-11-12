import type { MCPServerConnection } from '../services/mcp/types.js'
import type { PermissionMode } from '../types/permissions.js'

/**
 * Open CDP has no private extension prompt notifications, tracked tab IDs, or
 * set_permission_mode RPC. Host MCP permissions are handled by client.ts.
 */
export function usePromptsFromClaudeInChrome(
  mcpClients: MCPServerConnection[],
  toolPermissionMode: PermissionMode,
): void {
  void mcpClients
  void toolPermissionMode
}
