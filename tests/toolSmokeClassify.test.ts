import { describe, expect, test } from 'bun:test'
import { classifyToolSmokeResult, SMOKE_TITLE_MARKER } from '../scripts/build-binary.ts'

const okWith = (payload: string) =>
  `{"ok":true,"result":{"content":${JSON.stringify(payload)},"isError":false}}`

describe('classifyToolSmokeResult', () => {
  test('pass: ok result containing the page title marker', () => {
    expect(classifyToolSmokeResult(okWith('### Page\nTitle: smoke-ok'))).toBe('pass')
  })

  test('fail:crash-pattern wins even when browser-missing text is also present', () => {
    const line = okWith(
      "Error: Cannot find module '/x/node_modules/playwright-core/package.json' — chrome channel not found",
    )
    expect(classifyToolSmokeResult(line)).toBe('fail:crash-pattern')
    const thrown = '{"ok":false,"error":"ResolveMessage: Cannot find module \'x\'"}'
    expect(classifyToolSmokeResult(thrown)).toBe('fail:crash-pattern')
  })

  test('fail:tool-error — thrown error without browser-missing markers', () => {
    expect(classifyToolSmokeResult('{"ok":false,"error":"boom"}')).toBe('fail:tool-error')
  })

  test('skip:browser-missing in thrown error', () => {
    expect(
      classifyToolSmokeResult(
        `{"ok":false,"error":"Executable doesn't exist at /opt/google/chrome/chrome"}`,
      ),
    ).toBe('skip:browser-missing')
    expect(
      classifyToolSmokeResult(
        '{"ok":false,"error":"browserType.launch: Chromium channel \'chrome\' not found"}',
      ),
    ).toBe('skip:browser-missing')
  })

  test(`skip:browser-missing delivered in-band (ok:true, isError, no ${SMOKE_TITLE_MARKER})`, () => {
    const line = okWith(
      "### Error\nbrowserType.launch: Chromium channel 'chrome' not found — No such file or directory",
    )
    expect(classifyToolSmokeResult(line)).toBe('skip:browser-missing')
  })

  test('skip:perf-timeout — MCP perf timeout on slow runners (Windows cold Chrome launch)', () => {
    expect(
      classifyToolSmokeResult(
        '{"ok":false,"error":"MCP error -32001: Request timed out; cleanup failed: Browser resource cleanup timed out"}',
      ),
    ).toBe('skip:perf-timeout')
  })

  test('fail:title-marker — ok result without the title marker (in-band MCP error without browser-missing text)', () => {
    expect(classifyToolSmokeResult(okWith('### Error\nsomething else failed'))).toBe(
      'fail:title-marker',
    )
  })

  test('fail:unparsable — result line is not JSON', () => {
    expect(classifyToolSmokeResult('not json at all')).toBe('fail:unparsable')
  })
})
