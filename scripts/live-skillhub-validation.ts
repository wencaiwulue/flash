import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { SkillHubClient } from '../src/services/skillSearch/skillhubClient.js'
import { loadRemoteSkill } from '../src/services/skillSearch/remoteSkillLoader.js'

const baseUrl = process.env.CLAUDE_SKILL_REGISTRY_URL || 'https://skill.xfyun.cn'
const cacheDir = await mkdtemp(join('/tmp', 'flash-skillhub-live-'))
const client = new SkillHubClient({
  baseUrl,
  token: process.env.CLAUDE_SKILL_REGISTRY_TOKEN,
})

try {
  const matches = await client.search('code', { limit: 1 })
  const match = matches[0]
  if (!match) throw new Error('SkillHub returned no skills for the live query')
  const slug = `${match.namespace}/${match.slug}`
  const url = `${baseUrl}/api/v1/skills/${encodeURIComponent(match.namespace)}/${encodeURIComponent(match.slug)}`
  const loaded = await loadRemoteSkill(slug, url, { cacheDir })
  if (!loaded.content.includes('name') && !loaded.content.includes('#')) {
    throw new Error('Downloaded SKILL.md is empty or malformed')
  }
  const cached = await loadRemoteSkill(slug, url, { cacheDir })
  if (!cached.cacheHit) throw new Error('Versioned SkillHub cache did not hit')
  console.log('SKILLHUB_LIVE_OK')
} finally {
  await rm(cacheDir, { recursive: true, force: true })
}
