import { registerDiscoveredRemoteSkill } from './remoteSkillState.js'
import { getSkillHubRegistryUrl, SkillHubClient } from './skillhubClient.js'

export type RemoteSkillMatch = {
  slug: string
  name: string
  description: string
  shortId?: string
}

export async function searchRemoteSkills(
  query: string,
  options: { limit?: number; signal?: AbortSignal } = {},
): Promise<RemoteSkillMatch[]> {
  const baseUrl = getSkillHubRegistryUrl()
  if (!baseUrl || !query.trim()) return []
  const client = new SkillHubClient({
    baseUrl,
    token: process.env.CLAUDE_SKILL_REGISTRY_TOKEN,
  })
  const results = await client.search(query, options)
  return results.map(result => {
    const slug = `${result.namespace}/${result.slug}`
    const shortId = result.shortId
    registerDiscoveredRemoteSkill({
      slug,
      name: result.name,
      description: result.description,
      url: `${baseUrl}/api/v1/skills/${encodeURIComponent(result.namespace)}/${encodeURIComponent(result.slug)}`,
      ...(shortId ? { shortId } : {}),
    })
    return {
      slug,
      name: result.name,
      description: result.description,
      ...(shortId ? { shortId } : {}),
    }
  })
}
