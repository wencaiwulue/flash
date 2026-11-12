import { describe, expect, mock, spyOn, test } from 'bun:test'
import type { ReactElement } from 'react'
import type { LocalJSXCommandContext } from '../src/types/command.ts'

const completeOnboarding = mock(() => {})
const interactiveHelpersActual = await import('../src/interactiveHelpers.tsx?actual')
mock.module('../src/interactiveHelpers.tsx', () => ({
  ...interactiveHelpersActual,
  completeOnboarding,
}))

const issue = (await import('../src/commands/issue/index.ts')).default
const feedback = (await import('../src/commands/feedback/index.ts')).default
const { call: feedbackCall } = await import('../src/commands/feedback/feedback.tsx')
const onboarding = (await import('../src/commands/onboarding/index.ts')).default
const { call: onboardingCall } = await import('../src/commands/onboarding/onboarding.tsx')
const { Onboarding } = await import('../src/components/Onboarding.tsx')

const context = {
  abortController: new AbortController(),
  messages: [],
} as LocalJSXCommandContext
const onDone = mock(() => {})

describe('/issue', () => {
  test('loads the exact existing feedback flow and passes the initial report', async () => {
    expect(issue.name).toBe('issue')
    expect(issue.isHidden).toBeUndefined()
    expect(await issue.load()).toBe(await feedback.load())
    const fetchSpy = spyOn(globalThis, 'fetch')
    const element = (await feedbackCall(onDone, context, 'initial report')) as ReactElement
    expect(element.props.initialDescription).toBe('initial report')
    expect(element.props.messages).toBe(context.messages)
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  test('does not add a repository-specific gh issue path', async () => {
    const source = await Bun.file(
      new URL('../src/commands/issue/index.ts', import.meta.url),
    ).text()
    expect(source).toContain("import('../feedback/feedback.js')")
    expect(source).not.toContain('gh issue')
    expect(source).not.toContain('git remote')
  })
})

describe('/onboarding', () => {
  test('returns the existing wizard and completes only from its final callback', async () => {
    completeOnboarding.mockClear()
    onDone.mockClear()
    const element = (await onboardingCall(onDone, context, '')) as ReactElement
    expect(element.type).toBe(Onboarding)
    expect(completeOnboarding).not.toHaveBeenCalled()

    // Cancelling never invokes the wizard's completion callback.
    expect(completeOnboarding).not.toHaveBeenCalled()
    expect(onDone).not.toHaveBeenCalled()

    element.props.onDone()
    element.props.onDone()
    expect(completeOnboarding).toHaveBeenCalledTimes(1)
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  test('rejects --reset without changing onboarding state', async () => {
    completeOnboarding.mockClear()
    const result = await onboardingCall(onDone, context, '--reset')
    expect(result).toBeNull()
    expect(onDone).toHaveBeenCalledWith(expect.stringContaining('Usage: /onboarding'))
    expect(completeOnboarding).not.toHaveBeenCalled()
  })
})
