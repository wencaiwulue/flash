export type BrowserToolDescriptor = {
  name: string
}

type ClaudeForChromeModule = {
  BROWSER_TOOLS?: BrowserToolDescriptor[]
}

function loadBrowserTools(): BrowserToolDescriptor[] {
  try {
    const module = require('@ant/claude-for-chrome-mcp') as ClaudeForChromeModule
    return Array.isArray(module.BROWSER_TOOLS) ? module.BROWSER_TOOLS : []
  } catch {
    return []
  }
}

export const BROWSER_TOOLS = loadBrowserTools()

export function isClaudeInChromeMcpAvailable(): boolean {
  return BROWSER_TOOLS.length > 0
}

export function assertClaudeInChromeMcpAvailable(): void {
  if (!isClaudeInChromeMcpAvailable()) {
    throw new Error(
      'Claude in Chrome is unavailable: @ant/claude-for-chrome-mcp is not included in this build',
    )
  }
}
