import { describe, expect, mock, test } from 'bun:test'
import type { spawnSync } from 'child_process'
import type { ToolUseContext } from '../src/Tool.ts'
import { formatContextInspection } from '../src/tools/CtxInspectTool/CtxInspectTool.ts'
import { createMonitorOutputReporter } from '../src/tools/MonitorTool/MonitorTool.ts'
import { makeOverflowOutput, OverflowTestTool } from '../src/tools/OverflowTestTool/OverflowTestTool.ts'
import { resolveSleepDuration, SleepTool } from '../src/tools/SleepTool/SleepTool.ts'
import type { ContextData } from '../src/utils/analyzeContext.ts'
import { TerminalPanel } from '../src/utils/terminalPanel.ts'

describe('SleepTool', () => {
  test('applies minimum, maximum, and unlimited settings', () => {
    expect(resolveSleepDuration(10, { minSleepDurationMs: 50 })).toBe(50)
    expect(
      resolveSleepDuration(100, {
        minSleepDurationMs: 20,
        maxSleepDurationMs: 60,
      }),
    ).toBe(60)
    expect(resolveSleepDuration(100_000, { maxSleepDurationMs: -1 })).toBe(100_000)
  })

  test('validates duration aliases and returns promptly on abort', async () => {
    const context = { abortController: new AbortController() } as ToolUseContext
    expect((await SleepTool.validateInput({}, context)).result).toBe(false)
    expect(
      (await SleepTool.validateInput({ duration: 1, duration_ms: 1 }, context))
        .result,
    ).toBe(false)

    context.abortController.abort()
    const result = await SleepTool.call({ duration: 60_000 }, context)
    expect(result.data.interrupted).toBe(true)
    expect(result.data.elapsedMs).toBeLessThan(100)
  })
})

describe('OverflowTestTool', () => {
  test('returns the exact requested deterministic output', async () => {
    expect(makeOverflowOutput(17)).toBe('0123456789abcdef0')
    const result = await OverflowTestTool.call(
      { size: 100_000 },
      {} as ToolUseContext,
    )
    expect(result.data.size).toBe(100_000)
    expect(result.data.content).toHaveLength(100_000)
    expect(result.data.content.slice(32, 48)).toBe('0123456789abcdef')
  })
})

describe('MonitorTool output reporting', () => {
  test('joins chunks into complete lines and flushes the final partial line', () => {
    const lines: string[] = []
    const report = createMonitorOutputReporter(line => lines.push(line))
    report.push('one\ntw')
    report.push('o\nthree')
    report.finish()
    report.finish()
    expect(lines).toEqual(['one', 'two', 'three'])
  })

  test('does not drop bursts or carriage-return line endings', () => {
    const lines: string[] = []
    const report = createMonitorOutputReporter(line => lines.push(line))
    const expected = Array.from({ length: 150 }, (_, i) => `line-${i + 1}`)
    report.push(`${expected.join('\r\n')}\r\n`)
    report.finish()
    expect(lines).toEqual(expected)
  })
})

describe('CtxInspectTool', () => {
  test('formats a JSON report without the visualization grid', () => {
    const data = {
      model: 'test-model',
      totalTokens: 120,
      maxTokens: 1_000,
      rawMaxTokens: 1_200,
      percentage: 12,
      categories: [
        { name: 'Messages', tokens: 100, color: 'purple_FOR_SUBAGENTS_ONLY' },
        { name: 'Deferred', tokens: 20, color: 'inactive', isDeferred: true },
      ],
      messageBreakdown: {
        toolCallTokens: 10,
        toolResultTokens: 20,
        attachmentTokens: 30,
        assistantMessageTokens: 25,
        userMessageTokens: 15,
        toolCallsByType: [],
        attachmentsByType: [],
      },
      apiUsage: null,
    } as ContextData
    const report = JSON.parse(formatContextInspection(data))
    expect(report.model).toBe('test-model')
    expect(report.categories).toEqual([
      { name: 'Messages', tokens: 100, deferred: false },
      { name: 'Deferred', tokens: 20, deferred: true },
    ])
    expect(report.contextCollapse.collapsedSpans).toBe(0)
    expect(report.gridRows).toBeUndefined()
  })
})

describe('TerminalCaptureTool', () => {
  test('captures an existing pane without creating or attaching a session', () => {
    const calls: string[][] = []
    const runner = mock((command: string, args: string[]) => {
      calls.push(args)
      if (args.includes('capture-pane')) {
        return { status: 0, stdout: 'first\nsecond\n', stderr: '' }
      }
      return { status: 0, stdout: '', stderr: '' }
    }) as unknown as typeof spawnSync
    const panel = new TerminalPanel(runner)

    expect(panel.capture(25)).toBe('first\nsecond\n')
    expect(calls.some(args => args.includes('new-session'))).toBe(false)
    expect(calls.some(args => args.includes('attach-session'))).toBe(false)
    const capture = calls.find(args => args.includes('capture-pane'))!
    expect(capture).toContain('-25')
    expect(capture).toContain('-p')
  })

  test('fails instead of inventing output when the panel is absent', () => {
    const runner = mock((command: string, args: string[]) => ({
      status: args.includes('has-session') ? 1 : 0,
      stdout: '',
      stderr: '',
    })) as unknown as typeof spawnSync
    expect(() => new TerminalPanel(runner).capture(10)).toThrow(
      'Terminal panel is not running',
    )
  })
})
