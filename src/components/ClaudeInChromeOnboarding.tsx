import React from 'react'
import { logEvent } from 'src/services/analytics/index.js'
// eslint-disable-next-line custom-rules/prefer-use-keybindings -- enter to continue
import { Box, Newline, Text, useInput } from '../ink.js'
import {
  getOpenChromeLaunchCommand,
  getOpenChromeProfileDir,
} from '../utils/claudeInChrome/setup.js'
import { saveGlobalConfig } from '../utils/config.js'
import { Dialog } from './design-system/Dialog.js'

type Props = {
  onDone(): void
}

export function ClaudeInChromeOnboarding({ onDone }: Props): React.ReactNode {
  React.useEffect(() => {
    logEvent('tengu_claude_in_chrome_onboarding_shown', {})
    saveGlobalConfig(current => ({
      ...current,
      hasCompletedClaudeInChromeOnboarding: true,
    }))
  }, [])

  useInput((_input, key) => {
    if (key.return) onDone()
  })

  return (
    <Dialog
      title="Claude in Chrome — Open CDP"
      onCancel={onDone}
      color="chromeYellow"
    >
      <Box flexDirection="column" gap={1}>
        <Text>
          Claude can control a dedicated Google Chrome instance through public
          loopback CDP. Its persistent profile keeps the tabs, cookies, and
          login state for that dedicated instance only.
        </Text>
        <Text color="warning">
          This does not implement private Claude Chrome extension pairing and
          does not attach to your everyday default Chrome profile.
        </Text>
        <Text>Persistent profile: {getOpenChromeProfileDir()}</Text>
        <Text>Start Chrome yourself with:</Text>
        <Text>{getOpenChromeLaunchCommand()}</Text>
        <Text dimColor>
          Then run claude --chrome. Use /chrome to view connection status and
          reconnect. Disconnecting does not close Chrome or clear its tabs.
        </Text>
        <Newline />
        <Text dimColor>Press Enter to continue.</Text>
      </Box>
    </Dialog>
  )
}
