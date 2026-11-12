/**
 * Parses a GitHub or GitHub Enterprise pull-request reference.
 * Accepts a full pull-request URL or #N and returns its positive numeric id.
 */
export function parsePRReference(input: string): number | null {
  const urlMatch = input.match(
    /^https?:\/\/[^/]+\/[^/]+\/[^/]+\/pull\/(\d+)\/?(?:[?#].*)?$/i,
  )
  if (urlMatch?.[1]) {
    return parseInt(urlMatch[1], 10)
  }

  const hashMatch = input.match(/^#(\d+)$/)
  if (hashMatch?.[1]) {
    return parseInt(hashMatch[1], 10)
  }

  return null
}
