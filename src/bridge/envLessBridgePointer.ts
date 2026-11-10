import { mkdir, readFile, stat, unlink, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { z } from 'zod/v4'
import { logForDebugging } from '../utils/debug.js'
import {
  getProjectsDir,
  sanitizePath,
} from '../utils/sessionStoragePortable.js'
import { lazySchema } from '../utils/lazySchema.js'
import { jsonStringify } from '../utils/slowOperations.js'

export const ENV_LESS_POINTER_TTL_MS = 4 * 60 * 60 * 1000

const PointerSchema = lazySchema(() =>
  z.object({
    sessionId: z.string().min(1),
    lastSequenceNum: z.number().int().nonnegative(),
    updatedAt: z.number(),
  }),
)

export type EnvLessBridgePointer = z.infer<ReturnType<typeof PointerSchema>>

function pathFor(dir: string): string {
  return join(getProjectsDir(), sanitizePath(dir), 'env-less-bridge-pointer.json')
}

export async function writeEnvLessBridgePointer(
  dir: string,
  pointer: EnvLessBridgePointer,
): Promise<void> {
  const path = pathFor(dir)
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, jsonStringify(pointer), { mode: 0o600 })
  } catch (error) {
    logForDebugging(`[env-less:pointer] write failed: ${error}`)
  }
}

export async function readEnvLessBridgePointer(
  dir: string,
): Promise<EnvLessBridgePointer | null> {
  const path = pathFor(dir)
  try {
    const [metadata, raw] = await Promise.all([stat(path), readFile(path, 'utf8')])
    if (Date.now() - metadata.mtimeMs > ENV_LESS_POINTER_TTL_MS) {
      await unlink(path).catch(() => {})
      return null
    }
    const pointer = PointerSchema().parse(JSON.parse(raw))
    return pointer
  } catch {
    return null
  }
}

export async function clearEnvLessBridgePointer(dir: string): Promise<void> {
  await unlink(pathFor(dir)).catch(() => {})
}
