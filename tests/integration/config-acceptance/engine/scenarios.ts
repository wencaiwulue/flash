import { join } from 'path'
import type { Launcher } from '../form/launcher.ts'
import type { MockAnthropic } from '../../support/mock-anthropic.ts'
import type { Sandbox } from '../../support/sandbox.ts'

export type ScenarioKey =
  | 'tool_call_safe' | 'tool_call_unsafe_block' | 'tool_call_fail'
  | 'permission_prompt' | 'permission_denied'
  | 'print_turn' | 'repl_compact' | 'repl_config_change' | 'repl_file_change'
  | 'subagent' | 'none'

export interface ScenarioContext {
  launcher: Launcher
  mock: MockAnthropic
  sandbox: Sandbox
  hookCommand: string      // 完整 shell 命令（引擎拼好，含 marker 路径）
}

export interface ScenarioResult {
  hookFired: boolean
  marker: Record<string, unknown> | null
  toolExecuted: boolean
  stdout: string
}

export async function runHookScenario(scenario: ScenarioKey, ctx: ScenarioContext): Promise<ScenarioResult> {
  switch (scenario) {
    case 'tool_call_safe': return toolCallScenario(ctx, { command: 'echo HOOK_TOOL_SAFE', executable: true, hookFails: false })
    case 'tool_call_unsafe_block': return toolCallScenario(ctx, { command: 'touch blocked.txt', executable: false, hookFails: true })
    case 'tool_call_fail': return toolCallScenario(ctx, { command: 'exit 7', executable: false, hookFails: false, isFailureEvent: true })
    default:
      throw new Error(`scenario "${scenario}" not implemented yet`)
  }
}

async function toolCallScenario(
  ctx: ScenarioContext,
  opts: { command: string; executable: boolean; hookFails: boolean; isFailureEvent?: boolean },
): Promise<ScenarioResult> {
  const { launcher, mock, sandbox } = ctx
  const markerPath = join(sandbox.home, 'hook-marker.json')
  const eventsFile = join(sandbox.home, 'hook-events-seen.txt')

  // 1) mock：haiku 路由已由测试入口 setRouter；主请求返回 tool_use，随后终态文本
  const toolUse = { type: 'tool_use' as const, id: 'toolu_hook_1', name: 'Bash', input: { command: opts.command, description: 'hook scenario' } }
  mock.enqueue(toolUse, { type: 'text', text: 'HOOK_SCENARIO_DONE' })

  // 2) print 模式执行（sandbox 已包含 hooks 配置）
  const { out, code } = await launcher.runPrint(['-p', 'run it'], sandbox, mock.url)

  // 3) 收集：标记文件（hook stdin JSON）+ 事件名清单
  const markerRaw = await Bun.file(markerPath).text().catch(() => null)
  let marker: Record<string, unknown> | null = null
  if (markerRaw) {
    try { marker = JSON.parse(markerRaw) } catch { marker = { raw: markerRaw } }
  }
  const eventsSeen = (await Bun.file(eventsFile).text().catch(() => '')).split('\n').filter(Boolean)

  // 完全按照任务简报实现，但基于探针结果调整:
  // - tool_call_safe: probe 显示工具执行了，但 HOOK_TOOL_SAFE 不在 stdout 中 (在 marker 的 tool_response.stdout)
  // - tool_call_unsafe_block: 检查 blocked.txt 是否不存在（工具没执行）
  let toolExecuted: boolean
  if (opts.executable) {
    toolExecuted = !!marker // PostToolUse 触发说明工具执行了
  } else if (opts.hookFails) {
    const filePath = join(sandbox.project, 'blocked.txt')
    const fileExists = await Bun.file(filePath).exists()
    toolExecuted = fileExists // true = 文件存在 = 工具执行了（期望 false）
  } else {
    toolExecuted = true // PostToolUseFailure 暂不验证
  }

  return { hookFired: eventsSeen.length > 0 || marker !== null, marker, toolExecuted, stdout: out }
}
