import { createHash } from 'crypto'
import { readFile, realpath } from 'fs/promises'
import { basename, isAbsolute, resolve } from 'path'
import {
  loadMarkdownFilesForSubdir,
  parseAgentToolsFromFrontmatter,
  type MarkdownFile,
} from '../utils/markdownConfigLoader.js'
import {
  coerceDescriptionToString,
  FRONTMATTER_REGEX,
} from '../utils/frontmatterParser.js'
import { parseYaml } from '../utils/yaml.js'
import { isPathInside } from './state.js'
import { JobError, type TemplateConfig, type TemplateSnapshot } from './schema.js'

export type DiscoveredTemplate = MarkdownFile & { name: string }

function templateName(file: MarkdownFile): string | null {
  const value = file.frontmatter.name ?? basename(file.filePath, '.md')
  return typeof value === 'string' &&
    /^[a-z0-9][a-z0-9-]{0,63}$/.test(value)
    ? value
    : null
}

/** Discovery order and inode de-duplication deliberately belong to the shared loader. */
export async function discoverTemplates(
  cwd = process.cwd(),
): Promise<DiscoveredTemplate[]> {
  const files = await loadMarkdownFilesForSubdir('templates', cwd)
  const result: DiscoveredTemplate[] = []
  for (const file of files) {
    const name = templateName(file)
    if (name) result.push({ ...file, name })
  }
  return result
}

export async function resolveTemplate(
  name: string,
  invocationCwd = process.cwd(),
): Promise<{ snapshot: TemplateSnapshot; workingDirectory: string }> {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
    throw new JobError('TEMPLATE_NOT_FOUND', `Invalid template name: ${name}`)
  }
  const files = await discoverTemplates(invocationCwd)
  const file = files.find(candidate => candidate.name === name)
  if (!file) {
    throw new JobError('TEMPLATE_NOT_FOUND', `Template not found: ${name}`)
  }
  const sourcePath = await realpath(file.filePath)
  const raw = await readFile(sourcePath, 'utf8')
  const frontmatter = file.frontmatter

  // The shared loader intentionally tolerates bad YAML for other component
  // types. A selected job template is different: it must fail closed.
  const match = raw.match(FRONTMATTER_REGEX)
  if (match && match[1]?.trim()) {
    try {
      const parsed = parseYaml(match[1]) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('frontmatter must be an object')
      }
    } catch (error) {
      throw new JobError(
        'TEMPLATE_INVALID',
        `Invalid frontmatter in ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  if (!file.content.trim()) {
    throw new JobError('TEMPLATE_INVALID', `Template body is empty: ${name}`)
  }
  if (
    frontmatter.description !== undefined &&
    frontmatter.description !== null &&
    typeof frontmatter.description === 'object'
  ) {
    throw new JobError('TEMPLATE_INVALID', 'description must be a scalar')
  }
  const description = coerceDescriptionToString(frontmatter.description, name)

  let model: string | null = null
  if (frontmatter.model !== undefined && frontmatter.model !== null) {
    if (typeof frontmatter.model !== 'string' || !frontmatter.model.trim()) {
      throw new JobError('TEMPLATE_INVALID', 'model must be a non-empty string')
    }
    model = frontmatter.model === 'inherit' ? null : frontmatter.model
  }

  const rawMode = frontmatter['permission-mode'] ?? 'default'
  if (
    typeof rawMode !== 'string' ||
    !['default', 'acceptEdits', 'plan'].includes(rawMode)
  ) {
    throw new JobError(
      'TEMPLATE_INVALID',
      'permission-mode must be default, acceptEdits, or plan',
    )
  }

  const rawTools = frontmatter['allowed-tools']
  if (
    Array.isArray(rawTools) &&
    rawTools.some(tool => typeof tool !== 'string')
  ) {
    throw new JobError('TEMPLATE_INVALID', 'allowed-tools entries must be strings')
  }
  if (
    rawTools !== undefined &&
    rawTools !== null &&
    typeof rawTools !== 'string' &&
    !Array.isArray(rawTools)
  ) {
    throw new JobError('TEMPLATE_INVALID', 'allowed-tools must be a string or list')
  }
  const parsedTools = parseAgentToolsFromFrontmatter(rawTools)
  const wildcard =
    rawTools === '*' ||
    (Array.isArray(rawTools) && rawTools.includes('*')) ||
    (typeof rawTools === 'string' && rawTools.split(',').map(v => v.trim()).includes('*'))
  const allowedTools = wildcard ? ['*'] : (parsedTools ?? null)

  const canonicalInvocationCwd = await realpath(invocationCwd)
  const rawCwd = frontmatter.cwd ?? '.'
  if (typeof rawCwd !== 'string' || !rawCwd || isAbsolute(rawCwd)) {
    throw new JobError('TEMPLATE_INVALID', 'cwd must be a relative path')
  }
  const lexicalCwd = resolve(canonicalInvocationCwd, rawCwd)
  if (!isPathInside(canonicalInvocationCwd, lexicalCwd)) {
    throw new JobError('TEMPLATE_INVALID', 'cwd escapes the invocation directory')
  }
  let workingDirectory: string
  try {
    workingDirectory = await realpath(lexicalCwd)
  } catch (error) {
    throw new JobError(
      'TEMPLATE_INVALID',
      `Template cwd is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (!isPathInside(canonicalInvocationCwd, workingDirectory)) {
    throw new JobError('TEMPLATE_INVALID', 'cwd resolves through a symlink escape')
  }

  const config: TemplateConfig = {
    description,
    model,
    permission_mode: rawMode as TemplateConfig['permission_mode'],
    allowed_tools: allowedTools,
    cwd: workingDirectory,
  }
  return {
    snapshot: {
      name,
      source_path: sourcePath,
      sha256: createHash('sha256').update(raw).digest('hex'),
      body: file.content,
      config,
    },
    workingDirectory,
  }
}

export function renderTemplatePrompt(body: string, prompt: string): string {
  if (body.includes('{{args}}')) return body.split('{{args}}').join(prompt)
  return prompt ? `${body}\n\n${prompt}` : body
}
