import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { getDefaultAppState } from '../src/state/AppStateStore.ts'
import type { AppState } from '../src/state/AppState.ts'
import { startWorkflowTask } from '../src/tasks/LocalWorkflowTask/LocalWorkflowTask.ts'
import { getWorkflowCommands } from '../src/tools/WorkflowTool/createWorkflowCommand.ts'
import { WorkflowExecution } from '../src/tools/WorkflowTool/executor.ts'
import {
  buildStepPrompt,
  parseWorkflowDefinition,
  type WorkflowDefinition,
} from '../src/tools/WorkflowTool/schema.ts'
import type { ToolUseContext } from '../src/Tool.ts'
import { resetCommandQueue } from '../src/utils/messageQueueManager.ts'
import { sleep } from '../src/utils/sleep.ts'

const baseSteps = [
  { id: 'a', prompt: 'A {{input}}', dependsOn: [], continueOnError: false },
  { id: 'b', prompt: 'B {{steps.a.output}}', dependsOn: ['a'], continueOnError: false },
]

function workflow(overrides?: Partial<WorkflowDefinition>): WorkflowDefinition {
  return parseWorkflowDefinition({
    name: 'test-flow',
    description: 'test workflow',
    steps: baseSteps,
    concurrency: 2,
    ...overrides,
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

afterEach(() => {
  resetCommandQueue()
})

describe('workflow schema', () => {
  test('validates dependencies and interpolates input and step output', () => {
    const definition = workflow()
    expect(definition.steps).toHaveLength(2)
    expect(
      buildStepPrompt(definition.steps[0]!, 'fix this', {}),
    ).toBe('A fix this')
    expect(
      buildStepPrompt(definition.steps[1]!, '', { a: 'first done' }),
    ).toBe('B first done')
  })

  test('rejects duplicate IDs, unknown dependencies, and cycles', () => {
    expect(() =>
      parseWorkflowDefinition({
        name: 'bad',
        description: 'bad',
        steps: [
          { id: 'a', prompt: 'a' },
          { id: 'a', prompt: 'again' },
        ],
      }),
    ).toThrow('Duplicate workflow step')
    expect(() =>
      parseWorkflowDefinition({
        name: 'bad',
        description: 'bad',
        steps: [{ id: 'a', prompt: 'a', dependsOn: ['missing'] }],
      }),
    ).toThrow('Unknown dependency')
    expect(() =>
      parseWorkflowDefinition({
        name: 'bad',
        description: 'bad',
        steps: [
          { id: 'a', prompt: 'a', dependsOn: ['b'] },
          { id: 'b', prompt: 'b', dependsOn: ['a'] },
        ],
      }),
    ).toThrow('dependency cycle')
  })
})

describe('WorkflowExecution', () => {
  test('runs independent steps concurrently and dependencies after both complete', async () => {
    const definition = workflow({
      steps: [
        { id: 'a', prompt: 'a', dependsOn: [], continueOnError: false },
        { id: 'b', prompt: 'b', dependsOn: [], continueOnError: false },
        {
          id: 'c',
          prompt: '{{steps.a.output}}+{{steps.b.output}}',
          dependsOn: ['a', 'b'],
          continueOnError: false,
        },
      ],
    })
    const pending = new Map<string, ReturnType<typeof deferred<string>>>()
    const prompts: string[] = []
    const execution = new WorkflowExecution(definition, '', (step, prompt) => {
      prompts.push(prompt)
      const wait = deferred<string>()
      pending.set(step.id, wait)
      return wait.promise
    })
    execution.start()
    await sleep(0)
    expect(pending.has('c')).toBe(false)
    pending.get('a')!.resolve('A')
    pending.get('b')!.resolve('B')
    await sleep(0)
    pending.get('c')!.resolve('C')
    const result = await execution.done
    expect(result.status).toBe('completed')
    expect(prompts).toContain('A+B')
    expect(result.results).toEqual({ a: 'A', b: 'B', c: 'C' })
  })

  test('propagates failure unless a dependent opts into continuation', async () => {
    const execution = new WorkflowExecution(
      workflow({
        steps: [
          { id: 'a', prompt: 'a', dependsOn: [], continueOnError: false },
          { id: 'b', prompt: 'b', dependsOn: ['a'], continueOnError: false },
          { id: 'c', prompt: 'c', dependsOn: ['a'], continueOnError: true },
        ],
      }),
      '',
      async step => (step.id === 'a' ? Promise.reject(new Error('boom')) : 'ok'),
    )
    execution.start()
    const result = await execution.done
    expect(result.status).toBe('failed')
    expect(result.agents.a?.status).toBe('failed')
    expect(result.agents.b?.status).toBe('skipped')
    expect(result.agents.c?.status).toBe('completed')
  })

  test('retries a failed step while the workflow is still running', async () => {
    const other = deferred<string>()
    let attempts = 0
    const execution = new WorkflowExecution(
      workflow({
        steps: [
          baseSteps[0]!,
          { id: 'other', prompt: 'other', dependsOn: [], continueOnError: false },
          baseSteps[1]!,
        ],
      }),
      '',
      async step => {
        if (step.id === 'other') return other.promise
        if (step.id === 'b') return 'done'
        attempts++
        if (attempts === 1) throw new Error('first attempt failed')
        return 'recovered'
      },
    )
    execution.start()
    await sleep(0)
    expect(execution.retry('a')).toBe(true)
    other.resolve('done')
    const result = await execution.done
    expect(attempts).toBe(2)
    expect(result.status).toBe('completed')
    expect(result.results.a).toBe('recovered')
    expect(result.results.b).toBe('done')
  })

  test('skip aborts a step and skips its dependents', async () => {
    const execution = new WorkflowExecution(
      workflow(),
      '',
      (_step, _prompt, signal) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    )
    execution.start()
    expect(execution.skip('a')).toBe(true)
    const result = await execution.done
    expect(result.status).toBe('completed')
    expect(result.agents.a?.status).toBe('skipped')
    expect(result.agents.b?.status).toBe('skipped')
  })

  test('kill aborts active runners and resolves as killed', async () => {
    const execution = new WorkflowExecution(
      workflow({ steps: [baseSteps[0]!] }),
      '',
      (_step, _prompt, signal) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    )
    execution.start()
    expect(execution.kill()).toBe(true)
    expect((await execution.done).status).toBe('killed')
    expect(execution.kill()).toBe(false)
  })
})

describe('workflow discovery and local task state', () => {
  test('discovers project JSON definitions as workflow commands', async () => {
    const project = await mkdtemp(join('/tmp', 'claude-workflow-test-'))
    try {
      const dir = join(project, '.claude', 'workflows')
      await mkdir(dir, { recursive: true })
      await writeFile(
        join(dir, 'review.json'),
        JSON.stringify({
          name: 'review',
          description: 'review changes',
          steps: [{ id: 'review', prompt: 'Review {{input}}' }],
        }),
      )
      const commands = await getWorkflowCommands(project)
      expect(commands.map(command => command.name)).toContain('review')
      expect(commands.find(command => command.name === 'review')?.kind).toBe(
        'workflow',
      )
    } finally {
      await rm(project, { recursive: true, force: true })
    }
  })

  test('completes a real AppState task and persists its result', async () => {
    let appState = getDefaultAppState()
    const setAppState = (update: (previous: AppState) => AppState) => {
      appState = update(appState)
    }
    const context = {
      setAppState,
      setAppStateForTasks: setAppState,
      toolUseId: 'tool-workflow-test',
    } as unknown as ToolUseContext
    const { taskId, done } = startWorkflowTask({
      workflow: workflow({ steps: [baseSteps[0]!] }),
      input: 'task input',
      context,
      canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }),
      runner: async (_step, prompt) => `finished: ${prompt}`,
    })
    expect((await done).status).toBe('completed')
    const task = appState.tasks[taskId]
    expect(task?.type).toBe('local_workflow')
    expect(task?.status).toBe('completed')
    expect(task && 'agents' in task ? task.agents?.a?.status : undefined).toBe(
      'completed',
    )
    const output = JSON.parse(await readFile(task!.outputFile, 'utf8'))
    expect(output.results.a).toBe('finished: A task input')
    await rm(task!.outputFile, { force: true })
  })
})
