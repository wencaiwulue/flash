import { getBrowserTools } from '../../utils/claudeInChrome/browserTools.js'
import { BASE_CHROME_PROMPT } from '../../utils/claudeInChrome/prompt.js'
import { registerBundledSkill } from '../bundledSkills.js'

const SKILL_ACTIVATION_MESSAGE = `
This skill uses the open Playwright MCP backend in an isolated browser profile. Start by inspecting the current page or opening a new tab, then use the browser's accessibility tree for precise actions.
`

export function registerClaudeInChromeSkill(): void {
  registerBundledSkill({
    name: 'claude-in-chrome',
    description:
      'Automates an isolated Chromium browser with Playwright MCP: navigation, forms, screenshots, console logs, and accessibility-tree inspection.',
    whenToUse:
      'When the user wants to interact with web pages, automate browser tasks, capture screenshots, read console logs, or test a web application.',
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
