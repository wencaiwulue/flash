import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import React from 'react'
import { PassThrough } from 'stream'
import PromptInput from '../src/components/PromptInput/PromptInput.tsx'
import {
  getModeFromInput,
  getValueFromInput,
  isInputModeCharacter,
  prependModeCharacterToInput,
} from '../src/components/PromptInput/inputModes.ts'
import { maybeTruncateInput } from '../src/components/PromptInput/inputPaste.ts'
import { useInputBuffer } from '../src/hooks/useInputBuffer.ts'
import { usePromptSuggestion } from '../src/hooks/usePromptSuggestion.ts'
import { render } from '../src/ink.ts'
import { KeybindingSetup } from '../src/keybindings/KeybindingProviderSetup.tsx'
import { AppStateProvider, useAppStateStore, type AppStateStore } from '../src/state/AppState.tsx'
import { getDefaultAppState } from '../src/state/AppStateStore.ts'
import { getEmptyToolPermissionContext } from '../src/Tool.ts'
import type { ProcessUserInputContext } from '../src/utils/processUserInput/processUserInput.ts'
import { Cursor } from '../src/utils/Cursor.ts'
import { transition } from '../src/vim/transitions.ts'

let instance: Awaited<ReturnType<typeof render>> | undefined

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1500
  while (!predicate() && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  expect(predicate()).toBe(true)
}

afterEach(() => {
  instance?.unmount()
  instance = undefined
})

function streams() {
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
  return { stdin, stdout, output: () => output }
}

async function mountPromptInput() {
  const io = streams()
  const onInputChange = mock()
  let renderedInput = ''
  const insertTextRef: {
    current: {
      insert: (text: string) => void
      setInputWithCursor: (value: string, cursor: number) => void
      cursorOffset: number
    } | null
  } = { current: null }
  function Harness(): React.ReactNode {
    const [input, setInput] = React.useState('hello')
    renderedInput = input
    const handleInputChange = (value: string) => {
      onInputChange(value)
      setInput(value)
    }
    return (
      <PromptInput
        debug={false}
        ideSelection={undefined}
        toolPermissionContext={getEmptyToolPermissionContext()}
        setToolPermissionContext={() => {}}
        apiKeyStatus="valid"
        commands={[]}
        agents={[]}
        isLoading={false}
        verbose={false}
        messages={[]}
        onAutoUpdaterResult={() => {}}
        autoUpdaterResult={null}
        input={input}
        onInputChange={handleInputChange}
        mode="prompt"
        onModeChange={() => {}}
        stashedPrompt={undefined}
        setStashedPrompt={() => {}}
        submitCount={0}
        onShowMessageSelector={() => {}}
        mcpClients={[]}
        pastedContents={{}}
        setPastedContents={() => {}}
        vimMode="INSERT"
        setVimMode={() => {}}
        showBashesDialog={false}
        setShowBashesDialog={() => {}}
        onExit={() => {}}
        getToolUseContext={() => ({}) as ProcessUserInputContext}
        onSubmit={async () => {}}
        isSearchingHistory={false}
        setIsSearchingHistory={() => {}}
        helpOpen={false}
        setHelpOpen={() => {}}
        insertTextRef={insertTextRef}
      />
    )
  }
  instance = await render(
    <AppStateProvider>
      <KeybindingSetup>
        <Harness />
      </KeybindingSetup>
    </AppStateProvider>,
    {
      stdout: io.stdout as unknown as NodeJS.WriteStream,
      stdin: io.stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
    },
  )
  await new Promise(resolve => setTimeout(resolve, 50))
  return {
    insertTextRef,
    onInputChange,
    getRenderedInput: () => renderedInput,
  }
}

describe('PromptInput production integration', () => {
  test('insertTextRef splices at cursor and applies explicit replacement', async () => {
    const { insertTextRef, onInputChange, getRenderedInput } =
      await mountPromptInput()
    expect(insertTextRef.current?.cursorOffset).toBe(5)

    insertTextRef.current!.insert('world')
    expect(onInputChange).toHaveBeenCalledWith('hello world')
    await waitFor(() => getRenderedInput() === 'hello world')
    await waitFor(() => insertTextRef.current?.cursorOffset === 11)

    insertTextRef.current!.setInputWithCursor('xy', 1)
    expect(onInputChange).toHaveBeenCalledWith('xy')
    await waitFor(() => insertTextRef.current?.cursorOffset === 1)
  })

  test('truncates large pastes into a reference while preserving the middle payload', () => {
    const input = `${'a'.repeat(500)}${'b'.repeat(9500)}${'c'.repeat(500)}`
    const result = maybeTruncateInput(input, {
      1: { id: 1, type: 'text', content: 'existing' },
    })

    expect(result.newInput.startsWith('a'.repeat(500))).toBe(true)
    expect(result.newInput.endsWith('c'.repeat(500))).toBe(true)
    expect(result.newInput).toContain('[...Truncated text #2 +')
    expect(result.newPastedContents[1]?.content).toBe('existing')
    expect(result.newPastedContents[2]?.content).toBe('b'.repeat(9500))
  })

  test('maps prompt and bash input modes without losing the payload', () => {
    expect(prependModeCharacterToInput('ls', 'bash')).toBe('!ls')
    expect(prependModeCharacterToInput('ask', 'prompt')).toBe('ask')
    expect(getModeFromInput('!ls')).toBe('bash')
    expect(getModeFromInput('ask')).toBe('prompt')
    expect(getValueFromInput('!ls')).toBe('ls')
    expect(getValueFromInput('ask')).toBe('ask')
    expect(isInputModeCharacter('!')).toBe(true)
    expect(isInputModeCharacter('x')).toBe(false)
  })
})

describe('useInputBuffer', () => {
  test('debounces rapid pushes and truncates history to max size', async () => {
    let api: ReturnType<typeof useInputBuffer> | undefined
    function Harness(): React.ReactNode {
      api = useInputBuffer({ maxBufferSize: 2, debounceMs: 20 })
      return null
    }
    instance = await render(<Harness />)
    api!.pushToBuffer('a', 1)
    api!.pushToBuffer('ab', 2)
    api!.pushToBuffer('abc', 3)
    await new Promise(resolve => setTimeout(resolve, 40))

    await waitFor(() => api!.canUndo)
    expect(api!.undo()?.text).toBe('a')
    api!.clearBuffer()
    await waitFor(() => !api!.canUndo)
    expect(api!.undo()).toBeUndefined()
  })

  test('drops the oldest entry beyond maxBufferSize', async () => {
    let api: ReturnType<typeof useInputBuffer> | undefined
    function Harness(): React.ReactNode {
      api = useInputBuffer({ maxBufferSize: 2, debounceMs: 0 })
      return null
    }
    instance = await render(<Harness />)
    api!.pushToBuffer('a', 1)
    api!.pushToBuffer('ab', 2)
    api!.pushToBuffer('abc', 3)
    await waitFor(() => api!.canUndo)
    expect(api!.undo()?.text).toBe('ab')
  })
})

describe('usePromptSuggestion', () => {
  test('hides while typing, accepts, and resets after submission', async () => {
    let api: ReturnType<typeof usePromptSuggestion> | undefined
    let store: AppStateStore | undefined
    function Harness(): React.ReactNode {
      api = usePromptSuggestion({ inputValue: '', isAssistantResponding: false })
      store = useAppStateStore()
      return null
    }
    const initialState = {
      ...getDefaultAppState(),
      promptSuggestion: {
        text: 'continue',
        promptId: 'offline-suggestion',
        shownAt: 1,
        acceptedAt: 0,
        generationRequestId: 'offline-request',
      },
    }
    instance = await render(
      <AppStateProvider initialState={initialState}>
        <Harness />
      </AppStateProvider>,
    )

    expect(api!.suggestion).toBe('continue')
    api!.markAccepted()
    expect(store!.getState().promptSuggestion.acceptedAt).toBeGreaterThan(0)
    api!.logOutcomeAtSubmission('continue')
    expect(store!.getState().promptSuggestion).toEqual({
      text: null,
      promptId: null,
      shownAt: 0,
      acceptedAt: 0,
      generationRequestId: null,
    })
  })
})

describe('Vim transitions', () => {
  function context(text: string) {
    let currentText = text
    let offset = 1
    let register = ''
    const changes: unknown[] = []
    return {
      cursor: Cursor.fromText(text, 20, offset),
      get text() {
        return currentText
      },
      setText(value: string) {
        currentText = value
      },
      setOffset(value: number) {
        offset = value
      },
      enterInsert: () => {},
      getRegister: () => register,
      setRegister: (value: string) => {
        register = value
      },
      getLastFind: () => null,
      setLastFind: () => {},
      recordChange: (change: unknown) => changes.push(change),
      get offset() {
        return offset
      },
      changes,
    }
  }

  test('executes x with a real cursor and records the deleted register', () => {
    const ctx = context('abc')
    const result = transition({ type: 'idle' }, 'x', ctx)
    result.execute?.()

    expect(ctx.text).toBe('ac')
    expect(ctx.getRegister()).toBe('b')
    expect(ctx.changes).toEqual([{ type: 'x', count: 1 }])
  })

  test('applies count before executing the operator', () => {
    const ctx = context('abcd')
    const counted = transition({ type: 'idle' }, '2', ctx)
    expect(counted.next).toEqual({ type: 'count', digits: '2' })
    const result = transition(counted.next!, 'x', ctx)
    result.execute?.()

    expect(ctx.text).toBe('ad')
    expect(ctx.getRegister()).toBe('bc')
    expect(ctx.changes).toEqual([{ type: 'x', count: 2 }])
  })
})
