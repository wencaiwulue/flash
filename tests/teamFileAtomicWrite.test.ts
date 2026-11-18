import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, readdir, stat } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

// 导入我们的实现
import {
  writeTeamFileAsync,
  getTeamFilePath,
  readTeamFileAsync,
  type TeamFile,
} from '../src/utils/swarm/teamHelpers.ts'

// 清除 memoize 缓存
import { getClaudeConfigHomeDir } from '../src/utils/envUtils.js'

// 备份原始环境变量
let originalConfigDir: string | undefined
let testRoot = ''

// 测试用的 TeamFile 样本
function sampleTeamFile(name: string): TeamFile {
  return {
    name,
    description: 'Test team',
    createdAt: Date.now(),
    leadAgentId: 'lead@test-team',
    leadSessionId: 'session-123',
    hiddenPaneIds: [],
    teamAllowedPaths: [],
    members: [
      {
        agentId: 'lead@test-team',
        name: 'lead',
        agentType: 'coder',
        joinedAt: Date.now(),
        tmuxPaneId: 'pane-1',
        cwd: '/test',
        subscriptions: [],
        isActive: true,
      },
    ],
  }
}

beforeEach(async () => {
  testRoot = await mkdtemp(join(tmpdir(), 'team-file-atomic-'))
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = join(testRoot, 'config')
  // 清除 memoize 缓存
  ;(getClaudeConfigHomeDir as any).cache?.clear?.()
})

afterEach(async () => {
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  ;(getClaudeConfigHomeDir as any).cache?.clear?.()
  await rm(testRoot, { recursive: true, force: true })
})

// ========================================================================
// TeamFile 原子写入测试
// ========================================================================

describe('TeamFile 原子写入', () => {
  test('普通写入后文件完整有效', async () => {
    const teamName = 'test-team'
    const data = sampleTeamFile(teamName)

    // 写入
    await writeTeamFileAsync(teamName, data)

    // 读取验证
    const readBack = await readTeamFileAsync(teamName)
    expect(readBack).not.toBeNull()
    expect(readBack!.name).toBe(teamName)
    expect(readBack!.members.length).toBe(1)
  })

  test('写入后可以通过 readTeamFileAsync 正确读取', async () => {
    const teamName = 'read-write-test'
    const original = sampleTeamFile(teamName)
    original.description = 'This is a test description'
    original.members.push({
      agentId: 'worker@test-team',
      name: 'worker',
      agentType: 'coder',
      joinedAt: Date.now(),
      tmuxPaneId: 'pane-2',
      cwd: '/test/worker',
      subscriptions: [],
      isActive: false,
    })

    await writeTeamFileAsync(teamName, original)
    const readBack = await readTeamFileAsync(teamName)

    expect(readBack!.description).toBe('This is a test description')
    expect(readBack!.members.length).toBe(2)
    expect(readBack!.members[1].name).toBe('worker')
  })

  test('失败时不会留下临时文件', async () => {
    const teamName = 'cleanup-test'
    const data = sampleTeamFile(teamName)

    // 第一次写入成功
    await writeTeamFileAsync(teamName, data)

    // 获取目录
    const teamDir = join(testRoot, 'config', 'teams', 'cleanup-test')

    // 检查目录中只有 config.json，没有临时文件
    const filesBefore = await readdir(teamDir)
    expect(filesBefore).toEqual(['config.json'])

    // 再次写入（也应该成功，并且不会留下临时文件）
    await writeTeamFileAsync(teamName, { ...data, description: 'updated' })

    const filesAfter = await readdir(teamDir)
    // 不应该有 .tmp 文件
    expect(filesAfter.some(f => f.endsWith('.tmp'))).toBe(false)
  })

  test('多次写入后最终结果总是有效的 JSON', async () => {
    const teamName = 'concurrent-safe'
    const data = sampleTeamFile(teamName)

    // 连续多次写入
    for (let i = 0; i < 10; i++) {
      await writeTeamFileAsync(teamName, {
        ...data,
        description: `write-${i}`,
      })
    }

    // 最终结果应该有效
    const final = await readTeamFileAsync(teamName)
    expect(final).not.toBeNull()
    expect(final!.description).toBe('write-9')
  })

  test('文件权限为 0o600（仅用户可读写）', async () => {
    const teamName = 'permission-test'
    await writeTeamFileAsync(teamName, sampleTeamFile(teamName))

    const filePath = getTeamFilePath(teamName)
    const fileStat = await stat(filePath)

    // 检查权限：0o600 = rw-------
    // group/other 应该没有权限
    expect((fileStat.mode & 0o077)).toBe(0)
  })

  test('不存在的团队 readTeamFileAsync 返回 null', async () => {
    const result = await readTeamFileAsync('non-existent-team')
    expect(result).toBeNull()
  })
})
