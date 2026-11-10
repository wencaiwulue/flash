import type { ToolUseContext } from '../Tool.js'
import type { Message } from '../types/message.js'
import type { CacheSafeParams } from '../utils/forkedAgent.js'
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js'
import { logForDebugging } from '../utils/debug.js'
import { roll } from './companion.js'

export type CompanionObserverResponse = {
  name?: string
  personality?: string
  reaction?: string
}

type ObserverDependencies = {
  run?: (question: string, cacheSafeParams: CacheSafeParams) => Promise<string | null>
  now?: () => number
  getConfig?: typeof getGlobalConfig
  saveConfig?: typeof saveGlobalConfig
}

let inFlight = false

function latestUserText(messages: Message[]): string {
  const message = messages.findLast(message => message.type === 'user')
  if (message?.type !== 'user') return ''
  const content = message.message.content
  if (typeof content === 'string') return content.slice(0, 4_000)
  return content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .slice(0, 4_000)
}

export function parseCompanionObserverResponse(
  text: string,
): CompanionObserverResponse | undefined {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    const value = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
    return {
      ...(typeof value.name === 'string' ? { name: value.name.slice(0, 40) } : {}),
      ...(typeof value.personality === 'string'
        ? { personality: value.personality.slice(0, 300) }
        : {}),
      ...(typeof value.reaction === 'string'
        ? { reaction: value.reaction.slice(0, 500) }
        : {}),
    }
  } catch {
    return undefined
  }
}

async function runObserverModel(
  question: string,
  cacheSafeParams: CacheSafeParams,
): Promise<string | null> {
  const { runSideQuestion } = await import('../utils/sideQuestion.js')
  return (await runSideQuestion({ question, cacheSafeParams })).response
}

export async function fireCompanionObserver(
  messages: Message[],
  onReaction: (reaction: string) => void,
  context?: ToolUseContext,
  dependencies: ObserverDependencies = {},
): Promise<void> {
  if (!context || inFlight) return
  const config = (dependencies.getConfig ?? getGlobalConfig)()
  if (config.companionMuted) return
  const stored = config.companion
  const userText = latestUserText(messages)
  if (stored && !userText.trim()) return
  inFlight = true
  try {
    const { bones, inspirationSeed } = roll(
      config.oauthAccount?.accountUuid ?? config.userID ?? 'anon',
    )
    const { getUserContext, getSystemContext } = await import('../context.js')
    const { asSystemPrompt } = await import('../utils/systemPromptType.js')
    const cacheSafeParams: CacheSafeParams = {
      systemPrompt: context.renderedSystemPrompt ?? asSystemPrompt([]),
      userContext: await getUserContext(),
      systemContext: await getSystemContext(),
      toolUseContext: context,
      forkContextMessages: messages,
    }
    const question = stored
      ? `You are ${stored.name}, a ${bones.rarity} ${bones.species} companion with this personality: ${stored.personality}. Write one short reaction to the user's latest message. Return JSON only: {"reaction":"..."}.\n\nLatest message:\n${userText}`
      : `Create a coding companion from these deterministic traits: ${JSON.stringify(bones)}. Seed ${inspirationSeed} is only inspiration, do not change the traits. Return JSON only: {"name":"...","personality":"...","reaction":"..."}. Keep name under 40 chars, personality under 300 chars, and reaction under 500 chars.\n\nLatest message:\n${userText}`
    const response = parseCompanionObserverResponse(
      (await (dependencies.run ?? runObserverModel)(question, cacheSafeParams)) ??
        '',
    )
    if (!response) return
    if (!stored && response.name && response.personality) {
      const { name, personality } = response
      ;(dependencies.saveConfig ?? saveGlobalConfig)(current => ({
        ...current,
        companion: {
          name,
          personality,
          hatchedAt: (dependencies.now ?? Date.now)(),
        },
      }))
    }
    if (response.reaction?.trim()) onReaction(response.reaction.trim())
  } catch (error) {
    logForDebugging(`Companion observer failed: ${String(error)}`)
  } finally {
    inFlight = false
  }
}
