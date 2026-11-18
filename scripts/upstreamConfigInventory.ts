import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const UPSTREAM_BASELINE_VERSION = '2.1.311' as const

/**
 * 确定条目归属批次 B1-B5，遵循路线 4.5 节语义
 */
export function determineOwnerBatch(
  id: string,
  entry?: { lifecycle?: 'active' | 'deprecated' | 'removed', kind?: 'setting' | 'hook' | 'env' }
): 1 | 2 | 3 | 4 | 5 {
  // B1: Hooks 与当前环境变量
  if (id.startsWith('hook:')) return 1

  // 环境变量按语义划分
  if (id.startsWith('env:')) {
    const envName = id.slice('env:'.length)
    // B4: MCP/插件/认证/远程/跨会话
    if (envName.includes('MCP') || envName.includes('PLUGIN') || envName.includes('SKILL') ||
        envName.includes('AUTH') || envName.includes('OAUTH') || envName.includes('GITHUB') ||
        envName.includes('GITLAB') || envName.includes('BRIDGE') || envName.includes('REMOTE') ||
        envName.includes('CROSS_SESSION') || envName.includes('GATEWAY')) {
      return 4
    }
    // B5: Artifact/同步/mods/反馈/自动继续
    if (envName.includes('ARTIFACT') || envName.includes('SYNC') || envName.includes('MOD') ||
        envName.includes('FEEDBACK') || envName.includes('AUTO_CONTINUE')) {
      return 5
    }
    // 剩余环境变量默认 B1
    return 1
  }

  // B5: 完全缺失功能（Artifact/同步/mods/反馈/自动继续）- 先检查更具体的前缀
  if (id.startsWith('setting:artifact') ||
      id.startsWith('setting:disableArtifact') ||
      id.startsWith('setting:enableArtifact') ||
      id.startsWith('setting:sync') ||
      id === 'setting:mod' || id.startsWith('setting:mod.') ||
      id.startsWith('setting:feedback') ||
      id.startsWith('setting:autoContinue') ||
      id.startsWith('setting:dialogExpiry') ||
      id.startsWith('setting:switchModels')) {
    return 5
  }

  // B4: 集成与托管（MCP/插件/认证/remote/跨会话）
  if (id.startsWith('setting:mcp') ||
      id.startsWith('setting:plugin') ||
      id.startsWith('setting:skill') ||
      id.startsWith('setting:auth') ||
      id.startsWith('setting:oauth') ||
      id.startsWith('setting:github') ||
      id.startsWith('setting:gitlab') ||
      id.startsWith('setting:bridge') ||
      id.startsWith('setting:remote') ||
      id.startsWith('setting:crossSession') ||
      id.startsWith('setting:isolatePeer') ||
      id.startsWith('setting:forceLogin') ||
      id.startsWith('setting:gateway') ||
      id.startsWith('setting:disableClaudeAi') ||
      id.startsWith('setting:allowAllClaudeAi') ||
      id.startsWith('setting:allowClaudeInChromeWithManagedMcp') ||
      id.startsWith('setting:forceRemote')) {
    return 4
  }

  // B3: 安全与文件系统（permissions/attribution/worktree/sandbox）
  if (id.startsWith('setting:permissions') ||
      id.startsWith('setting:attribution') ||
      id.startsWith('setting:worktree') ||
      id.startsWith('setting:sandbox') ||
      id.startsWith('setting:allowManagedHooksOnly')) {
    return 3
  }

  // B1: setting 前缀匹配（subagent/进程相关）
  if (id.startsWith('setting:subagent') ||
      id.startsWith('setting:background') ||
      id.startsWith('setting:daemon')) {
    return 1
  }

  // B2: 本地核心与 UI
  if (id.startsWith('setting:model') ||
      id.startsWith('setting:thinking') ||
      id.startsWith('setting:compact') ||
      id.startsWith('setting:output') ||
      id.startsWith('setting:status') ||
      id.startsWith('setting:terminal') ||
      id.startsWith('setting:theme') ||
      id.startsWith('setting:editor') ||
      id.startsWith('setting:ui') ||
      id.startsWith('setting:show') ||
      id.startsWith('setting:verbose') ||
      id.startsWith('setting:auto') ||
      id.startsWith('setting:fileCheckpointing') ||
      id.startsWith('setting:teammate') ||
      id.startsWith('setting:preferred')) {
    return 2
  }

  // 默认 B3（B0 批次，基础设施）
  return 3
}

export type InventoryDiff = {
  left: string
  right: string
  added: UpstreamEntry[]
  removed: UpstreamEntry[]
  changed: Array<{
    id: string
    left: UpstreamEntry
    right: UpstreamEntry
    changes: Array<'types' | 'default' | 'scopes' | 'sourceRules' | 'precedence' | 'lifecycle' | 'introduced' | 'replacement'>
  }>
  unchanged: string[]
}

export type BaselinePointer = {
  schemaVersion: 1
  active: string
  available: string[]
}

export async function getBaselinePointer(fixturesRoot?: string): Promise<BaselinePointer> {
  const root = fixturesRoot
    ? join(fixturesRoot, 'baseline.json')
    : new URL('../fixtures/upstream-config/baseline.json', import.meta.url)
  return JSON.parse(await readFile(root, 'utf8')) as BaselinePointer
}

export async function loadInventoryForVersion(
  version: string,
  fixturesRoot?: string,
): Promise<UpstreamInventory> {
  const root = fixturesRoot
    ? join(fixturesRoot, version)
    : fileURLToPath(new URL(`../fixtures/upstream-config/${version}/`, import.meta.url))
  const inventoryPath = join(root, 'inventory.json')
  return JSON.parse(await readFile(inventoryPath, 'utf8')) as UpstreamInventory
}

export function diffInventories(left: UpstreamInventory, right: UpstreamInventory): InventoryDiff {
  const leftById = new Map(left.entries.map(entry => [entry.id, entry]))
  const rightById = new Map(right.entries.map(entry => [entry.id, entry]))
  const allIds = new Set([...leftById.keys(), ...rightById.keys()])

  const added: UpstreamEntry[] = []
  const removed: UpstreamEntry[] = []
  const changed: InventoryDiff['changed'] = []
  const unchanged: string[] = []

  for (const id of allIds) {
    const leftEntry = leftById.get(id)
    const rightEntry = rightById.get(id)
    if (!leftEntry && rightEntry) {
      added.push(rightEntry)
    } else if (leftEntry && !rightEntry) {
      removed.push(leftEntry)
    } else if (leftEntry && rightEntry) {
      const changes: InventoryDiff['changed'][0]['changes'] = []
      function fieldChanged<T>(a: T, b: T, name: typeof changes[0]) {
        const aStr = JSON.stringify(a)
        const bStr = JSON.stringify(b)
        if (aStr !== bStr) changes.push(name)
      }
      fieldChanged(leftEntry.types, rightEntry.types, 'types')
      fieldChanged(leftEntry.default, rightEntry.default, 'default')
      fieldChanged(leftEntry.scopes, rightEntry.scopes, 'scopes')
      fieldChanged(leftEntry.sourceRules, rightEntry.sourceRules, 'sourceRules')
      fieldChanged(leftEntry.precedence, rightEntry.precedence, 'precedence')
      fieldChanged(leftEntry.lifecycle, rightEntry.lifecycle, 'lifecycle')
      fieldChanged(leftEntry.introduced, rightEntry.introduced, 'introduced')
      fieldChanged(leftEntry.replacement, rightEntry.replacement, 'replacement')
      if (changes.length > 0) {
        changed.push({ id, left: leftEntry, right: rightEntry, changes })
      } else {
        unchanged.push(id)
      }
    }
  }

  return {
    left: left.baseline.version,
    right: right.baseline.version,
    added,
    removed,
    changed,
    unchanged,
  }
}

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

function stripMarkdownLinks(value: string): string {
  const linkStart = /\[([^\]]+)\]\(/g
  let result = ''
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = linkStart.exec(value))) {
    let depth = 1
    let index = linkStart.lastIndex
    let escaped = false
    for (; index < value.length; index++) {
      const character = value[index]!
      if (escaped) {
        escaped = false
        continue
      }
      if (character === '\\') {
        escaped = true
        continue
      }
      if (character === '(') depth++
      if (character === ')') {
        depth--
        if (depth === 0) {
          index++
          break
        }
      }
    }
    if (depth !== 0) {
      result += value.slice(cursor, linkStart.lastIndex)
      cursor = linkStart.lastIndex
      continue
    }
    result += value.slice(cursor, match.index) + match[1]!
    cursor = index
    linkStart.lastIndex = index
  }
  return result + value.slice(cursor)
}

export function stripMarkdown(value: string): string {
  return stripMarkdownLinks(value)
    .replace(/\\(.)/g, (match, character: string) =>
      '\\`*_{}[]()#+-.!|>'.includes(character) ? character : match,
    )
    .trim()
}

function splitTableRow(line: string): string[] {
  const cells: string[] = []
  let cell = ''
  let escaped = false
  let codeDelimiterLength = 0

  for (let index = 0; index < line.length; index++) {
    const character = line[index]!
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
      let end = index + 1
      while (line[end] === '`') end++
      const delimiterLength = end - index
      cell += line.slice(index, end)
      if (codeDelimiterLength === 0) codeDelimiterLength = delimiterLength
      else if (codeDelimiterLength === delimiterLength) codeDelimiterLength = 0
      index = end - 1
      continue
    }
    if (character === '|' && codeDelimiterLength === 0) {
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

function codeFenceVisibility(lines: string[]): boolean[] {
  const visible: boolean[] = []
  let fence: { character: string; length: number } | undefined
  for (const line of lines) {
    const marker = line.match(/^\s*(?:>\s*)?(`{3,}|~{3,})/)?.[1]
    if (fence) {
      visible.push(false)
      if (
        marker?.[0] === fence.character &&
        marker.length >= fence.length &&
        /^\s*(?:>\s*)?(?:`{3,}|~{3,})\s*$/.test(line)
      ) {
        fence = undefined
      }
      continue
    }
    if (marker) {
      fence = { character: marker[0]!, length: marker.length }
      visible.push(false)
    } else {
      visible.push(true)
    }
  }
  return visible
}

function parseTargetTable(
  markdown: string,
  expectedHeaders: readonly string[],
): TableRow[] {
  const lines = markdown.split(/\r?\n/)
  const visible = codeFenceVisibility(lines)
  const headerIndex = lines.findIndex((line, index) => {
    if (!visible[index] || !line.trimStart().startsWith('|')) return false
    const cells = splitTableRow(line)
    return cells.length === expectedHeaders.length &&
      cells.every((cell, index) => stripMarkdown(cell) === expectedHeaders[index])
  })
  if (headerIndex === -1) {
    throw new Error(`target table not found: ${expectedHeaders.join(' | ')}`)
  }

  const rows: TableRow[] = []
  for (let index = headerIndex + 1; index < lines.length; index++) {
    if (!visible[index]) continue
    const line = lines[index]!
    if (line.trim() === '') break
    if (!line.trimStart().startsWith('|')) {
      if (/^#{1,6}\s+/.test(line.trimStart())) break
      throw new Error(`malformed target table row at line ${index + 1}: expected a leading |`)
    }
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
  const visible = codeFenceVisibility(lines)
  const sections = new Map<string, DetailSection>()
  for (let index = 0; index < lines.length; index++) {
    if (!visible[index]) continue
    const match = lines[index]!.match(/^###\s+`([^`]+)`\s*$/)
    if (!match) continue
    let end = index + 1
    while (
      end < lines.length &&
      (!visible[end] || !/^#{1,3}\s+/.test(lines[end]!))
    ) end++
    sections.set(match[1]!, { lines: lines.slice(index + 1, end) })
  }
  return sections
}

function withoutCodeBlocks(lines: string[]): string[] {
  const visible = codeFenceVisibility(lines)
  return lines.filter((_, index) => visible[index])
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
  const cleaned = stripMarkdown(value).trim()
  const match = cleaned.match(/^(boolean|string|number|object|array)\b(.*)$/i)
  if (!match) return [cleaned]
  const primary = match[1]!.toLowerCase()
  if (primary === 'object' || primary === 'array') {
    return [`${primary}${match[2]!}`]
  }
  return [primary]
}

const NESTED_SETTING_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/
const NON_KEY_CODE_SPANS = new Set([
  'array',
  'boolean',
  'false',
  'integer',
  'map',
  'null',
  'number',
  'object',
  'record',
  'string',
  'true',
  'undefined',
])

type ObjectWithChild = {
  key: string
  types: string[]
}

function directlyDeclaredChildType(trailingText: string): string[] {
  const match = trailingText.match(
    /^\s*(?:\(\s*|,\s*)?(?:as\s+)?(?:an?\s+)?(boolean|string|number|object|array)\b/i,
  )
  return match ? [match[1]!.toLowerCase()] : []
}

function objectWithChildren(typeValue: string | undefined): ObjectWithChild[] {
  if (!typeValue) return []
  const cleaned = stripMarkdown(typeValue)
  if (!/^object\s+with\b/i.test(cleaned)) return []

  const spans = [...cleaned.matchAll(/`([^`\r\n]+)`/g)]
  const children: ObjectWithChild[] = []
  const seen = new Set<string>()
  let parenthesisDepth = 0
  let cursor = 0

  for (let index = 0; index < spans.length; index++) {
    const span = spans[index]!
    const spanStart = span.index!
    const precedingText = cleaned.slice(cursor, spanStart)
    for (const character of precedingText) {
      if (character === '(') parenthesisDepth++
      if (character === ')') parenthesisDepth = Math.max(0, parenthesisDepth - 1)
    }
    cursor = spanStart + span[0].length

    const key = span[1]!.trim()
    if (
      parenthesisDepth === 0 &&
      NESTED_SETTING_KEY_PATTERN.test(key) &&
      !NON_KEY_CODE_SPANS.has(key.toLowerCase()) &&
      !seen.has(key)
    ) {
      const nextSpanStart = spans[index + 1]?.index ?? cleaned.length
      children.push({
        key,
        types: directlyDeclaredChildType(cleaned.slice(cursor, nextSpanStart)),
      })
      seen.add(key)
    }
  }
  return children
}

function parseDefault(value: string | undefined): {
  value: unknown
  documented: boolean
} {
  if (value === undefined) return { value: null, documented: false }
  const cleaned = stripMarkdown(value)
  const previousDefault = cleaned.match(
    /\bBefore v(\d+\.\d+\.\d+),\s+the default was\s+(`[^`]+`)/i,
  )
  const effectiveValue = previousDefault &&
    compareVersions(UPSTREAM_BASELINE_VERSION, previousDefault[1]!) < 0
    ? previousDefault[2]!
    : cleaned
  const literal = effectiveValue.match(/^`(true|false|null)`(?=$|[\s,.;:?!])/)
  if (literal) {
    return {
      value: literal[1] === 'null' ? null : literal[1] === 'true',
      documented: true,
    }
  }
  const numeric = effectiveValue.match(/^`(-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)`(?=$|[\s,.;:?!])/i)
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

function detailLifecycle(lines: string[]): {
  lifecycle: UpstreamEntry['lifecycle']
  warning?: string
} {
  for (const line of lines) {
    const cleaned = stripMarkdown(line).replace(/^\s*>\s*/, '')
    if (/^Deprecated\b/i.test(cleaned)) return { lifecycle: 'deprecated', warning: line }
    if (/^Removed\b/i.test(cleaned)) return { lifecycle: 'removed', warning: line }
  }
  return { lifecycle: 'active' }
}

function replacementFromText(value: string): string | undefined {
  return value.match(/\buse\s+`([^`]+)`/i)?.[1]
}

export function completeRequiresStatement(value: string): string | undefined {
  const start = /Requires Claude Code v\d+\.\d+\.\d+\b/.exec(value)
  if (!start) return undefined
  const statement = value.slice(start.index).split('|', 1)[0]!.trim()
  const afterVersion = statement.slice(start[0].length)
  const punctuation = /[.!?](?=\s|$)/.exec(afterVersion)
  if (punctuation) {
    return statement.slice(0, start[0].length + punctuation.index + 1)
  }
  return /\bor later$/.test(statement) ? statement : undefined
}

function versionMetadata(value: string): {
  introduced?: string
  afterBaseline?: boolean
} {
  const versions = [...new Set(
    [...value.matchAll(REQUIRES_PATTERN)].map(match => match[1]!),
  )]
  if (versions.length === 0) return {}
  if (versions.length > 1) {
    throw new Error(`multiple Requires versions are ambiguous: ${versions.join(', ')}`)
  }
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
    if (/^\s*(?:#|\*\s*\*\*(?:Type|Default)\*\*:|```)/.test(line)) continue
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

function makeExcerpt(
  parts: Array<string | undefined>,
  requiredRequiresStatement?: string,
): string {
  const combined = parts
    .filter((part): part is string => Boolean(part))
    .map(part => stripMarkdown(part!))
    .join(' | ')
    .replace(/\s+/g, ' ')
    .trim()
  const excerpt = combined.slice(0, 1000)
  if (requiredRequiresStatement) {
    const required = stripMarkdown(requiredRequiresStatement).replace(/\s+/g, ' ').trim()
    if (!excerpt.includes(required)) {
      throw new Error('complete Requires statement does not fit in the 1000-character excerpt')
    }
  }
  return excerpt
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

  const parents = rows.map(({ cells, lineNumber }) => {
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
    const detailLifecycleResult = detailLifecycle(prose)
    const resolvedLifecycle = lifecycle === 'active' ? detailLifecycleResult.lifecycle : lifecycle
    const requiresText = primaryProse.join('\n')
    const versions = versionMetadata(`${description}\n${requiresText}`)
    const replacement = resolvedLifecycle === 'active'
      ? undefined
      : replacementFromText(`${description}\n${prose.join('\n')}`)
    const sourceRules = scopeLine ? stripMarkdown(scopeLine) : ''
    const requiresSource = primaryProse.find(line =>
      /Requires Claude Code v\d+\.\d+\.\d+/.test(line),
    ) ?? (/Requires Claude Code v\d+\.\d+\.\d+/.test(description) ? description : undefined)
    const requiresStatement = requiresSource === undefined
      ? undefined
      : completeRequiresStatement(requiresSource)
    if (requiresSource !== undefined && requiresStatement === undefined) {
      throw new Error(`setting ${path} has an incomplete Requires statement`)
    }
    const requiresRemainder = requiresSource !== undefined &&
      requiresSource !== description && requiresStatement !== undefined
      ? requiresSource.replace(requiresStatement, '')
      : undefined

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
        requiresStatement,
        sourceRules,
        typeLine,
        defaultLine,
        lifecycle === 'active' ? detailLifecycleResult.warning : undefined,
        requiresRemainder,
        precedence,
      ], requiresStatement),
    }
  })

  const explicitPaths = new Set<string>([...details.keys(), ...parents.map(entry => entry.path)])
  return parents.flatMap(parent => {
    const prose = withoutCodeBlocks(details.get(parent.path)?.lines ?? [])
    const typeValue = metadataValue(prose, 'Type')
    const typeLine = metadataLine(prose, 'Type')
    const children = objectWithChildren(typeValue)
      .filter(({ key }) => !explicitPaths.has(`${parent.path}.${key}`))
      .map(({ key, types }): UpstreamEntry => {
        const path = `${parent.path}.${key}`
        const parentRequiresStatement = completeRequiresStatement(parent.excerpt)
        return {
          id: `setting:${path}`,
          kind: 'setting',
          path,
          title: path,
          types,
          default: null,
          defaultDocumented: false,
          scopes: [...parent.scopes],
          sourceRules: parent.sourceRules,
          precedence: '',
          precedenceDocumented: false,
          lifecycle: parent.lifecycle,
          ...(parent.introduced ? { introduced: parent.introduced } : {}),
          ...(parent.afterBaseline ? { afterBaseline: true } : {}),
          source: { ...parent.source },
          excerpt: makeExcerpt(
            [parentRequiresStatement, typeLine, parent.sourceRules],
            parentRequiresStatement,
          ),
        }
      })
    return [parent, ...children]
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
    const replacement = lifecycle === 'active' ? undefined : replacementFromText(description)
    const requiresStatement = completeRequiresStatement(description)
    if (
      /Requires Claude Code v\d+\.\d+\.\d+/.test(description) &&
      requiresStatement === undefined
    ) {
      throw new Error(`hook ${path} has an incomplete Requires statement`)
    }
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
      excerpt: makeExcerpt([description], requiresStatement),
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
    const replacement = lifecycle === 'active' ? undefined : replacementFromText(description)
    const precedence = PRECEDENCE_PATTERN.test(description) ? description : ''
    const requiresStatement = completeRequiresStatement(description)
    if (
      /Requires Claude Code v\d+\.\d+\.\d+/.test(description) &&
      requiresStatement === undefined
    ) {
      throw new Error(`environment variable ${path} has an incomplete Requires statement`)
    }
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
      excerpt: makeExcerpt([description], requiresStatement),
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
    if (!entry.source.anchor) {
      throw new Error(`inventory entry requires a source anchor: ${entry.id}`)
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
  const binaryVersion = version.match(/^\d+\.\d+\.\d+(?=\s|$)/)?.[0]
  if (binaryVersion !== UPSTREAM_BASELINE_VERSION) {
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
