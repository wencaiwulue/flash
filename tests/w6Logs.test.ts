import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const roots: string[] = []
afterAll(async () => {
  await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })))
})

describe('conversation and error log handlers', () => {
  test('runs real handlers in an isolated HOME with JSONL and privacy coverage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'w6-logs-'))
    roots.push(root)
    const script = join(root, 'fixture.ts')
    await writeFile(script, `
      import assert from 'node:assert/strict'
      import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
      import { join } from 'node:path'
      const { errorHandler, logHandler, exportHandler } = await import(${JSON.stringify(join(process.cwd(), 'src/cli/handlers/ant.ts'))})
      const { CACHE_PATHS } = await import(${JSON.stringify(join(process.cwd(), 'src/utils/cachePaths.ts'))})
      const { getProjectDir } = await import(${JSON.stringify(join(process.cwd(), 'src/utils/sessionStorage.ts'))})
      const { getOriginalCwd } = await import(${JSON.stringify(join(process.cwd(), 'src/bootstrap/state.ts'))})
      const sink = await import(${JSON.stringify(join(process.cwd(), 'src/utils/errorLogSink.ts'))})
      const { logError, _resetErrorLogForTesting } = await import(${JSON.stringify(join(process.cwd(), 'src/utils/log.ts'))})
      let stdout = ''
      let stderr = ''
      const capture = () => {
        stdout = ''; stderr = ''; process.exitCode = 0
        process.stdout.write = chunk => { stdout += chunk.toString(); return true }
        process.stderr.write = chunk => { stderr += chunk.toString(); return true }
      }
      const id = '11111111-1111-4111-8111-111111111111'
      const entry = {
        type: 'user', uuid: id, parentUuid: null, timestamp: '2026-01-01T00:00:00.000Z',
        sessionId: id, cwd: ${JSON.stringify(root)}, userType: 'external', version: '1.0.0',
        message: { role: 'user', content: 'real local conversation' },
      }
      const project = getProjectDir(getOriginalCwd())
      await mkdir(project, { recursive: true })
      await writeFile(join(project, id + '.jsonl'), 'damaged-line\\n' + JSON.stringify(entry) + '\\n')
      capture(); await logHandler(undefined)
      assert.match(stdout, /real local conversation/)
      capture(); await logHandler(0)
      assert.match(stdout, /real local conversation/)
      capture(); await logHandler(id)
      assert.match(stdout, /real local conversation/)
      capture(); await exportHandler(id, join(${JSON.stringify(root)}, 'uuid-export.txt'))
      assert.match(await readFile(join(${JSON.stringify(root)}, 'uuid-export.txt'), 'utf8'), /real local conversation/)
      capture(); await exportHandler('0', join(${JSON.stringify(root)}, 'index-export.txt'))
      assert.match(await readFile(join(${JSON.stringify(root)}, 'index-export.txt'), 'utf8'), /real local conversation/)
      capture(); await logHandler(99)
      assert.equal(process.exitCode, 1)
      assert.match(stderr, /not found/)

      const errors = CACHE_PATHS.errors()
      assert.ok(errors.startsWith(${JSON.stringify(root)}))
      await mkdir(errors, { recursive: true })
      await writeFile(join(errors, 'one.jsonl'), JSON.stringify({ error: 'older error', timestamp: '2025-01-01T00:00:00.000Z' }) + '\\n')
      await writeFile(join(errors, 'two.jsonl'), 'broken\\n' + JSON.stringify({ error: 'newest error', timestamp: '2026-01-01T00:00:00.000Z' }) + '\\n')
      capture(); await errorHandler(undefined)
      assert.match(stdout, /newest error/)
      assert.match(stdout, /older error/)
      capture(); await errorHandler(0)
      assert.match(stdout, /newest error/)
      capture(); await errorHandler(-1)
      assert.equal(process.exitCode, 1)
      assert.match(stderr, /index -1/)

      _resetErrorLogForTesting()
      sink.initializeErrorLogSink()
      logError(new Error('persisted locally'))
      sink._flushLogWritersForTesting()
      const path = sink.getErrorsPath()
      assert.match(await readFile(path, 'utf8'), /persisted locally/)
      assert.equal((await stat(path)).mode & 0o777, 0o600)
      process.env.DISABLE_ERROR_REPORTING = '1'
      logError(new Error('must not persist'))
      sink._flushLogWritersForTesting()
      assert.doesNotMatch(await readFile(path, 'utf8'), /must not persist/)
      sink._clearLogWritersForTesting()
      process.exitCode = 0
      console.log('isolated log assertions passed')
    `)
    const child = Bun.spawn([process.execPath, script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        XDG_CACHE_HOME: join(root, 'cache'),
        CLAUDE_CONFIG_DIR: join(root, 'config'),
        ANTHROPIC_API_KEY: 'offline-test-placeholder',
        DISABLE_ERROR_REPORTING: '',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '',
        DISABLE_TELEMETRY: '',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (exitCode !== 0) throw new Error(`fixture failed:\n${stdout}\n${stderr}`)
    expect(stderr).toBe('')
    expect(stdout).toContain('isolated log assertions passed')
    expect(exitCode).toBe(0)
  }, 30_000)
})
