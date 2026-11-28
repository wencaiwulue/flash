import { realpathSync } from 'fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'path'
import React from 'react'
import { ExportDialog } from '../../components/ExportDialog.js'
import type { ToolUseContext } from '../../Tool.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import type { Message } from '../../types/message.js'
import { getCwd } from '../../utils/cwd.js'
import { renderMessagesToPlainText } from '../../utils/exportRenderer.js'
import { writeFileSync_DEPRECATED } from '../../utils/slowOperations.js'

function formatTimestamp(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  const seconds = String(date.getSeconds()).padStart(2, '0')
  return `${year}-${month}-${day}-${hours}${minutes}${seconds}`
}

export function extractFirstPrompt(messages: Message[]): string {
  const firstUserMessage = messages.find(msg => msg.type === 'user')

  if (!firstUserMessage || firstUserMessage.type !== 'user') {
    return ''
  }

  const content = firstUserMessage.message?.content
  let result = ''

  if (typeof content === 'string') {
    result = content.trim()
  } else if (Array.isArray(content)) {
    const textContent = content.find(item => item.type === 'text')
    if (textContent && 'text' in textContent) {
      result = textContent.text.trim()
    }
  }

  // Take first line only and limit length
  result = result.split('\n')[0] || ''
  if (result.length > 50) {
    result = result.substring(0, 49) + '…'
  }

  return result
}

export function sanitizeFilename(text: string): string {
  // Replace special characters with hyphens
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '') // Remove special chars
    .replace(/\s+/g, '-') // Replace spaces with hyphens
    .replace(/-+/g, '-') // Replace multiple hyphens with single
    .replace(/^-|-$/g, '') // Remove leading/trailing hyphens
}

export function resolveExportOutputPath(
  filename: string,
  cwd = getCwd(),
): string {
  const requested = filename.trim()
  if (!requested || requested.includes('\0')) {
    throw new Error('Provide a non-empty output filename.')
  }
  const finalFilename = requested.endsWith('.txt')
    ? requested
    : requested.replace(/\.[^.]+$/, '') + '.txt'
  if (isAbsolute(finalFilename)) {
    throw new Error(
      'Use a relative output path inside the current working directory.',
    )
  }

  const destination = resolve(cwd, finalFilename)
  const fromCwd = relative(cwd, destination)
  if (fromCwd === '..' || fromCwd.startsWith(`..${sep}`) || isAbsolute(fromCwd)) {
    throw new Error(
      'The output path must stay inside the current working directory.',
    )
  }

  // Do not let a symlinked parent redirect the write outside the workspace.
  // The parent must exist because /export does not create directories.
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

async function exportWithReactRenderer(
  context: ToolUseContext,
): Promise<string> {
  const tools = context.options.tools || []
  return renderMessagesToPlainText(context.messages, tools)
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: ToolUseContext,
  args: string,
): Promise<React.ReactNode> {
  // Render the conversation content
  const content = await exportWithReactRenderer(context)

  // If args are provided, write directly to file and skip dialog
  const filename = args.trim()
  if (filename) {
    try {
      const filepath = resolveExportOutputPath(filename)
      writeFileSync_DEPRECATED(filepath, content, {
        encoding: 'utf-8',
        flush: true,
        flag: 'wx',
      })
      onDone(`Conversation exported to: ${filepath}`)
      return null
    } catch (error) {
      onDone(
        `Failed to export conversation: ${error instanceof Error ? error.message : 'Unknown error'}`,
      )
      return null
    }
  }

  // Generate default filename from first prompt or timestamp
  const firstPrompt = extractFirstPrompt(context.messages)
  const timestamp = formatTimestamp(new Date())

  let defaultFilename: string
  if (firstPrompt) {
    const sanitized = sanitizeFilename(firstPrompt)
    defaultFilename = sanitized
      ? `${timestamp}-${sanitized}.txt`
      : `conversation-${timestamp}.txt`
  } else {
    defaultFilename = `conversation-${timestamp}.txt`
  }

  // Return the dialog component when no args provided
  return (
    <ExportDialog
      content={content}
      defaultFilename={defaultFilename}
      onDone={result => {
        onDone(result.message)
      }}
    />
  )
}
