import { shouldEnableClaudeInChrome } from '../utils/claudeInChrome/setup.js'
import { useStartupNotification } from './notifs/useStartupNotification.js'

function getChromeFlag(): boolean | undefined {
  if (process.argv.includes('--chrome')) return true
  if (process.argv.includes('--no-chrome')) return false
  return undefined
}

/** The legacy hook name is retained; open CDP never checks for an extension. */
export function useChromeExtensionNotification(): void {
  useStartupNotification(async () => {
    if (!shouldEnableClaudeInChrome(getChromeFlag())) return null
    return {
      key: 'claude-in-chrome-open-cdp-enabled',
      text: 'Real Chrome uses a dedicated profile over public loopback CDP · /chrome for setup and reconnect',
      priority: 'low' as const,
    }
  })
}
