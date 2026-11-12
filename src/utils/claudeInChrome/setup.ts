import {
  assertClaudeInChromeMcpAvailable,
  getBrowserTools,
} from './browserTools.js'
import { join } from 'path'
import { fileURLToPath } from 'url'
import {
  getIsNonInteractiveSession,
  getSessionBypassPermissionsMode,
} from '../../bootstrap/state.js'
import type { ScopedMcpServerConfig } from '../../services/mcp/types.js'
import { isInBundledMode } from '../bundledMode.js'
import { getGlobalConfig } from '../config.js'
import { getClaudeConfigHomeDir, isEnvDefinedFalsy, isEnvTruthy } from '../envUtils.js'
import { getPlatform } from '../platform.js'
import { CLAUDE_IN_CHROME_MCP_SERVER_NAME } from './common.js'
import { getChromeSystemPrompt } from './prompt.js'

export function shouldEnableClaudeInChrome(chromeFlag?: boolean): boolean {
  if (getIsNonInteractiveSession() && chromeFlag !== true) return false
  if (chromeFlag !== undefined) return chromeFlag
  if (isEnvTruthy(process.env.CLAUDE_CODE_ENABLE_CFC)) return true
  if (isEnvDefinedFalsy(process.env.CLAUDE_CODE_ENABLE_CFC)) return false
  return getGlobalConfig().claudeInChromeDefaultEnabled ?? false
}

/** Open CDP is opt-in; extension detection must never auto-enable it. */
export async function shouldAutoEnableClaudeInChrome(): Promise<boolean> {
  return false
}

export function getOpenChromeProfileDir(): string {
  return join(getClaudeConfigHomeDir(), 'chrome', 'open-cdp-profile')
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

export function getOpenChromeLaunchCommand(): string {
  const endpoint = new URL(
    process.env.CLAUDE_CHROME_CDP_ENDPOINT ?? 'http://127.0.0.1:9222',
  )
  const executable =
    getPlatform() === 'macos'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : 'google-chrome'
  return [
    shellQuote(executable),
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${endpoint.port || '9222'}`,
    `--user-data-dir=${shellQuote(getOpenChromeProfileDir())}`,
  ].join(' ')
}

/** Configure only the public Playwright CDP backend, never native pairing. */
export async function setupClaudeInChrome(): Promise<{
  mcpConfig: Record<string, ScopedMcpServerConfig>
  allowedTools: string[]
  systemPrompt: string
}> {
  await assertClaudeInChromeMcpAvailable()
  const allowedTools = (await getBrowserTools()).map(
    tool => `mcp__claude-in-chrome__${tool.name}`,
  )

  const env: Record<string, string> = {
    CLAUDE_CHROME_PERMISSION_MODE: getSessionBypassPermissionsMode()
      ? 'skip_all_permission_checks'
      : (process.env.CLAUDE_CHROME_PERMISSION_MODE ?? 'ask'),
  }
  for (const key of [
    'CLAUDE_CHROME_CDP_ENDPOINT',
    'CLAUDE_CHROME_CDP_TIMEOUT_MS',
    'CLAUDE_CHROME_ALLOWED_ORIGINS',
    'PLAYWRIGHT_MCP_ALLOWED_ORIGINS',
  ]) {
    if (process.env[key]) env[key] = process.env[key]
  }

  if (isInBundledMode()) {
    return {
      mcpConfig: {
        [CLAUDE_IN_CHROME_MCP_SERVER_NAME]: {
          type: 'stdio' as const,
          command: process.execPath,
          args: ['--claude-in-chrome-mcp'],
          scope: 'dynamic' as const,
          env,
        },
      },
      allowedTools,
      systemPrompt: getChromeSystemPrompt(),
    }
  }

  const cliPath = join(fileURLToPath(import.meta.url), '..', 'cli.js')
  return {
    mcpConfig: {
      [CLAUDE_IN_CHROME_MCP_SERVER_NAME]: {
        type: 'stdio' as const,
        command: process.execPath,
        args: [cliPath, '--claude-in-chrome-mcp'],
        scope: 'dynamic' as const,
        env,
      },
    },
    allowedTools,
    systemPrompt: getChromeSystemPrompt(),
  }
}
