import { buildStepPrompt, type WorkflowDefinition, type WorkflowStep } from './schema.js'

export type WorkflowAgentStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'

export type WorkflowAgentState = {
  status: WorkflowAgentStatus
  output?: string
  error?: string
}

export type WorkflowExecutionStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'killed'

export type WorkflowExecutionState = {
  status: WorkflowExecutionStatus
  agents: Record<string, WorkflowAgentState>
  results: Record<string, string>
  error?: string
}

export type WorkflowStepRunner = (
  step: WorkflowStep,
  prompt: string,
  signal: AbortSignal,
) => Promise<string>

export class WorkflowExecution {
  readonly done: Promise<WorkflowExecutionState>
  private state: WorkflowExecutionState
  private readonly controllers = new Map<string, AbortController>()
  private wake: (() => void) | undefined
  private finish!: (state: WorkflowExecutionState) => void

  constructor(
    private readonly workflow: WorkflowDefinition,
    private readonly input: string,
    private readonly runner: WorkflowStepRunner,
    private readonly onUpdate: (state: WorkflowExecutionState) => void = () => {},
  ) {
    this.state = {
      status: 'running',
      agents: Object.fromEntries(
        workflow.steps.map(step => [step.id, { status: 'pending' }]),
      ),
      results: {},
    }
    this.done = new Promise(resolve => {
      this.finish = resolve
    })
  }

  start(): void {
    this.onUpdate(this.snapshot())
    void this.loop()
  }

  getState(): WorkflowExecutionState {
    return this.snapshot()
  }

  skip(stepId: string): boolean {
    if (this.state.status !== 'running') return false
    const agent = this.state.agents[stepId]
    if (!agent || agent.status === 'completed') return false
    this.state.agents[stepId] = { status: 'skipped' }
    this.controllers.get(stepId)?.abort()
    this.notify()
    return true
  }

  retry(stepId: string): boolean {
    if (this.state.status !== 'running') return false
    const agent = this.state.agents[stepId]
    if (!agent || (agent.status !== 'failed' && agent.status !== 'skipped')) {
      return false
    }
    this.state.agents[stepId] = { status: 'pending' }
    const resetDependents = (id: string): void => {
      for (const step of this.workflow.steps) {
        if (!step.dependsOn.includes(id)) continue
        const dependent = this.state.agents[step.id]
        if (
          dependent?.status === 'skipped' &&
          dependent.error === 'Skipped because a dependency did not complete'
        ) {
          this.state.agents[step.id] = { status: 'pending' }
          resetDependents(step.id)
        }
      }
    }
    resetDependents(stepId)
    this.notify()
    return true
  }

  kill(): boolean {
    if (this.state.status !== 'running') return false
    this.state.status = 'killed'
    for (const [id, agent] of Object.entries(this.state.agents)) {
      if (agent.status === 'pending') this.state.agents[id] = { status: 'skipped' }
    }
    for (const controller of this.controllers.values()) controller.abort()
    this.notify()
    return true
  }

  private snapshot(): WorkflowExecutionState {
    return {
      ...this.state,
      agents: Object.fromEntries(
        Object.entries(this.state.agents).map(([id, agent]) => [id, { ...agent }]),
      ),
      results: { ...this.state.results },
    }
  }

  private notify(): void {
    this.onUpdate(this.snapshot())
    this.wake?.()
    this.wake = undefined
  }

  private dependenciesReady(step: WorkflowStep): boolean {
    return step.dependsOn.every(id => {
      const dependency = this.state.agents[id]
      return (
        dependency?.status === 'completed' ||
        (dependency?.status === 'failed' && step.continueOnError)
      )
    })
  }

  private propagateSkips(): boolean {
    let changed = false
    for (const step of this.workflow.steps) {
      if (this.state.agents[step.id]?.status !== 'pending') continue
      const blocked = step.dependsOn.some(id => {
        const status = this.state.agents[id]?.status
        return status === 'skipped' || (status === 'failed' && !step.continueOnError)
      })
      if (blocked) {
        this.state.agents[step.id] = {
          status: 'skipped',
          error: 'Skipped because a dependency did not complete',
        }
        changed = true
      }
    }
    return changed
  }

  private launch(step: WorkflowStep): void {
    const controller = new AbortController()
    this.controllers.set(step.id, controller)
    this.state.agents[step.id] = { status: 'running' }
    this.notify()
    void this.runner(
      step,
      buildStepPrompt(step, this.input, this.state.results),
      controller.signal,
    )
      .then(output => {
        if (
          this.state.status !== 'killed' &&
          this.state.agents[step.id]?.status === 'running'
        ) {
          this.state.results[step.id] = output
          this.state.agents[step.id] = { status: 'completed', output }
        }
      })
      .catch(error => {
        if (
          this.state.status !== 'killed' &&
          this.state.agents[step.id]?.status === 'running'
        ) {
          this.state.agents[step.id] = {
            status: 'failed',
            error: error instanceof Error ? error.message : String(error),
          }
        }
      })
      .finally(() => {
        this.controllers.delete(step.id)
        this.notify()
      })
  }

  private async loop(): Promise<void> {
    try {
      while (
        this.state.status === 'running' ||
        (this.state.status === 'killed' && this.controllers.size > 0)
      ) {
        this.propagateSkips()
        const running = this.controllers.size
        const ready = this.workflow.steps.filter(
          step =>
            this.state.agents[step.id]?.status === 'pending' &&
            this.dependenciesReady(step),
        )
        for (const step of ready.slice(0, this.workflow.concurrency - running)) {
          this.launch(step)
        }

        const pending = this.workflow.steps.some(
          step => this.state.agents[step.id]?.status === 'pending',
        )
        if (this.controllers.size === 0 && !pending) break
        if (ready.length === 0 || this.controllers.size >= this.workflow.concurrency) {
          await new Promise<void>(resolve => {
            this.wake = resolve
          })
        }
      }

      if (this.state.status === 'running') {
        this.state.status = Object.values(this.state.agents).some(
          agent => agent.status === 'failed',
        )
          ? 'failed'
          : 'completed'
      }
      this.finish(this.snapshot())
      this.onUpdate(this.snapshot())
    } catch (error) {
      this.state.status = 'failed'
      this.state.error = error instanceof Error ? error.message : String(error)
      this.finish(this.snapshot())
      this.onUpdate(this.snapshot())
    }
  }
}
