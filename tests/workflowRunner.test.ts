import { afterEach, describe, expect, mock, test } from 'bun:test'
import { runWorkflowStep } from '../src/tools/WorkflowTool/runner.ts'
import { WorkflowExecution } from '../src/tools/WorkflowTool/executor.ts'
import { parseWorkflowDefinition, type WorkflowStep } from '../src/tools/WorkflowTool/schema.ts'
import { getDefaultAppState } from '../src/state/AppStateStore.ts'
import type { ToolUseContext } from '../src/Tool.ts'
import type { CanUseToolFn } from '../src/hooks/useCanUseTool.ts'

const actualGeneralPurpose = await import('../src/tools/AgentTool/built-in/generalPurposeAgent.ts')
const actualTools = await import('../src/tools.ts')
const runAgentCalls: Array<Record<string, unknown>> = []
const fakeTools = [{ name: 'FakeTool' }]
let outerAbort: AbortController | null = null

mock.module('../src/tools/AgentTool/runAgent.ts', () => ({
  runAgent: async function* (options: Record<string, unknown>) {
    runAgentCalls.push(options)
    if (options.description === 'error-step') {
      throw new Error('agent failure')
    }
    const text = options.description === 'abort-step' ? 'aborted text' : 'final text'
    if (options.description === 'abort-step') {
      outerAbort?.abort(new Error('outer abort'))
    } else {
      yield {
        type: 'assistant',
        uuid: 'assistant-0',
        message: { content: [{ type: 'text', text: 'earlier text' }] },
      }
    }
    yield {
      type: 'assistant',
      uuid: 'assistant-1',
      message: { content: [{ type: 'text', text: 'ignored first' }, { type: 'text', text }] },
    }
  },
}))
mock.module('../src/tools.ts', () => ({
  ...actualTools,
  getTools: () => fakeTools,
}))

afterEach(() => {
  runAgentCalls.length = 0
  outerAbort = null
})

function context(agentType = 'custom-agent'): ToolUseContext {
  return {
    options: {
      agentDefinitions: {
        allAgents: [{ agentType, name: 'Custom Agent', description: 'custom' }],
      },
    },
    getAppState: () => getDefaultAppState(),
  } as unknown as ToolUseContext
}

function step(id: string, agentType = 'custom-agent'): WorkflowStep {
  return {
    id,
    prompt: `Run ${id}`,
    agentType,
    dependsOn: [],
    continueOnError: false,
  }
}

const canUseTool: CanUseToolFn = async () => true

describe('runWorkflowStep', () => {
  test('uses the matching agent, forwards options, and returns the complete last assistant text', async () => {
    const controller = new AbortController()
    const result = await runWorkflowStep(
      step('step-1'),
      'fix the bug',
      controller.signal,
      context(),
      canUseTool,
      'transcripts/custom',
    )
    expect(result).toBe('ignored first\nfinal text')
    expect(runAgentCalls).toHaveLength(1)
    const call = runAgentCalls[0]!
    expect(call.agentDefinition).toMatchObject({ agentType: 'custom-agent', name: 'Custom Agent' })
    expect(call.promptMessages[0]).toMatchObject({
      type: 'user',
      message: { content: 'fix the bug' },
    })
    expect(call.availableTools).toBe(fakeTools)
    expect(call.description).toBe('step-1')
    expect(call.transcriptSubdir).toBe('transcripts/custom')
    expect(call.canUseTool).toBe(canUseTool)
    expect(call.isAsync).toBe(false)
    expect(call.canShowPermissionPrompts).toBe(true)
    expect(call.querySource).toBe('agent:custom')
  })

  test('falls back to the real general-purpose agent for an unknown type', async () => {
    await runWorkflowStep(step('fallback', 'missing-agent'), 'prompt', new AbortController().signal, context(), canUseTool)
    expect(runAgentCalls[0]!.agentDefinition).toBe(actualGeneralPurpose.GENERAL_PURPOSE_AGENT)
  })

  test('propagates abort and removes the abort listener', async () => {
    const controller = new AbortController()
    const add = mock(controller.signal.addEventListener.bind(controller.signal))
    const remove = mock(controller.signal.removeEventListener.bind(controller.signal))
    controller.signal.addEventListener = add
    controller.signal.removeEventListener = remove
    outerAbort = controller
    await expect(runWorkflowStep(step('abort-step'), 'prompt', controller.signal, context(), canUseTool)).rejects.toThrow('outer abort')
    expect(runAgentCalls[0]).toMatchObject({
      override: { abortController: { signal: { aborted: true } } },
    })
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  test('propagates an agent execution failure', async () => {
    await expect(
      runWorkflowStep(
        step('error-step'),
        'prompt',
        new AbortController().signal,
        context(),
        canUseTool,
      ),
    ).rejects.toThrow('agent failure')
  })
})

describe('killed workflow completion', () => {
  test('does not mark a killed step completed or failed after its runner settles', async () => {
    let resolveStep!: (value: string) => void
    const execution = new WorkflowExecution(
      parseWorkflowDefinition({
        name: 'kill-flow',
        description: 'kill behavior',
        concurrency: 1,
        steps: [{ id: 'a', prompt: 'A', dependsOn: [], continueOnError: false }],
      }),
      'input',
      () => new Promise<string>(resolve => {
        resolveStep = resolve
      }),
    )
    execution.start()
    expect(execution.kill()).toBe(true)
    resolveStep('late output')
    const result = await execution.done
    expect(result.status).toBe('killed')
    expect(result.agents.a?.status).toBe('running')
    expect(result.results).toEqual({})
  })

  test('does not mark a killed step failed when its runner rejects', async () => {
    let rejectStep!: (error: Error) => void
    const execution = new WorkflowExecution(
      parseWorkflowDefinition({
        name: 'kill-error-flow',
        description: 'kill error behavior',
        concurrency: 1,
        steps: [{ id: 'a', prompt: 'A', dependsOn: [], continueOnError: false }],
      }),
      'input',
      () => new Promise<string>((_, reject) => {
        rejectStep = reject
      }),
    )
    execution.start()
    execution.kill()
    rejectStep(new Error('late failure'))
    const result = await execution.done
    expect(result.status).toBe('killed')
    expect(result.agents.a?.status).toBe('running')
    expect(result.results).toEqual({})
  })
})
