import { describe, test, expect, afterAll } from 'bun:test'
import { join } from 'path'
import { writeFile } from 'node:fs/promises'
import { loadHookEntries, isBlocked, type HookEntry } from './engine/entries'
import { runHookScenario } from './engine/scenarios'
import { createFormLauncher, skipLine, type Launcher } from './form/launcher'
import { createMockAnthropic, MOCK_API_KEY, type MockAnthropic } from '../support/mock-anthropic'
import { createSandbox, type Sandbox } from '../support/sandbox'

const FORM = (process.env.FLASH_IT_FORM ?? 'dist') as 'dist' | 'source'
const hooksYaml = join(import.meta.dir, 'fixtures', 'hooks.yaml')

const toClose: Array<{ sandbox?: Sandbox; mock?: MockAnthropic }> = []
afterAll(async () => {
  for (const item of toClose) {
    await item.sandbox?.cleanup()
    await item.mock?.stop()
  }
})

function routeHaikuAux(mock: MockAnthropic): void {
  mock.setRouter(request => {
    const model = (request.body as Record<string, unknown> | null)?.model
    return typeof model === 'string' && model.includes('haiku')
      ? { type: 'text', text: 'HAIKU_AUX_OK' }
      : null
  })
}

// 每条目独立沙箱; hook 命令写 stdin JSON 到 marker 并把事件名追加到 events-seen
function hookSettingsFor(event: string, sandboxHome: string, exit2: boolean): Record<string, unknown> {
  const markerPath = join(sandboxHome, `hook-marker-${event}.json`)
  const eventsFile = join(sandboxHome, 'hook-events-seen.txt')
  // 对于新事件，使用单独的标记文件；对于旧事件，保持向后兼容
  const legacyMarkerPath = join(sandboxHome, 'hook-marker.json')
  const body = `cat > '${markerPath}'; echo '${event}' >> '${eventsFile}'; ln -sf '${markerPath}' '${legacyMarkerPath}' 2>/dev/null || true`
  const cmd = exit2 ? `${body}; exit 2` : body
  return {
    hooks: {
      [event]: [{ matcher: '*', hooks: [{ type: 'command', command: cmd }] }],
    },
  }
}

async function runEntry(entry: HookEntry): Promise<void> {
  const launcher = createFormLauncher(FORM)
  const mock = await createMockAnthropic()

  // 按要求实现：先创建沙箱（此时有 home 路径），然后立即配置 hook（在运行前完成）
  const sandbox = await createSandbox()
  const settings = hookSettingsFor(entry.event, sandbox.home, entry.exit_semantics === 'block')
  await writeFile(join(sandbox.home, '.claude', 'settings.json'), JSON.stringify(settings))

  toClose.push({ sandbox, mock })
  routeHaikuAux(mock)

  const result = await runHookScenario(entry.trigger as never, { launcher, mock, sandbox, hookCommand: '' })

  // 查找对应的标记（优先使用 markersByEvent，回退到单个 marker）
  const eventMarker = result.markersByEvent?.[entry.event] ?? result.marker

  for (const [key, expected] of Object.entries(entry.expected_effect)) {
    if (key === 'hook_fired') {
      expect(result.hookFired, `${entry.id} hook_fired`).toBe(expected)
    } else if (key === 'tool_executed') {
      expect(result.toolExecuted, `${entry.id} tool_executed`).toBe(expected)
    } else if (key === 'marker_has_tool_name') {
      expect((eventMarker as Record<string, unknown> | null)?.tool_name, `${entry.id} marker.tool_name`).toBe('Bash')
    } else if (key === 'marker_has_error') {
      expect(JSON.stringify(eventMarker), `${entry.id} marker error`).toMatch(/error|is_error/i)
    } else if (key === 'marker_has_message') {
      expect((eventMarker as Record<string, unknown> | null)?.message, `${entry.id} marker.message`).toBeDefined()
    } else if (key === 'marker_has_prompt') {
      expect((eventMarker as Record<string, unknown> | null)?.prompt, `${entry.id} marker.prompt`).toBeDefined()
    } else if (key === 'marker_has_source') {
      expect((eventMarker as Record<string, unknown> | null)?.source, `${entry.id} marker.source`).toBeDefined()
    }
  }
}

describe('hook matrix', () => {
  const entries = loadHookEntries(hooksYaml)
  for (const entry of entries) {
    if (isBlocked(entry.status)) {
      test.skip(`${entry.id} (${entry.status})`, () => {})
      console.log(skipLine(entry.status, entry.id))
      continue
    }
    test(`${entry.id} [${entry.trigger}]`, { timeout: 120_000 }, async () => {
      await runEntry(entry)
    })
  }
})
