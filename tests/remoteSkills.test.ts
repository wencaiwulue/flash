import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createServer, type Server } from 'http'
import { mkdtemp, readFile, rm, stat } from 'fs/promises'
import { join } from 'path'
import { strToU8, zipSync } from 'fflate'
import { getTurnZeroSkillDiscovery } from '../src/services/skillSearch/prefetch.ts'
import { loadRemoteSkill } from '../src/services/skillSearch/remoteSkillLoader.ts'
import { searchRemoteSkills } from '../src/services/skillSearch/remoteSearch.ts'
import {
  clearDiscoveredRemoteSkills,
  getDiscoveredRemoteSkill,
} from '../src/services/skillSearch/remoteSkillState.ts'
import type { ToolUseContext } from '../src/Tool.ts'
import { createUserMessage } from '../src/utils/messages.ts'

let server: Server
let baseUrl: string
let cacheDir: string
let version = '1.0.0'
let packageEntries: Record<string, Uint8Array> = {}
const originalUrl = process.env.CLAUDE_SKILL_REGISTRY_URL

beforeEach(async () => {
  version = '1.0.0'
  packageEntries = {
    'SKILL.md': strToU8('---\nname: demo\n---\nUse demo instructions'),
    'refs/info.txt': strToU8('reference'),
  }
  cacheDir = await mkdtemp(join('/tmp', 'claude-skill-cache-'))
  server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (url.pathname === '/api/v1/skills') {
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          code: 0,
          data: [
            {
              namespace: 'default',
              slug: 'demo',
              name: 'Demo Skill',
              description: 'Demonstrate remote skills',
              version,
              id: 'short-demo',
            },
          ],
        }),
      )
      return
    }
    if (url.pathname === '/api/v1/skills/default/demo/resolve') {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ code: 0, data: { version } }))
      return
    }
    if (
      url.pathname ===
        `/api/v1/skills/default/demo/versions/${version}/download` ||
      url.pathname === '/api/v1/skills/default/demo/download'
    ) {
      response.setHeader('content-type', 'application/zip')
      response.end(Buffer.from(zipSync(packageEntries)))
      return
    }
    response.statusCode = 404
    response.end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No test port')
  baseUrl = `http://127.0.0.1:${address.port}`
  process.env.CLAUDE_SKILL_REGISTRY_URL = baseUrl
})

afterEach(async () => {
  clearDiscoveredRemoteSkills()
  if (originalUrl === undefined) delete process.env.CLAUDE_SKILL_REGISTRY_URL
  else process.env.CLAUDE_SKILL_REGISTRY_URL = originalUrl
  await new Promise<void>(resolve => server.close(() => resolve()))
  await rm(cacheDir, { recursive: true, force: true })
})

function skillUrl(): string {
  return `${baseUrl}/api/v1/skills/default/demo`
}

describe('SkillHub discovery and loading', () => {
  test('searches, registers canonical skills, and surfaces them in prefetch', async () => {
    const matches = await searchRemoteSkills('demo')
    expect(matches[0]).toMatchObject({
      slug: 'default/demo',
      name: 'Demo Skill',
      shortId: 'short-demo',
    })
    expect(getDiscoveredRemoteSkill('default/demo')?.url).toBe(skillUrl())

    const context = {
      messages: [createUserMessage({ content: 'use demo' })],
      discoveredSkillNames: new Set<string>(),
    } as unknown as ToolUseContext
    const attachments = await getTurnZeroSkillDiscovery(
      'demo',
      context.messages,
      context,
      [],
    )
    expect(attachments).toHaveLength(1)
    expect(attachments[0]?.source).toBe('aki')
    expect(attachments[0]?.skills[0]).toMatchObject({
      name: '_canonical_default/demo',
      shortId: 'short-demo',
    })
  })

  test('downloads safely, caches by version, and invalidates on version change', async () => {
    const first = await loadRemoteSkill('default/demo', skillUrl(), { cacheDir })
    expect(first.cacheHit).toBe(false)
    expect(first.content).toContain('Use demo instructions')
    expect(first.fileCount).toBe(2)
    expect(first.totalBytes).toBeGreaterThan(0)
    expect((await stat(join(first.skillPath, 'refs/info.txt'))).isFile()).toBe(true)

    const second = await loadRemoteSkill('default/demo', skillUrl(), { cacheDir })
    expect(second.cacheHit).toBe(true)
    expect(second.content).toBe(first.content)

    version = '1.0.1'
    packageEntries['SKILL.md'] = strToU8('updated instructions')
    const updated = await loadRemoteSkill('default/demo', skillUrl(), { cacheDir })
    expect(updated.cacheHit).toBe(false)
    expect(updated.content).toBe('updated instructions')
  })

  test('rejects path traversal and symlink entries without writing outside cache', async () => {
    version = '2.0.0'
    packageEntries = { '../escape.txt': strToU8('bad'), 'SKILL.md': strToU8('bad') }
    await expect(
      loadRemoteSkill('default/demo', skillUrl(), { cacheDir }),
    ).rejects.toThrow('Unsafe path')
    await expect(readFile(join(cacheDir, '../escape.txt'), 'utf8')).rejects.toThrow()
  })

  test('rejects symlink entries', async () => {
    version = '3.0.0'
    const bytes = zipSync({ 'SKILL.md': strToU8('bad') })
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    for (let offset = 0; offset + 46 <= bytes.length; offset++) {
      if (view.getUint32(offset, true) !== 0x02014b50) continue
      view.setUint32(offset + 38, 0o120777 << 16, true)
    }
    packageEntries = {}
    server.removeAllListeners('request')
    server.on('request', (request, response) => {
      if (request.url?.includes('/resolve')) {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ code: 0, data: { version } }))
        return
      }
      response.setHeader('content-type', 'application/zip')
      response.end(Buffer.from(bytes))
    })
    await expect(
      loadRemoteSkill('default/demo', skillUrl(), { cacheDir }),
    ).rejects.toThrow('symlink')
  })
})
