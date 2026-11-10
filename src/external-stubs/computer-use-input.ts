export type ComputerUseInputAPI = {
  isSupported: true
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
  getFrontmostAppInfo(): {
    bundleId?: string
    appName: string
  } | null
}

export type ComputerUseInput =
  | ComputerUseInputAPI
  | { isSupported: false }

/** The loader checks this flag and fails before invoking any native method. */
export const isSupported = false as const
