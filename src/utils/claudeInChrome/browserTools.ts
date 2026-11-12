import type { BrowserToolDescriptor } from '@ant/claude-for-chrome-mcp'
import { createChromeContext } from './mcpServer.js'

let catalog: Promise<BrowserToolDescriptor[]> | undefined

export function getBrowserTools(): Promise<BrowserToolDescriptor[]> {
  catalog ??= import('@ant/claude-for-chrome-mcp')
    .then(module => module.listOpenChromeTools(createChromeContext()))
    .catch(error => {
      catalog = undefined
      throw error
    })
  return catalog
}

export async function isClaudeInChromeMcpAvailable(): Promise<boolean> {
  return (await getBrowserTools()).length > 0
}

export async function assertClaudeInChromeMcpAvailable(): Promise<void> {
  if (!(await isClaudeInChromeMcpAvailable())) {
    throw new Error('Playwright MCP returned no real Chrome CDP tools')
  }
}
