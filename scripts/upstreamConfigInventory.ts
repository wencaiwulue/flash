import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const UPSTREAM_BASELINE_VERSION = '2.1.311' as const

export type UpstreamSource = {
  url: string
  sha256: string
}

export type UpstreamDocument = UpstreamSource & {
  capturedAt: string
}

export type UpstreamBinary = {
  version: string
  commit: string
  platform: string
  sha256: string
}

export type UpstreamEntry = {
  id: string
  kind: 'setting' | 'hook' | 'env'
  path: string
  title: string
  types: string[]
  default: unknown
  defaultDocumented: boolean
  scopes: string[]
  sourceRules: string
  precedence: string
  precedenceDocumented: boolean
  lifecycle: 'active' | 'deprecated' | 'removed'
  introduced?: string
  afterBaseline?: boolean
  replacement?: string
  source: UpstreamSource & { anchor: string }
  excerpt: string
}

export type UpstreamInventory = {
  schemaVersion: 1
  baseline: {
    version: typeof UPSTREAM_BASELINE_VERSION
    distTag: 'stable'
    capturedAt: string
    documents: Record<string, UpstreamDocument>
    binary: UpstreamBinary
  }
  entries: UpstreamEntry[]
}

export type BuildInventoryInput = {
  entries: UpstreamEntry[]
  documents: Record<string, UpstreamDocument>
  capturedAt: string
  binary: UpstreamBinary
}

type TableRow = {
  cells: string[]
  line: string
  lineNumber: number
}

type DetailSection = {
  lines: string[]
}

const KIND_ORDER: Record<UpstreamEntry['kind'], number> = {
  setting: 0,
  hook: 1,
  env: 2,
}

const PRECEDENCE_PATTERN = /precedence|override|merge|highest|outrank/i
const REQUIRES_PATTERN = /Requires Claude Code v(\d+\.\d+\.\d+)/g

export function stripMarkdown(value: string): string {
  return value
    .replace(/\[([^\]]+)\]\((?:\\.|[^)])*\)/g, '$1')
    .replace(/\\(.)/g, (match, character: string) =>
      '\\`*_{}[]()#+-.!|>'.includes(character) ? character : match,
    )
    .trim()
}

function splitTableRow(line: string): string[] {
  const cells: string[] = []
  let cell = ''
  let escaped = false
  let inBackticks = false

  for (const character of line) {
    if (escaped) {
      cell += character
      escaped = false
      continue
    }
    if (character === '\\') {
      cell += character
      escaped = true
      continue
    }
    if (character === '`') {
      inBackticks = !inBackticks
      cell += character
      continue
    }
    if (character === '|' && !inBackticks) {
      cells.push(cell)
      cell = ''
      continue
    }
    cell += character
  }
  cells.push(cell)

  if (cells[0]?.trim() === '') cells.shift()
  if (cells.at(-1)?.trim() === '') cells.pop()
  return cells.map(cell => cell.trim())
}

function parseTargetTable(
  markdown: string,
  expectedHeaders: readonly string[],
): TableRow[] {
  const lines = markdown.split(/\r?\n/)
  const headerIndex = lines.findIndex(line => {
    if (!line.trimStart().startsWith('|')) return false
    const cells = splitTableRow(line)
    return cells.length === expectedHeaders.length &&
      cells.every((cell, index) => stripMarkdown(cell) === expectedHeaders[index])
  })
  if (headerIndex === -1) {
    throw new Error(`target table not found: ${expectedHeaders.join(' | ')}`)
  }

  const rows: TableRow[] = []
  for (let index = headerIndex + 1; index < lines.length; index++) {
    const line = lines[index]!
    if (!line.trimStart().startsWith('|')) break
    const cells = splitTableRow(line)
    if (cells.length !== expectedHeaders.length) {
      throw new Error(
        `malformed target table row at line ${index + 1}: expected ${expectedHeaders.length} columns, received ${cells.length}`,
      )
    }
    if (cells.every(cell => /^:?-+:?$/.test(cell.replace(/\s/g, '')))) continue
    rows.push({ cells, line, lineNumber: index + 1 })
  }
  return rows
}

function indexDetailSections(markdown: string): Map<string, DetailSection> {
  const lines = markdown.split(/\r?\n/)
  const sections = new Map<string, DetailSection>()
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index]!.match(/^###\s+`([^`]+)`\s*$/)
    if (!match) continue
    let end = index + 1
    while (end < lines.length && !/^#{1,3}\s+/.test(lines[end]!)) end++
    sections.set(match[1]!, { lines: lines.slice(index + 1, end) })
  }
  return sections
}

function withoutCodeBlocks(lines: string[]): string[] {
  const result: string[] = []
  let inCodeBlock = false
  for (const line of lines) {
    if (/^\s*(?:>\s*)?```/.test(line)) {
      inCodeBlock = !inCodeBlock
      continue
    }
    if (!inCodeBlock) result.push(line)
  }
  return result
}

function metadataValue(lines: string[], label: string): string | undefined {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`^\\s*\\*\\s+\\*\\*${escapedLabel}\\*\\*:\\s*(.+?)\\s*$`)
  for (const line of lines) {
    const match = line.match(pattern)
    if (match) return match[1]
  }
  return undefined
}

function metadataLine(lines: string[], label: string): string | undefined {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`^\\s*\\*\\s+\\*\\*${escapedLabel}\\*\\*:`)
  return lines.find(line => pattern.test(line))
}

function normalizeType(value: string | undefined): string[] {
  if (!value) return []
  const primary = stripMarkdown(value).split(/[,:]/, 1)[0]!.trim().toLowerCase()
  const aliases: Record<string, string> = {
    boolean: 'boolean',
    string: 'string',
    number: 'number',
    object: 'object',
    array: 'array',
  }
  return [aliases[primary] ?? primary]
}

function parseDefault(value: string | undefined): {
  value: unknown
  documented: boolean
} {
  if (value === undefined) return { value: null, documented: false }
  const cleaned = stripMarkdown(value)
  const literal = cleaned.match(/^`(true|false|null)`(?:\s|$)/)
  if (literal) {
    return {
      value: literal[1] === 'null' ? null : literal[1] === 'true',
      documented: true,
    }
  }
  const numeric = cleaned.match(/^`(-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)`(?:\s|$)/i)
  if (numeric) {
    const number = Number(numeric[1])
    if (Number.isFinite(number)) return { value: number, documented: true }
  }
  return { value: null, documented: true }
}

function lifecycleFromText(value: string): UpstreamEntry['lifecycle'] {
  const cleaned = stripMarkdown(value).replace(/^\s*>\s*/, '')
  if (/^Deprecated\b/i.test(cleaned)) return 'deprecated'
  if (/^Removed\b/i.test(cleaned)) return 'removed'
  return 'active'
}

function detailLifecycle(lines: string[]): UpstreamEntry['lifecycle'] {
  for (const line of lines) {
    const cleaned = stripMarkdown(line).replace(/^\s*>\s*/, '')
    if (/^Deprecated\b/i.test(cleaned)) return 'deprecated'
    if (/^Removed\b/i.test(cleaned)) return 'removed'
  }
  return 'active'
}

function replacementFromText(value: string): string | undefined {
  return value.match(/\buse\s+`([^`]+)`/i)?.[1]
}

function versionMetadata(value: string): {
  introduced?: string
  afterBaseline?: boolean
} {
  const versions = [...value.matchAll(REQUIRES_PATTERN)].map(match => match[1]!)
  if (versions.length === 0) return {}
  const afterBaseline = versions.some(version => compareVersions(version, UPSTREAM_BASELINE_VERSION) > 0)
  return {
    introduced: versions[0],
    ...(afterBaseline ? { afterBaseline: true } : {}),
  }
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split('.').map(Number)
  const rightParts = right.split('.').map(Number)
  for (let index = 0; index < 3; index++) {
    const difference = leftParts[index]! - rightParts[index]!
    if (difference !== 0) return difference
  }
  return 0
}

function settingsPrecedence(lines: string[]): string {
  const passages: string[] = []
  for (const line of lines) {
    const perSession = metadataValue([line], 'Per-session overrides')
    if (perSession) {
      passages.push(stripMarkdown(perSession))
      continue
    }
    if (!PRECEDENCE_PATTERN.test(line)) continue
    if (/^\s*(?:#|\*\s*\*\*(?:Scope|Type|Default)\*\*:|```)/.test(line)) continue
    const cleaned = stripMarkdown(line)
    if (cleaned) passages.push(cleaned)
  }
  return [...new Set(passages)].join('\n')
}

function scopeNames(scopeValue: string | undefined, fallback: string): string[] {
  const value = scopeValue ?? fallback
  const linkedScope = value.match(/\[([^\]]+)\]\(#scopes\)/)?.[1]
  const cleaned = stripMarkdown(linkedScope ?? value)
    .replace(/^`/, '')
    .replace(/`$/, '')
    .trim()
  return cleaned ? [cleaned] : []
}

function makeExcerpt(parts: Array<string | undefined>): string {
  return parts
    .filter((part): part is string => Boolean(part))
    .map(part => stripMarkdown(part!))
    .join(' | ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1000)
}

export function parseSettingsReference(
  markdown: string,
  source: UpstreamSource,
): UpstreamEntry[] {
  let rows: TableRow[]
  try {
    rows = parseTargetTable(markdown, ['Key', 'Description', 'Topic', 'Scope'])
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith('target table not found:')) {
      throw error
    }
    rows = parseTargetTable(markdown, ['Setting', 'Description', 'Category', 'Scope'])
  }
  if (rows.length === 0) throw new Error('settings index table not found')
  const details = indexDetailSections(markdown)

  return rows.map(({ cells, lineNumber }) => {
    const key = cells[0]!.match(/^\[\s*`([^`]+)`\s*\]\(#([^)]+)\)$/)
    if (!key) throw new Error(`malformed settings index key at line ${lineNumber}`)
    const [, path, anchor] = key
    const description = cells[1]!
    const detail = details.get(path!)?.lines ?? []
    const prose = withoutCodeBlocks(detail)
    const firstMetadataIndex = prose.findIndex(line =>
      /^\s*\*\s+\*\*(?:Scope|Type|Default)\*\*:/.test(line),
    )
    const primaryProse = firstMetadataIndex === -1 ? prose : prose.slice(0, firstMetadataIndex)
    const scopeLine = metadataLine(prose, 'Scope')
    const scopeValue = metadataValue(prose, 'Scope')
    const typeLine = metadataLine(prose, 'Type')
    const typeValue = metadataValue(prose, 'Type')
    const defaultLine = metadataLine(prose, 'Default')
    const defaultValue = metadataValue(prose, 'Default')
    const parsedDefault = parseDefault(defaultValue)
    const precedence = settingsPrecedence(prose)
    const lifecycle = lifecycleFromText(description)
    const resolvedLifecycle = lifecycle === 'active' ? detailLifecycle(prose) : lifecycle
    const requiresText = primaryProse.join('\n')
    const versions = versionMetadata(`${description}\n${requiresText}`)
    const replacement = replacementFromText(`${description}\n${prose.join('\n')}`)
    const sourceRules = scopeLine ? stripMarkdown(scopeLine) : ''

    return {
      id: `setting:${path}`,
      kind: 'setting',
      path: path!,
      title: path!,
      types: normalizeType(typeValue),
      default: parsedDefault.value,
      defaultDocumented: parsedDefault.documented,
      scopes: scopeNames(scopeValue, cells[3]!),
      sourceRules,
      precedence,
      precedenceDocumented: precedence.length > 0,
      lifecycle: resolvedLifecycle,
      ...versions,
      ...(replacement ? { replacement } : {}),
      source: { ...source, anchor: `#${anchor}` },
      excerpt: makeExcerpt([
        description,
        sourceRules,
        typeLine,
        defaultLine,
        primaryProse.find(line => /Requires Claude Code v\d+\.\d+\.\d+/.test(line)),
        precedence,
      ]),
    }
  })
}

export function parseHooksReference(
  markdown: string,
  source: UpstreamSource,
): UpstreamEntry[] {
  return parseTargetTable(markdown, ['Event', 'When it fires']).map(({ cells, lineNumber }) => {
    const path = cells[0]!.match(/^`([^`]+)`$/)?.[1]
    if (!path) throw new Error(`malformed hook event at line ${lineNumber}`)
    const description = stripMarkdown(cells[1]!)
    const lifecycle = lifecycleFromText(description)
    const versions = versionMetadata(description)
    const replacement = replacementFromText(description)
    return {
      id: `hook:${path}`,
      kind: 'hook',
      path,
      title: path,
      types: [],
      default: null,
      defaultDocumented: false,
      scopes: [],
      sourceRules: '',
      precedence: '',
      precedenceDocumented: false,
      lifecycle,
      ...versions,
      ...(replacement ? { replacement } : {}),
      source: { ...source, anchor: `#${path.toLowerCase()}` },
      excerpt: makeExcerpt([description]),
    }
  })
}

export function parseEnvironmentReference(
  markdown: string,
  source: UpstreamSource,
): UpstreamEntry[] {
  return parseTargetTable(markdown, ['Variable', 'Purpose']).map(({ cells, lineNumber }) => {
    const path = cells[0]!.match(/^`([^`]+)`$/)?.[1]
    if (!path) throw new Error(`malformed environment variable at line ${lineNumber}`)
    const description = stripMarkdown(cells[1]!)
    const deprecated = /^\[DEPRECATED\](?:\s|$)/i.test(description)
    const lifecycle = deprecated ? 'deprecated' : lifecycleFromText(description)
    const versions = versionMetadata(description)
    const replacement = replacementFromText(description)
    const precedence = PRECEDENCE_PATTERN.test(description) ? description : ''
    return {
      id: `env:${path}`,
      kind: 'env',
      path,
      title: path,
      types: [],
      default: null,
      defaultDocumented: false,
      scopes: [],
      sourceRules: description,
      precedence,
      precedenceDocumented: precedence.length > 0,
      lifecycle,
      ...versions,
      ...(replacement ? { replacement } : {}),
      source: { ...source, anchor: '#variables' },
      excerpt: makeExcerpt([description]),
    }
  })
}

export function buildInventory(input: BuildInventoryInput): UpstreamInventory {
  if (input.entries.length === 0) throw new Error('inventory entries must not be empty')
  const ids = new Set<string>()
  for (const entry of input.entries) {
    if (!entry.id) throw new Error('inventory entry id must not be empty')
    if (ids.has(entry.id)) throw new Error(`duplicate inventory id: ${entry.id}`)
    ids.add(entry.id)
    if (!entry.path) throw new Error(`empty inventory path: ${entry.id}`)
    if (!['setting', 'hook', 'env'].includes(entry.kind)) {
      throw new Error(`invalid inventory kind: ${entry.id}`)
    }
    if (!['active', 'deprecated', 'removed'].includes(entry.lifecycle)) {
      throw new Error(`invalid inventory lifecycle: ${entry.id}`)
    }
    if (!entry.source?.url || !entry.source.sha256) {
      throw new Error(`inventory entry requires a source: ${entry.id}`)
    }
  }

  const entries = [...input.entries].sort((left, right) => {
    const kindDifference = KIND_ORDER[left.kind] - KIND_ORDER[right.kind]
    if (kindDifference !== 0) return kindDifference
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  })

  return {
    schemaVersion: 1,
    baseline: {
      version: UPSTREAM_BASELINE_VERSION,
      distTag: 'stable',
      capturedAt: input.capturedAt,
      documents: input.documents,
      binary: input.binary,
    },
    entries,
  }
}

const DOCUMENT_OPTIONS = {
  settingsReference: {
    flag: '--settings-reference',
    url: 'https://code.claude.com/docs/en/settings-reference.md',
  },
  settings: {
    flag: '--settings',
    url: 'https://code.claude.com/docs/en/settings.md',
  },
  hooksReference: {
    flag: '--hooks-reference',
    url: 'https://code.claude.com/docs/en/hooks.md',
  },
  envVars: {
    flag: '--env-vars',
    url: 'https://code.claude.com/docs/en/env-vars.md',
  },
  llms: {
    flag: '--llms',
    url: 'https://code.claude.com/docs/llms.txt',
  },
} as const

type CliOptions = Record<
  | 'settingsReference'
  | 'settings'
  | 'hooksReference'
  | 'envVars'
  | 'llms'
  | 'binary'
  | 'binaryCommit'
  | 'binaryPlatform'
  | 'capturedAt'
  | 'outputDir',
  string
>

const VALUE_OPTIONS: Record<string, keyof CliOptions> = {
  '--settings-reference': 'settingsReference',
  '--settings': 'settings',
  '--hooks-reference': 'hooksReference',
  '--env-vars': 'envVars',
  '--llms': 'llms',
  '--binary': 'binary',
  '--binary-commit': 'binaryCommit',
  '--binary-platform': 'binaryPlatform',
  '--captured-at': 'capturedAt',
  '--output-dir': 'outputDir',
}

const USAGE = `Usage: bun scripts/upstreamConfigInventory.ts \\
  --settings-reference <markdown> --settings <markdown> \\
  --hooks-reference <markdown> --env-vars <markdown> --llms <txt> \\
  --binary <claude-2.1.311> --binary-commit <commit> \\
  --binary-platform <platform> --captured-at <iso-8601> \\
  --output-dir <directory>`

function parseCliArguments(arguments_: string[]): CliOptions | null {
  if (arguments_.length === 1 && (arguments_[0] === '--help' || arguments_[0] === '-h')) {
    return null
  }
  const values = new Map<keyof CliOptions, string>()
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index]!
    const key = VALUE_OPTIONS[flag]
    if (!key) throw new Error(`unknown argument: ${flag}`)
    if (values.has(key)) throw new Error(`duplicate argument: ${flag}`)
    const value = arguments_[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${flag}`)
    values.set(key, value)
  }
  const missing = Object.entries(VALUE_OPTIONS)
    .filter(([, key]) => !values.has(key))
    .map(([flag]) => flag)
  if (missing.length > 0) throw new Error(`missing required arguments: ${missing.join(', ')}`)
  return Object.fromEntries(values) as CliOptions
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function runCli(arguments_: string[]): Promise<void> {
  const options = parseCliArguments(arguments_)
  if (!options) {
    console.log(USAGE)
    return
  }
  if (Number.isNaN(Date.parse(options.capturedAt))) {
    throw new Error('--captured-at must be an ISO 8601 timestamp')
  }

  const documentContents = new Map<keyof typeof DOCUMENT_OPTIONS, Buffer>()
  for (const [key, definition] of Object.entries(DOCUMENT_OPTIONS) as Array<
    [keyof typeof DOCUMENT_OPTIONS, { flag: string; url: string }]
  >) {
    documentContents.set(key, await readFile(options[key], undefined))
  }
  const documents = Object.fromEntries(
    Object.entries(DOCUMENT_OPTIONS).map(([key, definition]) => [
      key,
      {
        url: definition.url,
        sha256: sha256(documentContents.get(key as keyof typeof DOCUMENT_OPTIONS)!),
        capturedAt: options.capturedAt,
      },
    ]),
  ) as Record<string, UpstreamDocument>

  const versionResult = spawnSync(options.binary, ['--version'], { encoding: 'utf8' })
  if (versionResult.error) throw versionResult.error
  if (versionResult.status !== 0) {
    throw new Error(`upstream binary --version exited ${versionResult.status}: ${versionResult.stderr.trim()}`)
  }
  const version = versionResult.stdout.trim()
  if (!version.includes(UPSTREAM_BASELINE_VERSION)) {
    throw new Error(`upstream binary is not ${UPSTREAM_BASELINE_VERSION}: ${version}`)
  }
  const binary: UpstreamBinary = {
    version,
    commit: options.binaryCommit,
    platform: options.binaryPlatform,
    sha256: await hashFile(options.binary),
  }

  const settingsSource: UpstreamSource = {
    url: documents.settingsReference!.url,
    sha256: documents.settingsReference!.sha256,
  }
  const hooksSource: UpstreamSource = {
    url: documents.hooksReference!.url,
    sha256: documents.hooksReference!.sha256,
  }
  const environmentSource: UpstreamSource = {
    url: documents.envVars!.url,
    sha256: documents.envVars!.sha256,
  }
  const entries = [
    ...parseSettingsReference(
      documentContents.get('settingsReference')!.toString('utf8'),
      settingsSource,
    ),
    ...parseHooksReference(
      documentContents.get('hooksReference')!.toString('utf8'),
      hooksSource,
    ),
    ...parseEnvironmentReference(
      documentContents.get('envVars')!.toString('utf8'),
      environmentSource,
    ),
  ]
  const inventory = buildInventory({
    entries,
    documents,
    capturedAt: options.capturedAt,
    binary,
  })
  const evidence = {
    schemaVersion: 1,
    capturedAt: options.capturedAt,
    documents,
    binary,
    probeDirectory: 'probes',
  }

  await mkdir(options.outputDir, { recursive: true })
  await Promise.all([
    writeFile(join(options.outputDir, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`),
    writeFile(join(options.outputDir, 'inventory.json'), `${JSON.stringify(inventory, null, 2)}\n`),
  ])
  const counts = Object.fromEntries(
    (['setting', 'hook', 'env'] as const).map(kind => [
      kind,
      entries.filter(entry => entry.kind === kind).length,
    ]),
  )
  console.log(`inventory entries: setting=${counts.setting} hook=${counts.hook} env=${counts.env}`)
}

if (import.meta.main) {
  runCli(process.argv.slice(2)).catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
