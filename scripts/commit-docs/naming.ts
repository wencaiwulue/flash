import type { Commit } from './schema.ts'

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export type DocumentPaths = {
  spec: string
  plan: string
  slug: string
}

export const SELF_DOCUMENT_PATHS = {
  spec: 'docs/specs/self-SPEC.md',
  plan: 'docs/plans/self-PLAN.md',
} as const

export function historicalDocumentPaths(
  commits: Commit[],
  getRecord: (fullSha: string) => { slug: string } | undefined,
): Map<string, DocumentPaths> {
  const occurrences = new Map<string, number>()
  const usedBasenames = new Map<string, string>()
  const result = new Map<string, DocumentPaths>()

  for (const commit of commits) {
    const record = getRecord(commit.full)
    if (!record) throw new Error(`${commit.short}: missing record for document naming`)
    if (typeof record.slug !== 'string' || !SLUG_PATTERN.test(record.slug)) {
      throw new Error(`${commit.short}: invalid slug: ${record.slug}`)
    }
    const date = commit.date.slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error(`${commit.short}: invalid commit date: ${commit.date}`)
    }

    const key = `${date}/${record.slug}`
    const occurrence = (occurrences.get(key) ?? 0) + 1
    occurrences.set(key, occurrence)
    const suffix = occurrence === 1 ? '' : `-${String(occurrence).padStart(2, '0')}`
    const basename = `${date}-${record.slug}${suffix}`
    const previous = usedBasenames.get(basename)
    if (previous) {
      throw new Error(`${commit.short}: document path collision with ${previous}: ${basename}`)
    }
    usedBasenames.set(basename, commit.short)
    result.set(commit.full, {
      spec: `docs/specs/${basename}-SPEC.md`,
      plan: `docs/plans/${basename}-PLAN.md`,
      slug: record.slug,
    })
  }
  return result
}
