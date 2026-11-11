import { readdir } from 'fs/promises'
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
  const actual = await file.text()
  if (actual !== expected) errors.push(`outdated: ${path}`)
}

for (const [directory, suffix] of [
  ['docs/specs', '-SPEC.md'],
  ['docs/plans', '-PLAN.md'],
] as const) {
  const files = await readdir(join(REPOSITORY_ROOT, directory))
  for (const file of files) {
    if (!file.endsWith(suffix)) continue
    const path = `${directory}/${file}`
    if (!documents.has(path)) errors.push(`orphaned generated document: ${path}`)
  }
}

if (errors.length > 0) {
  console.error(errors.join('\n'))
  throw new Error(`Commit documentation is incomplete or outdated (${errors.length} issue(s)). Generate and review the records before committing.`)
}
console.log(`All ${documents.size - 2} substantive commit documents and indexes pass structural, reference, naming, and duplication checks (${mode} mode). Semantic review is a separate requirement.`)
