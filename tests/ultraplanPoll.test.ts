import { describe, expect, test } from 'bun:test'
import { pollForApprovedExitPlanMode } from '../src/utils/ultraplan/ccrSession.ts'

describe('ultraplan polling', () => {
  test('refreshes OAuth before every remote poll', async () => {
    let polls = 0
    let refreshes = 0

    const promise = pollForApprovedExitPlanMode(
      'session-id',
      10_000,
      undefined,
      () => polls >= 2,
      {
        pollEvents: async () => {
          polls++
          return {
            newEvents: [],
            lastEventId: null,
            sessionStatus: 'running',
          }
        },
        refreshOAuth: async () => {
          refreshes++
        },
        sleep: async () => {},
      },
    )

    await expect(promise).rejects.toMatchObject({ reason: 'stopped' })
    expect(refreshes).toBe(2)
    expect(polls).toBe(2)
  })
})
