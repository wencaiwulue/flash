import {
  getComputerUseHelper,
  type ComputerUseHelper,
} from '../utils/computerUse/nativeHelper.js'

export type ComputerUseInputAPI = {
  isSupported: boolean
  moveMouse(x: number, y: number, animated: boolean): Promise<void>
  mouseButton(
    button: 'left' | 'right' | 'middle',
    action: 'click' | 'press' | 'release',
    count?: 1 | 2 | 3,
  ): Promise<void>
  mouseScroll(amount: number, axis: 'vertical' | 'horizontal'): Promise<void>
  mouseLocation(): Promise<{ x: number; y: number }>
  key(keyName: string, action: 'press' | 'release'): Promise<void>
  keys(keyNames: readonly string[]): Promise<void>
  typeText(text: string): Promise<void>
  getFrontmostAppInfo(): Promise<{
    bundleId?: string
    appName: string
  } | null>
}

export type ComputerUseInput = ComputerUseInputAPI | { isSupported: false }

/** Create the public CGEvent/NSWorkspace adapter over an injectable helper. */
export function createComputerUseInput(
  helper: ComputerUseHelper,
): ComputerUseInputAPI {
  const request = <T>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> => helper.request<T>(`input.${method}`, params)

  return {
    isSupported: process.platform === 'darwin',
    async moveMouse(x, y, animated) {
      await request('moveMouse', { x, y, animated })
    },
    async mouseButton(button, action, count) {
      await request('mouseButton', { button, action, count })
    },
    async mouseScroll(amount, axis) {
      await request('mouseScroll', { amount, axis })
    },
    mouseLocation() {
      return request<{ x: number; y: number }>('mouseLocation')
    },
    async key(keyName, action) {
      await request('key', { keyName, action })
    },
    async keys(keyNames) {
      await request('keys', { keyNames: [...keyNames] })
    },
    async typeText(text) {
      await request('typeText', { text })
    },
    getFrontmostAppInfo() {
      return request<{ bundleId?: string; appName: string } | null>(
        'getFrontmostAppInfo',
      )
    },
  }
}

let cached: ComputerUseInputAPI | undefined
export function resetComputerUseInputAdapter(): void {
  cached = undefined
}

function defaultInput(): ComputerUseInputAPI {
  return (cached ??= createComputerUseInput(getComputerUseHelper()))
}

export const isSupported = process.platform === 'darwin'
export const moveMouse: ComputerUseInputAPI['moveMouse'] = (...args) =>
  defaultInput().moveMouse(...args)
export const mouseButton: ComputerUseInputAPI['mouseButton'] = (...args) =>
  defaultInput().mouseButton(...args)
export const mouseScroll: ComputerUseInputAPI['mouseScroll'] = (...args) =>
  defaultInput().mouseScroll(...args)
export const mouseLocation: ComputerUseInputAPI['mouseLocation'] = () =>
  defaultInput().mouseLocation()
export const key: ComputerUseInputAPI['key'] = (...args) =>
  defaultInput().key(...args)
export const keys: ComputerUseInputAPI['keys'] = (...args) =>
  defaultInput().keys(...args)
export const typeText: ComputerUseInputAPI['typeText'] = (...args) =>
  defaultInput().typeText(...args)
export const getFrontmostAppInfo: ComputerUseInputAPI['getFrontmostAppInfo'] =
  () => defaultInput().getFrontmostAppInfo()
