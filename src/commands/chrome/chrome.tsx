import React, { useState } from 'react'
import {
  type OptionWithDescription,
  Select,
} from '../../components/CustomSelect/select.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { Box, Text } from '../../ink.js'
import { clearServerCache } from '../../services/mcp/client.js'
import { useAppState } from '../../state/AppState.js'
import { CLAUDE_IN_CHROME_MCP_SERVER_NAME } from '../../utils/claudeInChrome/common.js'
import {
  getOpenChromeLaunchCommand,
  getOpenChromeProfileDir,
} from '../../utils/claudeInChrome/setup.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { env } from '../../utils/env.js'

type MenuAction = 'reconnect' | 'toggle-default'

type Props = {
  onDone: (result?: string) => void
  configEnabled: boolean | undefined
  isWSL: boolean
}

function ClaudeInChromeMenu({
  onDone,
  configEnabled,
  isWSL,
}: Props): React.ReactNode {
  const mcpClients = useAppState(s => s.mcp.clients)
  const [enabledByDefault, setEnabledByDefault] = useState(
    configEnabled ?? false,
  )
  const chromeClient = mcpClients.find(
    client => client.name === CLAUDE_IN_CHROME_MCP_SERVER_NAME,
  )
  const endpoint =
    process.env.CLAUDE_CHROME_CDP_ENDPOINT ?? 'http://127.0.0.1:9222'
  const hasOriginAllowlist = Boolean(
    process.env.CLAUDE_CHROME_ALLOWED_ORIGINS ??
      process.env.PLAYWRIGHT_MCP_ALLOWED_ORIGINS,
  )

  async function handleAction(action: MenuAction): Promise<void> {
    if (action === 'toggle-default') {
      const newValue = !enabledByDefault
      saveGlobalConfig(current => ({
        ...current,
        claudeInChromeDefaultEnabled: newValue,
      }))
      setEnabledByDefault(newValue)
      return
    }

    if (!chromeClient) {
      onDone('Chrome CDP is not enabled. Restart with claude --chrome after starting the dedicated Chrome instance.')
      return
    }
    await clearServerCache(CLAUDE_IN_CHROME_MCP_SERVER_NAME, chromeClient.config)
    onDone('Chrome CDP connection reset. Reconnecting does not close Chrome or its tabs; no isolated browser fallback is used.')
  }

  const options: OptionWithDescription<MenuAction>[] = [
    {
      label: 'Reconnect real Chrome over public CDP',
      value: 'reconnect',
      description: 'Detach and reconnect without closing the browser or its tabs',
    },
    {
      label: `Enabled by default: ${enabledByDefault ? 'Yes' : 'No'}`,
      value: 'toggle-default',
    },
  ]

  return (
    <Dialog
      title="Claude in Chrome — Open CDP"
      onCancel={() => onDone()}
      color="chromeYellow"
    >
      <Box flexDirection="column" gap={1}>
        <Text>
          Controls a dedicated, persistent Google Chrome profile through public
          loopback CDP and Playwright MCP. Existing tabs, cookies, and login
          state belong to that dedicated instance.
        </Text>
        <Text color="warning">
          This is not compatible with private Claude Chrome extension pairing,
          native messaging, or the Playwright browser extension. It does not
          attach to your everyday default Chrome profile.
        </Text>
        {isWSL && (
          <Text color="error">Open Chrome CDP is not supported in WSL.</Text>
        )}
        <Text>
          Status:{' '}
          {chromeClient?.type === 'connected' ? (
            <Text color="success">Connected to real Chrome CDP</Text>
          ) : chromeClient?.type === 'failed' ? (
            <Text color="error">Connection failed (no isolated fallback)</Text>
          ) : (
            <Text color="inactive">Not connected</Text>
          )}
        </Text>
        <Text>Endpoint: {endpoint} (loopback only)</Text>
        <Text>Persistent profile: {getOpenChromeProfileDir()}</Text>
        <Text>
          Origins:{' '}
          {hasOriginAllowlist
            ? 'restricted by the configured allowlist'
            : 'all sites allowed (no origin allowlist configured)'}
        </Text>
        <Text>
          Start this dedicated instance yourself, then restart with claude
          --chrome or select reconnect:
        </Text>
        <Text>{getOpenChromeLaunchCommand()}</Text>
        <Text dimColor>
          Do not run a second Chrome instance with the same locked profile.
          Claude never kills Chrome. browser_close is disabled; disconnect MCP
          or explicitly close an individual tab instead.
        </Text>
        {!isWSL && (
          <Select
            options={options}
            onChange={action => void handleAction(action)}
            hideIndexes
          />
        )}
        <Text dimColor>Usage: claude --chrome / claude --no-chrome</Text>
      </Box>
    </Dialog>
  )
}

export const call = async function (
  onDone: (result?: string) => void,
): Promise<React.ReactNode> {
  const config = getGlobalConfig()
  return (
    <ClaudeInChromeMenu
      onDone={onDone}
      configEnabled={config.claudeInChromeDefaultEnabled}
      isWSL={env.isWslEnvironment()}
    />
  )
}
