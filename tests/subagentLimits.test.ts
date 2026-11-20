import { afterEach, describe, expect, it } from 'bun:test'
import {
  acquireSubagentSlot,
  getActiveSubagentCount,
  getMaxConcurrentSubagents,
  getMaxSubagentSpawnDepth,
  SubagentLimitError,
} from '../src/utils/subagentLimits.js'

describe('subagentLimits', () => {
  afterEach(() => {
    delete process.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS
    delete process.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH
  })

  it('defaults to 20 concurrent / 3 depth (upstream 2.1.311)', () => {
    expect(getMaxConcurrentSubagents()).toBe(20)
    expect(getMaxSubagentSpawnDepth()).toBe(3)
  })

  it('honors env overrides', () => {
    process.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS = '5'
    process.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH = '1'
    expect(getMaxConcurrentSubagents()).toBe(5)
    expect(getMaxSubagentSpawnDepth()).toBe(1)
  })

  it('falls back to defaults for invalid env values', () => {
    process.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS = 'abc'
    process.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH = '-2'
    expect(getMaxConcurrentSubagents()).toBe(20)
    expect(getMaxSubagentSpawnDepth()).toBe(3)
  })

  it('rejects spawn beyond max depth', () => {
    process.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH = '2'
    expect(() => acquireSubagentSlot(3)).toThrow(SubagentLimitError)
    acquireSubagentSlot(2)() // within depth: acquire then release
  })

  it('increments on acquire and decrements on release', () => {
    const before = getActiveSubagentCount()
    const release = acquireSubagentSlot(1)
    expect(getActiveSubagentCount()).toBe(before + 1)
    release()
    expect(getActiveSubagentCount()).toBe(before)
  })

  it('release is idempotent', () => {
    const before = getActiveSubagentCount()
    const release = acquireSubagentSlot(1)
    release()
    release()
    expect(getActiveSubagentCount()).toBe(before)
  })

  it('rejects when concurrency cap reached, allows after release', () => {
    process.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS = '1'
    const release = acquireSubagentSlot(1)
    expect(() => acquireSubagentSlot(1)).toThrow(SubagentLimitError)
    release()
    const r2 = acquireSubagentSlot(1)
    r2()
  })
})
