import type { ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import type { Attachment } from '../../utils/attachments.js'
import { logForDebugging } from '../../utils/debug.js'
import { isSkillSearchEnabled } from './featureCheck.js'
import {
  getVisibleSkillNames,
  searchLocalSkills,
  type SkillIndexEntry,
} from './localSearch.js'
import { searchRemoteSkills } from './remoteSearch.js'
import type { DiscoverySignal } from './signals.js'

export type SkillDiscoveryAttachment = Extract<
  Attachment,
  { type: 'skill_discovery' }
>

export type SkillDiscoveryPrefetch = {
  readonly attachments: Promise<SkillDiscoveryAttachment[]>
}

const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit', 'MultiEdit'])

function latestUserText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.type !== 'user') continue
    const content = message.message.content
    if (typeof content === 'string') return content
    const text = content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')
    if (text) return text
  }
  return ''
}

function lastDiscoveryIndex(messages: Message[]): number {
  return messages.findLastIndex(
    message =>
      message.type === 'attachment' &&
      message.attachment.type === 'skill_discovery',
  )
}

export function findWritePivot(messages: Message[]): number {
  const discoveredAt = lastDiscoveryIndex(messages)
  return messages.findLastIndex((message, index) => {
    if (index <= discoveredAt || message.type !== 'assistant') return false
    return message.message.content.some(
      block => block.type === 'tool_use' && WRITE_TOOLS.has(block.name),
    )
  })
}

export function buildDiscoveryQuery(
  input: string | null,
  messages: Message[],
  signal: DiscoverySignal,
): string {
  if (input?.trim()) return input.trim().slice(0, 2_000)
  const parts = [latestUserText(messages)]
  if (signal === 'write_pivot') {
    const writeAt = findWritePivot(messages)
    const message = writeAt >= 0 ? messages[writeAt] : undefined
    if (message?.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type !== 'tool_use' || !WRITE_TOOLS.has(block.name)) continue
        const input = block.input as Record<string, unknown>
        for (const key of ['file_path', 'command', 'description']) {
          if (typeof input[key] === 'string') parts.push(input[key])
        }
      }
    }
  }
  return parts.filter(Boolean).join('\n').slice(0, 2_000)
}

async function discover(
  query: string,
  context: ToolUseContext,
  signal: DiscoverySignal,
  index?: SkillIndexEntry[],
): Promise<SkillDiscoveryAttachment[]> {
  if (!query.trim() || !isSkillSearchEnabled()) return []
  try {
    const [localSkills, remoteSkills] = await Promise.all([
      searchLocalSkills(query, context, { index }),
      searchRemoteSkills(query, { limit: 5 }).catch(error => {
        logForDebugging(`Remote skill discovery failed: ${String(error)}`)
        return []
      }),
    ])
    const visible = getVisibleSkillNames(context.messages)
    const remote = remoteSkills.filter(
      skill => !visible.has(`_canonical_${skill.slug}`),
    )
    if (localSkills.length === 0 && remote.length === 0) return []
    for (const skill of remote) {
      context.discoveredSkillNames?.add(`_canonical_${skill.slug}`)
    }
    return [
      {
        type: 'skill_discovery',
        skills: [
          ...localSkills.map(skill => ({
            name: skill.name,
            description: skill.description,
          })),
          ...remote.map(skill => ({
            name: `_canonical_${skill.slug}`,
            description: skill.description,
            ...(skill.shortId ? { shortId: skill.shortId } : {}),
          })),
        ],
        signal,
        source: remote.length > 0 && localSkills.length > 0 ? 'both' : remote.length > 0 ? 'aki' : 'native',
      },
    ]
  } catch (error) {
    logForDebugging(`Skill discovery failed: ${String(error)}`)
    return []
  }
}

export async function getTurnZeroSkillDiscovery(
  input: string,
  messages: Message[],
  context: ToolUseContext,
  index?: SkillIndexEntry[],
): Promise<SkillDiscoveryAttachment[]> {
  return discover(
    buildDiscoveryQuery(input, messages, 'user_input'),
    context,
    'user_input',
    index,
  )
}

export function startSkillDiscoveryPrefetch(
  input: string | null,
  messages: Message[],
  context: ToolUseContext,
  index?: SkillIndexEntry[],
): SkillDiscoveryPrefetch | null {
  if (!isSkillSearchEnabled()) return null
  const hasDiscovery = lastDiscoveryIndex(messages) >= 0
  const signal: DiscoverySignal | null = input !== null
    ? 'user_input'
    : context.agentId && !hasDiscovery
      ? 'subagent_spawn'
      : findWritePivot(messages) >= 0
        ? 'write_pivot'
        : null
  if (!signal) return null
  const query = buildDiscoveryQuery(input, messages, signal)
  if (!query.trim()) return null
  return { attachments: discover(query, context, signal, index) }
}

export async function collectSkillDiscoveryPrefetch(
  prefetch: SkillDiscoveryPrefetch,
): Promise<SkillDiscoveryAttachment[]> {
  try {
    return await prefetch.attachments
  } catch (error) {
    logForDebugging(`Local skill prefetch failed: ${String(error)}`)
    return []
  }
}
