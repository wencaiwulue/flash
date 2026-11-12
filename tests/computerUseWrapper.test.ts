import { afterEach, describe, expect, test } from 'bun:test'
import type { ToolUseContext } from '../src/Tool.ts'
import {
  closeComputerUseBackend,
  getComputerUseMCPToolOverrides,
} from '../src/utils/computerUse/wrapper.tsx'

function context(): ToolUseContext {
  return {
    abortController: new AbortController(),
    getAppState: () => ({}),
    setAppState: () => {},
    setToolJSX: () => {},
  } as unknown as ToolUseContext
}

afterEach(async () => {
  await closeComputerUseBackend()
  delete process.env.COMPUTER_USE_BACKEND
})

describe('Computer Use wrapper result conversion', () => {
  test('preserves Zavora isError and structuredContent', async () => {
    process.env.COMPUTER_USE_BACKEND = 'zavora'
    const overrides = getComputerUseMCPToolOverrides('get_tool_guide')
    const result = await overrides.call({}, context(), 'tool-use-id')
    expect(result).toMatchObject({
      isError: true,
      mcpMeta: {
        structuredContent: {
          error: 'invalid_arguments',
          tool: 'get_tool_guide',
        },
      },
    })
  }, 30_000)

  test('keeps structured successful results without desktop actions', async () => {
    process.env.COMPUTER_USE_BACKEND = 'zavora'
    const overrides = getComputerUseMCPToolOverrides('get_tool_guide')
    const result = await overrides.call(
      { task_description: 'inspect tool metadata without input' },
      context(),
      'tool-use-id',
    )
    expect(JSON.stringify(result)).toContain('mcpMeta')
    expect(JSON.stringify(result)).not.toContain('"isError":true')
  }, 30_000)
})
