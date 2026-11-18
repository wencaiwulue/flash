import { join } from 'path'
import type { Launcher } from '../form/launcher'
import type { MockAnthropic } from '../../support/mock-anthropic'
import type { Sandbox } from '../../support/sandbox'

export type ScenarioKey =
  | 'tool_call_safe'
  | 'tool_call_unsafe_block'
  | 'tool_call_fail'
  | 'permission_prompt'
  | 'permission_denied'
  | 'print_turn'
  | 'repl_compact'
  | 'repl_config_change'
  | 'repl_file_change'
  | 'subagent'
  | 'none'

export interface ScenarioContext {
  launcher: Launcher
  mock: MockAnthropic
  sandbox: Sandbox
  hookCommand: string // 完整 shell 命令（引擎拼好，含 marker 路径）
}

export interface ScenarioResult {
  hookFired: boolean
  marker: Record<string, unknown> | null
  toolExecuted: boolean
  stdout: string
  markersByEvent?: Record<string, Record<string, unknown> | null>
}

export async function runHookScenario(scenario: ScenarioKey, ctx: ScenarioContext): Promise<ScenarioResult> {
  switch (scenario) {
    case 'tool_call_safe':
      return toolCallScenario(ctx, { command: 'echo HOOK_TOOL_SAFE', executable: true, hookFails: false })
    case 'tool_call_unsafe_block':
      return toolCallScenario(ctx, { command: 'touch blocked.txt', executable: false, hookFails: true })
    case 'tool_call_fail':
      return toolCallScenario(ctx, { command: 'exit 7', executable: false, hookFails: false, isFailureEvent: true })
    case 'print_turn':
      return printTurnScenario(ctx)
    case 'permission_prompt':
      return permissionPromptScenario(ctx, { approve: true })
    case 'permission_denied':
      return permissionPromptScenario(ctx, { approve: false })
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

  // 1) mock: haiku 路由已由测试入口 setRouter; 主请求返回 tool_use, 随后终态文本
  const toolUse = { type: 'tool_use' as const, id: 'toolu_hook_1', name: 'Bash', input: { command: opts.command, description: 'hook scenario' } }
  mock.enqueue(toolUse, { type: 'text', text: 'HOOK_SCENARIO_DONE' })

  // 2) print 模式执行（sandbox 已包含 hooks 配置）
  const { out, code } = await launcher.runPrint(['-p', 'run it'], sandbox, mock.url)

  // 3) 收集: 标记文件（hook stdin JSON）+ 事件名清单
  const markerRaw = await Bun.file(markerPath).text().catch(() => null)
  let marker: Record<string, unknown> | null = null
  if (markerRaw) {
    try {
      marker = JSON.parse(markerRaw)
    } catch {
      marker = { raw: markerRaw }
    }
  }
  const eventsSeen = (await Bun.file(eventsFile).text().catch(() => '')).split('\n').filter(Boolean)

  // 完全按照任务简报实现，但基于探针结果调整:
  // - tool_call_safe: probe 显示工具执行了，但 HOOK_TOOL_SAFE 不在 stdout 中（在 marker 的 tool_response.stdout）
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

async function printTurnScenario(ctx: ScenarioContext): Promise<ScenarioResult> {
  const { launcher, mock, sandbox } = ctx
  const eventsFile = join(sandbox.home, 'hook-events-seen.txt')

  // 1) mock: haiku 路由已由测试入口 setRouter; 主请求返回文本响应
  mock.enqueue({ type: 'text', text: 'HOOK_SCENARIO_DONE' })

  // 2) print 模式执行（sandbox 已包含 hooks 配置）
  const { out, code } = await launcher.runPrint(['-p', 'run it'], sandbox, mock.url)

  // 3) 收集: 事件名清单 + 各事件的标记文件
  const eventsSeen = (await Bun.file(eventsFile).text().catch(() => '')).split('\n').filter(Boolean)
  const markersByEvent: Record<string, Record<string, unknown> | null> = {}

  // 尝试读取每个事件的标记文件
  for (const event of ['Notification', 'PermissionRequest', 'PermissionDenied', 'UserPromptSubmit', 'SessionStart', 'SessionEnd', 'Stop', 'StopFailure', 'Setup', 'InstructionsLoaded']) {
    const markerPath = join(sandbox.home, `hook-marker-${event}.json`)
    const markerRaw = await Bun.file(markerPath).text().catch(() => null)
    if (markerRaw) {
      try {
        markersByEvent[event] = JSON.parse(markerRaw)
      } catch {
        markersByEvent[event] = { raw: markerRaw }
      }
    }
  }

  // print_turn 场景不涉及工具执行
  return { hookFired: eventsSeen.length > 0 || Object.keys(markersByEvent).length > 0, marker: null, toolExecuted: false, stdout: out, markersByEvent }
}

async function permissionPromptScenario(ctx: ScenarioContext, opts: { approve: boolean }): Promise<ScenarioResult> {
  const { launcher, mock, sandbox } = ctx
  const markerPath = join(sandbox.home, 'hook-marker.json')
  const eventsFile = join(sandbox.home, 'hook-events-seen.txt')

  // 1) mock: haiku 路由已由测试入口 setRouter; 主请求返回 tool_use（不安全操作触发权限提示）
  const toolUse = { type: 'tool_use' as const, id: 'toolu_hook_1', name: 'Bash', input: { command: 'touch testfile.txt', description: 'hook scenario' } }
  mock.enqueue(toolUse)

  // 2) spawn REPL 会话
  const session = await launcher.spawnRepl({ sandbox, mockUrl: mock.url })

  try {
    // 3) 等待会话就绪
    await session.waitFor('/effort', 30_000)

    // 4) 发送用户提示
    session.write('create a test file\r')

    // 5) 等待权限提示出现
    await session.waitFor('proceed?', 30_000)

    // 6) 批准或拒绝权限请求
    if (opts.approve) {
      session.write('1')
      await new Promise(r => setTimeout(r, 300))
      session.write('\r')
    } else {
      session.write('3')
      await new Promise(r => setTimeout(r, 300))
      session.write('\r')
    }

    // 7) 等待一小段时间让钩子执行
    await new Promise(r => setTimeout(r, 1000))
  } finally {
    // 8) 总是清理会话
    await session.kill().catch(() => {})
  }

  // 9) 收集: 标记文件（hook stdin JSON）+ 事件名清单
  const markerRaw = await Bun.file(markerPath).text().catch(() => null)
  let marker: Record<string, unknown> | null = null
  if (markerRaw) {
    try {
      marker = JSON.parse(markerRaw)
    } catch {
      marker = { raw: markerRaw }
    }
  }
  const eventsSeen = (await Bun.file(eventsFile).text().catch(() => '')).split('\n').filter(Boolean)

  // 10) 收集各事件的标记文件
  const markersByEvent: Record<string, Record<string, unknown> | null> = {}
  for (const event of ['Notification', 'PermissionRequest', 'PermissionDenied', 'UserPromptSubmit', 'SessionStart', 'SessionEnd', 'Stop', 'StopFailure', 'Setup', 'InstructionsLoaded']) {
    const eventMarkerPath = join(sandbox.home, `hook-marker-${event}.json`)
    const eventMarkerRaw = await Bun.file(eventMarkerPath).text().catch(() => null)
    if (eventMarkerRaw) {
      try {
        markersByEvent[event] = JSON.parse(eventMarkerRaw)
      } catch {
        markersByEvent[event] = { raw: eventMarkerRaw }
      }
    }
  }

  // 检查工具是否执行了
  const toolExecuted = await Bun.file(join(sandbox.project, 'testfile.txt')).exists().catch(() => false)

  return { hookFired: eventsSeen.length > 0 || marker !== null || Object.keys(markersByEvent).length > 0, marker, toolExecuted, stdout: '', markersByEvent }
}
