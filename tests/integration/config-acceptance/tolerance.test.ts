import { describe, test, expect, afterAll } from 'bun:test'
import { join } from 'path'
import { parse } from 'yaml'
import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { isBlocked, type EntryStatus } from './engine/entries'
import { createFormLauncher, skipLine } from './form/launcher'
import { createMockAnthropic } from '../support/mock-anthropic'
import { createSandbox } from '../support/sandbox'

const FORM = (process.env.FLASH_IT_FORM ?? 'dist') as 'dist' | 'source'
const toleranceYaml = join(import.meta.dir, 'fixtures', 'tolerance.yaml')

export interface ToleranceEntry {
  id: string
  status: EntryStatus
  form: 'dist' | 'source'
  layers: Record<string, Record<string, unknown>>
  expect_key: string
  expect_value: unknown
  expected_effect?: Record<string, unknown>
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
    if (value !== undefined && (typeof value !== 'object' || value === null || Array.isArray(value))) {
      throw new Error(`entry #${index}: layers.${key} must be an object`)
    }
  }
  return v as Record<string, Record<string, unknown>>
}

function loadToleranceEntries(yamlPath: string): ToleranceEntry[] {
  const raw = parse(readFileSync(yamlPath, 'utf8')) as Array<Record<string, unknown>>
  return raw.map((item, index) => {
    const entry: ToleranceEntry = {
      id: requireString(item, 'id', index),
      status: requireStatus(item, index),
      form: requireForm(item, index),
      layers: requireLayers(item, index),
      expect_key: requireString(item, 'expect_key', index),
      expect_value: item.expect_value,
      expected_effect: item.expected_effect as Record<string, unknown> | undefined,
    }
    return entry
  })
}

async function runToleranceEntry(
  entry: ToleranceEntry,
  launcher: ReturnType<typeof createFormLauncher>,
  mock: ReturnType<typeof createMockAnthropic>,
  sandbox: Awaited<ReturnType<typeof createSandbox>>
): Promise<unknown> {
  // Clear mock requests
  mock.requests.length = 0

  // Materialize layers into appropriate locations
  let flagSettingsPath: string | null = null

  for (const [layerName, settings] of Object.entries(entry.layers)) {
    switch (layerName) {
      case 'user':
        if (settings) {
          await writeFile(
            join(sandbox.home, '.claude', 'settings.json'),
            JSON.stringify(settings)
          )
        }
        break

      case 'project':
        if (settings) {
          await writeFile(
            join(sandbox.project, '.claude', 'settings.json'),
            JSON.stringify(settings)
          )
        }
        break

      case 'local':
        if (settings) {
          await writeFile(
            join(sandbox.project, '.claude', 'settings.local.json'),
            JSON.stringify(settings)
          )
        }
        break

      case 'flag':
        if (settings) {
          flagSettingsPath = join(sandbox.home, 'flag-settings.json')
          await writeFile(flagSettingsPath, JSON.stringify(settings))
        }
        break

      case 'managed':
        // For tolerance:managed-corrupt, write invalid JSON
        const managedPath = join(sandbox.managedDir, 'managed-settings.json')
        if (entry.id === 'tolerance:managed-corrupt') {
          await writeFile(managedPath, 'this is not valid json')
        } else if (settings) {
          await writeFile(managedPath, JSON.stringify(settings))
        }
        break

      default:
        throw new Error(`Unknown layer: ${layerName}`)
    }
  }

  // Build print command args
  const args: string[] = ['-p', 'hi']
  if (flagSettingsPath) {
    args.push('--settings', flagSettingsPath)
  }

  // Run print command
  await launcher.runPrint(args, sandbox, mock.url)

  // Find the last /v1/messages request and return the observed model
  const messagesRequests = mock.requests.filter(r => r.path === '/v1/messages')
  const lastRequest = messagesRequests.at(-1)

  if (!lastRequest?.body) {
    return null
  }

  const body = lastRequest.body as Record<string, unknown>
  return body[entry.expect_key]
}

function routeHaikuAux(mock: ReturnType<typeof createMockAnthropic>): void {
  mock.setRouter(request => {
    const model = (request.body as Record<string, unknown> | null)?.model
    return typeof model === 'string' && model.includes('haiku')
      ? { type: 'text', text: 'HAIKU_AUX_OK' }
      : null
  })
}

const toClose: Array<{ sandbox?: Awaited<ReturnType<typeof createSandbox>>; mock?: ReturnType<typeof createMockAnthropic> }> = []
afterAll(async () => {
  for (const item of toClose) {
    await item.sandbox?.cleanup()
    await item.mock?.stop()
  }
})

describe('settings tolerance', () => {
  const entries = loadToleranceEntries(toleranceYaml)

  for (const entry of entries) {
    if (isBlocked(entry.status)) {
      test.skip(`${entry.id} (${entry.status})`, () => {})
      console.log(skipLine(entry.status, entry.id))
      continue
    }

    // Skip form:source entries when not in source form
    if (entry.form === 'source' && FORM !== 'source') {
      test.skip(`${entry.id} (form:source)`, () => {})
      console.log(skipLine('form:source', entry.id))
      continue
    }

    test(`${entry.id}`, { timeout: 120_000 }, async () => {
      const launcher = createFormLauncher(FORM)
      const mock = await createMockAnthropic()
      const sandbox = await createSandbox()

      toClose.push({ sandbox, mock })
      routeHaikuAux(mock)

      const observed = await runToleranceEntry(entry, launcher, mock, sandbox)
      expect(observed).toBe(entry.expect_value)
    })
  }
})
