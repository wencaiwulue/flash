import * as React from 'react'
import { MessageResponse } from '../../components/MessageResponse.js'
import { Text } from '../../ink.js'
import { renderToolResultMessage as renderDefaultMCPToolResultMessage } from '../../tools/MCPTool/UI.js'
import type { MCPToolResult } from '../../utils/mcpValidation.js'
import { truncateToWidth } from '../format.js'

export type { Tool } from '@modelcontextprotocol/sdk/types.js'
export type ChromeToolName = string

function renderChromeToolUseMessage(
  input: Record<string, unknown>,
  toolName: ChromeToolName,
  verbose: boolean,
): React.ReactNode {
  if (toolName === 'browser_navigate' && typeof input.url === 'string') {
    try {
      return new URL(input.url).hostname
    } catch {
      return truncateToWidth(input.url, 30)
    }
  }
  if (typeof input.ref === 'string') return `element ${input.ref}`
  if (toolName === 'browser_tabs' && typeof input.action === 'string') {
    return input.action
  }
  if (toolName === 'browser_evaluate' && verbose) {
    return typeof input.function === 'string' ? input.function : ''
  }
  return ''
}

export function renderChromeToolResultMessage(
  output: MCPToolResult,
  toolName: ChromeToolName,
  verbose: boolean,
): React.ReactNode {
  if (verbose) return renderDefaultMCPToolResultMessage(output, [], { verbose })
  const summaries: Record<string, string> = {
    browser_navigate: 'Navigation completed',
    browser_tabs: 'Tab action completed',
    browser_snapshot: 'Page snapshot captured',
    browser_take_screenshot: 'Screenshot captured',
    browser_console_messages: 'Console messages retrieved',
    browser_evaluate: 'Script executed',
    browser_click: 'Click completed',
    browser_type: 'Input completed',
  }
  const summary = summaries[toolName]
  return summary ? (
    <MessageResponse height={1}>
      <Text dimColor>{summary}</Text>
    </MessageResponse>
  ) : null
}

export function getClaudeInChromeMCPToolOverrides(toolName: string): {
  userFacingName: (input?: Record<string, unknown>) => string
  renderToolUseMessage: (
    input: Record<string, unknown>,
    options: { verbose: boolean },
  ) => React.ReactNode
  renderToolUseTag: (input: Partial<Record<string, unknown>>) => React.ReactNode
  renderToolResultMessage: (
    output: string | MCPToolResult,
    progressMessagesForMessage: unknown[],
    options: { verbose: boolean },
  ) => React.ReactNode
} {
  return {
    userFacingName: () => `Real Chrome CDP[${toolName}]`,
    renderToolUseMessage: (input, { verbose }) =>
      renderChromeToolUseMessage(input, toolName, verbose),
    // Private clau.de/chrome/tab links are not valid for public CDP tabs.
    renderToolUseTag: () => null,
    renderToolResultMessage: (output, _progress, { verbose }) => {
      if (typeof output === 'string') return null
      return renderChromeToolResultMessage(output, toolName, verbose)
    },
  }
}
