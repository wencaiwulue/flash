import type { Command, LocalJSXCommandContext, LocalJSXCommandOnDone } from '../types/command.js'
import {
  isSnipRuntimeEnabled,
  snipCompactIfNeeded,
} from '../services/compact/snipCompact.js'

async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
): Promise<null> {
  const result = snipCompactIfNeeded(context.messages, { force: true })
  if (!result.executed) {
    onDone('No older messages are eligible to snip.')
    return null
  }
  context.setMessages(() => result.messages)
  onDone(
    result.boundaryMessage?.type === 'system'
      ? result.boundaryMessage.content
      : 'Older history snipped.',
  )
  return null
}

export default {
  type: 'local-jsx',
  name: 'force-snip',
  description: 'Snip older history while preserving recent work and tool-result pairs',
  immediate: true,
  isEnabled: isSnipRuntimeEnabled,
  load: () => Promise.resolve({ call }),
} satisfies Command
