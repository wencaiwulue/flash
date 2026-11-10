export type DiscoveredRemoteSkill = {
  slug: string
  name: string
  description: string
  url: string
  shortId?: string
}

const CANONICAL_PREFIX = '_canonical_'
const discovered = new Map<string, DiscoveredRemoteSkill>()

export function stripCanonicalPrefix(commandName: string): string | null {
  if (!commandName.startsWith(CANONICAL_PREFIX)) return null
  const slug = commandName.slice(CANONICAL_PREFIX.length)
  return slug.length > 0 ? slug : null
}

export function registerDiscoveredRemoteSkill(
  skill: DiscoveredRemoteSkill,
): void {
  discovered.set(skill.slug, skill)
}

export function getDiscoveredRemoteSkill(
  slug: string,
): DiscoveredRemoteSkill | undefined {
  return discovered.get(slug)
}

export function listDiscoveredRemoteSkills(): DiscoveredRemoteSkill[] {
  return [...discovered.values()]
}

export function clearDiscoveredRemoteSkills(): void {
  discovered.clear()
}
