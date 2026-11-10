import { isKairosRuntimeEnabled } from './index.js'

/** Open runtime gate; trust and OAuth checks remain at their existing call sites. */
export async function isKairosEnabled(): Promise<boolean> {
  return isKairosRuntimeEnabled()
}
