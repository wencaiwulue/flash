import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { trace } from '@opentelemetry/api'
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base'
import antTrace from '../src/commands/ant-trace/index.ts'
import {
  BoundedSpanRecorder,
  getLocalTraceExport,
  startLocalTrace,
  stopLocalTrace,
} from '../src/commands/ant-trace/recorder.ts'
import { setTracerProvider } from '../src/bootstrap/state.ts'
import type { LocalJSXCommandContext } from '../src/types/command.ts'
import { writeNewDiagnosticJson } from '../src/utils/diagnosticExport.ts'

afterEach(async () => {
  await stopLocalTrace()
  trace.disable()
  setTracerProvider(null)
  spyOn(globalThis, 'fetch').mockRestore()
})

describe('/ant-trace', () => {
  test('registers a real local JSX command and lazy status call', async () => {
    expect(antTrace.name).toBe('ant-trace')
    expect(antTrace.isHidden).not.toBe(true)
    expect(antTrace.isEnabled?.() ?? true).toBe(true)
    const { call } = await antTrace.load()
    let output = ''
    const node = await call(value => { output = value ?? '' }, {} as LocalJSXCommandContext, 'status')
    expect(node).toBeNull()
    expect(output).toContain('spans=0')
  })

  test('start/stop are idempotent and stopped recorders ignore new spans', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch')
    expect(startLocalTrace()).toBe('started')
    expect(startLocalTrace()).toBe('already-started')
    trace.getTracer('test').startSpan('claude_code.before_stop').end()
    expect(getLocalTraceExport().spans).toHaveLength(1)
    expect(await stopLocalTrace()).toBe('stopped')
    expect(await stopLocalTrace()).toBe('not-started')
    trace.getTracer('test').startSpan('claude_code.after_stop').end()
    expect(getLocalTraceExport().spans).toHaveLength(1)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test('bounds the ring and filters sensitive attributes, raw errors, events, and MCP names', async () => {
    const recorder = new BoundedSpanRecorder(2, 10_000)
    const provider = new BasicTracerProvider({ spanProcessors: [recorder] })
    const tracer = provider.getTracer('test')
    for (let index = 0; index < 3; index++) {
      const span = tracer.startSpan(index === 0 ? '/private/prompt' : `claude_code.test_${index}`, {
        attributes: {
          model: 'claude-test',
          tool_name: 'mcp__private-server__secret-tool',
          user_prompt: 'sensitive prompt',
          tool_input: { token: 'sk-ant-secret-value' },
          headers: { authorization: 'Bearer secret' },
          status_code: 429,
          error: 'raw provider body must not be exported',
          input_tokens: 12,
        },
      })
      span.addEvent('exception', { 'exception.message': 'sensitive exception' })
      span.end()
    }
    const exported = recorder.getExport()
    expect(exported.spans).toHaveLength(2)
    expect(exported.droppedSpans).toBe(1)
    expect(exported.spans[0]?.name).toBe('claude_code.test_1')
    expect(exported.spans[0]?.attributes.tool_name).toBe('mcp_tool')
    expect(exported.spans[0]?.errorCategory).toBe('rate_limit')
    const serialized = JSON.stringify(exported)
    expect(serialized).not.toContain('sensitive')
    expect(serialized).not.toContain('private-server')
    expect(serialized).not.toContain('raw provider')
    await provider.shutdown()
  })

  test('export writes the bounded schema with wx and refuses overwrite', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-ant-trace-'))
    try {
      const path = join(dir, 'trace.json')
      await writeNewDiagnosticJson(path, getLocalTraceExport())
      const parsed = JSON.parse(await readFile(path, 'utf8'))
      expect(parsed.schemaVersion).toBe(1)
      expect(parsed.kind).toBe('local-opentelemetry-diagnostics')
      await expect(writeNewDiagnosticJson(path, {})).rejects.toThrow()
      expect(await readFile(path, 'utf8')).toContain('local-opentelemetry-diagnostics')
      const other = join(dir, 'other.json')
      await writeFile(other, 'keep')
      await expect(writeNewDiagnosticJson(other, {})).rejects.toThrow()
      expect(await readFile(other, 'utf8')).toBe('keep')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
