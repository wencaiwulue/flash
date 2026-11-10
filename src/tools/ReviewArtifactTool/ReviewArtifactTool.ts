import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'

const inputSchema = z.record(z.string(), z.unknown())
const outputSchema = z.object({ message: z.string() })
type InputSchema = typeof inputSchema
type Output = z.infer<typeof outputSchema>

export const ReviewArtifactTool = buildTool({
  name: 'ReviewArtifact',
  maxResultSizeChars: 1_000,
  inputSchema,
  outputSchema,
  isEnabled: () => false,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  async description() {
    return 'Review artifacts are unavailable in this build.'
  },
  async prompt() {
    return 'Review artifacts are unavailable in this build.'
  },
  renderToolUseMessage() {
    return null
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseID: string) {
    return { type: 'tool_result', tool_use_id: toolUseID, content: output.message }
  },
  async call(): Promise<never> {
    throw new Error('ReviewArtifact is unavailable in this build')
  },
} satisfies ToolDef<InputSchema, Output>)
