import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { isProactiveActive } from '../../proactive/index.js'
import { getSettings_DEPRECATED } from '../../utils/settings/settings.js'
import { sleep } from '../../utils/sleep.js'
import { DESCRIPTION, SLEEP_TOOL_NAME, SLEEP_TOOL_PROMPT } from './prompt.js'

const inputSchema = z.strictObject({
  duration: z
    .number()
    .nonnegative()
    .optional()
    .describe('Duration to sleep in milliseconds'),
  duration_ms: z
    .number()
    .nonnegative()
    .optional()
    .describe('Deprecated alias for duration'),
})
type InputSchema = typeof inputSchema

const outputSchema = z.object({
  requestedMs: z.number(),
  effectiveMs: z.number(),
  elapsedMs: z.number(),
  interrupted: z.boolean(),
})
type Output = z.infer<typeof outputSchema>

export function resolveSleepDuration(
  requestedMs: number,
  settings: { minSleepDurationMs?: unknown; maxSleepDurationMs?: unknown },
): number {
  const minimum =
    typeof settings.minSleepDurationMs === 'number'
      ? settings.minSleepDurationMs
      : 0
  const maximum =
    typeof settings.maxSleepDurationMs === 'number'
      ? settings.maxSleepDurationMs
      : -1
  const withMinimum = Math.max(requestedMs, minimum)
  return maximum < 0
    ? withMinimum
    : Math.min(withMinimum, Math.max(minimum, maximum))
}

export const SleepTool = buildTool({
  name: SLEEP_TOOL_NAME,
  inputSchema,
  outputSchema,
  maxResultSizeChars: 1_000,
  isEnabled: () => isProactiveActive(),
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  renderToolUseMessage() {
    return null
  },
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return SLEEP_TOOL_PROMPT
  },
  async validateInput({ duration, duration_ms }) {
    if (duration === undefined && duration_ms === undefined) {
      return {
        result: false as const,
        message: 'Missing required parameter: duration',
        errorCode: 1,
      }
    }
    if (duration !== undefined && duration_ms !== undefined) {
      return {
        result: false as const,
        message: 'Provide only one of duration or duration_ms',
        errorCode: 1,
      }
    }
    return { result: true as const }
  },
  async call(input, context) {
    const requestedMs = input.duration ?? input.duration_ms ?? 0
    const effectiveMs = resolveSleepDuration(
      requestedMs,
      getSettings_DEPRECATED(),
    )
    const started = performance.now()
    context.setHasInterruptibleToolInProgress?.(true)
    try {
      await sleep(effectiveMs, context.abortController.signal)
    } finally {
      context.setHasInterruptibleToolInProgress?.(false)
    }
    return {
      data: {
        requestedMs,
        effectiveMs,
        elapsedMs: Math.round(performance.now() - started),
        interrupted: context.abortController.signal.aborted,
      },
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      type: 'tool_result',
      tool_use_id: toolUseID,
      content: output.interrupted
        ? `Sleep interrupted after ${output.elapsedMs}ms`
        : `Slept for ${output.elapsedMs}ms`,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
