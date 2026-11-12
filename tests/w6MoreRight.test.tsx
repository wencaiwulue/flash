import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { randomUUID } from 'crypto'
import React from 'react'
import { PassThrough } from 'stream'
import { render } from '../src/ink.js'
import { useMoreRight } from '../src/moreright/useMoreRight.js'
import type { Message } from '../src/types/message.js'

let messages: Message[]
let input: string
let api: ReturnType<typeof useMoreRight> | null = null
const setToolJSX = mock()

function Harness({ enabled }: { enabled: boolean }): React.ReactNode {
  api = useMoreRight({
    enabled,
    inputValue: input,
    setInputValue: value => { input = value },
    setMessages: update => {
      messages = typeof update === 'function' ? update(messages) : update
    },
    setToolJSX,
  })
  return api.render()
}

function user(text: string): Message {
  return {
    type: 'user',
    uuid: randomUUID(),
    timestamp: '2026-01-01T00:00:00.000Z',
    message: { role: 'user', content: text },
  } as Message
}

function assistant(): Message {
  return {
    type: 'assistant',
    uuid: randomUUID(),
    timestamp: '2026-01-01T00:00:01.000Z',
    message: { role: 'assistant', content: [] },
  } as Message
}

async function mount(enabled: boolean): Promise<{
  instance: Awaited<ReturnType<typeof render>>
  stdin: PassThrough
  output: () => string
}> {
  const stdout = new PassThrough()
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean
    isRaw: boolean
    setRawMode: (value: boolean) => void
    ref: () => void
    unref: () => void
  }
  stdin.isTTY = true
  stdin.isRaw = false
  stdin.setRawMode = value => { stdin.isRaw = value }
  stdin.ref = () => {}
  stdin.unref = () => {}
  let output = ''
  stdout.on('data', chunk => { output += chunk.toString() })
  const instance = await render(<Harness enabled={enabled} />, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })
  await new Promise(resolve => setTimeout(resolve, 20))
  return { instance, stdin, output: () => output }
}

const original = process.env.CLAUDE_MORERIGHT
beforeEach(() => {
  process.env.CLAUDE_MORERIGHT = '1'
  messages = []
  input = ''
  api = null
  setToolJSX.mockClear()
})
afterEach(() => {
  if (original === undefined) delete process.env.CLAUDE_MORERIGHT
  else process.env.CLAUDE_MORERIGHT = original
})

describe('useMoreRight', () => {
  test('disabled has no interception, messages, or sidebar', async () => {
    const mounted = await mount(false)
    expect(await api!.onBeforeQuery('@right private', [], 0)).toBe(true)
    await api!.onTurnComplete([user('ordinary')], false)
    expect(messages).toEqual([])
    expect(input).toBe('')
    expect(mounted.output()).not.toContain('MoreRight')
    mounted.instance.unmount()
  })

  test('ordinary input passes through and notes stay out of model messages', async () => {
    const mounted = await mount(true)
    input = 'ordinary'
    expect(await api!.onBeforeQuery('ordinary', [], 0)).toBe(true)
    expect(input).toBe('ordinary')
    expect(messages).toEqual([])

    expect(await api!.onBeforeQuery('@right local secret note', [], 0)).toBe(false)
    expect(input).toBe('')
    expect(messages).toHaveLength(1)
    expect(JSON.stringify(messages)).not.toContain('local secret note')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(mounted.output()).toContain('local secret note')
    expect(mounted.output()).toContain('MoreRight local notes (1)')

    expect(await api!.onBeforeQuery('@right    ', [], 0)).toBe(false)
    expect(messages).toHaveLength(2)
    expect(JSON.stringify(messages.at(-1))).toContain('empty notes')

    await api!.onTurnComplete([user('successful turn'), assistant()], false)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(mounted.output()).toContain('Last turn completed')
    await api!.onTurnComplete([user('next turn'), assistant()], true)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(mounted.output()).toContain('Last turn aborted')
    expect(mounted.output()).not.toContain('unavailable')
    mounted.instance.unmount()
  })

  test('caps notes, clears locally and unmounts keyboard handling', async () => {
    const mounted = await mount(true)
    for (let index = 0; index < 25; index++) {
      expect(await api!.onBeforeQuery(`@right note-${index}`, [], 0)).toBe(false)
    }
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(mounted.output()).toContain('MoreRight local notes (20)')
    expect(mounted.output()).toContain('note-24')
    expect(messages).toHaveLength(25)

    mounted.stdin.write('\x18')
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(mounted.output()).toContain('MoreRight local notes (0)')
    mounted.instance.unmount()
    expect((mounted.stdin as unknown as { isRaw: boolean }).isRaw).toBe(false)
  })
})
