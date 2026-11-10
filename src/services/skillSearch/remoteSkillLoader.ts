import { createHash, randomUUID } from 'crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { unzipSync } from 'fflate'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { SkillHubClient } from './skillhubClient.js'

export type RemoteSkillLoadResult = {
  cacheHit: boolean
  latencyMs: number
  skillPath: string
  content: string
  fileCount: number
  totalBytes: number
  fetchMethod: string
}

type LoaderOptions = {
  cacheDir?: string
  client?: SkillHubClient
  signal?: AbortSignal
}

const MAX_FILES = 100
const MAX_TOTAL_BYTES = 5 * 1024 * 1024
const inFlight = new Map<string, Promise<RemoteSkillLoadResult>>()

function parseSkillLocation(slug: string, url: string): {
  baseUrl: string
  namespace: string
  slug: string
} {
  const parsed = new URL(url)
  const marker = '/api/v1/skills/'
  const index = parsed.pathname.indexOf(marker)
  if (index < 0) throw new Error('Unsupported SkillHub skill URL')
  const baseUrl = `${parsed.origin}${parsed.pathname.slice(0, index)}`.replace(/\/$/, '')
  const parts = slug.split('/')
  if (parts.length >= 2 && parts[0] && parts[1]) {
    return { baseUrl, namespace: parts[0]!, slug: parts.slice(1).join('/') }
  }
  const pathSlug = parsed.pathname.slice(index + marker.length)
  const [namespace, name] = pathSlug.split('/')
  if (!namespace || !name) throw new Error('Invalid canonical skill slug')
  return { baseUrl, namespace, slug: name }
}

function assertNoZipSymlinks(bytes: Uint8Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let offset = 0; offset + 46 <= bytes.length; offset++) {
    if (view.getUint32(offset, true) !== 0x02014b50) continue
    const externalAttributes = view.getUint32(offset + 38, true)
    if (((externalAttributes >>> 16) & 0o170000) === 0o120000) {
      throw new Error('SkillHub package contains a symlink')
    }
  }
}

function assertSafePath(path: string): void {
  const parts = path.split('/')
  if (
    !path ||
    path.startsWith('/') ||
    path.includes('\\') ||
    parts.some(part => part === '..' || part === '.')
  ) {
    throw new Error(`Unsafe path in skill package: ${path}`)
  }
}

async function load(
  slug: string,
  url: string,
  options: LoaderOptions,
): Promise<RemoteSkillLoadResult> {
  const started = Date.now()
  const location = parseSkillLocation(slug, url)
  const client =
    options.client ??
    new SkillHubClient({
      baseUrl: location.baseUrl,
      token: process.env.CLAUDE_SKILL_REGISTRY_TOKEN,
    })
  const resolved = await client.resolve(location.namespace, location.slug, {
    signal: options.signal,
  })
  const version =
    typeof resolved.version === 'string'
      ? resolved.version
      : typeof resolved.latestVersion === 'string'
        ? resolved.latestVersion
        : undefined
  const key = createHash('sha256')
    .update(`${location.baseUrl}/${location.namespace}/${location.slug}@${version ?? 'latest'}`)
    .digest('hex')
  const cacheRoot = options.cacheDir ?? join(getClaudeConfigHomeDir(), 'skill-cache')
  const destination = join(cacheRoot, key)
  const manifestPath = join(destination, 'SKILL.md')
  const metadataPath = join(destination, '.skillhub.json')

  try {
    const [content, metadata] = await Promise.all([
      readFile(manifestPath, 'utf8'),
      readFile(metadataPath, 'utf8').then(JSON.parse),
    ])
    return {
      cacheHit: true,
      latencyMs: Date.now() - started,
      skillPath: destination,
      content,
      fileCount: metadata.fileCount,
      totalBytes: metadata.totalBytes,
      fetchMethod: 'skillhub-cache',
    }
  } catch {
    // Cache miss or incomplete extraction.
  }

  const bytes = await client.download(
    location.namespace,
    location.slug,
    version,
    options.signal,
  )
  assertNoZipSymlinks(bytes)
  const files = Object.entries(unzipSync(bytes)).filter(
    ([path]) => !path.endsWith('/'),
  )
  if (files.length === 0 || files.length > MAX_FILES) {
    throw new Error(`Skill package has an invalid file count: ${files.length}`)
  }
  if (!files.some(([path]) => path === 'SKILL.md')) {
    throw new Error('Skill package is missing SKILL.md')
  }
  let totalBytes = 0
  for (const [path, data] of files) {
    assertSafePath(path)
    totalBytes += data.byteLength
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new Error('Skill package exceeds the 5 MB unpacked limit')
    }
  }

  const staging = join(cacheRoot, `${key}.${process.pid}.${randomUUID()}.tmp`)
  await mkdir(staging, { recursive: true, mode: 0o700 })
  try {
    for (const [path, data] of files) {
      const output = join(staging, path)
      await mkdir(dirname(output), { recursive: true, mode: 0o700 })
      await writeFile(output, data, { mode: 0o600 })
    }
    await writeFile(
      metadataPath.replace(destination, staging),
      JSON.stringify({ fileCount: files.length, totalBytes }),
      { mode: 0o600 },
    )
    await rm(destination, { recursive: true, force: true })
    await mkdir(cacheRoot, { recursive: true, mode: 0o700 })
    await rename(staging, destination)
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }

  return {
    cacheHit: false,
    latencyMs: Date.now() - started,
    skillPath: destination,
    content: await readFile(manifestPath, 'utf8'),
    fileCount: files.length,
    totalBytes,
    fetchMethod: 'skillhub',
  }
}

export async function loadRemoteSkill(
  slug: string,
  url: string,
  options: LoaderOptions = {},
): Promise<RemoteSkillLoadResult> {
  const key = `${slug}@${url}`
  let pending = inFlight.get(key)
  if (!pending) {
    pending = load(slug, url, options).finally(() => {
      inFlight.delete(key)
    })
    inFlight.set(key, pending)
  }
  return pending
}
