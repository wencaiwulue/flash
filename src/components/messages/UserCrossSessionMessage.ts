import type { TextBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import React from 'react'
import { parseCrossSessionMessage } from '../../bridge/crossSessionMessages.js'
import { Box, Text } from '../../ink.js'

export {
  formatCrossSessionMessage,
  parseCrossSessionMessage,
} from '../../bridge/crossSessionMessages.js'
export type {
  CrossSessionMessage,
  CrossSessionTransport,
} from '../../bridge/crossSessionMessages.js'

export function UserCrossSessionMessage({
  addMargin,
  param,
}: {
  addMargin: boolean
  param: TextBlockParam
}): React.ReactNode {
  const parsed = parseCrossSessionMessage(param.text)
  if (!parsed) {
    return React.createElement(
      Box,
      { marginTop: addMargin ? 1 : 0 },
      React.createElement(Text, null, param.text),
    )
  }
  return React.createElement(
    Box,
    { flexDirection: 'column', marginTop: addMargin ? 1 : 0 },
    React.createElement(
      Text,
      { dimColor: true },
      `Cross-session message · ${parsed.transport}`,
    ),
    React.createElement(Text, { bold: true }, `From: ${parsed.from}`),
    React.createElement(Text, null, parsed.text),
  )
}
