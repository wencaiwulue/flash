import { afterEach, describe, expect, test } from 'bun:test'
import { getCoordinatorAgents } from '../src/coordinator/workerAgent.ts'
import {
  activateProactive,
  deactivateProactive,
  getNextTickAt,
  getProactiveControlState,
  isProactiveActive,
  pauseProactive,
  resumeProactive,
  setContextBlocked,
  subscribeToProactiveChanges,
} from '../src/proactive/index.ts'
import {
  ProactiveTickScheduler,
  type UseProactiveOptions,
} from '../src/proactive/useProactive.ts'
import { SleepTool } from '../src/tools/SleepTool/SleepTool.ts'
import { sleep } from '../src/utils/sleep.ts'

let scheduler: ProactiveTickScheduler | undefined

function idleOptions(): UseProactiveOptions {
  return {
    isLoading: false,
    queuedCommandsLength: 0,
    hasActiveLocalJsxUI: false,
    isInPlanMode: false,
    onSubmitTick: () => {},
    onQueueTick: () => {},
  }
}

afterEach(() => {
  scheduler?.cancel()
  scheduler = undefined
  deactivateProactive()
})

describe('proactive state', () => {
  test('tracks activation, pause, context blocking, and listeners', () => {
    let notifications = 0
    const unsubscribe = subscribeToProactiveChanges(() => notifications++)
    expect(activateProactive('command')).toBe(true)
    expect(activateProactive('command')).toBe(false)
    expect(isProactiveActive()).toBe(true)
    expect(SleepTool.isEnabled()).toBe(true)

    expect(pauseProactive()).toBe(true)
    expect(getProactiveControlState().paused).toBe(true)
    expect(resumeProactive()).toBe(true)
    expect(setContextBlocked(true)).toBe(true)
    expect(getProactiveControlState().contextBlocked).toBe(true)
    expect(setContextBlocked(false)).toBe(true)

    expect(deactivateProactive()).toBe(true)
    expect(deactivateProactive()).toBe(false)
    expect(SleepTool.isEnabled()).toBe(false)
    expect(notifications).toBe(6)
    unsubscribe()
  })

  test('schedules an idle tick and exposes its due time', async () => {
    const submitted: string[] = []
    activateProactive('command')
    scheduler = new ProactiveTickScheduler(5)
    scheduler.setOptions({
      ...idleOptions(),
      onSubmitTick: prompt => submitted.push(prompt),
    })
    scheduler.sync()
    expect(getNextTickAt()).not.toBeNull()
    await sleep(20)
    expect(submitted).toHaveLength(1)
    expect(submitted[0]).toMatch(/^<tick>.*<\/tick>$/)
    expect(getNextTickAt()).toBeNull()
  })

  test('suppresses scheduling while busy, paused, or context-blocked', () => {
    activateProactive('command')
    scheduler = new ProactiveTickScheduler(5)
    for (const options of [
      { ...idleOptions(), isLoading: true },
      { ...idleOptions(), queuedCommandsLength: 1 },
      { ...idleOptions(), hasActiveLocalJsxUI: true },
      { ...idleOptions(), isInPlanMode: true },
    ]) {
      scheduler.setOptions(options)
      scheduler.sync()
      expect(getNextTickAt()).toBeNull()
    }
    scheduler.setOptions(idleOptions())
    pauseProactive()
    scheduler.sync()
    expect(getNextTickAt()).toBeNull()
    resumeProactive()
    setContextBlocked(true)
    scheduler.sync()
    expect(getNextTickAt()).toBeNull()
  })
})

describe('Coordinator workers', () => {
  test('registers one real asynchronous worker with non-recursive tools', async () => {
    const agents = getCoordinatorAgents()
    expect(agents).toHaveLength(1)
    const worker = agents[0]!
    expect(worker.agentType).toBe('worker')
    expect(worker.background).toBe(true)
    expect(worker.tools).toContain('Bash')
    expect(worker.tools).toContain('Read')
    expect(worker.tools).not.toContain('Agent')
    expect(worker.tools).not.toContain('SendMessage')
    expect(worker.tools).not.toContain('SyntheticOutput')
    expect(await worker.getSystemPrompt({} as never)).toContain(
      'The coordinator\'s prompt is your complete task',
    )
  })
})
