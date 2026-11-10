import type { TextBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import React from 'react'
import { Box, Text } from '../../ink.js'

export function UserForkBoilerplateMessage({
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
      'Fork boilerplate rendering is unavailable in this build.',
    ),
  )
}
