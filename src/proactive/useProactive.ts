import { useEffect, useRef, useSyncExternalStore } from 'react'
import { TICK_TAG } from '../constants/xml.js'
import {
  getNextTickAt,
  getProactiveControlState,
  setProactiveNextTickAt,
  subscribeToProactiveChanges,
} from './index.js'

export type UseProactiveOptions = {
  isLoading: boolean
  queuedCommandsLength: number
  hasActiveLocalJsxUI: boolean
  isInPlanMode: boolean
  onSubmitTick: (prompt: string) => void
  onQueueTick: (prompt: string) => void
}

export type ProactiveHookStatus = { enabled: boolean }

export const PROACTIVE_TICK_DELAY_MS = 1_000

export function formatProactiveTick(date = new Date()): string {
  return `<${TICK_TAG}>${date.toLocaleTimeString()}</${TICK_TAG}>`
}

export class ProactiveTickScheduler {
  private options: UseProactiveOptions | undefined
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly delayMs = PROACTIVE_TICK_DELAY_MS) {}

  setOptions(options: UseProactiveOptions): void {
    this.options = options
  }

  sync(): void {
    this.cancel()
    const options = this.options
    const control = getProactiveControlState()
    if (
      !options ||
      !control.active ||
      control.paused ||
      control.contextBlocked ||
      options.isLoading ||
      options.queuedCommandsLength > 0 ||
      options.hasActiveLocalJsxUI ||
      options.isInPlanMode
    ) {
      return
    }

    setProactiveNextTickAt(Date.now() + this.delayMs)
    this.timer = setTimeout(() => {
      this.timer = undefined
      setProactiveNextTickAt(null)
      const latest = this.options
      const current = getProactiveControlState()
      if (
        !latest ||
        !current.active ||
        current.paused ||
        current.contextBlocked ||
        latest.queuedCommandsLength > 0 ||
        latest.hasActiveLocalJsxUI ||
        latest.isInPlanMode
      ) {
        return
      }
      const prompt = formatProactiveTick()
      if (latest.isLoading) latest.onQueueTick(prompt)
      else latest.onSubmitTick(prompt)
    }, this.delayMs)
    this.timer.unref()
  }

  cancel(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    if (getNextTickAt() !== null) setProactiveNextTickAt(null)
  }
}

export function useProactive(
  options: UseProactiveOptions,
): ProactiveHookStatus {
  const control = useSyncExternalStore(
    subscribeToProactiveChanges,
    getProactiveControlState,
    getProactiveControlState,
  )
  const schedulerRef = useRef<ProactiveTickScheduler | null>(null)
  if (schedulerRef.current === null) {
    schedulerRef.current = new ProactiveTickScheduler()
  }
  const scheduler = schedulerRef.current
  scheduler.setOptions(options)

  useEffect(() => {
    scheduler.sync()
    return () => scheduler.cancel()
  }, [
    scheduler,
    control,
    options.isLoading,
    options.queuedCommandsLength,
    options.hasActiveLocalJsxUI,
    options.isInPlanMode,
  ])

  return { enabled: control.active }
}
