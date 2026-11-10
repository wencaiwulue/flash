import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'

export const OVERFLOW_TEST_TOOL_NAME = 'OverflowTest'

const inputSchema = z.strictObject({
  size: z
    .number()
    .int()
    .min(1)
    .max(2_000_000)
    .default(100_000)
    .describe('Number of characters to return (1–2,000,000)'),
})
type InputSchema = typeof inputSchema

const outputSchema = z.object({
  content: z.string(),
  size: z.number(),
})
type Output = z.infer<typeof outputSchema>

export function makeOverflowOutput(size: number): string {
  const pattern = '0123456789abcdef'
  return pattern.repeat(Math.ceil(size / pattern.length)).slice(0, size)
}

export const OverflowTestTool = buildTool({
  name: OVERFLOW_TEST_TOOL_NAME,
  inputSchema,
  outputSchema,
  maxResultSizeChars: 2_000_100,
  isEnabled: () => true,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  renderToolUseMessage() {
    return null
  },
  async description() {
    return 'Generate a deterministic large result for overflow-handling tests'
  },
  async prompt() {
    return 'Debugging tool: return exactly size characters to exercise large tool-result truncation, persistence, and rendering. Do not use for ordinary file or command output.'
  },
  async call({ size }) {
    return { data: { content: makeOverflowOutput(size), size } }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      type: 'tool_result',
      tool_use_id: toolUseID,
      content: output.content,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
