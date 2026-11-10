import { beforeAll, describe, expect, test } from 'bun:test'

let getAllBaseTools: typeof import('../src/tools.ts').getAllBaseTools

beforeAll(async () => {
  Object.assign(globalThis, {
    MACRO: {
      VERSION: '1.0.0',
      BUILD_TIME: '',
      PACKAGE_URL: '',
      NATIVE_PACKAGE_URL: '',
      VERSION_CHANGELOG: '',
      FEEDBACK_CHANNEL: '',
      ISSUES_EXPLAINER: '',
    },
  })
  const toolsModule = await import('../src/tools.ts')
  getAllBaseTools = toolsModule.getAllBaseTools
})

describe('external tool pool', () => {
  test('contains only concrete tools with unique names', () => {
    const tools = getAllBaseTools()
    const names = tools.map(tool => tool?.name)

    expect(tools.every(Boolean)).toBe(true)
    expect(new Set(names).size).toBe(names.length)
  })

  test('includes the core agent and file tools', () => {
    const names = new Set(getAllBaseTools().map(tool => tool.name))

    for (const name of ['Agent', 'Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep']) {
      expect(names.has(name)).toBe(true)
    }
  })
})
