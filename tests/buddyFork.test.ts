import { describe, expect, mock, test } from 'bun:test'
import { rollWithSeed } from '../src/buddy/companion.ts'
import {
  fireCompanionObserver,
  parseCompanionObserverResponse,
} from '../src/buddy/companionObserver.ts'
import type { Command } from '../src/types/command.ts'
import type { ToolUseContext } from '../src/Tool.ts'
import type { Message } from '../src/types/message.ts'
import { createAssistantMessage, createUserMessage } from '../src/utils/messages.ts'
import {
  buildChildMessage,
  buildForkedMessages,
  buildWorktreeNotice,
  FORK_AGENT,
  isInForkChild,
} from '../src/tools/AgentTool/forkSubagent.ts'
import forkCommand from '../src/commands/fork/index.ts'

describe('Buddy companion', () => {
  test('rolls deterministic bones and bounded stats', () => {
    const first = rollWithSeed('same-user')
    const second = rollWithSeed('same-user')
    expect(second).toEqual(first)
    expect(first.inspirationSeed).toBeGreaterThanOrEqual(0)
    for (const value of Object.values(first.bones.stats)) {
      expect(value).toBeGreaterThanOrEqual(1)
      expect(value).toBeLessThanOrEqual(100)
    }
  })

  test('parses JSON responses without accepting malformed output', () => {
    expect(
      parseCompanionObserverResponse('```json\n{"name":"Ada","reaction":"Hi"}\n```'),
    ).toEqual({ name: 'Ada', reaction: 'Hi' })
    expect(parseCompanionObserverResponse('not json')).toBeUndefined()
  })

  test('hatches and persists a soul, then emits a reaction', async () => {
    let config = { userID: 'test-user' } as ReturnType<
      typeof import('../src/utils/config.ts').getGlobalConfig
    >
    const saveConfig = mock((updater: (current: typeof config) => typeof config) => {
      config = updater(config)
    })
    const reaction = mock(() => {})
    const run = mock(async () =>
      JSON.stringify({ name: 'Ada', personality: 'Calm helper', reaction: 'Ready' }),
    )
    const messages = [createUserMessage({ content: 'Help me test' })]
    await fireCompanionObserver(
      messages,
      reaction,
      {} as ToolUseContext,
      {
        run,
        now: () => 123,
        getConfig: () => config,
        saveConfig,
      },
    )
    expect(config.companion).toEqual({
      name: 'Ada',
      personality: 'Calm helper',
      hatchedAt: 123,
    })
    expect(reaction).toHaveBeenCalledWith('Ready')

    const saveAfterHatch = mock((updater: (current: typeof config) => typeof config) => {
      config = updater(config)
    })
    await fireCompanionObserver(
      messages,
      reaction,
      {} as ToolUseContext,
      {
        run: async () => '{"reaction":"Working"}',
        getConfig: () => config,
        saveConfig: saveAfterHatch,
      },
    )
    expect(reaction).toHaveBeenCalledWith('Working')
    expect(saveAfterHatch).not.toHaveBeenCalled()
  })
})

describe('Fork subagent', () => {
  test('defines an inheriting background-safe agent and recursive guard', () => {
    expect(FORK_AGENT.tools).toEqual(['*'])
    expect(FORK_AGENT.model).toBe('inherit')
    expect(FORK_AGENT.permissionMode).toBe('bubble')
    const directive = 'Review this exact file'
    const child = buildChildMessage(directive)
    expect(child).toContain('Do NOT spawn sub-agents')
    expect(child).toContain(directive)
    expect(
      isInForkChild([
        createUserMessage({ content: [{ type: 'text', text: child }] }),
      ]),
    ).toBe(true)
  })

  test('uses identical tool-result placeholders without mutating the parent', () => {
    const parent = createAssistantMessage({
      content: [
        { type: 'tool_use', id: 'a', name: 'Read', input: {} },
        { type: 'tool_use', id: 'b', name: 'Grep', input: {} },
      ],
    })
    const originalUuid = parent.uuid
    const messages = buildForkedMessages('inspect', parent)
    expect(parent.uuid).toBe(originalUuid)
    expect(messages).toHaveLength(2)
    expect(messages[0]?.uuid).not.toBe(originalUuid)
    const content = messages[1]?.type === 'user' ? messages[1].message.content : []
    expect(Array.isArray(content)).toBe(true)
    if (Array.isArray(content)) {
      const results = content.filter(block => block.type === 'tool_result')
      expect(results).toHaveLength(2)
      expect(results[0]?.content).toEqual(results[1]?.content)
    }
  })

  test('includes worktree path translation and exposes a real prompt command', async () => {
    expect(buildWorktreeNotice('/parent', '/worktree')).toContain('/worktree')
    expect(forkCommand.type).toBe('prompt')
    if (forkCommand.type !== 'prompt') return
    const prompt = await forkCommand.getPromptForCommand(
      'inspect the parser',
      {} as ToolUseContext,
    )
    expect(prompt[0]?.type).toBe('text')
    expect(JSON.stringify(prompt)).toContain('without a subagent_type')
    expect(JSON.stringify(prompt)).toContain('inspect the parser')
  })
})
