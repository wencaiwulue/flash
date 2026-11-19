
import { describe, test, expect, afterAll } from 'bun:test'
import { join } from 'path'
import { loadSourceEntries, runSourceEntry } from './engine/source-engine'
import { isBlocked } from './engine/entries'
import { createFormLauncher, skipLine } from './form/launcher'
import { createMockAnthropic } from '../support/mock-anthropic'
import { createSandbox } from '../support/sandbox'

const FORM = (process.env.FLASH_IT_FORM ?? 'dist') as 'dist' | 'source'
const sourcesYaml = join(import.meta.dir, 'fixtures', 'sources.yaml')

const toClose: Array<{ sandbox?: Sandbox; mock?: MockAnthropic }> = []
afterAll(async () => {
  for (const item of toClose) {
    await item.sandbox?.cleanup()
    await item.mock?.stop()
  }
})

function routeHaikuAux(mock: MockAnthropic): void {
  mock.setRouter(request => {
    const model = (request.body as Record<string, unknown> | null)?.model
    return typeof model === 'string' && model.includes('haiku')
      ? { type: 'text', text: 'HAIKU_AUX_OK' }
      : null
  })
}

describe('sources precedence', () => {
  const entries = loadSourceEntries(sourcesYaml)

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

      const observed = await runSourceEntry(entry, launcher, mock, sandbox)
      expect(observed).toBe(entry.expect_value)
    })
  }
})

