import { open } from 'fs/promises'

/** Write a new local diagnostic file without following an overwrite path. */
export async function writeNewDiagnosticJson(
  path: string,
  value: unknown,
): Promise<void> {
  if (!path.trim()) throw new Error('An output path is required')
  const handle = await open(path, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}
