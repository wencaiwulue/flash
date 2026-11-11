import { buildCommitDocuments } from './document-commits.ts'

const documents = await buildCommitDocuments()
const errors: string[] = []
for (const [path, expected] of documents) {
  const file = Bun.file(path)
  if (!(await file.exists())) {
    errors.push(`missing: ${path}`)
    continue
  }
  const actual = await file.text()
  if (actual !== expected) errors.push(`outdated: ${path}`)
}
if (errors.length > 0) {
  console.error(errors.join('\n'))
  throw new Error(`Commit documentation is incomplete (${errors.length} issue(s)). Run bun scripts/document-commits.ts and commit the result.`)
}
console.log(`All ${documents.size - 2} commit documents and indexes are present and current.`)
