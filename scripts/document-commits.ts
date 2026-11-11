import { mkdir, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { commits, REPOSITORY_ROOT } from './commit-docs/git.ts'
import { loadRecords } from './commit-docs/load.ts'
import { buildDocuments } from './commit-docs/render.ts'
import { validateRecords } from './commit-docs/validate.ts'
import type { DocumentationMode } from './commit-docs/schema.ts'

export function documentationMode(args = Bun.argv.slice(2)): DocumentationMode {
  if (args.length === 0) return 'head'
  if (args.length === 1 && args[0] === '--next') return 'next'
  throw new Error('usage: bun scripts/document-commits.ts [--next]')
}

export async function prepareCommitDocuments(mode: DocumentationMode) {
  const history = commits()
  const loaded = await loadRecords()
  const errors = validateRecords(loaded, history, mode)
  if (errors.length > 0) {
    throw new Error(`Commit design records are invalid:\n${errors.join('\n')}`)
  }
  return buildDocuments(loaded, history, mode)
}

async function writeCommitDocuments(): Promise<void> {
  const mode = documentationMode()
  const documents = await prepareCommitDocuments(mode)
  for (const [path, content] of documents) {
    const absolute = join(REPOSITORY_ROOT, path)
    await mkdir(dirname(absolute), { recursive: true })
    await writeFile(absolute, content)
  }
  console.log(`Generated ${documents.size - 2} commit design/implementation documents and indexes (${mode} mode).`)
}

if (import.meta.main) await writeCommitDocuments()
