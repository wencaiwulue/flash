export type DiscoveredRemoteSkill = {
  slug: string
  name: string
  description: string
  url: string
  shortId?: string
}

const CANONICAL_PREFIX = '_canonical_'

export function stripCanonicalPrefix(commandName: string): string | null {
  if (!commandName.startsWith(CANONICAL_PREFIX)) return null
  const slug = commandName.slice(CANONICAL_PREFIX.length)
  return slug.length > 0 ? slug : null
}

export function getDiscoveredRemoteSkill(
  _slug: string,
): DiscoveredRemoteSkill | undefined {
  return undefined
}
