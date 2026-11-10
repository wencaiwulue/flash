import Fuse from 'fuse.js'
import type { Command } from '../../commands.js'
import type { ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import { getCwd } from '../../utils/cwd.js'
import { isEnvDefinedFalsy } from '../../utils/envUtils.js'

export type SkillIndexEntry = {
  name: string
  description: string
  whenToUse: string
}

export type LocalSkillMatch = {
  name: string
  description: string
  score: number
}

const indexCache = new Map<string, Promise<SkillIndexEntry[]>>()

export function clearSkillIndexCache(): void {
  indexCache.clear()
}

function toIndexEntry(command: Command): SkillIndexEntry {
  return {
    name: command.name,
    description: command.description,
    whenToUse: command.whenToUse ?? '',
  }
}

async function loadLocalSkillIndex(cwd: string): Promise<SkillIndexEntry[]> {
  // Lazy import breaks commands.ts -> localSearch -> commands.ts initialization.
  const { getSkillToolCommands } = await import('../../commands.js')
  const commands = await getSkillToolCommands(cwd)
  return commands
    .filter(
      command =>
        command.loadedFrom !== 'bundled' && command.loadedFrom !== 'mcp',
    )
    .map(toIndexEntry)
}

export function getLocalSkillIndex(cwd = getCwd()): Promise<SkillIndexEntry[]> {
  let index = indexCache.get(cwd)
  if (!index) {
    index = loadLocalSkillIndex(cwd).catch(error => {
      indexCache.delete(cwd)
      throw error
    })
    indexCache.set(cwd, index)
  }
  return index
}

export function searchSkillIndex(
  entries: SkillIndexEntry[],
  query: string,
  options?: { limit?: number; exclude?: ReadonlySet<string> },
): LocalSkillMatch[] {
  const normalized = query.trim()
  if (!normalized) return []
  const exclude = options?.exclude
  const candidates = entries.filter(entry => !exclude?.has(entry.name))
  if (candidates.length === 0) return []
  const fuse = new Fuse(candidates, {
    keys: [
      { name: 'name', weight: 0.5 },
      { name: 'description', weight: 0.3 },
      { name: 'whenToUse', weight: 0.2 },
    ],
    threshold: 0.4,
    ignoreLocation: true,
    includeScore: true,
    minMatchCharLength: 2,
  })
  const limit = Math.max(1, Math.min(options?.limit ?? 5, 10))
  let results = fuse.search(normalized)
  if (results.length === 0) {
    const stopWords = new Set([
      'about',
      'after',
      'before',
      'check',
      'could',
      'from',
      'have',
      'into',
      'please',
      'should',
      'that',
      'this',
      'with',
      'would',
    ])
    const terms = Array.from(
      new Set(
        normalized
          .toLowerCase()
          .split(/[^\p{L}\p{N}_-]+/u)
          .filter(term => term.length >= 3 && !stopWords.has(term)),
      ),
    )
    const best = new Map<
      string,
      { item: SkillIndexEntry; score: number; matchedTerms: number }
    >()
    for (const term of terms) {
      for (const result of fuse.search(term)) {
        const current = best.get(result.item.name)
        best.set(result.item.name, {
          item: result.item,
          score: Math.min(current?.score ?? 1, result.score ?? 1),
          matchedTerms: (current?.matchedTerms ?? 0) + 1,
        })
      }
    }
    results = Array.from(best.values())
      .sort((a, b) => b.matchedTerms - a.matchedTerms || a.score - b.score)
      .map(result => ({
        item: result.item,
        score: result.score,
        refIndex: 0,
      }))
  }
  return results.slice(0, limit).map(result => ({
    name: result.item.name,
    description: result.item.description,
    score: result.score ?? 1,
  }))
}

export function getVisibleSkillNames(messages: Message[]): Set<string> {
  const names = new Set<string>()
  for (const message of messages) {
    if (message.type === 'attachment' && message.attachment.type === 'skill_discovery') {
      for (const skill of message.attachment.skills) names.add(skill.name)
      continue
    }
    if (message.type !== 'assistant') continue
    for (const block of message.message.content) {
      if (block.type !== 'tool_use' || block.name !== 'Skill') continue
      const input = block.input as { skill?: unknown }
      if (typeof input.skill === 'string') names.add(input.skill)
    }
  }
  return names
}

export async function searchLocalSkills(
  query: string,
  context: ToolUseContext,
  options?: { limit?: number; index?: SkillIndexEntry[] },
): Promise<LocalSkillMatch[]> {
  if (isEnvDefinedFalsy(process.env.CLAUDE_CODE_SKILL_SEARCH)) return []
  const [index, visible] = await Promise.all([
    options?.index ?? getLocalSkillIndex(),
    Promise.resolve(getVisibleSkillNames(context.messages)),
  ])
  const matches = searchSkillIndex(index, query, {
    limit: options?.limit,
    exclude: visible,
  })

  for (const match of matches) context.discoveredSkillNames?.add(match.name)
  return matches
}
