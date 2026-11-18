import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import React from 'react'
import { PassThrough } from 'stream'
import {
  resetStateForTests,
  setAllowedSettingSources,
  setOriginalCwd,
  setProjectRoot,
} from '../src/bootstrap/state.ts'
import { render } from '../src/ink.ts'
import {
  AppStateProvider,
  useAppState,
  useAppStateStore,
  type AppState,
  type AppStateStore,
} from '../src/state/AppState.tsx'
import { getDefaultAppState } from '../src/state/AppStateStore.ts'
import {
  dispose,
  notifyChange,
  resetForTesting,
} from '../src/utils/settings/changeDetector.ts'
import { resetSettingsCache } from '../src/utils/settings/settingsCache.ts'

let tempDir: string
let originalConfigDir: string | undefined
let originalCwd: string
let store: AppStateStore | undefined
let instance: Awaited<ReturnType<typeof render>> | undefined

beforeEach(async () => {
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  originalCwd = process.cwd()
  tempDir = await mkdtemp(join(tmpdir(), 'flash-app-state-'))
  process.env.CLAUDE_CONFIG_DIR = tempDir
  await mkdir(tempDir, { recursive: true })
  resetStateForTests()
  setOriginalCwd(tempDir)
  setProjectRoot(tempDir)
  setAllowedSettingSources(['userSettings'])
  resetSettingsCache()
  await resetForTesting()
  store = undefined
})

afterEach(async () => {
  instance?.unmount()
  instance = undefined
  await dispose()
  await resetForTesting()
  resetSettingsCache()
  resetStateForTests()
  process.chdir(originalCwd)
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  await rm(tempDir, { recursive: true, force: true })
})

function StoreCapture(): React.ReactNode {
  store = useAppStateStore()
  return null
}

async function mount(
  children: React.ReactNode,
  initialState?: AppState,
  onChangeAppState?: (args: { newState: AppState; oldState: AppState }) => void,
) {
  const stdout = new PassThrough()
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
  instance = await render(
    <AppStateProvider
      initialState={initialState}
      onChangeAppState={onChangeAppState}
    >
      <StoreCapture />
      {children}
    </AppStateProvider>,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
    },
  )
  await new Promise(resolve => setTimeout(resolve, 30))
  return { output: () => output }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1500
  while (!predicate() && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  expect(predicate()).toBe(true)
}

describe('AppStateProvider React integration', () => {
  test('selector subscriptions rerender only affected slices and skip identical state', async () => {
    const renders = { verbose: 0, tasks: 0 }
    const onChange = mock()
    function VerboseProbe(): React.ReactNode {
      useAppState(state => state.verbose)
      renders.verbose++
      return null
    }
    function TasksProbe(): React.ReactNode {
      useAppState(state => state.tasks)
      renders.tasks++
      return null
    }

    await mount(
      <>
        <VerboseProbe />
        <TasksProbe />
      </>,
      getDefaultAppState(),
      onChange,
    )
    const baseline = { ...renders }

    store!.setState(prev => ({ ...prev, verbose: true }))
    await waitFor(() => renders.verbose > baseline.verbose)
    expect(renders.tasks).toBe(baseline.tasks)

    const afterVerbose = { ...renders }
    store!.setState(prev => ({ ...prev, tasks: [] }))
    await waitFor(() => renders.tasks > afterVerbose.tasks)
    expect(renders.verbose).toBe(afterVerbose.verbose)

    const afterTasks = { ...renders }
    const changeCount = onChange.mock.calls.length
    store!.setState(prev => prev)
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(renders).toEqual(afterTasks)
    expect(onChange).toHaveBeenCalledTimes(changeCount)
  })

  test('nested providers surface the explicit nesting error', async () => {
    const mounted = await mount(
      <AppStateProvider>
        <StoreCapture />
      </AppStateProvider>,
    )
    expect(mounted.output()).toContain(
      'AppStateProvider can not be nested within another AppStateProvider',
    )
  })

  test('external userSettings changes update the provider store', async () => {
    const settingsPath = join(tempDir, 'settings.json')
    await writeFile(
      settingsPath,
      JSON.stringify({ model: 'offline-model-a', verbose: false }),
    )
    resetSettingsCache()
    await mount(null)

    await writeFile(
      settingsPath,
      JSON.stringify({ model: 'offline-model-b', verbose: true }),
    )
    notifyChange('userSettings')

    await waitFor(() => store?.getState().settings.model === 'offline-model-b')
    expect(store?.getState().settings.verbose).toBe(true)
  })
})
