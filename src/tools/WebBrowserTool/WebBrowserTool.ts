import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { closeOpenBrowserClient, getOpenBrowserClient, listBrowserTools } from '@ant/claude-for-chrome-mcp'
import { jsonStringify } from '../../utils/slowOperations.js'

const inputSchema = z.strictObject({
  action: z.string().min(1).describe('Playwright MCP tool name'),
  arguments: z.record(z.string(), z.unknown()).default({}),
})
type InputSchema = typeof inputSchema
const outputSchema = z.object({
  content: z.unknown(),
  isError: z.boolean().optional(),
})
type Output = z.infer<typeof outputSchema>

export const WebBrowserTool = buildTool({
  name: 'WebBrowser',
  inputSchema,
  outputSchema,
  maxResultSizeChars: 200_000,
  isEnabled: () => true,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  async description() {
    return 'Control an isolated Chromium browser with Playwright MCP'
  },
  async prompt() {
    const tools = await listBrowserTools()
    return `Control a real isolated Chromium browser. Available actions: ${tools.map(tool => tool.name).join(', ')}. Pass action and arguments matching the selected Playwright MCP schema. Do not claim navigation, clicks, screenshots, or console output unless the tool returns them.`
  },
  async checkPermissions(input) {
    return { behavior: 'allow', updatedInput: input }
  },
  renderToolUseMessage() {
    return null
  },
  async call({ action, arguments: args }) {
    const client = await getOpenBrowserClient()
    let result: Awaited<ReturnType<typeof client.callTool>>
    try {
      result = await client.callTool({ name: action, arguments: args })
    } catch (error) {
      if (action === 'browser_close') {
        try {
          await closeOpenBrowserClient(client)
        } catch (closeError) {
          throw new AggregateError(
            [error, closeError],
            'Browser action and cleanup both failed',
          )
        }
      }
      throw error
    }
    if (action === 'browser_close') await closeOpenBrowserClient(client)
    return {
      data: {
        content: result.content,
        ...(result.isError === true
          ? { isError: true }
          : result.isError === false
            ? { isError: false }
            : {}),
      },
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      type: 'tool_result',
      tool_use_id: toolUseID,
      content: jsonStringify(output.content),
    }
  },
} satisfies ToolDef<InputSchema, Output>)
