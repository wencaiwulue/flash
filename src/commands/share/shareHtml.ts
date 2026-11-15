import { realpathSync } from 'fs'
import { writeFile } from 'fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'path'
import type { Message } from '../../types/message.js'
import { getCwd } from '../../utils/cwd.js'

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

type RenderBlock = {
  type?: string
  text?: string
  name?: string
  input?: unknown
  content?: unknown
  is_error?: boolean
}

function textForBlock(block: RenderBlock, includeToolOutput: boolean): string {
  if (block.type === 'text') return block.text ?? ''
  if (block.type === 'tool_use' && includeToolOutput) {
    return `[Tool call: ${block.name ?? 'unknown'}]\n${JSON.stringify(block.input ?? null, null, 2)}`
  }
  if (block.type === 'tool_result' && includeToolOutput) {
    const content =
      typeof block.content === 'string'
        ? block.content
        : Array.isArray(block.content)
          ? block.content
              .map(item => textForBlock(item as RenderBlock, true))
              .filter(Boolean)
              .join('\n')
          : JSON.stringify(block.content ?? null, null, 2)
    return `[Tool result${block.is_error ? ' (error)' : ''}]\n${content}`
  }
  if (block.type === 'image') return '[Image]'
  if (block.type === 'document') return '[Document]'
  return ''
}

function messageText(message: Message, includeToolOutput: boolean): string {
  if (message.type === 'user' || message.type === 'assistant') {
    const content = message.message.content
    if (typeof content === 'string') return content
    return content
      .map(block => textForBlock(block as RenderBlock, includeToolOutput))
      .filter(Boolean)
      .join('\n\n')
  }
  if (message.type === 'system' && 'content' in message) {
    return typeof message.content === 'string' ? message.content : ''
  }
  return ''
}

export function getSharePreview(messages: Message[]): string {
  const preview = messages
    .map(message => messageText(message, false))
    .filter(Boolean)
    .join('\n\n')
  return preview.length > 4000 ? `${preview.slice(0, 4000)}\n…` : preview
}

export function renderConversationToHtml(
  messages: Message[],
  { includeToolOutput }: { includeToolOutput: boolean },
): string {
  const sections = messages
    .map(message => {
      const text = messageText(message, includeToolOutput)
      if (!text) return ''
      const role =
        message.type === 'user'
          ? 'User'
          : message.type === 'assistant'
            ? 'Claude'
            : 'System'
      return `<section class="message ${message.type}"><h2>${role}</h2><pre>${escapeHtml(text)}</pre></section>`
    })
    .filter(Boolean)
    .join('\n')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>flash conversation</title>
<style>
body{font-family:ui-sans-serif,system-ui,sans-serif;max-width:960px;margin:2rem auto;padding:0 1rem;background:#f7f7f5;color:#20201e}
h1{font-size:1.5rem}.message{background:white;border:1px solid #ddd;border-radius:8px;padding:1rem;margin:1rem 0}h2{font-size:.85rem;text-transform:uppercase;color:#666}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-family:ui-monospace,monospace;margin:0}
</style>
</head>
<body>
<h1>flash conversation</h1>
${sections || '<p>No conversation messages.</p>'}
</body>
</html>
`
}

export function resolveShareOutputPath(filename: string, cwd = getCwd()): string {
  const requested = filename.trim()
  if (!requested || requested.includes('\0')) {
    throw new Error('Provide a non-empty output filename ending in .html.')
  }
  if (!requested.toLowerCase().endsWith('.html')) {
    throw new Error('The output filename must end in .html.')
  }
  if (isAbsolute(requested)) {
    throw new Error('Use a relative output path inside the current working directory.')
  }
  const destination = resolve(cwd, requested)
  const fromCwd = relative(cwd, destination)
  if (fromCwd === '..' || fromCwd.startsWith(`..${sep}`) || isAbsolute(fromCwd)) {
    throw new Error('The output path must stay inside the current working directory.')
  }

  // Lexical normalization alone does not stop a symlinked parent directory
  // from redirecting the write outside the workspace. The parent must exist;
  // writeSharedHtml deliberately does not create directories.
  const realCwd = realpathSync(cwd)
  const realParent = realpathSync(dirname(destination))
  const realFromCwd = relative(realCwd, realParent)
  if (
    realFromCwd === '..' ||
    realFromCwd.startsWith(`..${sep}`) ||
    isAbsolute(realFromCwd)
  ) {
    throw new Error('The output path must not escape through a symbolic link.')
  }
  return destination
}

export async function writeSharedHtml(
  destination: string,
  html: string,
): Promise<void> {
  await writeFile(destination, html, { encoding: 'utf8', flag: 'wx' })
}
