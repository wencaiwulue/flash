import { describe, expect, test } from 'bun:test'
import { chromeWiringBundledAction } from '../src/utils/claudeInChrome/setup.js'

describe('chromeWiringBundledAction', () => {
  test('non-bundled always wires (none)', () => {
    expect(chromeWiringBundledAction(true, false, true)).toBe('none')
    expect(chromeWiringBundledAction(true, false, false)).toBe('none')
    expect(chromeWiringBundledAction(false, false, true)).toBe('none')
    expect(chromeWiringBundledAction(false, false, false)).toBe('none')
  })

  test('bundled + not enabled = none', () => {
    expect(chromeWiringBundledAction(false, true, true)).toBe('none')
    expect(chromeWiringBundledAction(false, true, false)).toBe('none')
  })

  test('bundled + enabled + explicit = warn', () => {
    expect(chromeWiringBundledAction(true, true, true)).toBe('warn')
  })

  test('bundled + enabled + default-config = skip', () => {
    expect(chromeWiringBundledAction(true, true, false)).toBe('skip')
  })
})
