import { beforeEach, afterEach, describe, expect, test } from 'bun:test'
import { Command } from '@commander-js/extra-typings'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  exportHandler,
  generateCompletion,
  taskCreateHandler,
  taskDirHandler,
  taskGetHandler,
  taskListHandler,
  taskUpdateHandler,
} from '../src/cli/handlers/ant.js'
import { rollback, type RollbackDependencies } from '../src/cli/rollback.js'
import { extractClaudeUpSection, findClaudeUpSection, up } from '../src/cli/up.js'

const execute = promisify(execFile)

let temporary = ''
let stdout = ''
let stderr = ''
const originalWrite = process.stdout.write
const originalErrorWrite = process.stderr.write
const originalConfig = process.env.CLAUDE_CONFIG_DIR

function capture(): void {
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += chunk.toString()
    return true
  }) as typeof process.stdout.write
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += chunk.toString()
    return true
  }) as typeof process.stderr.write
}

beforeEach(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'w6-maintenance-'))
  process.env.CLAUDE_CONFIG_DIR = join(temporary, 'config')
  stdout = ''
  stderr = ''
  process.exitCode = 0
  capture()
})

afterEach(async () => {
  process.exitCode = 0
  process.stdout.write = originalWrite
  process.stderr.write = originalErrorWrite
  if (originalConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfig
  await rm(temporary, { recursive: true, force: true })
})

describe('task maintenance handlers', () => {
  test('concurrent create uses unique IDs, filters/sorts, updates and gets tasks', async () => {
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        taskCreateHandler(`task ${index}`, { description: `description ${index}` }),
      ),
    )
    const ids = stdout.trim().split('\n')
    expect(new Set(ids).size).toBe(8)
    expect(ids.map(Number).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])

    stdout = ''
    await taskUpdateHandler('2', { status: 'completed', owner: 'agent-a' })
    expect(JSON.parse(stdout)).toMatchObject({ id: '2', status: 'completed', owner: 'agent-a' })
    stdout = ''
    await taskListHandler({ pending: true, json: true })
    const pending = JSON.parse(stdout) as Array<{ id: string; status: string }>
    expect(pending).toHaveLength(7)
    expect(pending.some(task => task.id === '2')).toBe(false)
    expect(pending.map(task => Number(task.id))).toEqual([1, 3, 4, 5, 6, 7, 8])

    stdout = ''
    await taskGetHandler('2', {})
    expect(JSON.parse(stdout)).toMatchObject({ blocks: [], blockedBy: [] })
    stdout = ''
    stderr = ''
    await taskUpdateHandler('2', { owner: 'b', clearOwner: true })
    expect(process.exitCode).toBe(1)
    expect(stderr).toContain('mutually exclusive')
    process.exitCode = 0
    stdout = ''
    stderr = ''
    await taskUpdateHandler('2', { status: 'root; rm -rf /' })
    expect(process.exitCode).toBe(1)
    expect(stderr).toContain('Invalid task status')
  })

  test('missing get does not create a task and dir is side-effect free', async () => {
    const list = 'custom-list'
    await taskDirHandler({ list })
    const directory = stdout.trim()
    expect(directory).toContain('custom-list')
    await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
    stdout = ''
    await taskGetHandler('99', { list })
    expect(process.exitCode).toBe(1)
    await expect(stat(join(directory, '99.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('export and completion handlers', () => {
  test('exports a real JSON transcript without overwriting', async () => {
    const id = '11111111-1111-4111-8111-111111111111'
    const source = join(temporary, 'input.json')
    const output = join(temporary, 'output.txt')
    await writeFile(
      source,
      JSON.stringify([
        {
          type: 'user',
          uuid: id,
          timestamp: '2026-01-02T03:04:05.000Z',
          sessionId: id,
          cwd: temporary,
          userType: 'external',
          version: '1.0.0',
          message: { role: 'user', content: 'hello from export' },
        },
      ]),
    )
    await exportHandler(source, output)
    expect(await readFile(output, 'utf8')).toContain('hello from export')
    expect((await stat(output)).mode & 0o777).toBe(0o600)
    const before = await readFile(output, 'utf8')
    await expect(exportHandler(source, output)).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await readFile(output, 'utf8')).toBe(before)
  })

  test('generates escaped nested bash/zsh/fish completions and rejects unknown shells', async () => {
    const program = new Command('fixture')
    const nested = program.command('task').description('tasks')
    nested.command('show').description("bad ' ` $(touch /tmp/nope)\nnext")
    nested.option('--owner <agent>', 'owner')
    program.command('secret', { hidden: true })
    for (const shell of ['bash', 'zsh', 'fish'] as const) {
      const script = generateCompletion(shell, program)
      expect(script).toContain('task')
      expect(script).toContain('show')
      expect(script).not.toContain('secret')
      expect(script).not.toContain('\nnext')
      expect(script).not.toContain('eval')
      if (shell !== 'bash') expect(script).toContain("'\\''")
      const path = join(temporary, `completion.${shell}`)
      await writeFile(path, script)
      if (shell === 'bash') await execute('bash', ['-n', path])
      else {
        try {
          await execute(shell, [shell === 'zsh' ? '-n' : '--no-execute', path])
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
    }
    expect(() => generateCompletion('powershell', program)).toThrow('Unsupported shell')
  })
})

describe('up and rollback', () => {
  test('extracts only the claude up section', () => {
    expect(extractClaudeUpSection('# Other\nno\n# claude up\nbun install\n## nested\nbun test\n# Next\nrm -rf /'))
      .toBe('bun install\n## nested\nbun test')
    expect(extractClaudeUpSection('# claude up\n\n# next')).toBeNull()
  })

  test('up uses nearest file, shows plan and honors cancellation/confirmation', async () => {
    await writeFile(join(temporary, 'CLAUDE.md'), '# claude up\nfake-update --safe')
    const nested = join(temporary, 'a', 'b')
    await mkdir(nested, { recursive: true })
    expect((await findClaudeUpSection(nested))?.instructions).toBe('fake-update --safe')
    let executions = 0
    await up({ cwd: nested, confirm: async () => false, execute: async () => { executions++ } })
    expect(executions).toBe(0)
    expect(stdout).toContain('fake-update --safe')
    await up({ cwd: nested, confirm: async () => true, execute: async instructions => {
      executions++
      expect(instructions).toBe('fake-update --safe')
    } })
    expect(executions).toBe(1)
  })

  test('rollback lists, resolves targets and dry-run/safe without real installation', async () => {
    let installs = 0
    const dependencies: RollbackDependencies = {
      currentVersion: '3.0.0',
      getVersions: async () => [
        { version: '3.0.0', publishedAt: '2026-01-03T00:00:00Z' },
        { version: '2.0.0', publishedAt: '2026-01-02T00:00:00Z' },
        { version: '1.0.0', publishedAt: '2026-01-01T00:00:00Z' },
      ],
      getSafeVersion: async () => '1.0.0',
      install: async version => {
        installs++
        return { latestVersion: version, wasUpdated: true }
      },
    }
    await rollback(undefined, { list: true }, dependencies)
    expect(stdout).toContain('3.0.0 (current)')
    expect(stdout).toContain('2.0.0')
    stdout = ''
    await rollback(undefined, { dryRun: true }, dependencies)
    expect(stdout).toContain('3.0.0 → 2.0.0')
    expect(installs).toBe(0)
    stdout = ''
    await rollback(undefined, { safe: true, dryRun: true }, dependencies)
    expect(stdout).toContain('3.0.0 → 1.0.0')
    expect(installs).toBe(0)
    stdout = ''
    await rollback('1.0.0', {}, dependencies)
    expect(installs).toBe(1)
    expect(stdout).toContain('Rolled back to 1.0.0')
    process.exitCode = 0
    stdout = ''
    await rollback('9.0.0', {}, dependencies)
    expect(process.exitCode).toBe(1)
    expect(stderr).toContain('not found')
    expect(installs).toBe(1)
  })
})
