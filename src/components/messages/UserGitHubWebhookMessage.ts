import type { TextBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import React from 'react'
import { Box, Text } from '../../ink.js'

export function UserGitHubWebhookMessage({
  addMargin,
  param: _param,
}: {
  addMargin: boolean
  param: TextBlockParam
}): React.ReactNode {
  return React.createElement(
    Box,
    { marginTop: addMargin ? 1 : 0 },
    React.createElement(
      Text,
      { dimColor: true },
      'GitHub webhook messages are unavailable in this build.',
    ),
  )
}
