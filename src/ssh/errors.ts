export type SSHErrorCode =
  | 'SSH_INVALID_ARGUMENT'
  | 'SSH_UNSUPPORTED_TARGET'
  | 'SSH_HEADLESS_UNSUPPORTED'
  | 'SSH_AUTH_FAILED'
  | 'SSH_HOST_KEY_FAILED'
  | 'SSH_PROBE_FAILED'
  | 'SSH_FORWARD_FAILED'
  | 'SSH_CONNECTION_LOST'
  | 'SSH_ARTIFACT_MISSING'
  | 'SSH_ARTIFACT_MISMATCH'
  | 'SSH_DEPLOY_FAILED'
  | 'AUTH_PROXY_FAILED'
  | 'AUTH_PROXY_PROTOCOL_ERROR'
  | 'SSH_INIT_TIMEOUT'
  | 'SSH_RECONNECT_EXHAUSTED'
  | 'SSH_DELIVERY_UNKNOWN'
  | 'CONTROL_ID_CONFLICT'

export class SSHSessionError extends Error {
  readonly code: SSHErrorCode

  constructor(code: SSHErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'SSHSessionError'
    this.code = code
  }
}

export function asSSHError(
  code: SSHErrorCode,
  message: string,
  cause: unknown,
): SSHSessionError {
  if (cause instanceof SSHSessionError) return cause
  return new SSHSessionError(code, message, { cause })
}
