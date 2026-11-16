import { describe, expect, test } from 'bun:test'
import { classifyToolSmokeResult, SMOKE_TITLE_MARKER } from '../scripts/build-binary.ts'

const okWith = (payload: string) =>
  `{"ok":true,"result":{"content":${JSON.stringify(payload)},"isError":false}}`

describe('classifyToolSmokeResult', () => {
  test('pass: ok result containing the page title marker', () => {
    expect(classifyToolSmokeResult(okWith('### Page\nTitle: smoke-ok'))).toBe('pass')
  })

  test('fail: crash pattern wins even when browser-missing text is also present', () => {
    const line = okWith(
      "Error: Cannot find module '/x/node_modules/playwright-core/package.json' — chrome channel not found",
    )
    expect(classifyToolSmokeResult(line)).toBe('fail')
    const thrown = '{"ok":false,"error":"ResolveMessage: Cannot find module \'x\'"}'
    expect(classifyToolSmokeResult(thrown)).toBe('fail')
  })

  test('fail: thrown error without browser-missing markers', () => {
    expect(classifyToolSmokeResult('{"ok":false,"error":"boom"}')).toBe('fail')
  })

  test('skip: browser-missing patterns in thrown error', () => {
    expect(
      classifyToolSmokeResult(
        `{"ok":false,"error":"Executable doesn't exist at /opt/google/chrome/chrome"}`,
      ),
    ).toBe('skip')
    expect(
      classifyToolSmokeResult(
        '{"ok":false,"error":"browserType.launch: Chromium channel \'chrome\' not found"}',
      ),
    ).toBe('skip')
  })

  test(`skip: browser-missing MCP error delivered in-band (ok:true, isError, no ${SMOKE_TITLE_MARKER})`, () => {
    const line = okWith(
      "### Error\nbrowserType.launch: Chromium channel 'chrome' not found — No such file or directory",
    )
    expect(classifyToolSmokeResult(line)).toBe('skip')
  })

  test('fail: ok result without the title marker (in-band MCP error without browser-missing text)', () => {
    expect(classifyToolSmokeResult(okWith('### Error\nsomething else failed'))).toBe('fail')
  })
})
