import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import perfIssue from '../src/commands/perf-issue/index.ts'
import {
  buildPerfIssueReport,
  sanitizeErrorForDiagnostics,
} from '../src/commands/perf-issue/perf-issue.tsx'
import { getIsInteractive, setIsInteractive } from '../src/bootstrap/state.ts'
import type { LocalJSXCommandContext } from '../src/types/command.ts'
import { writeNewDiagnosticJson } from '../src/utils/diagnosticExport.ts'

const wasInteractive = getIsInteractive()
afterEach(() => {
  setIsInteractive(wasInteractive)
  spyOn(globalThis, 'fetch').mockRestore()
})

describe('/perf-issue', () => {
  test('registers interactive-only JSX and lazy preview without enabling profiler or network', async () => {
    expect(perfIssue.name).toBe('perf-issue')
    expect(perfIssue.isHidden).not.toBe(true)
    setIsInteractive(false)
    expect(perfIssue.isEnabled?.()).toBe(false)
    setIsInteractive(true)
    expect(perfIssue.isEnabled?.()).toBe(true)
    const before = {
      startup: process.env.CLAUDE_CODE_PROFILE_STARTUP,
      query: process.env.CLAUDE_CODE_PROFILE_QUERY,
    }
    const fetchSpy = spyOn(globalThis, 'fetch')
    const { call } = await perfIssue.load()
    const node = await call(() => {}, { options: { mcpClients: [] } } as LocalJSXCommandContext, '')
    expect(node).not.toBeNull()
    expect(process.env.CLAUDE_CODE_PROFILE_STARTUP).toBe(before.startup)
    expect(process.env.CLAUDE_CODE_PROFILE_QUERY).toBe(before.query)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test('handles missing profiles and bounds checkpoints, long errors, and redacted fields', () => {
    const secret = `sk-ant-${'x'.repeat(40)}`
    const report = buildPerfIssueReport(
      { options: { mcpClients: [{}, {}, {}] } } as unknown as LocalJSXCommandContext,
      {
        getStartupProfileData: () => ({ detailedEnabled: false, checkpointCount: 0, phases: [], totalTimeMs: 0 }),
        getQueryProfileData: () => ({
          enabled: false, queryCount: 0, totalTimeMs: 0,
          checkpoints: Array.from({ length: 300 }, (_, i) => ({ name: `query_${i}`, startTimeMs: i, durationMs: 1 })),
        }),
        getInMemoryErrors: () => Array.from({ length: 25 }, (_, i) => ({
          timestamp: '2026-01-01T00:00:00.000Z',
          error: `rate limit ${i} ${secret} ${'x'.repeat(10_000)}`,
        })),
        getMcpCount: () => 3,
        getMemoryUsage: () => ({ rss: 1, heapUsed: 2, heapTotal: 3, external: 4, arrayBuffers: 5 }),
        getStartupTextReportAvailable: () => false,
      },
    )
    expect(report.query.checkpoints).toHaveLength(256)
    expect(report.recentErrors).toHaveLength(20)
    expect(report.recentErrors[0]?.category).toBe('rate-limit')
    expect(report.recentErrors[0]).not.toHaveProperty('excerpt')
    expect(report.mcpServerCount).toBe(3)
    const serialized = JSON.stringify(report)
    expect(serialized).not.toContain(secret)
    expect(serialized).not.toContain('mcpClients')
    expect(serialized).not.toContain('process.env')
    expect(sanitizeErrorForDiagnostics(`authorization: Bearer ${secret}`)).toEqual({ category: 'authentication' })
  })

  test('writes only new JSON with the expected schema', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-perf-issue-'))
    try {
      const report = buildPerfIssueReport(
        { options: { mcpClients: [] } } as LocalJSXCommandContext,
        {
          getStartupProfileData: () => ({ detailedEnabled: false, checkpointCount: 0, phases: [], totalTimeMs: 0 }),
          getQueryProfileData: () => ({ enabled: false, queryCount: 0, checkpoints: [], totalTimeMs: 0 }),
          getInMemoryErrors: () => [],
          getMcpCount: () => 0,
          getMemoryUsage: () => process.memoryUsage(),
          getStartupTextReportAvailable: () => false,
        },
      )
      const path = join(dir, 'perf.json')
      await writeNewDiagnosticJson(path, report)
      const disk = JSON.parse(await readFile(path, 'utf8'))
      expect(disk.schemaVersion).toBe(1)
      expect(disk.kind).toBe('claude-code-performance-diagnostics')
      expect(disk.query.enabled).toBe(false)
      await expect(writeNewDiagnosticJson(path, report)).rejects.toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
