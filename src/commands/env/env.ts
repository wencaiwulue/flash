import type { LocalCommandCall } from '../../types/command.js'
import {
  SETTING_SOURCES,
  getEnabledSettingSources,
  getSettingSourceName,
  type SettingSource,
} from '../../utils/settings/constants.js'
import { getSettingsForSource } from '../../utils/settings/settings.js'

const USAGE = 'Usage: /env [NAME] (NAME must start with CLAUDE_ or ANTHROPIC_)'
const MAX_VALUE_LENGTH = 4096
const SECRET_KEY =
  /(?:^|_)(?:API_?KEY|AUTH_?TOKEN|TOKEN|SECRET|PASSWORD|PASSPHRASE|CREDENTIALS?|COOKIE|PRIVATE_?KEY|CLIENT_?KEY|CUSTOM_?HEADERS?|SESSION_?KEY)(?:_|$)/i
const SECRET_VALUE =
  /(?:\bsk-[a-z0-9_-]{8,}|\bBearer\s+\S+|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|(?:token|secret|password|api[_-]?key)\s*[=:]\s*\S+)/i

export type EffectiveEnvEntry = {
  name: string
  value: string
  source: SettingSource | 'process'
  redacted: boolean
}

export type EnvSource = {
  source: SettingSource
  env?: Record<string, string>
}

function isAllowedName(name: string): boolean {
  return /^(?:CLAUDE|ANTHROPIC)_[A-Z0-9_]+$/.test(name)
}

function hasSensitiveUrlParts(value: string): boolean {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return false
  try {
    const url = new URL(value)
    return Boolean(url.username || url.password || url.search)
  } catch {
    // An invalid URL may still contain userinfo or a query. Do not expose it.
    return /(?:\/\/[^/?#]*@|\?)/.test(value)
  }
}

export function shouldRedactEnv(name: string, value: string): boolean {
  return (
    SECRET_KEY.test(name) ||
    hasSensitiveUrlParts(value) ||
    SECRET_VALUE.test(value)
  )
}

/** Pure effective-value calculation. It never applies settings to process.env. */
export function getEffectiveEnv(
  processEnv: NodeJS.ProcessEnv,
  sources: readonly EnvSource[],
): EffectiveEnvEntry[] {
  const effective = new Map<string, EffectiveEnvEntry>()
  for (const [name, value] of Object.entries(processEnv)) {
    if (value !== undefined && isAllowedName(name)) {
      effective.set(name, {
        name,
        value,
        source: 'process',
        redacted: shouldRedactEnv(name, value),
      })
    }
  }

  const bySource = new Map(sources.map(source => [source.source, source]))
  for (const source of SETTING_SOURCES) {
    const env = bySource.get(source)?.env
    if (!env) continue
    for (const [name, value] of Object.entries(env)) {
      if (typeof value === 'string' && isAllowedName(name)) {
        effective.set(name, {
          name,
          value,
          source,
          redacted: shouldRedactEnv(name, value),
        })
      }
    }
  }
  return [...effective.values()].sort((a, b) => a.name.localeCompare(b.name))
}

function loadSources(): EnvSource[] {
  const enabled = new Set(getEnabledSettingSources())
  return SETTING_SOURCES.filter(source => enabled.has(source)).map(source => ({
    source,
    env: getSettingsForSource(source)?.env,
  }))
}

function printableValue(entry: EffectiveEnvEntry): string {
  if (entry.redacted) return '<redacted>'
  const truncated =
    entry.value.length > MAX_VALUE_LENGTH
      ? `${entry.value.slice(0, MAX_VALUE_LENGTH)}…`
      : entry.value
  return JSON.stringify(truncated)
}

export function formatEnv(entries: readonly EffectiveEnvEntry[]): string {
  if (entries.length === 0) {
    return 'No effective CLAUDE_* or ANTHROPIC_* variables found.'
  }
  return entries
    .map(entry => {
      const source =
        entry.source === 'process'
          ? 'process env'
          : getSettingSourceName(entry.source)
      return `${entry.name}=${printableValue(entry)} (${source})`
    })
    .join('\n')
}

export function formatEnvSelection(
  args: string,
  entries: readonly EffectiveEnvEntry[],
): string {
  const tokens = args.trim().split(/\s+/).filter(Boolean)
  if (tokens.length > 1 || (tokens[0] && !isAllowedName(tokens[0]))) {
    return USAGE
  }
  if (!tokens[0]) return formatEnv(entries)
  const entry = entries.find(candidate => candidate.name === tokens[0])
  return entry
    ? formatEnv([entry])
    : `${tokens[0]} is not set in process env or enabled settings.`
}

export function runEnv(args: string): string {
  return formatEnvSelection(args, getEffectiveEnv(process.env, loadSources()))
}

export const call: LocalCommandCall = async args => ({
  type: 'text',
  value: runEnv(args),
})
