import { readdir } from 'fs/promises'
import { join } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import type { CommitRecord } from './schema.ts'

const RECORDS_DIRECTORY = fileURLToPath(new URL('./records/', import.meta.url))

export type LoadedRecords = {
  historical: Map<string, CommitRecord>
  self: CommitRecord
}

export async function loadRecords(): Promise<LoadedRecords> {
  const files = (await readdir(RECORDS_DIRECTORY))
    .filter(file => file.endsWith('.ts'))
    .sort()
  const historical = new Map<string, CommitRecord>()
  let self: CommitRecord | undefined

  for (const file of files) {
    const module = await import(pathToFileURL(join(RECORDS_DIRECTORY, file)).href)
    const record = module.record as CommitRecord | undefined
    if (!record || typeof record.commit !== 'string') {
      throw new Error(`${file}: must export a commit record`)
    }
    const expectedName = record.commit === 'self'
      ? 'self.ts'
      : `${record.commit.slice(0, 7)}.ts`
    if (file !== expectedName) {
      throw new Error(`${file}: record SHA does not match its filename`)
    }
    if (record.commit === 'self') {
      if (self) throw new Error('multiple self records')
      self = record
      continue
    }
    if (!/^[0-9a-f]{40}$/.test(record.commit)) {
      throw new Error(`${file}: historical record must contain a full SHA`)
    }
    if (historical.has(record.commit)) {
      throw new Error(`${file}: duplicate record for ${record.commit}`)
    }
    historical.set(record.commit, record)
  }

  if (!self) throw new Error('missing records/self.ts')
  if (!self.changeId || !self.title) {
    throw new Error('self record requires changeId and title')
  }
  return { historical, self }
}
