export type SentinelCategory = 'shell' | 'filesystem' | 'system_settings'

export const SENTINEL_APPS: Readonly<Record<string, SentinelCategory>> = Object.freeze({
  'com.apple.Terminal': 'shell',
  'com.googlecode.iterm2': 'shell',
  'com.apple.finder': 'filesystem',
  'com.apple.systempreferences': 'system_settings',
})

export function getSentinelCategory(
  bundleId: string,
): SentinelCategory | null {
  return SENTINEL_APPS[bundleId] ?? null
}
