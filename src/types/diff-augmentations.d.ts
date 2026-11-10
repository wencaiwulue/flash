import 'diff'

declare module 'diff' {
  interface PatchOptions {
    /** Maximum time in milliseconds spent diffing before giving up. */
    timeout?: number
  }
}
