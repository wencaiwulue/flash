import { parse } from 'yaml'
import { readFileSync } from 'node:fs'

export type EntryStatus =
  | 'active'
  | `blocked-by-batch:${string}`
  | `blocked-by-prereq:${string}`
  | 'form:source'

export interface HookEntry {
  id: string
  event: string
  status: EntryStatus
  trigger: string
  matcher: string
  exit_semantics: 'block' | 'allow' | 'nonblock'
  expected_effect: Record<string, unknown>
}

const KNOWN_TRIGGER_PREFIX = 'tool_call|permission_prompt|permission_denied|print_turn|repl_|subagent|none'

export function isBlocked(status: EntryStatus): boolean {
  return status !== 'active'
}

export function loadHookEntries(yamlPath: string): HookEntry[] {
  const raw = parse(readFileSync(yamlPath, 'utf8')) as Array<Record<string, unknown>>
  return raw.map((item, index) => {
    const event = require_string(item, 'event', index)
    const entry: HookEntry = {
      id: `hook:${event}`,
      event,
      status: require_status(item, index),
      trigger: require_string(item, 'trigger', index),
      matcher: typeof item.matcher === 'string' ? item.matcher : '*',
      exit_semantics: require_exit(item, index),
      expected_effect: (item.expected_effect as Record<string, unknown>) ?? {},
    }
    if (entry.trigger !== 'none' && !new RegExp(`^(${KNOWN_TRIGGER_PREFIX})`).test(entry.trigger)) {
      throw new Error(`${entry.id}: unknown trigger "${entry.trigger}"`)
    }
    return entry
  })
}

function require_string(item: Record<string, unknown>, key: string, index: number): string {
  const v = item[key]
  if (typeof v !== 'string' || v.length === 0) throw new Error(`entry #${index}: missing "${key}"`)
  return v
}

function require_status(item: Record<string, unknown>, index: number): EntryStatus {
  const v = item.status
  if (
    v === 'active' || v === 'form:source' ||
    (typeof v === 'string' && (v.startsWith('blocked-by-batch:') || v.startsWith('blocked-by-prereq:')))
  ) return v as EntryStatus
  throw new Error(`entry #${index}: invalid status "${String(v)}"`)
}

function require_exit(item: Record<string, unknown>, index: number): 'block' | 'allow' | 'nonblock' {
  const v = item.exit_semantics
  if (v === 'block' || v === 'allow' || v === 'nonblock') return v
  throw new Error(`entry #${index}: invalid exit_semantics "${String(v)}"`)
}
