import type { MCPServerConnection } from '../services/mcp/types.js'
import type { Command } from '../types/command.js'
import { memoizeWithLRU } from '../utils/memoize.js'

export const fetchMcpSkillsForClient = memoizeWithLRU(
  async (_client: MCPServerConnection): Promise<Command[]> => [],
  (client: MCPServerConnection) => client.name,
)
