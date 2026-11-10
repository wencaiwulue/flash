import { oscColor, type TerminalQuerier } from '../ink/terminal-querier.js'
import {
  getSystemThemeName,
  setCachedSystemTheme,
  themeFromOscColor,
  type SystemTheme,
} from './systemTheme.js'

const POLL_INTERVAL_MS = 5_000

/** Poll OSC 11 without overlapping terminal query batches. */
export function watchSystemTheme(
  querier: TerminalQuerier,
  onChange: (theme: SystemTheme) => void,
): () => void {
  let stopped = false
  let polling = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const poll = async (): Promise<void> => {
    if (stopped || polling) return
    polling = true
    try {
      const [response] = await Promise.all([
        querier.send(oscColor(11)),
        querier.flush(),
      ])
      const theme = response ? themeFromOscColor(response.data) : undefined
      if (!stopped && theme && theme !== getSystemThemeName()) {
        setCachedSystemTheme(theme)
        onChange(theme)
      }
    } catch {
      // A closed stdin/stdout ends live updates; the cached theme remains valid.
    } finally {
      polling = false
      if (!stopped) {
        timer = setTimeout(() => void poll(), POLL_INTERVAL_MS)
      }
    }
  }

  void poll()
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
}
