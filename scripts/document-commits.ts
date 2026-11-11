import { mkdir, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { REPOSITORY_ROOT } from './commit-docs/git.ts'
import { buildManualIndexes, type DocumentationMode } from './commit-docs/manual.ts'

export function documentationMode(args = Bun.argv.slice(2)): DocumentationMode {
  if (args.length === 0) return 'head'
  if (args.length === 1 && args[0] === '--next') return 'next'
  throw new Error('usage: bun scripts/document-commits.ts [--next]')
}

export async function prepareCommitDocuments(mode: DocumentationMode) {
  return buildManualIndexes(mode)
}

async function writeCommitDocuments(): Promise<void> {
  const mode = documentationMode()
  const documents = await prepareCommitDocuments(mode)
  for (const [path, content] of documents) {
    const absolute = join(REPOSITORY_ROOT, path)
    await mkdir(dirname(absolute), { recursive: true })
    await writeFile(absolute, content)
  }
  const count = JSON.parse(documents.get('docs/status/index.json')!).commits.length
  console.log(`Validated ${count * 2} commit design/implementation documents and wrote indexes (${mode} mode).`)
}

if (import.meta.main) await writeCommitDocuments()
