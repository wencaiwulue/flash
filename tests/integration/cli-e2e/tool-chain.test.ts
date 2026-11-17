
import { describe, test, expect, afterAll } from 'bun:test'
import { distMainPath } from '../support/dist-fixture.ts'
import { createSandbox, type Sandbox } from '../support/sandbox.ts'
import { createMockAnthropic, MOCK_API_KEY, type MockAnthropic } from '../support/mock-anthropic.ts'
import { stripAnsi } from '../support/ansi.ts'

const toClose: Array<{ sandbox?: Sandbox; mock?: MockAnthropic }> = []
afterAll(async () => {
  for (const item of toClose) {
    await item.sandbox?.cleanup()
    await item.mock?.stop()
  }
})

async function runPrint(args: string[], sandbox: Sandbox, mockUrl: string) {
  const main = await distMainPath()
  const proc = Bun.spawn([process.execPath, main, ...args], {
    cwd: sandbox.project,
    env: { ...sandbox.env, ANTHROPIC_API_KEY: MOCK_API_KEY, ANTHROPIC_BASE_URL: mockUrl },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const out = await new Response(proc.stdout).text()
  const err = await new Response(proc.stderr).text()
  const code = await proc.exited
  return { out: stripAnsi(out), err: stripAnsi(err), code }
}

describe('tool execution chain', () => {
  test('executes scripted Bash tool and returns result to model', async () => {
    const mock = await createMockAnthropic()
    const sandbox = await createSandbox()
    toClose.push({ sandbox, mock })
    mock.enqueue(
      { type: 'tool_use', id: 'toolu_mock_b1', name: 'Bash', input: { command: 'echo TOOL_CHAIN_ECHO_9d3c', description: 'print marker' } },
      { type: 'text', text: 'TOOL_CHAIN_DONE_9d3c' },
    )
    const { out, err, code } = await runPrint(['-p', 'run the command', '--dangerously-skip-permissions'], sandbox, mock.url)
    expect(code, `stderr: ${err}`).toBe(0)
    // Note: Tool output may not be visible in print-mode stdout; we verify via the API request instead
    expect(out).toContain('TOOL_CHAIN_DONE_9d3c')

    const messageRequests = mock.requests.filter(r => r.path === '/v1/messages')
    expect(messageRequests.length).toBeGreaterThanOrEqual(2)
    const lastMessages = (messageRequests.at(-1)!.body as Record<string, unknown>).messages as Array<Record<string, unknown>>
    const toolResultBlock = lastMessages.at(-1)!
    expect(toolResultBlock).toBeDefined()
    const toolResultJson = JSON.stringify(toolResultBlock)
    expect(toolResultJson).toContain('TOOL_CHAIN_ECHO_9d3c')
    expect(toolResultJson).toContain('"is_error":false')
    expect(toolResultJson).toContain('toolu_mock_b1')
  })

  test('failed command reports is_error true to the model', async () => {
    const mock = await createMockAnthropic()
    const sandbox = await createSandbox()
    toClose.push({ sandbox, mock })
    mock.enqueue(
      { type: 'tool_use', id: 'toolu_mock_b2', name: 'Bash', input: { command: 'exit 7', description: 'fail on purpose' } },
      { type: 'text', text: 'done' },
    )
    await runPrint(['-p', 'run it', '--dangerously-skip-permissions'], sandbox, mock.url)
    const messageRequests = mock.requests.filter(r => r.path === '/v1/messages')
    expect(messageRequests.length).toBeGreaterThanOrEqual(2)
    const lastMessages = (messageRequests.at(-1)!.body as Record<string, unknown>).messages as Array<Record<string, unknown>>
    const toolResultBlock = lastMessages.at(-1)!
    const toolResultJson = JSON.stringify(toolResultBlock)
    expect(toolResultJson).toContain('"is_error":true')
    expect(toolResultJson).toContain('toolu_mock_b2')
  })
})
