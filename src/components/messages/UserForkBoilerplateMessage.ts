import type { TextBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import React from 'react'
import {
  FORK_BOILERPLATE_TAG,
  FORK_DIRECTIVE_PREFIX,
} from '../../constants/xml.js'
import { Box, Text } from '../../ink.js'

const FORK_MESSAGE_PATTERN = new RegExp(
  `^<${FORK_BOILERPLATE_TAG}>\\n([\\s\\S]*?)\\n</${FORK_BOILERPLATE_TAG}>\\n\\n${FORK_DIRECTIVE_PREFIX}([\\s\\S]+)$`,
)

export function parseForkBoilerplateDirective(
  value: string,
): string | undefined {
  const match = FORK_MESSAGE_PATTERN.exec(value)
  if (
    !match ||
    !match[1]!.startsWith('STOP. READ THIS FIRST.') ||
    !match[2]!.trim() ||
    match[2]!.includes(
      `<${FORK_BOILERPLATE_TAG}>\nSTOP. READ THIS FIRST.`,
    )
  ) {
    return undefined
  }
  return match[2]
}

export function UserForkBoilerplateMessage({
  addMargin,
  param,
}: {
  addMargin: boolean
  param: TextBlockParam
}): React.ReactNode {
  const directive = parseForkBoilerplateDirective(param.text)
  return React.createElement(
    Box,
    { marginTop: addMargin ? 1 : 0 },
    React.createElement(Text, null, directive ?? param.text),
  )
}
