import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import {
  buildInventory,
  parseEnvironmentReference,
  parseHooksReference,
  parseSettingsReference,
  type UpstreamSource,
} from '../scripts/upstreamConfigInventory.ts'

const source: UpstreamSource = {
  url: 'https://code.claude.com/docs/en/settings-reference',
  sha256: 'a'.repeat(64),
}

const settingsFixture = `
| Setting | Description | Category | Scope |
| :- | :- | :- | :- |
| [\`model\`](#model) | Set the model | Model | Any file |
| [\`oldKey\`](#oldkey) | Deprecated; use \`newKey\` instead | Other | Any file |
| [\`futureKey\`](#futurekey) | Future setting | Other | Any file |
### \`model\`
Set the model.
* **Scope**: [\`Any file\`](#scopes)
* **Type**: string, a model alias or full model ID
* **Default**: unset
* **Per-session overrides**: --model takes precedence over this key
### \`oldKey\`
Deprecated.
* **Type**: Boolean
* **Default**: \`true\`
### \`futureKey\`
Requires Claude Code v2.1.319 or later.
* **Type**: object
* **Default**: unset
`

describe('upstream config inventory', () => {
  test('parses paths, metadata, lifecycle, replacement and after-baseline versions', () => {
    const entries = parseSettingsReference(settingsFixture, source)
    expect(entries.map(entry => entry.id)).toEqual([
      'setting:model', 'setting:oldKey', 'setting:futureKey',
    ])
    expect(entries[0]).toMatchObject({
      path: 'model', types: ['string'], defaultDocumented: true,
      lifecycle: 'active', scopes: ['Any file'],
      precedenceDocumented: true, precedence: '--model takes precedence over this key',
    })
    expect(entries[1]).toMatchObject({
      lifecycle: 'deprecated', replacement: 'newKey', default: true,
    })
    expect(entries[2]).toMatchObject({
      introduced: '2.1.319', afterBaseline: true,
    })
  })

  test('does not mark an existing setting after-baseline for a later subfeature', () => {
    const markdown = `
| Setting | Description | Category | Scope |
| :- | :- | :- | :- |
| [\`apiKeyHelper\`](#apikeyhelper) | Generate a credential | Other | Any file |
### \`apiKeyHelper\`
Generate a credential.
* **Scope**: [\`Any file\`](#scopes)
* **Type**: string
* **Default**: unset
* A newer refresh case Requires Claude Code v2.1.319 or later.
`
    const entry = parseSettingsReference(markdown, source)[0]!
    expect(entry.introduced).toBeUndefined()
    expect(entry.afterBaseline).toBeUndefined()
  })

  test('parses hooks only from the event summary table', () => {
    const markdown = `
| Event | When it fires |
| :- | :- |
| \`SessionStart\` | When a session begins |
| \`PostToolBatch\` | After a parallel batch |
### \`SessionStart\`
Details must not create a duplicate.
`
    const entries = parseHooksReference(markdown, source)
    expect(entries.map(entry => entry.id)).toEqual([
      'hook:SessionStart', 'hook:PostToolBatch',
    ])
  })

  test('parses env table and retains deprecated variables', () => {
    const markdown = `
| Variable | Purpose |
| :- | :- |
| \`API_TIMEOUT_MS\` | Header timeout |
| \`ANTHROPIC_SMALL_FAST_MODEL\` | \\[DEPRECATED] Old model variable |
`
    const entries = parseEnvironmentReference(markdown, source)
    expect(entries.map(entry => entry.id)).toEqual([
      'env:API_TIMEOUT_MS', 'env:ANTHROPIC_SMALL_FAST_MODEL',
    ])
    expect(entries[1]?.lifecycle).toBe('deprecated')
  })

  test('rejects duplicate IDs and sorts by kind then id', () => {
    const settings = parseSettingsReference(settingsFixture, source)
    expect(() => buildInventory({
      entries: [...settings, ...settings],
      documents: {}, capturedAt: '2026-11-16T00:00:00.000Z',
      binary: { version: '2.1.311', commit: 'e7d3b8365a0f', platform: 'darwin-arm64', sha256: 'b'.repeat(64) },
    })).toThrow('duplicate inventory id')
  })

  test('real 2.1.311 snapshot is complete and self-consistent', async () => {
    const root = new URL('../fixtures/upstream-config/2.1.311/', import.meta.url)
    const inventory = JSON.parse(await readFile(new URL('inventory.json', root), 'utf8'))
    const evidence = JSON.parse(await readFile(new URL('evidence.json', root), 'utf8'))
    expect(inventory.baseline.version).toBe('2.1.311')
    expect(evidence.binary.version).toContain('2.1.311')
    expect(inventory.entries.filter((entry: { kind: string }) => entry.kind === 'hook')).toHaveLength(33)
    expect(inventory.entries.some((entry: { id: string }) => entry.id === 'setting:permissions.denyInsteadOfPrompting' && entry.afterBaseline)).toBe(true)
    expect(inventory.entries.some((entry: { id: string }) => entry.id === 'setting:keybindingFlavor' && entry.lifecycle === 'deprecated')).toBe(true)
    expect(new Set(inventory.entries.map((entry: { id: string }) => entry.id)).size).toBe(inventory.entries.length)
    for (const entry of inventory.entries) {
      expect(Object.keys(entry.source).sort()).toEqual(['anchor', 'sha256', 'url'])
    }
  })
})
