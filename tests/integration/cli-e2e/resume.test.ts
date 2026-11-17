
import { describe, test, expect, afterAll } from 'bun:test'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'path'
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

async function runPrint(sandbox: Sandbox, mock: MockAnthropic, args: string[]) {
  const main = await distMainPath()
  const proc = Bun.spawn([process.execPath, main, '-p', ...args], {
    cwd: sandbox.project,
    env: { ...sandbox.env, ANTHROPIC_API_KEY: MOCK_API_KEY, ANTHROPIC_BASE_URL: mock.url },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const out = stripAnsi(await new Response(proc.stdout).text())
  const err = stripAnsi(await new Response(proc.stderr).text())
  const code = await proc.exited
  return { out, err, code }
}

async function newestSessionId(home: string): Promise<string> {
  const projectsDir = join(home, '.claude', 'projects')
  const slugs = await readdir(projectsDir)
  let newest = { id: '', mtime: 0 }
  for (const slug of slugs) {
    for (const file of await readdir(join(projectsDir, slug))) {
      if (!file.endsWith('.jsonl')) continue
      const info = await stat(join(projectsDir, slug, file))
      if (info.mtimeMs > newest.mtime) newest = { id: file.replace(/\.jsonl$/, ''), mtime: info.mtimeMs }
    }
  }
  if (!newest.id) throw new Error('no session files found under ' + projectsDir)
  return newest.id
}

describe('session resume', () => {
  test('--resume replays prior history into the outgoing request', async () => {
    const mock = await createMockAnthropic()
    const sandbox = await createSandbox({ globalConfig: { customApiKeyResponses: { approved: [MOCK_API_KEY] } } })
    toClose.push({ sandbox, mock })

    // First run - create a session with marker
    mock.enqueue({ type: 'text', text: 'AUX_OK' })
    mock.enqueue({ type: 'text', text: 'RESUME_SESSION_ONE_OK' })
    const first = await runPrint(sandbox, mock, ['remember the marker RESUME_MARKER_A5'])
    expect(first.code, `stderr: ${first.err}`).toBe(0)

    const sessionId = await newestSessionId(sandbox.home)

    // Second run - resume the session
    mock.enqueue({ type: 'text', text: 'AUX_OK' })
    mock.enqueue({ type: 'text', text: 'RESUME_SESSION_TWO_OK' })
    const second = await runPrint(sandbox, mock, ['--resume', sessionId, 'what did I ask you to remember'])
    expect(second.code, `stderr: ${second.err}`).toBe(0)

    // Check that the last message request contains the marker from the first session
    const history = JSON.stringify(
      (mock.requests.filter(r => r.path === '/v1/messages').at(-1)!.body as Record<string, unknown>).messages,
    )
    expect(history).toContain('RESUME_MARKER_A5')
  })

  test('--resume with an invalid session id exits nonzero', async () => {
    const mock = await createMockAnthropic()
    const sandbox = await createSandbox({ globalConfig: { customApiKeyResponses: { approved: [MOCK_API_KEY] } } })
    toClose.push({ sandbox, mock })
    const { code, err } = await runPrint(sandbox, mock, ['--resume', 'not-a-real-session-id', 'hi'])
    expect(code).not.toBe(0)
  })
})
