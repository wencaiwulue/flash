import { describe, expect, test } from 'bun:test'
import { spawn } from 'child_process'
import {
  createComputerUseInput,
  isSupported,
} from '../src/external-stubs/computer-use-input.ts'
import { createComputerUseSwift } from '../src/external-stubs/computer-use-swift.ts'
import {
  NativeHelperClient,
  type ComputerUseHelper,
} from '../src/utils/computerUse/nativeHelper.ts'

class FakeHelper implements ComputerUseHelper {
  calls: Array<{ method: string; params: Record<string, unknown> }> = []
  listeners = new Set<() => void>()
  registered = true

  async request<T>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    this.calls.push({ method, params })
    if (method === 'input.mouseLocation') return { x: 10, y: 20 } as T
    if (method === 'input.getFrontmostAppInfo') {
      return { bundleId: 'example.Test', appName: 'Test' } as T
    }
    if (method === 'display.getSize') {
      return {
        displayId: 7,
        width: 1440,
        height: 900,
        scaleFactor: 2,
        originX: -1440,
        originY: 0,
      } as T
    }
    if (method === 'display.listAll') return [] as T
    if (method === 'apps.previewHideSet') return [] as T
    if (method === 'apps.findWindowDisplays') return [] as T
    if (method === 'apps.appUnderPoint') return null as T
    if (method === 'apps.listInstalled' || method === 'apps.listRunning') {
      return [] as T
    }
    if (method === 'apps.iconDataUrl') return null as T
    if (method.startsWith('tcc.')) return { granted: true } as T
    if (method === 'hotkey.registerEscape') {
      return { registered: this.registered } as T
    }
    if (method === 'drainMainRunLoop') return { drained: 2 } as T
    if (method === 'screenshot.captureRegion') {
      return { base64: 'region', width: 10, height: 20 } as T
    }
    if (method.startsWith('screenshot.') || method === 'resolvePrepareCapture') {
      return {
        base64: 'jpeg',
        width: 100,
        height: 80,
        displayWidth: 1440,
        displayHeight: 900,
        displayId: 7,
        originX: -1440,
        originY: 0,
        hidden: ['example.Other'],
      } as T
    }
    if (method === 'apps.prepareDisplay') {
      return { hidden: ['example.Other'], activated: 'example.Test' } as T
    }
    return {} as T
  }

  onEvent(_event: 'escape', listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async close(): Promise<void> {}
}

describe('open native helper adapters', () => {
  test('uses platform detection rather than a fixed unsupported sentinel', () => {
    expect(isSupported).toBe(process.platform === 'darwin')
  })

  test('input forwards every mouse, keyboard, Unicode and frontmost method', async () => {
    const helper = new FakeHelper()
    const input = createComputerUseInput(helper)
    await input.moveMouse(-10, 20, true)
    await input.mouseButton('left', 'click', 3)
    await input.mouseButton('right', 'press')
    await input.mouseButton('middle', 'release')
    await input.mouseScroll(-4, 'horizontal')
    expect(await input.mouseLocation()).toEqual({ x: 10, y: 20 })
    await input.key('shift', 'press')
    await input.keys(['command', 'shift', 'a'])
    await input.typeText('你好\u{1F600}\n')
    expect(await input.getFrontmostAppInfo()).toEqual({
      bundleId: 'example.Test',
      appName: 'Test',
    })
    expect(helper.calls.map(call => call.method)).toEqual([
      'input.moveMouse',
      'input.mouseButton',
      'input.mouseButton',
      'input.mouseButton',
      'input.mouseScroll',
      'input.mouseLocation',
      'input.key',
      'input.keys',
      'input.typeText',
      'input.getFrontmostAppInfo',
    ])
    expect(helper.calls[0]?.params).toEqual({ x: -10, y: 20, animated: true })
    expect(helper.calls[7]?.params).toEqual({
      keyNames: ['command', 'shift', 'a'],
    })
    expect(helper.calls[8]?.params).toEqual({ text: '你好\u{1F600}\n' })
  })

  test('swift forwards display, capture, all app, TCC, prepare and drain methods', async () => {
    const helper = new FakeHelper()
    const swift = createComputerUseSwift(helper)
    expect((await swift.display.getSize(7)).originX).toBe(-1440)
    await swift.display.listAll()
    expect(
      (await swift.screenshot.captureExcluding(['example.Test'], 0.75, 100, 80, 7))
        .base64,
    ).toBe('jpeg')
    expect(
      await swift.screenshot.captureRegion(
        ['example.Test'],
        -1400,
        10,
        20,
        30,
        10,
        20,
        0.75,
        7,
      ),
    ).toEqual({ base64: 'region', width: 10, height: 20 })
    expect(
      await swift.apps.prepareDisplay(['example.Test'], 'example.Host', 7),
    ).toEqual({ hidden: ['example.Other'], activated: 'example.Test' })
    await swift.apps.previewHideSet(['example.Test'], 7)
    await swift.apps.findWindowDisplays(['example.Test'])
    expect(await swift.apps.appUnderPoint(1, 2)).toBeNull()
    await swift.apps.listInstalled()
    expect(await swift.apps.iconDataUrl('/Applications/Test.app')).toBeNull()
    await swift.apps.listRunning()
    await swift.apps.open('example.Test')
    await swift.apps.unhide(['example.Other'])
    expect(await swift.tcc.checkAccessibility()).toBe(true)
    expect(await swift.tcc.checkScreenRecording()).toBe(true)
    expect(
      await swift.resolvePrepareCapture(
        ['example.Test'],
        'example.Host',
        0.75,
        100,
        80,
        7,
        true,
        true,
      ),
    ).toMatchObject({ displayId: 7, hidden: ['example.Other'] })
    await swift._drainMainRunLoop()
    expect(helper.calls.map(call => call.method)).toContain('apps.unhide')
    expect(helper.calls.map(call => call.method)).toContain('drainMainRunLoop')
    expect(helper.calls.map(call => call.method)).toContain(
      'resolvePrepareCapture',
    )
  })

  test('hotkey emits real helper events and cleans up on failure/unregister', async () => {
    const helper = new FakeHelper()
    const swift = createComputerUseSwift(helper)
    let escapes = 0
    expect(await swift.hotkey.registerEscape(() => escapes++)).toBe(true)
    for (const listener of helper.listeners) listener()
    expect(escapes).toBe(1)
    await swift.hotkey.notifyExpectedEscape()
    await swift.hotkey.unregister()
    expect(helper.listeners.size).toBe(0)

    helper.registered = false
    expect(await swift.hotkey.registerEscape(() => escapes++)).toBe(false)
    expect(helper.listeners.size).toBe(0)
    await swift.hotkey.unregister()
  })

  test('JSON-lines loader handles responses, events, abort and close', async () => {
    const child = spawn(process.execPath, ['-e', `
      let buffer = '';
      process.stdin.on('data', chunk => {
        buffer += chunk;
        for (;;) {
          const index = buffer.indexOf('\\n');
          if (index < 0) break;
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          const request = JSON.parse(line);
          if (request.method === 'escape') {
            process.stdout.write('{"event":"escape"}\\n');
            process.stdout.write(JSON.stringify({id: request.id, ok: true, result: {}}) + '\\n');
            continue;
          }
          const respond = () => process.stdout.write(JSON.stringify({id: request.id, ok: true, result: {method: request.method, params: request.params}}) + '\\n');
          if (request.method === 'slow') setTimeout(respond, 100);
          else respond();
        }
      });
      process.stdin.on('end', () => process.exit(0));
    `], { stdio: ['pipe', 'pipe', 'pipe'], shell: false })
    const client = new NativeHelperClient(child)
    expect(await client.request('display.listAll', { test: true })).toEqual({
      method: 'display.listAll',
      params: { test: true },
    })
    let escaped = 0
    const remove = client.onEvent('escape', () => escaped++)
    await client.request('escape')
    expect(escaped).toBe(1)
    remove()
    const controller = new AbortController()
    const slow = client.request('slow', {}, { signal: controller.signal })
    controller.abort()
    await expect(slow).rejects.toMatchObject({ name: 'AbortError' })
    await client.close()
    expect(child.exitCode).toBe(0)
  })
})
