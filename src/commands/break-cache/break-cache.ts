import type { LocalCommandCall } from '../../types/command.js'
import { clearSessionCaches } from '../clear/caches.js'

export async function runBreakCache(
  args: string,
  clear: typeof clearSessionCaches = clearSessionCaches,
): Promise<string> {
  if (args.trim()) return 'Usage: /break-cache'
  const result = await clear()
  const lines = [
    'Process-local derived caches cleared; commands, skills, file suggestions, and repository detection will rebuild on demand.',
    `Completed cache groups: ${result.completed.join(', ')}.`,
  ]
  if (result.failed.length > 0) {
    lines.push(
      `Failed cache groups: ${result.failed.map(({ name, error }) => `${name} (${error})`).join('; ')}.`,
    )
  }
  lines.push(
    'Conversation messages, running tasks, local files, usage statistics, and provider limits were not changed. Server-side prompt caches are not affected by this command.',
  )
  return lines.join('\n')
}

export const call: LocalCommandCall = async args => ({
  type: 'text',
  value: await runBreakCache(args),
})
