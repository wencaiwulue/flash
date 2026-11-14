import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { stringify } from 'yaml'
import {
  INDEX_PATH,
  MANIFEST_PATH,
  REQUIRED_HEADINGS,
} from '../scripts/check-design-docs.ts'

let cwd: string
const checker = resolve(import.meta.dir, '../scripts/check-design-docs.ts')

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'design-docs-cli-'))
})

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true })
})

function put(path: string, content: string): void {
  const absolute = join(cwd, path)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, content)
}

function git(...args: string[]): void {
  const result = Bun.spawnSync({ cmd: ['git', ...args], cwd, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
}

function run(...args: string[]): { exitCode: number; output: string } {
  const result = Bun.spawnSync({
    cmd: [process.execPath, checker, ...args],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    exitCode: result.exitCode,
    output: `${result.stdout.toString()}\n${result.stderr.toString()}`,
  }
}

function createFixture(): void {
  put(MANIFEST_PATH, stringify({
    schema_version: 1,
    roots: ['src', 'tests', 'scripts'],
    specs: [{
      id: 'system',
      spec: 'docs/superpowers/specs/system-design.md',
      coverage: 'docs/architecture/coverage/system.yaml',
      batch: 0,
      status: 'approved',
    }],
    exclusions: [],
  }))
  put('docs/architecture/coverage/system.yaml', stringify({
    schema_version: 1,
    spec_id: 'system',
    spec: '../../superpowers/specs/system-design.md',
    status: 'approved',
    groups: [{
      id: 'source', kind: 'source', section: 4,
      summary: 'Source.', files: ['src/index.ts'],
    }],
  }))
  const headingsWithout9 = REQUIRED_HEADINGS.slice(0, -1).map(heading => `${heading}\n\n正文。\n`).join('\n')
  put('docs/superpowers/specs/system-design.md', `---
id: system
batch: 0
title: System
status: approved
---
# System

${headingsWithout9}

## 9. 改进建议

| 优先级 | 触发场景与证据 | 建议方向 | 回归风险 | 验收方式 | 工作量 | 置信度 |
|---|---|---|---|---|---|---|
| P2 | 测试 | 测试建议 | 低 | 验收 | S | 已证实 |

[Coverage](../../architecture/coverage/system.yaml)
`)
  put(INDEX_PATH, '# Architecture\n\n[System](../superpowers/specs/system-design.md)\n')
  put('src/index.ts', 'export {}\n')
  git('init', '-q')
  git('add', '.')
}

test('CLI distinguishes intermediate, strict, and usage failures', () => {
  createFixture()
  expect(run().exitCode).toBe(0)
  expect(run('--require-approved').exitCode).toBe(0)

  put('src/uncovered.ts', 'export {}\n')
  git('add', 'src/uncovered.ts')
  const normal = run()
  expect(normal.exitCode).toBe(0)
  expect(normal.output).toContain('UNCOVERED_FILE')

  const strict = run('--require-approved')
  expect(strict.exitCode).toBe(1)
  expect(strict.output).toContain('UNCOVERED_FILE')
  expect(run('--unknown').exitCode).toBe(2)
}, 15000)
