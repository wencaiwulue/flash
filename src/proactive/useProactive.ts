export type UseProactiveOptions = {
  isLoading: boolean
  queuedCommandsLength: number
  hasActiveLocalJsxUI: boolean
  isInPlanMode: boolean
  onSubmitTick: (prompt: string) => void
  onQueueTick: (prompt: string) => void
}

export type ProactiveHookStatus = { enabled: false }

/** Disabled hook boundary: it never schedules ticks or submits prompts. */
export function useProactive(
  _options: UseProactiveOptions,
): ProactiveHookStatus {
  return { enabled: false }
}
