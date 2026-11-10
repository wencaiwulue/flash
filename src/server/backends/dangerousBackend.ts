/** The permission-bypassing subprocess backend is internal-only. */
export class DangerousBackend {
  constructor() {
    throw new Error('The dangerous server backend is unavailable in this build')
  }
}
