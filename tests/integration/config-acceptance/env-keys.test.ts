import { describe, test, expect, afterAll } from 'bun:test'
import { join } from 'path'
import { parse } from 'yaml'
import { readFileSync } from 'node:fs'
import { isBlocked, type EntryStatus } from './engine/entries'
import { createFormLauncher, skipLine } from './form/launcher'
import { createMockAnthropic } from '../support/mock-anthropic'
import { createSandbox } from '../support/sandbox'

const FORM = (process.env.FLASH_IT_FORM ?? 'dist') as 'dist' | 'source'
const FIXTURES_PATH = join(import.meta.dir, 'fixtures', 'env-keys.yaml')

export interface EnvKeyEntry {
  id: string
  status: EntryStatus
  form: 'dist' | 'source'
  env: Record<string, string>
  expected_effect: Record<string, unknown>
  comment?: string
}

function requireString(value: unknown, key: string, index: number): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`entry #${index}: missing "${key}"`)
  }
  return value
}

function requireStatus(value: unknown, index: number): EntryStatus {
  if (
    value === 'active' || value === 'form:source' ||
    (typeof value === 'string' && (value.startsWith('blocked-by-batch:') || value.startsWith('blocked-by-prereq:')))
  ) return value as EntryStatus
  throw new Error(`entry #${index}: invalid status "${String(value)}"`)
}

function requireForm(value: unknown, index: number): 'dist' | 'source' {
  if (value === 'dist' || value === 'source') return value as 'dist' | 'source'
  throw new Error(`entry #${index}: invalid form "${String(value)}"`)
}

function requireEnv(value: unknown, index: number): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`entry #${index}: env must be an object`)
  }
  return value as Record<string, string>
}

function requireExpectedEffect(value: unknown, index: number): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`entry #${index}: expected_effect must be an object`)
  }
  return value as Record<string, unknown>
}

function loadEnvKeyEntries(): EnvKeyEntry[] {
  const raw = parse(readFileSync(FIXTURES_PATH, 'utf8')) as Array<Record<string, unknown>>
  return raw.map((item, index) => ({
    id: requireString(item.id, 'id', index),
    status: requireStatus(item.status, index),
    form: requireForm(item.form, index),
    env: requireEnv(item.env, index),
    expected_effect: requireExpectedEffect(item.expected_effect, index),
    comment: typeof item.comment === 'string' ? item.comment : undefined,
  }))
}

async function runEnvKeyEntry(
  entry: EnvKeyEntry,
  launcher: ReturnType<typeof createFormLauncher>,
  mock: ReturnType<typeof createMockAnthropic>,
  sandbox: Awaited<ReturnType<typeof createSandbox>>,
): Promise<Record<string, unknown>> {
  mock.requests.length = 0

  // Set up environment
  const originalEnv = { ...sandbox.env }
  for (const [key, value] of Object.entries(entry.env)) {
    if (value === '') {
      delete sandbox.env[key]
    } else {
      sandbox.env[key] = value
    }
  }

  // Run print command
  const args = ['-p', 'hi']
  await launcher.runPrint(args, sandbox, mock.url)

  // Restore original environment
  sandbox.env = originalEnv

  // Collect observations
  const lastRequest = mock.requests.at(-1)
  const observations: Record<string, unknown> = {}

  if (lastRequest?.body) {
    const body = lastRequest.body as Record<string, unknown>
    // Observe thinking config if present
    if ('thinking' in body && body.thinking) {
      observations.thinking = body.thinking
    }
  }

  return observations
}

const toClose: Array<{ sandbox?: Awaited<ReturnType<typeof createSandbox>>; mock?: ReturnType<typeof createMockAnthropic> }> = []
afterAll(async () => {
  for (const item of toClose) {
    await item.sandbox?.cleanup()
    await item.mock?.stop()
  }
})

describe('env keys', () => {
  const entries = loadEnvKeyEntries()

  for (const entry of entries) {
    if (isBlocked(entry.status)) {
      test.skip(`${entry.id} (${entry.status})`, () => { })
      console.log(skipLine(entry.status, entry.id))
      continue
    }

    if (entry.form === 'source' && FORM !== 'source') {
      test.skip(`${entry.id} (form:source)`, () => { })
      console.log(skipLine('form:source', entry.id))
      continue
    }

    test(`${entry.id}`, { timeout: 120_000 }, async () => {
      const launcher = createFormLauncher(FORM)
      const mock = await createMockAnthropic()
      const sandbox = await createSandbox()

      toClose.push({ sandbox, mock })

      const observations = await runEnvKeyEntry(entry, launcher, mock, sandbox)

      // Check expected effects
      if (entry.expected_effect.thinking) {
        expect(observations.thinking).toEqual(entry.expected_effect.thinking)
      }
    })
  }
})
