import { beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { ToolPermissionContext } from '../src/Tool.ts'

const sideQueryMock = mock()
mock.module('../src/utils/sideQuery.ts', () => ({ sideQuery: sideQueryMock }))

let classifier: typeof import('../src/utils/permissions/bashClassifier.ts')
let permissionRuleValueToString: typeof import('../src/utils/permissions/permissionRuleParser.ts').permissionRuleValueToString

beforeAll(async () => {
  classifier = await import('../src/utils/permissions/bashClassifier.ts')
  ;({ permissionRuleValueToString } = await import(
    '../src/utils/permissions/permissionRuleParser.ts'
  ))
})

beforeEach(() => {
  sideQueryMock.mockReset()
})

function permissionContext(rules: {
  allow?: string[]
  deny?: string[]
  ask?: string[]
}): ToolPermissionContext {
  return {
    mode: 'default',
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: { session: rules.allow ?? [] },
    alwaysDenyRules: { session: rules.deny ?? [] },
    alwaysAskRules: { session: rules.ask ?? [] },
    isBypassPermissionsModeAvailable: false,
  } as ToolPermissionContext
}

function toolResponse(input: unknown, name = 'classify_bash_command') {
  return {
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', name, input }],
  }
}

function validMatch(overrides: Record<string, unknown> = {}) {
  return {
    matches: true,
    matched_description_index: 0,
    confidence: 'high',
    reason: 'Matches the supplied rule',
    ...overrides,
  }
}

describe('Bash prompt rule parsing and collection', () => {
  test('round-trips escaped descriptions and rejects invalid content', () => {
    const content = classifier.createPromptRuleContent(
      '  delete files (recursively)  ',
    )
    expect(content).toBe('prompt: delete files (recursively)')
    const rule = permissionRuleValueToString({
      toolName: 'Bash',
      ruleContent: content,
    })
    expect(rule).toBe('Bash(prompt: delete files \\(recursively\\))')
    expect(classifier.extractPromptDescription(content)).toBe(
      'delete files (recursively)',
    )
    expect(classifier.extractPromptDescription('npm:*')).toBeNull()
    expect(classifier.extractPromptDescription('prompted: no')).toBeNull()
    expect(classifier.extractPromptDescription('prompt:   ')).toBeNull()
    expect(classifier.extractPromptDescription('prompt: bad\0value')).toBeNull()
    expect(
      classifier.extractPromptDescription(`prompt: ${'x'.repeat(1001)}`),
    ).toBeNull()
    expect(() => classifier.createPromptRuleContent(' ')).toThrow()
    expect(() => classifier.createPromptRuleContent('x\0y')).toThrow()
  })

  test('collects only the requested behavior and deduplicates exact text', () => {
    const context = permissionContext({
      allow: [
        'Bash(prompt: read files)',
        'Bash(prompt: read files)',
        'Bash(npm:*)',
      ],
      deny: ['Bash(prompt: delete files)'],
      ask: ['Bash(prompt: modify files)'],
    })
    expect(classifier.getBashPromptAllowDescriptions(context)).toEqual([
      'read files',
    ])
    expect(classifier.getBashPromptDenyDescriptions(context)).toEqual([
      'delete files',
    ])
    expect(classifier.getBashPromptAskDescriptions(context)).toEqual([
      'modify files',
    ])
  })

  test('invalid or oversized rule sets fail configuration instead of truncating deny rules', () => {
    const invalid = permissionContext({
      deny: ['Bash(prompt:   )'],
      allow: ['Bash(prompt: read files)'],
    })
    expect(
      classifier.getBashPromptRuleConfigurationError(invalid),
    ).toContain('Invalid Bash prompt rule')
    expect(classifier.getBashPromptAllowDescriptions(invalid)).toEqual([])

    const tooMany = permissionContext({
      deny: Array.from(
        { length: 65 },
        (_, index) => `Bash(prompt: rule ${index})`,
      ),
    })
    expect(
      classifier.getBashPromptRuleConfigurationError(tooMany),
    ).toContain('at most 64')
    expect(classifier.getBashPromptDenyDescriptions(tooMany)).toEqual([])

    const tooLarge = permissionContext({
      ask: Array.from(
        { length: 21 },
        (_, index) => `Bash(prompt: ${index}-${'x'.repeat(990)})`,
      ),
    })
    expect(
      classifier.getBashPromptRuleConfigurationError(tooLarge),
    ).toContain('total limit')
  })
})

describe('classifyBashCommand', () => {
  test.each(['allow', 'deny', 'ask'] as const)(
    'uses forced structured output for %s rules',
    async behavior => {
      sideQueryMock.mockResolvedValue(toolResponse(validMatch()))
      const signal = new AbortController().signal
      const result = await classifier.classifyBashCommand(
        'rm -rf build',
        '/project',
        ['delete build output'],
        behavior,
        signal,
        false,
      )
      expect(result).toEqual({
        available: true,
        matches: true,
        matchedDescription: 'delete build output',
        confidence: 'high',
        reason: 'Matches the supplied rule',
      })
      const request = sideQueryMock.mock.calls[0]![0]
      expect(request.querySource).toBe('bash_classifier')
      expect(request.skipSystemPromptPrefix).toBe(true)
      expect(request.temperature).toBe(0)
      expect(request.thinking).toBe(false)
      expect(request.maxRetries).toBe(1)
      expect(request.tool_choice).toEqual({
        type: 'tool',
        name: 'classify_bash_command',
      })
      expect(request.tools[0].input_schema.additionalProperties).toBe(false)
      expect(request.signal).toBeDefined()
      expect(JSON.parse(request.messages[0].content)).toEqual({
        command: 'rm -rf build',
        cwd: '/project',
        behavior,
        descriptions: ['delete build output'],
      })
    },
  )

  test('maps the final index exactly and validates non-match shape', async () => {
    sideQueryMock.mockResolvedValueOnce(
      toolResponse(validMatch({ matched_description_index: 1 })),
    )
    const descriptions = ['first', 'second']
    expect(
      await classifier.classifyBashCommand(
        'cmd',
        '/cwd',
        descriptions,
        'allow',
        new AbortController().signal,
        false,
      ),
    ).toMatchObject({ matchedDescription: 'second', available: true })

    sideQueryMock.mockResolvedValueOnce(
      toolResponse({ matches: false, confidence: 'medium', reason: 'Unclear' }),
    )
    expect(
      await classifier.classifyBashCommand(
        'cmd',
        '/cwd',
        descriptions,
        'allow',
        new AbortController().signal,
        false,
      ),
    ).toEqual({
      available: true,
      matches: false,
      confidence: 'medium',
      reason: 'Unclear',
    })
  })

  test.each([
    ['no tool call', { stop_reason: 'end_turn', content: [] }],
    [
      'text JSON',
      {
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: '{"matches":true}' }],
      },
    ],
    [
      'multiple tool calls',
      {
        stop_reason: 'tool_use',
        content: [
          { type: 'tool_use', name: 'classify_bash_command', input: validMatch() },
          { type: 'tool_use', name: 'classify_bash_command', input: validMatch() },
        ],
      },
    ],
    ['unknown field', toolResponse(validMatch({ extra: true }))],
    [
      'missing reason',
      toolResponse({
        matches: true,
        matched_description_index: 0,
        confidence: 'high',
      }),
    ],
    [
      'index out of range',
      toolResponse(validMatch({ matched_description_index: 4 })),
    ],
    [
      'index on non-match',
      toolResponse({
        matches: false,
        matched_description_index: 0,
        confidence: 'high',
        reason: 'No match',
      }),
    ],
    ['wrong tool', toolResponse(validMatch(), 'other_tool')],
  ])('fails closed for %s', async (_name, response) => {
    sideQueryMock.mockResolvedValue(response)
    const result = await classifier.classifyBashCommand(
      'cmd',
      '/cwd',
      ['rule'],
      'allow',
      new AbortController().signal,
      false,
    )
    expect(result.available).toBe(false)
    expect(result.matches).toBe(false)
    expect(result.confidence).toBe('low')
    expect(result.matchedDescription).toBeUndefined()
  })

  test('returns unavailable on service failure and propagates caller abort', async () => {
    sideQueryMock.mockRejectedValueOnce(new Error('network unavailable'))
    expect(
      await classifier.classifyBashCommand(
        'cmd',
        '/cwd',
        ['rule'],
        'deny',
        new AbortController().signal,
        false,
      ),
    ).toMatchObject({ available: false, matches: false, confidence: 'low' })

    sideQueryMock.mockImplementationOnce(
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
    const pending = classifier.classifyBashCommand(
      'cmd',
      '/cwd',
      ['rule'],
      'allow',
      controller.signal,
      false,
    )
    controller.abort()
    await expect(pending).rejects.toThrow('aborted')
  })

  test('empty rules are unavailable without a model call', async () => {
    expect(
      await classifier.classifyBashCommand(
        'cmd',
        '/cwd',
        [],
        'allow',
        new AbortController().signal,
        false,
      ),
    ).toMatchObject({ available: false, confidence: 'low' })
    expect(sideQueryMock).not.toHaveBeenCalled()
  })
})

describe('generateGenericDescription', () => {
  test('does not call the model when a specific description exists', async () => {
    expect(
      await classifier.generateGenericDescription(
        'ls',
        'list files',
        new AbortController().signal,
      ),
    ).toBe('list files')
    expect(sideQueryMock).not.toHaveBeenCalled()
  })

  test('uses bounded structured output and returns null on invalid output', async () => {
    sideQueryMock.mockResolvedValueOnce(
      toolResponse({ description: 'List files' }, 'describe_bash_command'),
    )
    expect(
      await classifier.generateGenericDescription(
        'ls',
        undefined,
        new AbortController().signal,
      ),
    ).toBe('List files')

    sideQueryMock.mockResolvedValueOnce(
      toolResponse({ description: 'x'.repeat(201) }, 'describe_bash_command'),
    )
    expect(
      await classifier.generateGenericDescription(
        'ls',
        undefined,
        new AbortController().signal,
      ),
    ).toBeNull()
  })
})
