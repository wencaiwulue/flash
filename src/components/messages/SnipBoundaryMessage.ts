import React from 'react'
import { Box, Text } from '../../ink.js'
import type { Message } from '../../types/message.js'

export function SnipBoundaryMessage({
  message: _message,
}: {
  message: Message
}): React.ReactNode {
  return React.createElement(
    Box,
    { marginY: 1 },
    React.createElement(Text, { dimColor: true }, '✻ Older history snipped'),
  )
}
