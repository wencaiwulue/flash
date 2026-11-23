import { describe, expect, it } from 'bun:test'
import { canonicalizeModelForMatch } from '../src/utils/model/model.ts'

// Upstream 2.1.311 Pre/PostModelSwitch matcher: canonical to_model, [1m]
// stripped, alias/date/provider normalized (D3463-3467). Values below reflect
// the current default models (opus->claude-opus-4-6, sonnet->claude-sonnet-4-6).
describe('canonicalizeModelForMatch', () => {
  it('normalizes aliases to canonical ids', () => {
    expect(canonicalizeModelForMatch('opus')).toBe('claude-opus-4-6')
    expect(canonicalizeModelForMatch('sonnet')).toBe('claude-sonnet-4-6')
  })

  it('keeps already-canonical ids unchanged', () => {
    expect(canonicalizeModelForMatch('claude-opus-4-6')).toBe('claude-opus-4-6')
  })

  it('strips the date suffix', () => {
    expect(canonicalizeModelForMatch('claude-opus-4-6-20251001')).toBe(
      'claude-opus-4-6',
    )
  })

  it('strips the [1m] suffix', () => {
    expect(canonicalizeModelForMatch('claude-opus-4-6[1m]')).toBe(
      'claude-opus-4-6',
    )
    expect(canonicalizeModelForMatch('opus[1m]')).toBe('claude-opus-4-6')
  })

  it('normalizes provider-prefixed (3P) ids', () => {
    expect(
      canonicalizeModelForMatch('us.anthropic.claude-3-5-haiku-20241022-v1:0'),
    ).toBe('claude-3-5-haiku')
    expect(canonicalizeModelForMatch('claude-3-5-haiku-20241022')).toBe(
      'claude-3-5-haiku',
    )
  })

  it('canonicalizes each segment of a pipe-separated list', () => {
    expect(canonicalizeModelForMatch('opus|sonnet')).toBe(
      'claude-opus-4-6|claude-sonnet-4-6',
    )
  })

  it('passes regex matchers through unchanged', () => {
    expect(canonicalizeModelForMatch('claude-.*')).toBe('claude-.*')
    expect(canonicalizeModelForMatch('opus|claude-.*')).toBe(
      'claude-opus-4-6|claude-.*',
    )
  })

  it('treats * as match-all (passthrough)', () => {
    expect(canonicalizeModelForMatch('*')).toBe('*')
  })
})
