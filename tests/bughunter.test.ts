import { describe, expect, mock, test } from 'bun:test'
import type { ReactElement } from 'react'
import type { LocalJSXCommandContext } from '../src/types/command.ts'

let enabled = true
let gate: { kind: string; billingNote?: string } = {
  kind: 'proceed',
  billingNote: '',
}
const checkOverageGate = mock(async () => gate)
const launchRemoteReview = mock(async () => null)
const confirmOverage = mock(() => {})

const growthbookActual = await import('../src/services/analytics/growthbook.ts?actual')
const reviewRemoteActual = await import('../src/commands/review/reviewRemote.ts?actual')
const overageDialogActual = await import('../src/commands/review/UltrareviewOverageDialog.tsx?actual')

mock.module('../src/services/analytics/growthbook.ts', () => ({
  ...growthbookActual,
  getFeatureValue_CACHED_MAY_BE_STALE: () => ({ enabled }),
}))
mock.module('../src/commands/review/reviewRemote.ts', () => ({
  ...reviewRemoteActual,
  checkOverageGate,
  launchRemoteReview,
  confirmOverage,
}))
mock.module('../src/commands/review/UltrareviewOverageDialog.tsx', () => ({
  ...overageDialogActual,
  UltrareviewOverageDialog: () => null,
}))

const bughunter = (await import('../src/commands/bughunter/index.ts')).default
const context = {} as LocalJSXCommandContext
const onDone = mock(() => {})

describe('/bughunter', () => {
  test('uses the ultrareview gate and lazy remote-review implementation', async () => {
    expect(bughunter.name).toBe('bughunter')
    expect(bughunter.availability).toEqual(['claude-ai'])
    expect(bughunter.isEnabled?.()).toBe(true)
    enabled = false
    expect(bughunter.isEnabled?.()).toBe(false)
    enabled = true
    expect((await bughunter.load()).call).toBeFunction()
  })

  test('passes focus to the existing remote launch without a second scanner', async () => {
    gate = { kind: 'proceed', billingNote: '' }
    launchRemoteReview.mockClear()
    await (await bughunter.load()).call(onDone, context, 'race conditions')
    expect(launchRemoteReview).toHaveBeenCalledWith(
      'race conditions',
      context,
      '',
    )
  })

  test('does not launch after quota rejection or overage cancellation', async () => {
    launchRemoteReview.mockClear()
    gate = { kind: 'not-enabled' }
    expect(await (await bughunter.load()).call(onDone, context, '')).toBeNull()
    expect(launchRemoteReview).not.toHaveBeenCalled()

    gate = { kind: 'needs-confirm' }
    const dialog = (await (await bughunter.load()).call(
      onDone,
      context,
      '',
    )) as ReactElement
    dialog.props.onCancel()
    expect(launchRemoteReview).not.toHaveBeenCalled()
    expect(confirmOverage).not.toHaveBeenCalled()
  })

  test('launches only after explicit overage confirmation', async () => {
    gate = { kind: 'needs-confirm' }
    launchRemoteReview.mockClear()
    confirmOverage.mockClear()
    const dialog = (await (await bughunter.load()).call(
      onDone,
      context,
      'security focus',
    )) as ReactElement
    await dialog.props.onProceed(new AbortController().signal)
    expect(launchRemoteReview).toHaveBeenCalledWith(
      'security focus',
      context,
      ' This review bills as Extra Usage.',
    )
    expect(confirmOverage).toHaveBeenCalledTimes(1)
  })
})
