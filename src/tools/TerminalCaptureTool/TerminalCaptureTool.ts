import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { getTerminalPanel } from '../../utils/terminalPanel.js'
import { TERMINAL_CAPTURE_TOOL_NAME } from './prompt.js'

const inputSchema = z.strictObject({
  lines: z
    .number()
    .int()
    .min(1)
    .max(10_000)
    .default(200)
    .describe('Number of scrollback lines to capture, starting from the latest'),
})
type InputSchema = typeof inputSchema

const outputSchema = z.object({
  content: z.string(),
  lines: z.number(),
})
type Output = z.infer<typeof outputSchema>

export const TerminalCaptureTool = buildTool({
  name: TERMINAL_CAPTURE_TOOL_NAME,
  inputSchema,
  outputSchema,
  maxResultSizeChars: 500_000,
  isEnabled: () => true,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  renderToolUseMessage() {
    return null
  },
  async description() {
    return 'Read output from the built-in terminal panel'
  },
  async prompt() {
    return 'Capture the existing built-in terminal panel, including scrollback. This does not create or attach to a terminal. Open the panel with Meta+J first. Use lines to bound the capture.'
  },
  async call({ lines }) {
    const content = getTerminalPanel().capture(lines)
    return {
      data: {
        content,
        lines: content === '' ? 0 : content.replace(/\n$/, '').split('\n').length,
      },
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      type: 'tool_result',
      tool_use_id: toolUseID,
      content: output.content || 'Terminal panel is empty.',
    }
  },
} satisfies ToolDef<InputSchema, Output>)
