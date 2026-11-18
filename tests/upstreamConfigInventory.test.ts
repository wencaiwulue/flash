import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildInventory,
  completeRequiresStatement,
  determineOwnerBatch,
  parseEnvironmentReference,
  parseHooksReference,
  parseSettingsReference,
  stripMarkdown,
  type UpstreamInventory,
  type UpstreamSource,
} from '../scripts/upstreamConfigInventory.ts'

const source: UpstreamSource = {
  url: 'https://code.claude.com/docs/en/settings-reference',
  sha256: 'a'.repeat(64),
}

function settingsMarkdown({
  path = 'key',
  description = 'A setting',
  scope = 'Any file',
  type = 'string',
  defaultValue = 'unset',
  detail = '',
}: {
  path?: string
  description?: string
  scope?: string
  type?: string
  defaultValue?: string
  detail?: string
} = {}) {
  return `
| Setting | Description | Category | Scope |
| :- | :- | :- | :- |
| [\`${path}\`](#${path.toLowerCase()}) | ${description} | Other | Any file |
### \`${path}\`
${description}.
* **Scope**: ${scope}
* **Type**: ${type}
* **Default**: ${defaultValue}
${detail}
`
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

  test('keeps a complete Requires statement ahead of long prose and metadata', () => {
    const requires = 'Requires Claude Code v2.1.319 or later.'
    const markdown = `
| Setting | Description | Category | Scope |
| :- | :- | :- | :- |
| [\`futureKey\`](#futurekey) | Future setting | Other | Any file |
### \`futureKey\`
${'Long prose prefix. '.repeat(80)}${requires}
* **Scope**: [\`Any file\`](#scopes). ${'Long scope metadata. '.repeat(80)}
* **Type**: Boolean
* **Default**: unset
`
    const entry = parseSettingsReference(markdown, source)[0]!
    expect(entry.afterBaseline).toBe(true)
    expect(entry.excerpt).toContain(requires)
    expect(entry.excerpt.length).toBeLessThanOrEqual(1000)
    expect(entry.excerpt).not.toContain('\n')
  })

  test('stops an unpunctuated Requires statement at excerpt metadata', () => {
    expect(completeRequiresStatement(
      'Requires Claude Code v2.1.319 or later | * **Type**: string.',
    )).toBe('Requires Claude Code v2.1.319 or later')
  })

  test('rejects ambiguous mixed-version Requires statements in every document kind', () => {
    expect(() => parseSettingsReference(settingsMarkdown({
      description: 'Requires Claude Code v2.1.300 or later. Requires Claude Code v2.1.319 or later.',
    }), source)).toThrow('multiple Requires versions')
    const splitSettings = settingsMarkdown({
      description: 'Requires Claude Code v2.1.300 or later.',
    }).replace(
      '* **Scope**:',
      'Requires Claude Code v2.1.319 or later.\n* **Scope**:',
    )
    expect(() => parseSettingsReference(splitSettings, source)).toThrow(
      'multiple Requires versions',
    )
    expect(() => parseHooksReference(`
| Event | When it fires |
| :- | :- |
| \`FutureEvent\` | Requires Claude Code v2.1.300 or later. Requires Claude Code v2.1.319 or later. |
`, source)).toThrow('multiple Requires versions')
    expect(() => parseEnvironmentReference(`
| Variable | Purpose |
| :- | :- |
| \`FUTURE_ENV\` | Requires Claude Code v2.1.300 or later. Requires Claude Code v2.1.319 or later. |
`, source)).toThrow('multiple Requires versions')
  })

  test('allows repeated statements for the same Requires version', () => {
    const requires = 'Requires Claude Code v2.1.319 or later.'
    const repeated = `${requires} ${requires}`
    const entries = [
      parseSettingsReference(settingsMarkdown({ description: requires }), source)[0]!,
      parseHooksReference(`
| Event | When it fires |
| :- | :- |
| \`FutureEvent\` | ${repeated} |
`, source)[0]!,
      parseEnvironmentReference(`
| Variable | Purpose |
| :- | :- |
| \`FUTURE_ENV\` | ${repeated} |
`, source)[0]!,
    ]
    for (const entry of entries) {
      expect(entry).toMatchObject({ introduced: '2.1.319', afterBaseline: true })
      expect(entry.excerpt).toContain(requires)
    }
  })

  test('rejects a Requires statement that is too long to preserve completely', () => {
    const markdown = `
| Setting | Description | Category | Scope |
| :- | :- | :- | :- |
| [\`futureKey\`](#futurekey) | Future setting | Other | Any file |
### \`futureKey\`
Requires Claude Code v2.1.319 ${'x'.repeat(1001)} or later.
* **Scope**: Any file
* **Type**: Boolean
* **Default**: unset
`
    expect(() => parseSettingsReference(markdown, source)).toThrow(
      'complete Requires statement',
    )
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

  test('refuses to truncate Requires evidence in hook and env excerpts', () => {
    const requires = 'Requires Claude Code v2.1.319 or later'
    const longPrefix = 'x'.repeat(1000)
    expect(() => parseHooksReference(`
| Event | When it fires |
| :- | :- |
| \`FutureEvent\` | ${longPrefix} ${requires} |
`, source)).toThrow('complete Requires statement')
    expect(() => parseEnvironmentReference(`
| Variable | Purpose |
| :- | :- |
| \`FUTURE_ENV\` | ${longPrefix} ${requires} |
`, source)).toThrow('complete Requires statement')
  })

  test('rejects duplicate IDs', () => {
    const settings = parseSettingsReference(settingsFixture, source)
    expect(() => buildInventory({
      entries: [...settings, ...settings],
      documents: {}, capturedAt: '2026-11-16T00:00:00.000Z',
      binary: { version: '2.1.311', commit: 'e7d3b8365a0f', platform: 'darwin-arm64', sha256: 'b'.repeat(64) },
    })).toThrow('duplicate inventory id')
  })

  test('sorts by kind and then id', () => {
    const settings = parseSettingsReference(settingsFixture, source)
    const env = { ...settings[0]!, id: 'env:Z', kind: 'env' as const, path: 'Z' }
    const stop = { ...settings[0]!, id: 'hook:Stop', kind: 'hook' as const, path: 'Stop' }
    const postToolUse = { ...settings[0]!, id: 'hook:PostToolUse', kind: 'hook' as const, path: 'PostToolUse' }
    const inventory = buildInventory({
      entries: [env, stop, settings[2]!, postToolUse, settings[0]!, settings[1]!],
      documents: {}, capturedAt: '2026-11-16T00:00:00.000Z',
      binary: { version: '2.1.311', commit: 'e7d3b8365a0f', platform: 'darwin-arm64', sha256: 'b'.repeat(64) },
    })
    expect(inventory.entries.map(entry => entry.id)).toEqual([
      'setting:futureKey', 'setting:model', 'setting:oldKey',
      'hook:PostToolUse', 'hook:Stop', 'env:Z',
    ])
  })

  test('rejects an empty source anchor', () => {
    const entry = parseSettingsReference(settingsFixture, source)[0]!
    entry.source.anchor = ''
    expect(() => buildInventory({
      entries: [entry], documents: {}, capturedAt: '2026-11-16T00:00:00.000Z',
      binary: { version: '2.1.311', commit: 'e7d3b8365a0f', platform: 'darwin-arm64', sha256: 'b'.repeat(64) },
    })).toThrow('source anchor')
  })

  test('retains precedence and merge semantics from Scope lines', () => {
    const scope = '`Any file`. Hooks merge across files rather than replacing each other.'
    const entry = parseSettingsReference(settingsMarkdown({ path: 'hooks', scope }), source)[0]!
    expect(entry.precedenceDocumented).toBe(true)
    expect(entry.precedence).toContain('Hooks merge across files')
  })

  test('includes the detail warning that drives deprecated lifecycle in the excerpt', () => {
    const entry = parseSettingsReference(settingsMarkdown({
      detail: '> Deprecated since v2.1.92, when the [`voice`](#voice) object replaced it.',
    }), source)[0]!
    expect(entry.lifecycle).toBe('deprecated')
    expect(entry.excerpt).toContain(
      'Deprecated since v2.1.92, when the `voice` object replaced it.',
    )
  })

  test('does not invent replacements for active settings', () => {
    const entry = parseSettingsReference(settingsMarkdown({
      description: 'Use `serverName` to identify a server',
      detail: 'The example can use `anotherKey` without deprecating this setting.',
    }), source)[0]!
    expect(entry.lifecycle).toBe('active')
    expect(entry.replacement).toBeUndefined()
  })

  test('preserves replacements for removed hook events', () => {
    const markdown = `
| Event | When it fires |
| :- | :- |
| \`OldEvent\` | Removed; use \`NewEvent\` instead |
`
    expect(parseHooksReference(markdown, source)[0]).toMatchObject({
      lifecycle: 'removed', replacement: 'NewEvent',
    })
  })

  test('throws for a malformed non-empty row inside a target table', () => {
    const markdown = `
| Event | When it fires |
| :- | :- |
| \`SessionStart\` | Valid A
\`Broken\` | Missing the leading pipe
| \`Stop\` | Valid C
`
    expect(() => parseHooksReference(markdown, source)).toThrow('malformed target table row')
  })

  test('ends a target table at a normal blank line', () => {
    const markdown = `
| Event | When it fires |
| :- | :- |
| \`SessionStart\` | Valid table row

Prose after the table is not a malformed row.
`
    expect(parseHooksReference(markdown, source).map(entry => entry.path)).toEqual(['SessionStart'])
  })

  test('preserves compound object and array types while normalizing simple primaries', () => {
    const cases = [
      {
        type: 'object keyed by hook event; each value is an array of `{ "matcher", "hooks" }` groups',
        expected: 'object keyed by hook event; each value is an array of `{ "matcher", "hooks" }` groups',
      },
      {
        type: 'Object with `allow`, `ask`, `deny`, and `defaultMode`',
        expected: 'object with `allow`, `ask`, `deny`, and `defaultMode`',
      },
      {
        type: 'Array of `{ "matcher": string, "hooks": [] }` groups',
        expected: 'array of `{ "matcher": string, "hooks": [] }` groups',
      },
      { type: 'String, a model alias or full model ID', expected: 'string' },
      {
        type: 'the string `"Agents"` in the `strictPluginOnlyCustomization` array; see [ManagedSettings](https://example.test/ManagedSettings)',
        expected: 'the string `"Agents"` in the `strictPluginOnlyCustomization` array; see ManagedSettings',
      },
    ]
    const actual = cases.map(({ type }) =>
      parseSettingsReference(settingsMarkdown({ type }), source)[0]!.types,
    )
    expect(actual).toEqual(cases.map(({ expected }) => [expected]))
  })

  test('extracts constrained object-with children without reading literals or examples', () => {
    const markdown = `
| Setting | Description | Category | Scope |
| :- | :- | :- | :- |
| [\`parent\`](#parent) | Parent object | Other | User or managed |
| [\`parent.enabled\`](#parent-enabled) | Explicit child | Other | User or managed |
### \`parent\`
Requires Claude Code v2.1.319 or later.
* **Scope**: [\`User or managed\`](#scopes). The highest source overrides the whole object.
* **Type**: object with \`plain\`, optional \`optionalValue\`, an \`items\` array of strings, \`enabled\` (Boolean), \`name\` (string), \`mode\` (\`"append"\`, \`"replace"\`), \`Boolean\`, \`string\`, \`false\`, \`1\`, and \`command\` always \`"command"\`
* **Default**: unset
\`\`\`json
{ "parent": { "exampleOnly": true, "plain": "example" } }
\`\`\`
### \`parent.enabled\`
Explicit child.
* **Scope**: [\`User or managed\`](#scopes)
* **Type**: Boolean
* **Default**: \`true\`
`
    const entries = parseSettingsReference(markdown, source)
    const byId = new Map(entries.map(entry => [entry.id, entry]))
    expect(entries).toHaveLength(8)
    expect([...byId.keys()].sort()).toEqual([
      'setting:parent',
      'setting:parent.command',
      'setting:parent.enabled',
      'setting:parent.items',
      'setting:parent.mode',
      'setting:parent.name',
      'setting:parent.optionalValue',
      'setting:parent.plain',
    ])
    expect(byId.get('setting:parent.enabled')).toMatchObject({
      default: true,
      defaultDocumented: true,
      types: ['boolean'],
      source: { anchor: '#parent-enabled' },
    })
    expect(byId.get('setting:parent.items')).toMatchObject({
      path: 'parent.items',
      title: 'parent.items',
      types: ['array'],
      default: null,
      defaultDocumented: false,
      scopes: ['User or managed'],
      precedence: '',
      precedenceDocumented: false,
      lifecycle: 'active',
      introduced: '2.1.319',
      afterBaseline: true,
      source: { anchor: '#parent' },
    })
    expect(byId.get('setting:parent.name')?.types).toEqual(['string'])
    expect(byId.get('setting:parent.plain')?.types).toEqual([])
    expect(byId.get('setting:parent.optionalValue')?.types).toEqual([])
    expect(byId.get('setting:parent.mode')?.types).toEqual([])
    expect(byId.get('setting:parent.command')?.types).toEqual([])
    expect(byId.get('setting:parent.items')?.sourceRules).toBe(
      byId.get('setting:parent')?.sourceRules,
    )
    expect(byId.get('setting:parent.items')?.excerpt).toContain(
      '* **Type**: object with `plain`',
    )
  })

  test('parses backtick literal defaults followed by punctuation', () => {
    const cases = [
      { literal: 'true', punctuation: '.', expected: true },
      { literal: 'false', punctuation: ',', expected: false },
      { literal: '0.01', punctuation: ';', expected: 0.01 },
      { literal: '0', punctuation: ':', expected: 0 },
      { literal: '-1e2', punctuation: '!', expected: -100 },
      { literal: 'false', punctuation: '?', expected: false },
    ]
    const actual = cases.map(({ literal, punctuation }) =>
      parseSettingsReference(settingsMarkdown({
        defaultValue: `\`${literal}\`${punctuation} explanation`,
      }), source)[0]!.default,
    )
    expect(actual).toEqual(cases.map(({ expected }) => expected))
  })

  test('uses the effective baseline default from explicit version history', () => {
    const cases = [
      {
        defaultValue: '`false`. Before v2.1.324, the default was `true`',
        expected: true,
      },
      {
        defaultValue: '`false`. Before v2.1.311, the default was `true`',
        expected: false,
      },
      {
        defaultValue: '`false`. Before v2.1.310, the default was `true`',
        expected: false,
      },
      {
        defaultValue: '`0`. Before v2.1.324, the default was `42`',
        expected: 42,
      },
    ]
    const actual = cases.map(({ defaultValue }) =>
      parseSettingsReference(settingsMarkdown({ defaultValue }), source)[0]!.default,
    )
    expect(actual).toEqual(cases.map(({ expected }) => expected))
  })

  test('ignores a fenced example table before the real target table', () => {
    const markdown = `
\`\`\`markdown
| Event | When it fires |
| :- | :- |
| \`FakeEvent\` | Example only |
\`\`\`

| Event | When it fires |
| :- | :- |
| \`SessionStart\` | Real table |
`
    expect(parseHooksReference(markdown, source).map(entry => entry.path)).toEqual(['SessionStart'])
  })

  test('does not truncate detail sections at headings inside fences', () => {
    const markdown = `
| Setting | Description | Category | Scope |
| :- | :- | :- | :- |
| [\`model\`](#model) | Set the model | Model | Any file |
### \`model\`
Set the model.
\`\`\`markdown
### \`notARealSetting\`
\`\`\`
* **Scope**: Any file
* **Type**: string
* **Default**: \`false\`.
`
    expect(parseSettingsReference(markdown, source)[0]).toMatchObject({
      path: 'model', types: ['string'], default: false, defaultDocumented: true,
    })
  })

  test('does not split table cells on pipes inside double-backtick code spans', () => {
    const markdown = `
| Variable | Purpose |
| :- | :- |
| \`API_VALUE\` | Literal \`\`foo|bar\`\` text |
`
    const entries = parseEnvironmentReference(markdown, source)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.sourceRules).toBe('Literal ``foo|bar`` text')
  })

  test('strips balanced parentheses in Markdown link destinations', () => {
    expect(stripMarkdown('[reference](https://example.test/a_(b))')).toBe('reference')
  })

  test('CLI rejects binary versions that merely contain the baseline semver', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'flash-inventory-version-'))
    const script = fileURLToPath(new URL('../scripts/upstreamConfigInventory.ts', import.meta.url))
    try {
      const documents: Record<string, string> = {
        'settings-reference.md': settingsMarkdown(),
        'settings.md': 'settings\n',
        'hooks-reference.md': '| Event | When it fires |\n| :- | :- |\n| `Stop` | Stop |\n',
        'env-vars.md': '| Variable | Purpose |\n| :- | :- |\n| `VALUE` | Purpose |\n',
        'llms.txt': 'llms\n',
      }
      for (const [name, contents] of Object.entries(documents)) {
        await writeFile(join(directory, name), contents)
      }
      const binary = join(directory, 'claude')
      const run = async (version: string) => {
        await writeFile(binary, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`)
        await chmod(binary, 0o755)
        return spawnSync(process.execPath, [
          script,
          '--settings-reference', join(directory, 'settings-reference.md'),
          '--settings', join(directory, 'settings.md'),
          '--hooks-reference', join(directory, 'hooks-reference.md'),
          '--env-vars', join(directory, 'env-vars.md'),
          '--llms', join(directory, 'llms.txt'),
          '--binary', binary,
          '--binary-commit', 'e7d3b8365a0f',
          '--binary-platform', 'darwin-arm64',
          '--captured-at', '2026-11-17T08:57:19Z',
          '--output-dir', join(directory, 'output'),
        ], { encoding: 'utf8' })
      }
      const invalid = [
        await run('2.1.3110 (Claude Code)'),
        await run('12.1.311 (Claude Code)'),
      ]
      expect(invalid.map(result => result.status)).toEqual([1, 1])
      expect(invalid.map(result => result.stderr)).toEqual([
        expect.stringContaining('upstream binary is not 2.1.311'),
        expect.stringContaining('upstream binary is not 2.1.311'),
      ])
      const valid = await run('2.1.311 (Claude Code)')
      expect(valid.status).toBe(0)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  async function readSnapshot() {
    const root = new URL('../fixtures/upstream-config/2.1.311/', import.meta.url)
    const inventory = JSON.parse(
      await readFile(new URL('inventory.json', root), 'utf8'),
    ) as UpstreamInventory
    const evidence = JSON.parse(await readFile(new URL('evidence.json', root), 'utf8'))
    return { inventory, evidence }
  }

  test('real 2.1.311 snapshot is complete and self-consistent', async () => {
    const { inventory, evidence } = await readSnapshot()
    expect(inventory.baseline.version).toBe('2.1.311')
    expect(inventory.baseline.capturedAt).toBe('2026-11-17T08:57:19Z')
    expect(evidence.capturedAt).toBe('2026-11-17T08:57:19Z')
    expect(evidence.binary.version).toBe('2.1.311 (Claude Code)')
    expect(Object.fromEntries(['setting', 'hook', 'env'].map(kind => [
      kind, inventory.entries.filter(entry => entry.kind === kind).length,
    ]))).toEqual({ setting: 285, hook: 33, env: 413 })
    expect(inventory.entries.some(entry =>
      entry.id === 'setting:permissions.denyInsteadOfPrompting' && entry.afterBaseline,
    )).toBe(true)
    expect(inventory.entries.some(entry =>
      entry.id === 'setting:keybindingFlavor' && entry.lifecycle === 'deprecated',
    )).toBe(true)
    expect(new Set(inventory.entries.map(entry => entry.id)).size).toBe(inventory.entries.length)
    for (const entry of inventory.entries) {
      expect(Object.keys(entry.source).sort()).toEqual(['anchor', 'sha256', 'url'])
      expect(entry.source.anchor).not.toBe('')
    }
  })

  test('real snapshot retains the complete original Requires statement for all eight later entries', async () => {
    const { inventory } = await readSnapshot()
    const expectedRequires: Record<string, string> = {
      'setting:permissions.blockWritesOutsideWorkingDirectories': 'Requires Claude Code v2.1.314 or later.',
      'setting:permissions.denyInsteadOfPrompting': 'Requires Claude Code v2.1.319 or later.',
      'env:CLAUDE_CODE_AUTOMOUNT_ROOTS': 'Requires Claude Code v2.1.323 or later',
      'env:CLAUDE_CODE_CONFIG_LOCK_WAIT_MS': 'Requires Claude Code v2.1.318 or later',
      'env:CLAUDE_CODE_DISABLE_FEATURE_FLAGS': 'Requires Claude Code v2.1.319 or later.',
      'env:CLAUDE_CODE_DISABLE_ULTRATHINK': 'Requires Claude Code v2.1.316 or later',
      'env:CLAUDE_CODE_DROP_UNAVAILABLE_DEFERRED_TOOL': 'Requires Claude Code v2.1.319 or later',
      'env:CLAUDE_CODE_RESUME_HINT_COMMAND': 'Requires Claude Code v2.1.323 or later',
    }
    const laterEntries = inventory.entries.filter(entry => entry.afterBaseline)
    expect(laterEntries.map(entry => entry.id).sort()).toEqual(
      Object.keys(expectedRequires).sort(),
    )
    for (const entry of laterEntries) {
      expect(entry.excerpt).toContain(expectedRequires[entry.id]!)
      expect(entry.excerpt.length).toBeLessThanOrEqual(1000)
      expect(entry.excerpt).not.toContain('\n')
    }
  })

  test('real snapshot has no active pseudo-replacements and retains lifecycle replacements', async () => {
    const { inventory } = await readSnapshot()
    expect(inventory.entries.filter(entry =>
      entry.lifecycle === 'active' && entry.replacement !== undefined,
    ).map(entry => entry.id)).toEqual([])
    expect(Object.fromEntries(inventory.entries
      .filter(entry => entry.replacement !== undefined)
      .map(entry => [entry.id, {
        lifecycle: entry.lifecycle,
        replacement: entry.replacement,
      }]))).toEqual({
      'setting:disableArtifact': {
        lifecycle: 'deprecated', replacement: 'enableArtifact',
      },
      'setting:includeCoAuthoredBy': {
        lifecycle: 'deprecated', replacement: 'attribution',
      },
      'env:CLAUDE_CODE_AUTO_BACKGROUND_WORKER_CHECKIN_SECONDS': {
        lifecycle: 'removed', replacement: 'CLAUDE_CODE_WORKER_CHECKIN_SCHEDULE',
      },
      'env:CLAUDE_CODE_CONNECT_TIMEOUT_MS': {
        lifecycle: 'removed', replacement: 'API_TIMEOUT_MS',
      },
      'env:ENABLE_PROMPT_CACHING_1H_BEDROCK': {
        lifecycle: 'deprecated', replacement: 'ENABLE_PROMPT_CACHING_1H',
      },
    })
  })

  test('real snapshot retains the voiceEnabled lifecycle warning in its excerpt', async () => {
    const { inventory } = await readSnapshot()
    const entry = inventory.entries.find(entry => entry.id === 'setting:voiceEnabled')
    expect(entry?.lifecycle).toBe('deprecated')
    expect(entry?.excerpt).toContain(
      'Deprecated since v2.1.92, when the `voice` object replaced it. Claude Code still reads it so older settings files keep working, but new configurations should set `voice.enabled`.',
    )
  })

  test('real snapshot parses all nine punctuated literal defaults', async () => {
    const { inventory } = await readSnapshot()
    const byId = new Map(inventory.entries.map(entry => [entry.id, entry]))
    const expectedDefaults: Record<string, unknown> = {
      'setting:sandbox.autoAllowBashIfSandboxed': true,
      'setting:sandbox.filesystem.disabled': false,
      'setting:skillListingBudgetFraction': 0.01,
      'setting:allowAllClaudeAiMcps': false,
      'setting:allowClaudeInChromeWithManagedMcp': false,
      'setting:allowManagedMcpServersOnly': false,
      'setting:disableClaudeAiConnectors': false,
      'setting:desktopSessionCleanupPeriodDays': 0,
      'setting:wslInheritsWindowsSettings': false,
    }
    for (const [id, value] of Object.entries(expectedDefaults)) {
      expect(byId.get(id)?.default).toBe(value)
      expect(byId.get(id)?.defaultDocumented).toBe(true)
    }
    expect(byId.get('setting:sandbox.autoAllowBashIfSandboxed')?.excerpt).toContain(
      '* **Default**: `false`. Before v2.1.324, the default was `true`',
    )
  })

  test('real snapshot preserves complete compound types', async () => {
    const { inventory } = await readSnapshot()
    const byId = new Map(inventory.entries.map(entry => [entry.id, entry]))
    expect(byId.get('setting:hooks')?.types).toEqual([
      'object keyed by hook event; each value is an array of `{ "matcher", "hooks" }` groups whose `hooks` entries have a `type` of `"command"`, `"prompt"`, `"agent"`, `"http"`, or `"mcp_tool"`',
    ])
    expect(byId.get('setting:permissions')?.types).toEqual([
      'object with `allow`, `ask`, `deny`, `additionalDirectories`, `blockReadsOutsideWorkingDirectories`, `blockWritesOutsideWorkingDirectories`, `defaultMode`, `denyInsteadOfPrompting`, `disableBypassPermissionsMode`, and `disableAutoMode`',
    ])
    expect(byId.get('setting:sandbox.filesystem')?.types).toEqual([
      'object with `allowWrite`, `denyWrite`, `denyRead`, and `allowRead` arrays, plus the `allowManagedReadPathsOnly` and `disabled` Booleans',
    ])
    for (const key of ['agents', 'hooks', 'mcp', 'skills']) {
      expect(byId.get(`setting:strictPluginOnlyCustomization.${key}`)?.types).toEqual([
        `the string \`"${key}"\` in the \`strictPluginOnlyCustomization\` array`,
      ])
    }
  })

  test('real snapshot registers every static child declared by an object-with Type', async () => {
    const { inventory } = await readSnapshot()
    const byId = new Map(inventory.entries.map(entry => [entry.id, entry]))
    const expectedIds = [
      'setting:autoMode.allow',
      'setting:autoMode.environment',
      'setting:autoMode.hard_deny',
      'setting:autoMode.soft_deny',
      'setting:fileSuggestion.command',
      'setting:fileSuggestion.type',
      'setting:modelPicker.options',
      'setting:modelPicker.replaceBuiltInOptions',
      'setting:modelPricing.multiplier',
      'setting:modelPricing.overrides',
      'setting:permissions.disableAutoMode',
      'setting:sandbox.credentials.sigv4.presigned',
      'setting:sandbox.credentials.sigv4.sigv4a',
      'setting:sandbox.credentials.sigv4.streaming',
      'setting:sandbox.network.tlsTerminate.caCertPath',
      'setting:sandbox.network.tlsTerminate.caKeyPath',
      'setting:sandbox.ripgrep.args',
      'setting:sandbox.ripgrep.command',
      'setting:spellcheck.checker',
      'setting:spellcheck.color',
      'setting:spellcheck.enabled',
      'setting:spellcheck.language',
      'setting:spinnerTipsOverride.excludeDefault',
      'setting:spinnerTipsOverride.label',
      'setting:spinnerTipsOverride.tips',
      'setting:spinnerTipsOverride.tipsFile',
      'setting:spinnerVerbs.mode',
      'setting:spinnerVerbs.verbs',
      'setting:statusLine.command',
      'setting:statusLine.hideVimModeIndicator',
      'setting:statusLine.padding',
      'setting:statusLine.refreshInterval',
      'setting:statusLine.type',
      'setting:voice.autoSubmit',
      'setting:voice.enabled',
      'setting:voice.mode',
    ]
    expect(expectedIds.filter(id => !byId.has(id))).toEqual([])
    for (const id of expectedIds) {
      const child = byId.get(id)!
      const parent = byId.get(id.slice(0, id.lastIndexOf('.')))!
      expect(child.path).toBe(id.slice('setting:'.length))
      expect(child.title).toBe(child.path)
      expect(child.default).toBeNull()
      expect(child.defaultDocumented).toBe(false)
      expect(child.scopes).toEqual(parent.scopes)
      expect(child.sourceRules).toBe(parent.sourceRules)
      expect(child.precedence).toBe('')
      expect(child.precedenceDocumented).toBe(false)
      expect(child.lifecycle).toBe(parent.lifecycle)
      expect(child.introduced).toBe(parent.introduced)
      expect(child.afterBaseline).toBe(parent.afterBaseline)
      expect(child.source).toEqual(parent.source)
      expect(child.excerpt).toContain('* **Type**: object with')
    }
  })

  test('real snapshot retains all sixteen Scope precedence passages and source rules', async () => {
    const { inventory } = await readSnapshot()
    const byId = new Map(inventory.entries.map(entry => [entry.id, entry]))
    const scopePrecedenceIds = [
      'setting:allowedHttpHookUrls',
      'setting:allowedMcpServers',
      'setting:bashEditDiffEnabled',
      'setting:deniedMcpServers',
      'setting:disableAutoMode',
      'setting:forceRemoteSettingsRefresh',
      'setting:hooks',
      'setting:httpHookAllowedEnvVars',
      'setting:managedSourcesBehavior',
      'setting:minimumVersion',
      'setting:modelPicker',
      'setting:parentSettingsBehavior',
      'setting:policyHelper',
      'setting:sandbox.allowNestedUserNamespaces',
      'setting:spellcheck',
      'setting:workflowSizeGuideline',
    ]
    for (const id of scopePrecedenceIds) {
      const entry = byId.get(id)!
      expect(entry.precedenceDocumented).toBe(true)
      expect(entry.precedence).toContain(entry.sourceRules)
    }
    expect(byId.get('setting:hooks')?.precedence).toContain('Hooks merge across files')
  })

  describe('ownerBatch determination', () => {
    test('assigns B1 to all hooks', () => {
      expect(determineOwnerBatch('hook:Stop')).toBe(1)
      expect(determineOwnerBatch('hook:PostToolBatch')).toBe(1)
      expect(determineOwnerBatch('hook:UserPromptExpansion')).toBe(1)
    })

    test('assigns B1 to process/subagent-related settings and env vars', () => {
      expect(determineOwnerBatch('setting:subagent')).toBe(1)
      expect(determineOwnerBatch('setting:background')).toBe(1)
      expect(determineOwnerBatch('setting:daemon')).toBe(1)
      expect(determineOwnerBatch('env:CLAUDE_CODE_MAX_SUBAGENT')).toBe(1)
      expect(determineOwnerBatch('env:DEBUG')).toBe(1)
      expect(determineOwnerBatch('env:LOG_LEVEL')).toBe(1)
      expect(determineOwnerBatch('env:VERBOSE')).toBe(1)
    })

    test('assigns B2 to local core and UI settings', () => {
      expect(determineOwnerBatch('setting:model')).toBe(2)
      expect(determineOwnerBatch('setting:thinking')).toBe(2)
      expect(determineOwnerBatch('setting:compact')).toBe(2)
      expect(determineOwnerBatch('setting:output')).toBe(2)
      expect(determineOwnerBatch('setting:status')).toBe(2)
      expect(determineOwnerBatch('setting:terminal')).toBe(2)
      expect(determineOwnerBatch('setting:theme')).toBe(2)
      expect(determineOwnerBatch('setting:editor')).toBe(2)
      expect(determineOwnerBatch('setting:ui')).toBe(2)
      expect(determineOwnerBatch('setting:show')).toBe(2)
      expect(determineOwnerBatch('setting:verbose')).toBe(2)
      expect(determineOwnerBatch('setting:auto')).toBe(2)
      expect(determineOwnerBatch('setting:fileCheckpointing')).toBe(2)
      expect(determineOwnerBatch('setting:teammate')).toBe(2)
      expect(determineOwnerBatch('setting:preferred')).toBe(2)
    })

    test('assigns B3 to security and filesystem settings', () => {
      expect(determineOwnerBatch('setting:permissions')).toBe(3)
      expect(determineOwnerBatch('setting:permissions.allow')).toBe(3)
      expect(determineOwnerBatch('setting:permissions.deny')).toBe(3)
      expect(determineOwnerBatch('setting:attribution')).toBe(3)
      expect(determineOwnerBatch('setting:worktree')).toBe(3)
      expect(determineOwnerBatch('setting:sandbox')).toBe(3)
      expect(determineOwnerBatch('setting:allowManagedHooksOnly')).toBe(3)
    })

    test('assigns B4 to integration and managed settings', () => {
      expect(determineOwnerBatch('setting:mcp')).toBe(4)
      expect(determineOwnerBatch('setting:plugin')).toBe(4)
      expect(determineOwnerBatch('setting:skill')).toBe(4)
      expect(determineOwnerBatch('setting:auth')).toBe(4)
      expect(determineOwnerBatch('setting:oauth')).toBe(4)
      expect(determineOwnerBatch('setting:github')).toBe(4)
      expect(determineOwnerBatch('setting:gitlab')).toBe(4)
      expect(determineOwnerBatch('setting:bridge')).toBe(4)
      expect(determineOwnerBatch('setting:remote')).toBe(4)
      expect(determineOwnerBatch('setting:crossSession')).toBe(4)
      expect(determineOwnerBatch('setting:isolatePeer')).toBe(4)
      expect(determineOwnerBatch('setting:forceLogin')).toBe(4)
      expect(determineOwnerBatch('setting:gateway')).toBe(4)
      expect(determineOwnerBatch('setting:disableClaudeAiConnectors')).toBe(4)
      expect(determineOwnerBatch('setting:allowAllClaudeAiMcps')).toBe(4)
      expect(determineOwnerBatch('setting:allowClaudeInChromeWithManagedMcp')).toBe(4)
      expect(determineOwnerBatch('setting:forceRemoteSettingsRefresh')).toBe(4)
      expect(determineOwnerBatch('env:CLAUDE_CODE_MCP')).toBe(4)
      expect(determineOwnerBatch('env:CLAUDE_CODE_PLUGIN')).toBe(4)
      expect(determineOwnerBatch('env:CLAUDE_CODE_REMOTE')).toBe(4)
      expect(determineOwnerBatch('env:CLAUDE_CROSS_SESSION')).toBe(4)
    })

    test('assigns B5 to independent feature settings', () => {
      expect(determineOwnerBatch('setting:artifact')).toBe(5)
      expect(determineOwnerBatch('setting:disableArtifact')).toBe(5)
      expect(determineOwnerBatch('setting:enableArtifact')).toBe(5)
      expect(determineOwnerBatch('setting:sync')).toBe(5)
      expect(determineOwnerBatch('setting:mod')).toBe(5)
      expect(determineOwnerBatch('setting:feedback')).toBe(5)
      expect(determineOwnerBatch('setting:autoContinue')).toBe(5)
      expect(determineOwnerBatch('setting:autoContinueAtUsageLimit')).toBe(5)
      expect(determineOwnerBatch('setting:dialogExpiry')).toBe(5)
      expect(determineOwnerBatch('setting:switchModelsOnFlag')).toBe(5)
      expect(determineOwnerBatch('env:CLAUDE_CODE_ARTIFACT')).toBe(5)
      expect(determineOwnerBatch('env:CLAUDE_CODE_SYNC')).toBe(5)
      expect(determineOwnerBatch('env:CLAUDE_CODE_MOD')).toBe(5)
      expect(determineOwnerBatch('env:CLAUDE_CODE_FEEDBACK')).toBe(5)
      expect(determineOwnerBatch('env:CLAUDE_CODE_AUTO_CONTINUE')).toBe(5)
    })

    test('assigns final to uncategorized settings for manual triage', () => {
      expect(determineOwnerBatch('setting:advisorModel')).toBe('final')
      expect(determineOwnerBatch('setting:agent')).toBe('final')
      expect(determineOwnerBatch('setting:agentPushNotifEnabled')).toBe('final')
      expect(determineOwnerBatch('setting:unknownFutureKey')).toBe('final')
    })

    test('assigns final to unknown env vars and B3 to sandbox env vars', () => {
      // 未知环境变量归 final，不再默认塞 B1
      expect(determineOwnerBatch('env:SOME_UNKNOWN_FLAG')).toBe('final')
      expect(determineOwnerBatch('env:ANTHROPIC_BASE_URL')).toBe('final')
      // 明确的 sandbox/security 语义归 B3
      expect(determineOwnerBatch('env:CLAUDE_CODE_SANDBOX')).toBe(3)
      expect(determineOwnerBatch('env:SEATBELT_PROFILE')).toBe(3)
      // 明确的进程/subagent 语义归 B1
      expect(determineOwnerBatch('env:CLAUDE_CODE_SUBAGENT')).toBe(1)
      expect(determineOwnerBatch('env:DEBUG')).toBe(1)
      expect(determineOwnerBatch('env:API_TIMEOUT_MS')).toBe(1)
    })
  })

  describe('multi-baseline functionality', () => {
    test('can load baseline pointer', async () => {
      const { getBaselinePointer } = await import('../scripts/upstreamConfigInventory.ts')
      const pointer = await getBaselinePointer()
      expect(pointer.schemaVersion).toBe(1)
      expect(typeof pointer.active).toBe('string')
      expect(Array.isArray(pointer.available)).toBe(true)
      expect(pointer.available.length).toBeGreaterThan(0)
    })

    test('can load inventory for 2.1.311', async () => {
      const { loadInventoryForVersion } = await import('../scripts/upstreamConfigInventory.ts')
      const inventory = await loadInventoryForVersion('2.1.311')
      expect(inventory.baseline.version).toBe('2.1.311')
      expect(inventory.entries.length).toBeGreaterThan(0)
    })

    test('diffInventories with same inventory produces empty diff', async () => {
      const { loadInventoryForVersion, diffInventories } = await import('../scripts/upstreamConfigInventory.ts')
      const inventory = await loadInventoryForVersion('2.1.311')
      const diff = diffInventories(inventory, inventory)
      expect(diff.added).toEqual([])
      expect(diff.removed).toEqual([])
      expect(diff.changed).toEqual([])
      expect(diff.unchanged.length).toEqual(inventory.entries.length)
    })
  })
})
