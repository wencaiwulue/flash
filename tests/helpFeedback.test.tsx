import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import React from 'react'
import { PassThrough } from 'stream'

let globalConfig: Record<string, any> = {}
const actualConfig = await import('../src/utils/config.ts')
const getGlobalConfigSpy = mock(() => globalConfig)
mock.module('../src/utils/config.ts', () => ({
  ...actualConfig,
  getGlobalConfig: getGlobalConfigSpy,
  saveGlobalConfig: (update: (current: Record<string, any>) => Record<string, any>) => {
    globalConfig = update(globalConfig)
  },
}))
const dynamicConfigSpy = mock((key: string, fallback: unknown) => {
  if (key === 'tengu_feedback_survey_config') {
    return {
      minTimeBeforeFeedbackMs: 0,
      minTimeBetweenFeedbackMs: 0,
      minTimeBetweenGlobalFeedbackMs: 100_000,
      minUserTurnsBeforeFeedback: 2,
      minUserTurnsBetweenFeedback: 2,
      hideThanksAfterMs: 3000,
      onForModels: ['*'],
      probability: 0.5,
    }
  }
  return fallback
})
mock.module('src/hooks/useDynamicConfig.ts', () => ({
  useDynamicConfig: dynamicConfigSpy,
}))
mock.module('../src/utils/settings/settings.ts', () => ({
  getInitialSettings: () => ({ feedbackSurveyRate: undefined }),
  getSettings_DEPRECATED: () => ({ spinnerTipsEnabled: true }),
}))
const disabledSpy = mock(() => false)
const policySpy = mock(() => true)
mock.module('../src/services/analytics/config.ts', () => ({
  isFeedbackSurveyDisabled: disabledSpy,
}))
mock.module('../src/services/policyLimits/index.ts', () => ({
  isPolicyAllowed: policySpy,
}))
mock.module('../src/utils/model/model.ts', () => ({
  getMainLoopModel: () => 'test-model',
}))
const sessionsSinceShown: Record<string, number> = {}
mock.module('../src/services/tips/tipHistory.ts', () => ({
  getSessionsSinceLastShown: (id: string) => sessionsSinceShown[id] ?? 0,
  recordTipShown: (id: string) => {
    sessionsSinceShown[id] = 0
  },
}))

const { useDebouncedDigitInput } = await import(
  '../src/components/FeedbackSurvey/useDebouncedDigitInput.ts'
)
const { useFeedbackSurvey } = await import(
  '../src/components/FeedbackSurvey/useFeedbackSurvey.tsx'
)
const { redactSensitiveInfo } = await import('../src/components/Feedback.tsx')
const { HelpV2 } = await import('../src/components/HelpV2/HelpV2.tsx')
const { selectTipWithLongestTimeSinceShown } = await import(
  '../src/services/tips/tipScheduler.ts'
)
const { getRecentReleaseNotes, parseChangelog } = await import(
  '../src/utils/releaseNotes.ts'
)
const { render } = await import('../src/ink.ts')
const { KeybindingSetup } = await import(
  '../src/keybindings/KeybindingProviderSetup.tsx'
)
const { AppStateProvider } = await import('../src/state/AppState.tsx')

let instance: Awaited<ReturnType<typeof render>> | undefined
const originalRandom = Math.random

afterEach(() => {
  instance?.unmount()
  instance = undefined
  Math.random = originalRandom
  globalConfig = {}
  for (const key of Object.keys(sessionsSinceShown)) delete sessionsSinceShown[key]
})

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1500
  while (!predicate() && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  expect(predicate()).toBe(true)
}

function streams() {
  const stdout = new PassThrough() as PassThrough & { columns: number; rows: number }
  let output = ''
  stdout.on('data', chunk => {
    output += chunk.toString()
  })
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean
    isRaw: boolean
    setRawMode: (value: boolean) => void
    ref: () => void
    unref: () => void
  }
  stdin.isTTY = true
  stdin.isRaw = false
  stdin.setRawMode = value => {
    stdin.isRaw = value
  }
  stdin.ref = () => {}
  stdin.unref = () => {}
  stdout.columns = 100
  stdout.rows = 40
  return { stdin, stdout, output: () => output }
}

describe('FeedbackSurvey real hooks', () => {
  test('debounces only the final digit and honors once', async () => {
    const selected: string[] = []
    const values: string[] = []
    function Harness() {
      const [input, setInput] = React.useState('')
      React.useEffect(() => {
        const timers = [
          setTimeout(() => setInput('1'), 0),
          setTimeout(() => setInput('12'), 5),
          setTimeout(() => setInput('123'), 50),
        ]
        return () => timers.forEach(clearTimeout)
      }, [])
      useDebouncedDigitInput({
        inputValue: input,
        setInputValue: value => {
          values.push(value)
          setInput(value)
        },
        isValidDigit: (char): char is string => /^[1-3]$/.test(char),
        onDigit: digit => selected.push(digit),
        once: true,
        debounceMs: 20,
      })
      return null
    }
    instance = await render(<Harness />)

    await waitFor(() => selected.length === 1)
    expect(selected).toEqual(['2'])
    expect(values).toEqual(['1'])
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(selected).toEqual(['2'])
  })

  test('cancels a pending digit when disabled', async () => {
    const selected: string[] = []
    function Harness({ enabled }: { enabled: boolean }) {
      const [input, setInput] = React.useState('')
      React.useEffect(() => {
        const timer = setTimeout(() => setInput('1'), 0)
        return () => clearTimeout(timer)
      }, [])
      useDebouncedDigitInput({
        inputValue: input,
        setInputValue: setInput,
        isValidDigit: (char): char is string => char === '1',
        onDigit: digit => selected.push(digit),
        enabled,
        debounceMs: 20,
      })
      return null
    }
    instance = await render(<Harness enabled={true} />)
    await new Promise(resolve => setTimeout(resolve, 5))
    await instance.rerender(<Harness enabled={false} />)
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(selected).toEqual([])
  })

  test('enforces turn eligibility and rolls probability once per submit count', async () => {
    let api: ReturnType<typeof useFeedbackSurvey> | undefined
    function Harness({ count }: { count: number }) {
      api = useFeedbackSurvey([], false, count)
      return null
    }
    const rolls = [0.9, 0.1]
    const randomSpy = spyOn(Math, 'random').mockImplementation(() => rolls.shift() ?? 0.1)
    instance = await render(<Harness count={0} />)
    expect(dynamicConfigSpy).toHaveBeenCalledWith(
      'tengu_feedback_survey_config',
      expect.any(Object),
    )
    expect(api!.state).toBe('closed')
    await instance.rerender(<Harness count={1} />)
    expect(api!.state).toBe('closed')
    await instance.rerender(<Harness count={3} />)
    await waitFor(() => randomSpy.mock.calls.length > 0)
    const firstRollCount = randomSpy.mock.calls.length
    expect(api!.state).toBe('closed')
    await instance.rerender(<Harness count={3} />)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(randomSpy.mock.calls.length).toBe(firstRollCount)
    await instance.rerender(<Harness count={4} />)
    await waitFor(() => api!.state === 'open')
    expect(randomSpy.mock.calls.length).toBeGreaterThan(firstRollCount)
    randomSpy.mockRestore()
  })

  test('enforces global feedback cooldown before opening', async () => {
    globalConfig.feedbackSurveyState = { lastShownTime: Date.now() }
    const randomSpy = spyOn(Math, 'random').mockReturnValue(0)
    let api: ReturnType<typeof useFeedbackSurvey> | undefined
    function Harness({ count }: { count: number }) {
      api = useFeedbackSurvey([], false, count)
      return null
    }
    instance = await render(<Harness count={0} />)
    expect(api!.state).toBe('closed')
    await instance.rerender(<Harness count={1} />)
    await instance.rerender(<Harness count={2} />)

    globalConfig.feedbackSurveyState.lastShownTime = Date.now() - 200_000
    const previousLastShown = globalConfig.feedbackSurveyState.lastShownTime
    await instance.rerender(<Harness count={4} />)
    await waitFor(() => getGlobalConfigSpy.mock.calls.length > 0)
    await waitFor(
      () => globalConfig.feedbackSurveyState.lastShownTime > previousLastShown,
    )
    randomSpy.mockRestore()
  })
})

describe('feedback redaction and help UI', () => {
  test('redacts dummy credentials while preserving normal text', () => {
    const secrets = {
      anthropic: `sk-ant-${'a'.repeat(30)}`,
      aws: `AKIA${'A'.repeat(16)}`,
      gcp: `AIza${'a'.repeat(35)}`,
      service: 'offline@example.iam.gserviceaccount.com',
      header: 'dummy-header-secret',
      bearer: 'dummy-bearer-secret',
      generic: 'dummy-generic-secret',
    }
    const input = `normal text ${secrets.anthropic} ${secrets.aws} ${secrets.gcp} ${secrets.service} x-api-key: ${secrets.header} authorization: Bearer ${secrets.bearer} API_KEY=${secrets.generic}`
    const redacted = redactSensitiveInfo(input)

    for (const secret of Object.values(secrets)) expect(redacted).not.toContain(secret)
    expect(redacted).toContain('normal text')
    expect(redacted).toContain('[REDACTED_API_KEY]')
    expect(redacted).toContain('[REDACTED_AWS_KEY]')
    expect(redacted).toContain('[REDACTED_GCP_KEY]')
    expect(redacted).toContain('[REDACTED_GCP_SERVICE_ACCOUNT]')
    expect(redacted).toContain('[REDACTED_TOKEN]')
  })

  test('switches HelpV2 tabs with real keybindings and dismisses with Escape', async () => {
    const io = streams()
    const onClose = mock()
    instance = await render(
      <AppStateProvider>
        <KeybindingSetup>
          <HelpV2 onClose={onClose} commands={[]} />
        </KeybindingSetup>
      </AppStateProvider>,
      {
        stdout: io.stdout as unknown as NodeJS.WriteStream,
        stdin: io.stdin as unknown as NodeJS.ReadStream,
        patchConsole: false,
      },
    )
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(io.output()).toContain('general')

    io.stdin.write('\t')
    await new Promise(resolve => setTimeout(resolve, 30))
    io.stdin.write('\t')
    await waitFor(() => io.output().includes('No custom commands found'))
    io.stdin.write('')
    await waitFor(() => onClose.mock.calls.length === 1)
    expect(onClose).toHaveBeenCalledWith('Help dialog dismissed', { display: 'system' })
  })
})

describe('tips and release notes', () => {
  test('selects the tip with the longest time since it was shown', () => {
    const tip = (id: string) => ({
      id,
      content: () => id,
      cooldownSessions: 1,
      isRelevant: () => true,
    })
    const older = tip('older')
    const recent = tip('recent')
    sessionsSinceShown.older = 8
    sessionsSinceShown.recent = 2

    expect(selectTipWithLongestTimeSinceShown([])).toBeUndefined()
    expect(selectTipWithLongestTimeSinceShown([older])?.id).toBe('older')
    expect(selectTipWithLongestTimeSinceShown([recent, older])?.id).toBe('older')
  })

  test('parses dated versions and returns at most five newest unseen notes', () => {
    const content = Array.from({ length: 7 }, (_, index) => {
      const version = index + 1
      return `## 1.${version}.0 - 2026-01-0${version}\n- note-${version}\nnot a bullet`
    }).join('\n')
    const parsed = parseChangelog(content)
    expect(parsed['1.7.0']).toEqual(['note-7'])
    expect(parsed['1.1.0']).toEqual(['note-1'])

    expect(getRecentReleaseNotes('1.7.0', '1.0.0', content)).toEqual([
      'note-7',
      'note-6',
      'note-5',
      'note-4',
      'note-3',
    ])
    expect(getRecentReleaseNotes('1.7.0', '1.7.0', content)).toEqual([])
  })
})
