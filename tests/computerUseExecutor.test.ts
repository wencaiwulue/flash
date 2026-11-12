import { describe, expect, mock, test } from 'bun:test'
import type { ComputerUseInputAPI } from '../src/external-stubs/computer-use-input.ts'
import type { ComputerUseAPI } from '../src/external-stubs/computer-use-swift.ts'
import { createCliExecutor } from '../src/utils/computerUse/executor.ts'

function fakeSwift(): ComputerUseAPI {
  return {
    _drainMainRunLoop: mock(async () => {}),
  } as unknown as ComputerUseAPI
}

function fakeInput(overrides: Partial<ComputerUseInputAPI> = {}) {
  const input: ComputerUseInputAPI = {
    isSupported: true,
    moveMouse: mock(async () => {}),
    mouseButton: mock(async () => {}),
    mouseScroll: mock(async () => {}),
    mouseLocation: mock(async () => ({ x: 0, y: 0 })),
    key: mock(async () => {}),
    keys: mock(async () => {}),
    typeText: mock(async () => {}),
    getFrontmostAppInfo: mock(async () => ({
      bundleId: 'example.A',
      appName: 'A',
    })),
    ...overrides,
  }
  return input
}

function executor(input: ComputerUseInputAPI) {
  return createCliExecutor({
    input,
    swift: fakeSwift(),
    getMouseAnimationEnabled: () => false,
    getHideBeforeActionEnabled: () => false,
  })
}

describe('CLI executor input cleanup', () => {
  test('holdKey releases only successfully pressed keys after a mid-press failure', async () => {
    const input = fakeInput()
    input.key.mockImplementation(async (keyName, action) => {
      if (keyName === 'a' && action === 'press') throw new Error('press failed')
    })
    await expect(executor(input).holdKey(['shift', 'a'], 1)).rejects.toThrow('press failed')
    expect(input.key.mock.calls).toEqual([
      ['shift', 'press'],
      ['a', 'press'],
      ['shift', 'release'],
    ])
  })

  test('holdKey releases in reverse order after success', async () => {
    const input = fakeInput()
    await executor(input).holdKey(['shift', 'a'], 1)
    expect(input.key.mock.calls).toEqual([
      ['shift', 'press'],
      ['a', 'press'],
      ['a', 'release'],
      ['shift', 'release'],
    ])
  })

  test('drag always releases the button when movement fails', async () => {
    const input = fakeInput()
    input.moveMouse.mockImplementation(async () => {
      throw new Error('move failed')
    })
    await expect(
      executor(input).drag(undefined, { x: 100, y: 100 }),
    ).rejects.toThrow('move failed')
    expect(input.mouseButton.mock.calls).toEqual([
      ['left', 'press', undefined],
      ['left', 'release', undefined],
    ])
  })

  test('concurrent native captures share the bounded runloop drain and resolve', async () => {
    const input = fakeInput()
    const swift = fakeSwift()
    const geometry = {
      displayId: 7,
      width: 100,
      height: 80,
      scaleFactor: 2,
      originX: 0,
      originY: 0,
    }
    swift.display = {
      getSize: mock(async () => geometry),
      listAll: mock(async () => [geometry]),
    }
    swift.screenshot = {
      captureExcluding: mock(async () => {
        await new Promise(resolve => setTimeout(resolve, 5))
        return {
          base64: 'jpeg',
          width: 100,
          height: 80,
          displayWidth: 100,
          displayHeight: 80,
          displayId: 7,
          originX: 0,
          originY: 0,
        }
      }),
      captureRegion: mock(async () => ({ base64: 'crop', width: 1, height: 1 })),
    }
    const cli = createCliExecutor({
      input,
      swift,
      getMouseAnimationEnabled: () => false,
      getHideBeforeActionEnabled: () => false,
    })
    const results = await Promise.all([
      cli.screenshot({ allowedBundleIds: ['example.A'], displayId: 7 }),
      cli.screenshot({ allowedBundleIds: ['example.A'], displayId: 7 }),
    ])
    expect(results).toHaveLength(2)
    expect(swift.screenshot.captureExcluding).toHaveBeenCalledTimes(2)
    expect(swift._drainMainRunLoop.mock.calls.length).toBeGreaterThan(0)
  })

  test('click modifiers are released when the click fails', async () => {
    const input = fakeInput()
    input.mouseButton.mockImplementation(async () => {
      throw new Error('click failed')
    })
    await expect(
      executor(input).click(1, 2, 'left', 1, ['shift']),
    ).rejects.toThrow('click failed')
    expect(input.key.mock.calls).toEqual([
      ['shift', 'press'],
      ['shift', 'release'],
    ])
  })
})
