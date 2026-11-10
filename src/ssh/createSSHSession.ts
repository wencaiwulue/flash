import type { ChildProcess } from 'child_process'
import {
  SSHSessionManager,
  type SSHSessionCallbacks,
} from './SSHSessionManager.js'

export type SSHSession = {
  remoteCwd: string
  proc: ChildProcess
  proxy: { stop: () => void }
  getStderrTail: () => string
  createManager: (callbacks: SSHSessionCallbacks) => SSHSessionManager
}

export type CreateSSHSessionOptions = {
  host: string
  cwd?: string
  localVersion: string
  permissionMode?: string
  dangerouslySkipPermissions: boolean
  extraCliArgs: string[]
}

export type CreateLocalSSHSessionOptions = {
  cwd?: string
  permissionMode?: string
  dangerouslySkipPermissions: boolean
}

export class SSHSessionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SSHSessionError'
  }
}

export async function createSSHSession(
  _options: CreateSSHSessionOptions,
  _callbacks: { onProgress?: (message: string) => void },
): Promise<SSHSession> {
  throw new SSHSessionError('SSH sessions are unavailable in this build')
}

export function createLocalSSHSession(
  _options: CreateLocalSSHSessionOptions,
): SSHSession {
  throw new SSHSessionError('Local SSH proxy sessions are unavailable in this build')
}
