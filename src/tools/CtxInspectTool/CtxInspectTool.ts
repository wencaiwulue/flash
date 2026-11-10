import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { getStats } from '../../services/contextCollapse/index.js'
import type { ContextData } from '../../utils/analyzeContext.js'
import { jsonStringify } from '../../utils/slowOperations.js'

const inputSchema = z.strictObject({})
type InputSchema = typeof inputSchema
const outputSchema = z.object({ report: z.string() })
type Output = z.infer<typeof outputSchema>

export function formatContextInspection(data: ContextData): string {
  return jsonStringify({
    model: data.model,
    totalTokens: data.totalTokens,
    maxTokens: data.maxTokens,
    rawMaxTokens: data.rawMaxTokens,
    percentage: data.percentage,
    categories: data.categories.map(category => ({
      name: category.name,
      tokens: category.tokens,
      deferred: category.isDeferred === true,
    })),
    messageBreakdown: data.messageBreakdown,
    apiUsage: data.apiUsage,
    contextCollapse: getStats(),
  })
}

export const CtxInspectTool = buildTool({
  name: 'CtxInspect',
  inputSchema,
  outputSchema,
  maxResultSizeChars: 100_000,
  isEnabled: () => true,
  isReadOnly: () => true,
  isConcurrencySafe: () => false,
  renderToolUseMessage() {
    return null
  },
  async description() {
    return 'Inspect the effective model context and context-collapse state'
  },
  async prompt() {
    return 'Return a JSON report of the effective context sent to the model, token categories, message breakdown, API usage, and context-collapse statistics. Use for debugging context growth and compaction behavior.'
  },
  async call(_input, context) {
    const { collectContextData } = await import(
      '../../commands/context/context-noninteractive.js'
    )
    const data = await collectContextData(context)
    return { data: { report: formatContextInspection(data) } }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      type: 'tool_result',
      tool_use_id: toolUseID,
      content: output.report,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
