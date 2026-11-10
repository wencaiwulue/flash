import type { ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import type { Attachment } from '../../utils/attachments.js'

export type SkillDiscoveryAttachment = Extract<
  Attachment,
  { type: 'skill_discovery' }
>

export type SkillDiscoveryPrefetch = {
  readonly attachments: Promise<SkillDiscoveryAttachment[]>
}

export async function getTurnZeroSkillDiscovery(
  _input: string,
  _messages: Message[],
  _context: ToolUseContext,
): Promise<SkillDiscoveryAttachment[]> {
  return []
}

export function startSkillDiscoveryPrefetch(
  _input: string | null,
  _messages: Message[],
  _context: ToolUseContext,
): SkillDiscoveryPrefetch | null {
  return null
}

export async function collectSkillDiscoveryPrefetch(
  _prefetch: SkillDiscoveryPrefetch,
): Promise<SkillDiscoveryAttachment[]> {
  return []
}
