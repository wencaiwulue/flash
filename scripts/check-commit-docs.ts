import { join } from 'path'
import { documentationMode, prepareCommitDocuments } from './document-commits.ts'
import { REPOSITORY_ROOT } from './commit-docs/git.ts'

const mode = documentationMode()
const documents = await prepareCommitDocuments(mode)
const errors: string[] = []
for (const [path, expected] of documents) {
  const file = Bun.file(join(REPOSITORY_ROOT, path))
  if (!(await file.exists())) {
    errors.push(`missing: ${path}`)
    continue
  }
  if ((await file.text()) !== expected) errors.push(`outdated: ${path}`)
}
if (errors.length > 0) {
  console.error(errors.join('\n'))
  throw new Error(`Commit documentation indexes are outdated (${errors.length} issue(s)).`)
}
const count = JSON.parse(documents.get('docs/status/index.json')!).commits.length
console.log(`All ${count * 2} independently authored commit documents and indexes pass (${mode} mode). Semantic review is separate.`)
