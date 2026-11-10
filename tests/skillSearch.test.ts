import { afterEach, describe, expect, test } from 'bun:test'
import { isSkillSearchEnabled } from '../src/services/skillSearch/featureCheck.ts'
import {
  getVisibleSkillNames,
  searchLocalSkills,
  searchSkillIndex,
  type SkillIndexEntry,
} from '../src/services/skillSearch/localSearch.ts'
import {
  collectSkillDiscoveryPrefetch,
  findWritePivot,
  getTurnZeroSkillDiscovery,
  startSkillDiscoveryPrefetch,
} from '../src/services/skillSearch/prefetch.ts'
import type { ToolUseContext } from '../src/Tool.ts'
import type { Message } from '../src/types/message.ts'

const index: SkillIndexEntry[] = [
  {
    name: 'release-notes',
    description: 'Draft release notes and changelogs from git commits',
    whenToUse: 'Preparing a versioned release',
  },
  {
    name: 'database-review',
    description: 'Review SQL schema migrations and database safety',
    whenToUse: 'Changing database tables or migration scripts',
  },
  {
    name: 'css-format',
    description: 'Format visual stylesheets',
    whenToUse: 'Editing CSS layout',
  },
]

const originalKillSwitch = process.env.CLAUDE_CODE_SKILL_SEARCH

afterEach(() => {
  if (originalKillSwitch === undefined) {
    delete process.env.CLAUDE_CODE_SKILL_SEARCH
  } else {
    process.env.CLAUDE_CODE_SKILL_SEARCH = originalKillSwitch
  }
})

function userMessage(text: string): Message {
  return {
    type: 'user',
    message: { role: 'user', content: text },
  } as Message
}

function assistantTool(name: string, input: Record<string, unknown>): Message {
  return {
    type: 'assistant',
    message: {
      id: 'msg-test',
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'tool-1', name, input }],
    },
  } as Message
}

function discoveryMessage(name: string): Message {
  return {
    type: 'attachment',
    attachment: {
      type: 'skill_discovery',
      skills: [{ name, description: 'already visible' }],
      signal: 'user_input',
      source: 'native',
    },
  } as Message
}

function context(messages: Message[]): ToolUseContext {
  return { messages, discoveredSkillNames: new Set() } as unknown as ToolUseContext
}

describe('local skill index', () => {
  test('ranks matching metadata and honors exclusions and limits', () => {
    const matches = searchSkillIndex(index, 'database migration')
    expect(matches[0]?.name).toBe('database-review')
    expect(searchSkillIndex(index, 'release changelog')[0]?.name).toBe(
      'release-notes',
    )
    expect(
      searchSkillIndex(index, 'database', {
        exclude: new Set(['database-review']),
      }).some(match => match.name === 'database-review'),
    ).toBe(false)
    expect(searchSkillIndex(index, 'release', { limit: 1 })).toHaveLength(1)
    expect(searchSkillIndex(index, ' ')).toEqual([])
  })

  test('tracks both discovery attachments and Skill invocations', () => {
    const messages = [
      discoveryMessage('release-notes'),
      assistantTool('Skill', { skill: 'database-review' }),
    ]
    expect([...getVisibleSkillNames(messages)].sort()).toEqual([
      'database-review',
      'release-notes',
    ])
  })

  test('records discovered names for SkillTool telemetry', async () => {
    const ctx = context([userMessage('review my migration')])
    const matches = await searchLocalSkills('database migration', ctx, { index })
    expect(matches[0]?.name).toBe('database-review')
    expect(ctx.discoveredSkillNames?.has('database-review')).toBe(true)
  })
})

describe('skill discovery prefetch', () => {
  test('returns turn-zero attachments and suppresses already visible skills', async () => {
    const ctx = context([userMessage('review the database migration')])
    const attachments = await getTurnZeroSkillDiscovery(
      'database migration',
      ctx.messages,
      ctx,
      index,
    )
    expect(attachments).toHaveLength(1)
    expect(attachments[0]?.signal).toBe('user_input')
    expect(attachments[0]?.source).toBe('native')
    expect(attachments[0]?.skills[0]?.name).toBe('database-review')

    ctx.messages.push(discoveryMessage('database-review'))
    expect(
      await getTurnZeroSkillDiscovery(
        'database migration',
        ctx.messages,
        ctx,
        index,
      ),
    ).toEqual([])
  })

  test('runs write-pivot discovery once and supports subagent spawn', async () => {
    const messages = [
      userMessage('check migration safety'),
      assistantTool('Write', { file_path: 'src/db/migration.sql' }),
    ]
    const ctx = context(messages)
    expect(findWritePivot(messages)).toBe(1)
    const prefetch = startSkillDiscoveryPrefetch(null, messages, ctx, index)
    expect(prefetch).not.toBeNull()
    const attachments = await collectSkillDiscoveryPrefetch(prefetch!)
    expect(attachments[0]?.signal).toBe('write_pivot')
    expect(attachments[0]?.skills[0]?.name).toBe('database-review')

    messages.push(discoveryMessage('database-review'))
    expect(findWritePivot(messages)).toBe(-1)
    expect(startSkillDiscoveryPrefetch(null, messages, ctx, index)).toBeNull()

    const subagent = context([userMessage('review database migration')])
    subagent.agentId = 'agent-test' as never
    const spawn = startSkillDiscoveryPrefetch(
      null,
      subagent.messages,
      subagent,
      index,
    )
    const spawnAttachments = await collectSkillDiscoveryPrefetch(spawn!)
    expect(spawnAttachments[0]?.signal).toBe('subagent_spawn')
  })

  test('provides an explicit runtime kill switch', () => {
    expect(isSkillSearchEnabled()).toBe(true)
    process.env.CLAUDE_CODE_SKILL_SEARCH = '0'
    expect(isSkillSearchEnabled()).toBe(false)
    expect(
      startSkillDiscoveryPrefetch(
        'database',
        [userMessage('database')],
        context([]),
        index,
      ),
    ).toBeNull()
  })
})
