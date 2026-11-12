import { describe, expect, test } from 'bun:test'
import { EXTERNAL_FEATURES } from '../scripts/externalFeatureProfile.ts'

describe('external feature profile', () => {
  test('does not contain duplicate feature flags', () => {
    expect(new Set(EXTERNAL_FEATURES).size).toBe(EXTERNAL_FEATURES.length)
  })
})
