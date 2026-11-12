import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { ToolPermissionContext, ToolUseContext } from '../src/Tool.ts'
import type { PendingClassifierCheck } from '../src/types/permissions.ts'

const sideQueryMock = mock()
let currentCwd = '/project-a'
mock.module('../src/utils/sideQuery.ts', () => ({ sideQuery: sideQueryMock }))
mock.module('../src/utils/cwd.ts', () => ({
  getCwd: () => currentCwd,
  pwd: () => currentCwd,
  runWithCwdOverride: (_cwd: string, fn: () => unknown) => fn(),
}))

let permissions: typeof import('../src/tools/BashTool/bashPermissions.ts')
let createClassifierCacheKey: typeof import('../src/utils/permissions/bashClassifier.ts').createClassifierCacheKey

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
  permissions = await import('../src/tools/BashTool/bashPermissions.ts')
  ;({ createClassifierCacheKey } = await import(
    '../src/utils/permissions/bashClassifier.ts'
  ))
})

beforeEach(() => {
  sideQueryMock.mockReset()
  currentCwd = '/project-a'
})

afterEach(() => {
  permissions.clearSpeculativeChecks()
})

function context(descriptions = ['delete build output']): ToolPermissionContext {
  return {
    mode: 'default',
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {
      session: descriptions.map(
        description => `Bash(prompt: ${description})`,
      ),
    },
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: false,
  } as ToolPermissionContext
}

function pending(
  command = 'rm -rf build',
  descriptions = ['delete build output'],
): PendingClassifierCheck {
  return {
    command,
    cwd: currentCwd,
    descriptions,
    cacheKey: createClassifierCacheKey(
      command,
      currentCwd,
      'allow',
      descriptions,
    ),
  }
}

function response(input: unknown) {
  return {
    stop_reason: 'tool_use',
    content: [
      { type: 'tool_use', name: 'classify_bash_command', input },
    ],
  }
}

function allowResult(overrides: Record<string, unknown> = {}) {
  return response({
    matches: true,
    matched_description_index: 0,
    confidence: 'high',
    reason: 'Explicitly authorized',
    ...overrides,
  })
}

describe('speculative Bash classifier cache', () => {
  test('keys promises by command, cwd, behavior, and ordered descriptions', async () => {
    sideQueryMock.mockResolvedValue(allowResult())
    expect(
      permissions.startSpeculativeClassifierCheck(
        'rm -rf build',
        context(),
        new AbortController().signal,
        false,
      ),
    ).toBe(true)
    expect(permissions.peekSpeculativeClassifierCheck(pending())).toBeDefined()

    expect(
      permissions.startSpeculativeClassifierCheck(
        'rm -rf build',
        context(),
        new AbortController().signal,
        false,
      ),
    ).toBe(true)
    expect(sideQueryMock).toHaveBeenCalledTimes(1)

    currentCwd = '/project-b'
    permissions.startSpeculativeClassifierCheck(
      'rm -rf build',
      context(),
      new AbortController().signal,
      false,
    )
    expect(sideQueryMock).toHaveBeenCalledTimes(2)
    expect(permissions.peekSpeculativeClassifierCheck(pending())).toBeDefined()

    currentCwd = '/project-a'
    const otherRules = ['remove generated files']
    permissions.startSpeculativeClassifierCheck(
      'rm -rf build',
      context(otherRules),
      new AbortController().signal,
      false,
    )
    expect(sideQueryMock).toHaveBeenCalledTimes(3)
    expect(
      permissions.peekSpeculativeClassifierCheck(pending('rm -rf build', otherRules)),
    ).toBeDefined()

    const consumed = permissions.consumeSpeculativeClassifierCheck(pending())
    expect(consumed).toBeDefined()
    expect(permissions.peekSpeculativeClassifierCheck(pending())).toBeUndefined()
    await consumed
  })

  test('does not start in bypass mode or with invalid rule configuration', () => {
    const bypass = {
      ...context(),
      mode: 'bypassPermissions',
    } as ToolPermissionContext
    expect(
      permissions.startSpeculativeClassifierCheck(
        'rm -rf build',
        bypass,
        new AbortController().signal,
        false,
      ),
    ).toBe(false)
    const invalid = context()
    invalid.alwaysDenyRules.session = ['Bash(prompt:   )']
    expect(
      permissions.startSpeculativeClassifierCheck(
        'rm -rf build',
        invalid,
        new AbortController().signal,
        false,
      ),
    ).toBe(false)
    expect(sideQueryMock).not.toHaveBeenCalled()
  })
})

describe('asynchronous Bash allow approval', () => {
  test('auto-approves only an available high-confidence exact match and completes once', async () => {
    sideQueryMock.mockResolvedValue(allowResult())
    const onAllow = mock()
    const onComplete = mock()
    await permissions.executeAsyncClassifierCheck(
      pending(),
      new AbortController().signal,
      false,
      { shouldContinue: () => true, onAllow, onComplete },
    )
    expect(onAllow).toHaveBeenCalledTimes(1)
    expect(onAllow.mock.calls[0]![0]).toMatchObject({
      type: 'classifier',
      classifier: 'bash_allow',
    })
    expect(onComplete).toHaveBeenCalledTimes(1)
  })

  test.each([
    ['medium confidence', { confidence: 'medium' }],
    ['no match', { matches: false, matched_description_index: undefined }],
  ])('does not auto-approve %s', async (_name, overrides) => {
    sideQueryMock.mockResolvedValue(allowResult(overrides))
    const onAllow = mock()
    const onComplete = mock()
    await permissions.executeAsyncClassifierCheck(
      pending(),
      new AbortController().signal,
      false,
      { shouldContinue: () => true, onAllow, onComplete },
    )
    expect(onAllow).not.toHaveBeenCalled()
    expect(onComplete).toHaveBeenCalledTimes(1)
  })

  test('does not auto-approve unavailable output or after user interaction', async () => {
    sideQueryMock.mockResolvedValue({ stop_reason: 'end_turn', content: [] })
    const onAllow = mock()
    const onComplete = mock()
    await permissions.executeAsyncClassifierCheck(
      pending(),
      new AbortController().signal,
      false,
      { shouldContinue: () => true, onAllow, onComplete },
    )
    expect(onAllow).not.toHaveBeenCalled()
    expect(onComplete).toHaveBeenCalledTimes(1)

    sideQueryMock.mockResolvedValue(allowResult())
    await permissions.executeAsyncClassifierCheck(
      pending(),
      new AbortController().signal,
      false,
      { shouldContinue: () => false, onAllow, onComplete },
    )
    expect(onAllow).not.toHaveBeenCalled()
    expect(onComplete).toHaveBeenCalledTimes(2)
  })

  test('abort fails closed and still completes exactly once', async () => {
    sideQueryMock.mockImplementation(
      ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            const error = new Error('aborted')
            error.name = 'AbortError'
            reject(error)
          })
        }),
    )
    const controller = new AbortController()
    const onAllow = mock()
    const onComplete = mock()
    const check = permissions.executeAsyncClassifierCheck(
      pending(),
      controller.signal,
      false,
      { shouldContinue: () => true, onAllow, onComplete },
    )
    controller.abort()
    await check
    expect(onAllow).not.toHaveBeenCalled()
    expect(onComplete).toHaveBeenCalledTimes(1)
  })

  test('awaitClassifierAutoApproval applies the same availability guard', async () => {
    sideQueryMock.mockResolvedValue(allowResult())
    expect(
      await permissions.awaitClassifierAutoApproval(
        pending(),
        new AbortController().signal,
        false,
      ),
    ).toMatchObject({ type: 'classifier', classifier: 'bash_allow' })

    sideQueryMock.mockResolvedValue({ stop_reason: 'end_turn', content: [] })
    expect(
      await permissions.awaitClassifierAutoApproval(
        pending(),
        new AbortController().signal,
        false,
      ),
    ).toBeUndefined()
  })
})

describe('Bash deny/ask classifier permission chain', () => {
  function ruleContext(rules: {
    allow?: string[]
    deny?: string[]
    ask?: string[]
  }): ToolPermissionContext {
    const serialize = (descriptions: string[] | undefined) =>
      (descriptions ?? []).map(description => `Bash(prompt: ${description})`)
    return {
      mode: 'default',
      additionalWorkingDirectories: new Map(),
      alwaysAllowRules: { session: serialize(rules.allow) },
      alwaysDenyRules: { session: serialize(rules.deny) },
      alwaysAskRules: { session: serialize(rules.ask) },
      isBypassPermissionsModeAvailable: false,
    } as ToolPermissionContext
  }

  function useContext(toolPermissionContext: ToolPermissionContext) {
    return {
      getAppState: () => ({ toolPermissionContext }),
      abortController: new AbortController(),
      options: { isNonInteractiveSession: false },
    } as unknown as ToolUseContext
  }

  test('an unavailable deny/ask classifier returns manual ask without pending allow', async () => {
    sideQueryMock.mockImplementation(({ messages }) => {
      const payload = JSON.parse(messages[0].content)
      if (payload.behavior === 'deny') {
        return Promise.resolve({ stop_reason: 'end_turn', content: [] })
      }
      return Promise.resolve(
        response({ matches: false, confidence: 'high', reason: 'No match' }),
      )
    })
    const result = await permissions.bashToolHasPermission(
      { command: 'rm -rf build' },
      useContext(
        ruleContext({
          allow: ['delete build output'],
          deny: ['delete files'],
          ask: ['destructive commands'],
        }),
      ),
    )
    expect(result.behavior).toBe('ask')
    expect(result.decisionReason).toMatchObject({
      type: 'other',
      reason: expect.stringContaining('unavailable'),
    })
    expect(result.pendingClassifierCheck).toBeUndefined()
  })

  test('a valid high deny wins over ask and allow', async () => {
    sideQueryMock.mockImplementation(({ messages }) => {
      const payload = JSON.parse(messages[0].content)
      return Promise.resolve(
        response({
          matches: true,
          matched_description_index: 0,
          confidence: 'high',
          reason: `${payload.behavior} match`,
        }),
      )
    })
    const result = await permissions.bashToolHasPermission(
      { command: 'rm -rf build' },
      useContext(
        ruleContext({
          allow: ['delete build output'],
          deny: ['delete files'],
          ask: ['destructive commands'],
        }),
      ),
    )
    expect(result.behavior).toBe('deny')
    expect(result.message).toContain('delete files')
  })

  test('a valid high ask remains an ask and cannot be bypassed by pending allow', async () => {
    sideQueryMock.mockImplementation(({ messages }) => {
      const payload = JSON.parse(messages[0].content)
      return Promise.resolve(
        response({
          matches: payload.behavior === 'ask',
          ...(payload.behavior === 'ask'
            ? { matched_description_index: 0 }
            : {}),
          confidence: 'high',
          reason: `${payload.behavior} result`,
        }),
      )
    })
    const result = await permissions.bashToolHasPermission(
      { command: 'rm -rf build' },
      useContext(
        ruleContext({
          allow: ['delete build output'],
          deny: ['unrelated files'],
          ask: ['destructive commands'],
        }),
      ),
    )
    expect(result.behavior).toBe('ask')
    expect(result.decisionReason).toMatchObject({
      reason: expect.stringContaining('destructive commands'),
    })
    expect(result.pendingClassifierCheck).toBeUndefined()
  })

  test('invalid deny configuration asks manually without dropping the rule set', async () => {
    const result = await permissions.bashToolHasPermission(
      { command: 'rm -rf build' },
      useContext(ruleContext({ deny: ['   '] })),
    )
    expect(result.behavior).toBe('ask')
    expect(result.decisionReason).toMatchObject({
      reason: expect.stringContaining('Invalid Bash prompt rule'),
    })
    expect(sideQueryMock).not.toHaveBeenCalled()
  })

  test('deterministic exact deny does not invoke any classifier', async () => {
    const toolPermissionContext = ruleContext({
      allow: ['delete build output'],
    })
    toolPermissionContext.alwaysDenyRules.session = ['Bash(rm -rf build)']
    const result = await permissions.bashToolHasPermission(
      { command: 'rm -rf build' },
      useContext(toolPermissionContext),
    )
    expect(result.behavior).toBe('deny')
    expect(sideQueryMock).not.toHaveBeenCalled()
  })
})
