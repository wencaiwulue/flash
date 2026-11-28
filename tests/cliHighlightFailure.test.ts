import { expect, mock, test } from 'bun:test'

mock.module('cli-highlight', () => {
  throw new Error('intentional offline cli-highlight load failure')
})

const { getCliHighlightPromise, getLanguageName } = await import(
  '../src/utils/cliHighlight.ts'
)

test('returns null and unknown after a deterministic loader failure while caching the attempt', async () => {
  try {
    const first = getCliHighlightPromise()
    const second = getCliHighlightPromise()
    expect(first).toBe(second)
    expect(await first).toBeNull()
    expect(await getLanguageName('test.ts')).toBe('unknown')
  } finally {
    mock.restore()
  }
})
