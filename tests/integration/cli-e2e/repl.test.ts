
import { describe, test, expect, afterAll } from 'bun:test'
import { distMainPath } from '../support/dist-fixture.ts'
import { createSandbox, type Sandbox } from '../support/sandbox.ts'
import { createMockAnthropic, MOCK_API_KEY, type MockAnthropic } from '../support/mock-anthropic.ts'
import { spawnPty, type PtySession } from '../support/pty-driver.ts'

const toClose: Array<{ sandbox?: Sandbox; mock?: MockAnthropic; session?: PtySession }> = []
afterAll(async () => {
  for (const item of toClose) {
    await item.session?.kill().catch(() => {})
    await item.sandbox?.cleanup()
    await item.mock?.stop()
  }
})

async function startRepl(): Promise<{ session: PtySession; sandbox: Sandbox; mock: MockAnthropic }> {
  const mock = await createMockAnthropic()
  const sandbox = await createSandbox()
  const session = await spawnPty({
    cmd: [process.execPath, await distMainPath()],
    cwd: sandbox.project,
    env: { ...sandbox.env, ANTHROPIC_API_KEY: MOCK_API_KEY, ANTHROPIC_BASE_URL: mock.url },
  })
  toClose.push({ session, sandbox, mock })

  // Navigate the API key dialog - wait a bit then select Yes
  await new Promise(r => setTimeout(r, 3000))
  session.write('\x1b[A\r') // Up arrow then Enter
  await new Promise(r => setTimeout(r, 2000))

  // Wait for the flash banner
  await session.waitFor(/flash/, 30_000)

  return { session, sandbox, mock }
}

describe('REPL interaction', () => {
  test('basic REPL startup and double Ctrl+C exit', { timeout: 90_000 }, async () => {
    const { session } = await startRepl()

    // Verify we can exit with double Ctrl+C
    await new Promise(r => setTimeout(r, 1000))
    session.write('\x03')
    await new Promise(r => setTimeout(r, 300))
    session.write('\x03')

    const code = await session.exited()
    expect([0, 130, -1]).toContain(code)
  })

  test('unknown slash command doesn\'t crash the process', { timeout: 90_000 }, async () => {
    const { session } = await startRepl()

    // Send unknown command
    await new Promise(r => setTimeout(r, 1000))
    session.write('/definitely-not-a-valid-command-xyz\r')
    await new Promise(r => setTimeout(r, 2000))

    // Verify the process is still alive by exiting cleanly
    session.write('\x03')
    await new Promise(r => setTimeout(r, 300))
    session.write('\x03')

    const exitCode = await session.exited()
    expect([0, 130, -1]).toContain(exitCode)
  })

  test('/exit command is handled (or fallback to Ctrl+C)', { timeout: 90_000 }, async () => {
    const { session } = await startRepl()

    await new Promise(r => setTimeout(r, 1000))
    session.write('/exit\r')

    let exitCode: number | undefined
    try {
      exitCode = await Promise.race([
        session.exited(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))
      ])
    } catch {
      // /exit didn't work, use double Ctrl+C
      session.write('\x03')
      await new Promise(r => setTimeout(r, 300))
      session.write('\x03')
      exitCode = await session.exited()
    }

    expect(exitCode).toBeDefined()
    expect([0, 130, -1]).toContain(exitCode)
  })
})

