import { getBrowserTools } from '../../utils/claudeInChrome/browserTools.js'
import { BASE_CHROME_PROMPT } from '../../utils/claudeInChrome/prompt.js'
import { registerBundledSkill } from '../bundledSkills.js'

const SKILL_ACTIVATION_MESSAGE = `
This skill controls real Chrome over public loopback CDP with isolated:false and a dedicated persistent profile. It is not compatible with private extension pairing. Start with browser_tabs(list), then browser_snapshot on the current page. Reuse relevant existing tabs and preserve their cookies/login state; create a tab only when the task requires it. Disconnecting must not close Chrome or its default context.
`

export function registerClaudeInChromeSkill(): void {
  registerBundledSkill({
    name: 'claude-in-chrome',
    description:
      'Automates a dedicated real Chrome profile over public loopback CDP with Playwright MCP: existing tabs, cookies, navigation, forms, screenshots, console logs, and accessibility-tree inspection.',
    whenToUse:
      'When the user explicitly wants the dedicated real-Chrome CDP session, its existing tabs, cookies, or authenticated state. Use WebBrowser instead for isolated local development.',
    allowedTools: [],
    userInvocable: true,
    isEnabled: () => true,
    async getPromptForCommand(args) {
      const tools = await getBrowserTools()
      const toolList = tools.map(tool => `mcp__claude-in-chrome__${tool.name}`).join(', ')
      let prompt = `${BASE_CHROME_PROMPT}\n${SKILL_ACTIVATION_MESSAGE}\nAvailable tools: ${toolList}`
      if (args) prompt += `\n## Task\n\n${args}`
      return [{ type: 'text', text: prompt }]
    },
  })
}
