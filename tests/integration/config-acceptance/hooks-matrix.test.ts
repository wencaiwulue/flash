import { describe, test, expect, afterAll } from 'bun:test'
import { join } from 'path'
import { writeFile } from 'node:fs/promises'
import { loadHookEntries, isBlocked, type HookEntry } from './engine/entries'
import { assertHookEntryResult, runHookScenario } from './engine/scenarios'
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
  const response = event === 'Elicitation'
    ? {
        hookSpecificOutput: {
          hookEventName: 'Elicitation',
          action: 'accept',
          content: { answer: 'CONFIG_ELICITATION_ACCEPT_33B' },
        },
      }
    : event === 'ElicitationResult'
      ? {
          hookSpecificOutput: {
            hookEventName: 'ElicitationResult',
            action: 'accept',
            content: { answer: 'CONFIG_ELICITATION_RESULT_ACCEPT_33B' },
          },
        }
      : undefined
  const responseOutput = response
    ? `; printf '%s\\n' '${JSON.stringify(response)}'`
    : ''
  const cmd = `${body}${responseOutput}${exit2 ? '; exit 2' : ''}`
  return {
    hooks: {
      [event]: [{ matcher: '*', hooks: [{ type: 'command', command: cmd }] }],
    },
  }
}

async function runEntries(entries: HookEntry[]): Promise<void> {
  const entry = entries[0]!
  const launcher = createFormLauncher(FORM)
  const mock = await createMockAnthropic()

  // 按要求实现：先创建沙箱（此时有 home 路径），然后立即配置 hook（在运行前完成）
  const sandbox = await createSandbox({
    // For permission_prompt/permission_denied and REPL scenarios, we need to pre-approve the API key
    globalConfig: entry.trigger === 'permission_prompt' || entry.trigger === 'permission_denied' || entry.trigger?.startsWith('repl_')
      ? { customApiKeyResponses: { approved: [MOCK_API_KEY] } }
      : undefined
  })
  const hooks: Record<string, unknown> = {}
  for (const item of entries) {
    Object.assign(hooks, hookSettingsFor(
      item.event,
      sandbox.home,
      item.exit_semantics === 'block',
    ).hooks)
  }
  await writeFile(join(sandbox.home, '.claude', 'settings.json'), JSON.stringify({ hooks }))

  toClose.push({ sandbox, mock })
  routeHaikuAux(mock)

  const result = await runHookScenario(entry.trigger as never, { launcher, mock, sandbox, hookCommand: '' })

  for (const item of entries) {
    assertHookEntryResult(item, result)
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
    // Both events share one in-process query below. Besides exercising the real
    // chain, this avoids reusing the process-global settings snapshot across sandboxes.
    if (entry.trigger === 'mcp_elicitation') continue
    test(`${entry.id} [${entry.trigger}]`, { timeout: 120_000 }, async () => {
      await runEntries([entry])
    })
  }
  const elicitationEntries = entries.filter(entry =>
    !isBlocked(entry.status) && entry.trigger === 'mcp_elicitation',
  )
  if (elicitationEntries.length > 0) {
    test('hook:Elicitation + hook:ElicitationResult [mcp_elicitation]', {
      timeout: 120_000,
    }, async () => {
      await runEntries(elicitationEntries)
    })
  }
})
