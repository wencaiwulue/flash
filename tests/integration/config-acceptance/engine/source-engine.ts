
import { parse } from 'yaml'
import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'path'
import type { EntryStatus } from './entries'
import type { Launcher } from '../form/launcher'
import type { MockAnthropic } from '../../support/mock-anthropic'
import type { Sandbox } from '../../support/sandbox'

export interface SourceEntry {
  id: string
  status: EntryStatus
  form: 'dist' | 'source'
  layers: Record<string, Record<string, unknown>>
  expect_key: string
  expect_value: unknown
}

function requireString(item: Record<string, unknown>, key: string, index: number): string {
  const v = item[key]
  if (typeof v !== 'string' || v.length === 0) throw new Error(`entry #${index}: missing "${key}"`)
  return v
}

function requireStatus(item: Record<string, unknown>, index: number): EntryStatus {
  const v = item.status
  if (
    v === 'active' || v === 'form:source' ||
    (typeof v === 'string' && (v.startsWith('blocked-by-batch:') || v.startsWith('blocked-by-prereq:')))
  ) return v as EntryStatus
  throw new Error(`entry #${index}: invalid status "${String(v)}"`)
}

function requireForm(item: Record<string, unknown>, index: number): 'dist' | 'source' {
  const v = item.form
  if (v === 'dist' || v === 'source') return v
  throw new Error(`entry #${index}: invalid form "${String(v)}"`)
}

function requireLayers(item: Record<string, unknown>, index: number): Record<string, Record<string, unknown>> {
  const v = item.layers
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new Error(`entry #${index}: layers must be an object`)
  }
  for (const [key, value] of Object.entries(v)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`entry #${index}: layers.${key} must be an object`)
    }
  }
  return v as Record<string, Record<string, unknown>>
}

export function loadSourceEntries(yamlPath: string): SourceEntry[] {
  const raw = parse(readFileSync(yamlPath, 'utf8')) as Array<Record<string, unknown>>
  return raw.map((item, index) => {
    const entry: SourceEntry = {
      id: requireString(item, 'id', index),
      status: requireStatus(item, index),
      form: requireForm(item, index),
      layers: requireLayers(item, index),
      expect_key: requireString(item, 'expect_key', index),
      expect_value: item.expect_value,
    }
    return entry
  })
}

export async function runSourceEntry(
  entry: SourceEntry,
  launcher: Launcher,
  mock: MockAnthropic,
  sandbox: Sandbox
): Promise<unknown> {
  // Clear mock requests
  mock.requests.length = 0

  // Materialize layers into appropriate locations
  let flagSettingsPath: string | null = null

  for (const [layerName, settings] of Object.entries(entry.layers)) {
    switch (layerName) {
      case 'user':
        await writeFile(
          join(sandbox.home, '.claude', 'settings.json'),
          JSON.stringify(settings)
        )
        break

      case 'project':
        await writeFile(
          join(sandbox.project, '.claude', 'settings.json'),
          JSON.stringify(settings)
        )
        break

      case 'local':
        await writeFile(
          join(sandbox.project, '.claude', 'settings.local.json'),
          JSON.stringify(settings)
        )
        break

      case 'flag':
        flagSettingsPath = join(sandbox.home, 'flag-settings.json')
        await writeFile(flagSettingsPath, JSON.stringify(settings))
        break

      case 'managed':
        // Managed settings go to sandbox.managedDir
        await writeFile(
          join(sandbox.managedDir, 'managed-settings.json'),
          JSON.stringify(settings)
        )
        break

      default:
        throw new Error(`Unknown layer: ${layerName}`)
    }
  }

  // Build print command args
  const args: string[] = ['-p', 'hello']
  if (flagSettingsPath) {
    args.push('--settings', flagSettingsPath)
  }

  // Run print command
  await launcher.runPrint(args, sandbox, mock.url)

  // Find the last /v1/messages request and return the observed model
  const messagesRequests = mock.requests.filter(r => r.path === '/v1/messages')
  const lastRequest = messagesRequests.at(-1)

  if (!lastRequest?.body) {
    throw new Error('No /v1/messages request found')
  }

  const body = lastRequest.body as Record<string, unknown>
  return body[entry.expect_key]
}

