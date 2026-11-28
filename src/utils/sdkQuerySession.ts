import { randomUUID } from 'crypto'
import { dirname } from 'path'
import type { InternalOptions } from '../entrypoints/sdk/runtimeTypes.js'
import type { Message } from '../types/message.js'
import {
  forkSdkSession,
  listSdkSessions,
  loadSdkSessionTranscript,
} from './sdkSessions.js'
import {
  resolveSessionFilePath,
  validateUuid,
} from './sessionStoragePortable.js'

type ClassicSessionOptions = Pick<
  InternalOptions,
  'continue' | 'resume' | 'forkSession' | 'resumeSessionAt'
>

export type SdkQuerySessionResolution = {
  session: { id: string; projectDir?: string }
  initialMessages?: Message[]
}

export function validateSdkQuerySessionOptions(
  options: ClassicSessionOptions,
): void {
  if (options.continue && options.resume !== undefined) {
    throw new Error('The continue and resume options are mutually exclusive')
  }
  if (options.resumeSessionAt !== undefined) {
    throw new Error(
      'resumeSessionAt is not supported by the in-process SDK query implementation',
    )
  }
  if (options.resume !== undefined && !validateUuid(options.resume)) {
    throw new Error(`Invalid session ID: ${options.resume}`)
  }
}

async function loadSession(
  sourceId: string,
  cwd: string,
  fork: boolean,
): Promise<SdkQuerySessionResolution> {
  const source = await resolveSessionFilePath(sourceId, cwd)
  if (!source) throw new Error(`Session not found: ${sourceId}`)

  const sourceDir = source.projectPath ?? cwd
  const sessionId = fork
    ? (await forkSdkSession(sourceId, { dir: sourceDir })).sessionId
    : sourceId
  const resolved = fork
    ? await resolveSessionFilePath(sessionId, sourceDir)
    : source
  if (!resolved) throw new Error(`Session not found: ${sessionId}`)

  const projectDir = resolved.projectPath ?? sourceDir
  return {
    session: { id: sessionId, projectDir: dirname(resolved.filePath) },
    initialMessages: await loadSdkSessionTranscript(sessionId, {
      dir: projectDir,
    }),
  }
}

export async function resolveSdkQuerySession(
  options: ClassicSessionOptions,
  cwd: string,
): Promise<SdkQuerySessionResolution> {
  validateSdkQuerySessionOptions(options)

  if (options.resume !== undefined) {
    return loadSession(options.resume, cwd, options.forkSession === true)
  }
  if (options.continue) {
    const [latest] = await listSdkSessions({ dir: cwd, limit: 1 })
    if (!latest) throw new Error('No conversation found to continue')
    return loadSession(latest.sessionId, cwd, options.forkSession === true)
  }
  return { session: { id: randomUUID() } }
}
