import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildInventory,
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
    ]))).toEqual({ setting: 249, hook: 33, env: 413 })
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
})
