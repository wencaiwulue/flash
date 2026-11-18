import { describe, expect, test } from 'bun:test'
import React from 'react'
import { LogUpdate } from '../src/ink/log-update.ts'
import { parseMultipleKeypresses } from '../src/ink/parse-keypress.ts'
import {
  CellWidth,
  CharPool,
  HyperlinkPool,
  StylePool,
  cellAt,
  createScreen,
  diffEach,
  setCellAt,
} from '../src/ink/screen.ts'
import type { Frame } from '../src/ink/frame.ts'
import { Text } from '../src/ink.ts'
import { renderToString } from '../src/utils/staticRender.tsx'

describe('terminal input state machine', () => {
  test('resumes partial CSI u sequences and parses modifiers, mouse and DA1', () => {
    const [partial, partialState] = parseMultipleKeypresses({}, '\x1b[13;')
    expect(partial).toEqual([])
    const [keys] = parseMultipleKeypresses(partialState, '2u')
    expect(keys[0]).toMatchObject({
      kind: 'key',
      name: 'return',
      shift: true,
      sequence: '\x1b[13;2u',
    })

    const [mouse] = parseMultipleKeypresses({}, '\x1b[<32;10;5M')
    expect(mouse[0]).toEqual({
      kind: 'mouse',
      button: 32,
      action: 'press',
      col: 10,
      row: 5,
      sequence: '\x1b[<32;10;5M',
    })

    const [response] = parseMultipleKeypresses({}, '\x1b[?1;2c')
    expect(response[0]).toMatchObject({
      kind: 'response',
      response: { type: 'da1', params: [1, 2] },
    })
  })

  test('treats bracketed paste content as one pasted key, including escape sequences', () => {
    const [keys, nextState] = parseMultipleKeypresses(
      {},
      '\x1b[200~hello\x1b[27m\x1b[201~',
    )
    expect(nextState.mode).toBe('NORMAL')
    expect(keys).toHaveLength(1)
    expect(keys[0]).toMatchObject({
      kind: 'key',
      isPasted: true,
      sequence: 'hello\x1b[27m',
    })
  })
})

function frameOf(
  width: number,
  height: number,
  viewportHeight = height + 1,
  pools?: { charPool: CharPool; hyperlinkPool: HyperlinkPool },
): Frame {
  const stylePool = new StylePool()
  return {
    screen: createScreen(
      width,
      height,
      stylePool,
      pools?.charPool ?? new CharPool(),
      pools?.hyperlinkPool ?? new HyperlinkPool(),
    ),
    viewport: { width, height: viewportHeight },
    cursor: { x: 0, y: 0, visible: true },
  }
}

describe('screen cells and damage', () => {
  test('tracks wide spacers and hyperlink identity while clearing overwrites', () => {
    const frame = frameOf(4, 1)
    setCellAt(frame.screen, 0, 0, {
      char: '界',
      width: CellWidth.Wide,
      styleId: 0,
      hyperlink: 'https://example.com',
    })

    expect(cellAt(frame.screen, 0, 0)).toMatchObject({
      char: '界',
      width: CellWidth.Wide,
      hyperlink: 'https://example.com',
    })
    expect(cellAt(frame.screen, 1, 0)?.width).toBe(CellWidth.SpacerTail)
    expect(frame.screen.hyperlinkPool.intern('https://example.com')).toBe(
      frame.screen.hyperlinkPool.intern('https://example.com'),
    )

    setCellAt(frame.screen, 0, 0, {
      char: 'a',
      width: CellWidth.Narrow,
      styleId: 0,
    })
    expect(cellAt(frame.screen, 0, 0)?.char).toBe('a')
    expect(cellAt(frame.screen, 1, 0)?.width).toBe(CellWidth.Narrow)
  })

  test('diffEach reports only the changed cell', () => {
    const pools = {
      charPool: new CharPool(),
      hyperlinkPool: new HyperlinkPool(),
    }
    const previous = frameOf(2, 1, 2, pools)
    const next = frameOf(2, 1, 2, pools)
    setCellAt(previous.screen, 0, 0, {
      char: 'a',
      width: CellWidth.Narrow,
      styleId: 0,
    })
    setCellAt(next.screen, 0, 0, {
      char: 'b',
      width: CellWidth.Narrow,
      styleId: 0,
    })
    const changes: Array<{
      x: number
      y: number
      removed: string | undefined
      added: string | undefined
    }> = []

    diffEach(previous.screen, next.screen, (x, y, removed, added) => {
      changes.push({ x, y, removed: removed?.char, added: added?.char })
    })

    expect(changes).toEqual([{ x: 0, y: 0, removed: 'a', added: 'b' }])
  })
})

describe('LogUpdate rendering', () => {
  test('renders a full frame in non-TTY mode and a changed cell in TTY mode', () => {
    const pools = {
      charPool: new CharPool(),
      hyperlinkPool: new HyperlinkPool(),
    }
    const previous = frameOf(2, 1, 2, pools)
    const next = frameOf(2, 1, 2, pools)
    setCellAt(previous.screen, 0, 0, {
      char: 'a',
      width: CellWidth.Narrow,
      styleId: 0,
    })
    setCellAt(next.screen, 0, 0, {
      char: 'b',
      width: CellWidth.Narrow,
      styleId: 0,
    })
    setCellAt(next.screen, 1, 0, {
      char: 'c',
      width: CellWidth.Narrow,
      styleId: 0,
    })
    const stylePool = new StylePool()

    const nonTty = new LogUpdate({ isTTY: false, stylePool }).render(
      previous,
      next,
    )
    expect(nonTty).toEqual([{ type: 'stdout', content: 'bc' }])

    const tty = new LogUpdate({ isTTY: true, stylePool }).render(
      previous,
      next,
    )
    expect(tty.some(operation => operation.type === 'clearTerminal')).toBe(false)
    expect(
      tty.some(
        operation =>
          operation.type === 'stdout' && operation.content.includes('b'),
      ),
    ).toBe(true)
  })
})

describe('real Ink rendering', () => {
  test('renders text through the production reconciler to a string', async () => {
    await expect(renderToString(<Text>hello</Text>, 10)).resolves.toBe('hello')
  })
})
