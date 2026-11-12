import {
  ProcessBackend,
  type ProcessBackendOptions,
} from './processBackend.js'

export type DangerousBackendOptions = ProcessBackendOptions & {
  /** Server-side opt-in. Client requests are separately checked by SessionManager. */
  allowDangerousSkipPermissions?: boolean
}

/**
 * Internal compatibility name for the permission-bypassing backend.
 * Constructing this class alone is not enough to enable bypass mode.
 */
export class DangerousBackend extends ProcessBackend {
  private readonly dangerousEnabled: boolean

  constructor(options: DangerousBackendOptions = {}) {
    super(options)
    this.dangerousEnabled = options.allowDangerousSkipPermissions === true
  }

  protected override allowsDangerousMode(): boolean {
    return this.dangerousEnabled
  }
}
