import { createHash, randomUUID } from 'crypto'
import { mkdir, readFile, rename, rm, writeFile, readdir, stat } from 'fs/promises'
import { dirname, join } from 'path'
import { unzipSync } from 'fflate'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { logForDebugging } from '../../utils/debug.js'
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
const CACHE_MAX_ENTRIES = 50 // Max cached skills
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
const inFlight = new Map<string, Promise<RemoteSkillLoadResult>>()
const cachedActivePaths = new Set<string>() // Track currently used cache paths

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
    return { baseUrl, namespace: parts[0], slug: parts.slice(1).join('/') }
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

/**
 * Cache cleanup - removes expired and excess cache entries
 * Always keeps currently active (in use) paths
 */
export async function pruneCache(cacheRoot: string): Promise<void> {
  try {
    const entries = await readdir(cacheRoot, { withFileTypes: true })
    const now = Date.now()
    const cacheEntries: { path: string; mtimeMs: number; size: number }[] = []

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const cachePath = join(cacheRoot, entry.name)
      // Skip any paths that are currently active
      if (cachedActivePaths.has(cachePath)) continue
      try {
        const stats = await stat(cachePath)
        cacheEntries.push({
          path: cachePath,
          mtimeMs: stats.mtimeMs,
          size: stats.size,
        })
      } catch {
        // Skip if we can't stat
      }
    }

    // First, remove expired entries
    const remaining: typeof cacheEntries = []
    let removed = 0
    let freedBytes = 0
    for (const entry of cacheEntries) {
      if (now - entry.mtimeMs > CACHE_TTL_MS) {
        try {
          await rm(entry.path, { recursive: true, force: true })
          removed++
          freedBytes += entry.size
        } catch {
          // Ignore removal errors
        }
      } else {
        remaining.push(entry)
      }
    }

    // Then, remove oldest entries if we still have too many
    if (remaining.length > CACHE_MAX_ENTRIES) {
      // Sort by mtime, oldest first
      remaining.sort((a, b) => a.mtimeMs - b.mtimeMs)
      const toRemove = remaining.slice(0, remaining.length - CACHE_MAX_ENTRIES)
      for (const entry of toRemove) {
        if (cachedActivePaths.has(entry.path)) continue // Double-check
        try {
          await rm(entry.path, { recursive: true, force: true })
          removed++
          freedBytes += entry.size
        } catch {
          // Ignore removal errors
        }
      }
    }

    if (removed > 0) {
      logForDebugging(`[skills] Pruned cache: removed ${removed} entries, freed ${freedBytes} bytes`)
    }
  } catch {
    // Cache dir might not exist yet
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

  // Try cache first
  try {
    const [content, metadata] = await Promise.all([
      readFile(manifestPath, 'utf8'),
      readFile(metadataPath, 'utf8').then(JSON.parse),
    ])
    // Mark this path as active while in use
    cachedActivePaths.add(destination)
    // Touch the cache entry to update mtime
    try {
      await mkdir(cacheRoot, { recursive: true, mode: 0o700 })
      await writeFile(metadataPath, JSON.stringify(metadata), { mode: 0o600 })
    } catch {
      // Ignore touch error
    }
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

  // Prune cache before adding new entry
  await pruneCache(cacheRoot)

  const bytes = await client.download(
    location.namespace,
    location.slug, version,
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

  // Mark this path as active
  cachedActivePaths.add(destination)

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

/**
 * Release a cached skill path (mark as no longer active)
 */
export function releaseCachedSkill(skillPath: string): void {
  cachedActivePaths.delete(skillPath)
}

/**
 * Clear all active paths (for testing/reset)
 */
export function clearActivePathsForTesting(): void {
  cachedActivePaths.clear()
}

/**
 * Get current active paths count (for monitoring/testing)
 */
export function getActivePathsCount(): number {
  return cachedActivePaths.size
}

/**
 * Check if a path is currently active
 */
export function isPathActive(skillPath: string): boolean {
  return cachedActivePaths.has(skillPath)
}
