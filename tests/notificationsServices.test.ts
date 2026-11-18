import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

const axiosPost = mock(async (..._args: unknown[]) => {
  throw new Error('Unexpected axios.post')
})
const executeNotificationHooks = mock(async () => [])
const execFileNoThrow = mock(async (..._args: unknown[]) => ({
  code: 1,
  stdout: '',
  stderr: '',
}))

mock.module('axios', () => ({ default: { post: axiosPost } }))
const hooksModule = await import('../src/utils/hooks.ts')
mock.module('../src/utils/hooks.ts', () => ({
  ...hooksModule,
  executeNotificationHooks,
}))
const execModule = await import('../src/utils/execFileNoThrow.ts')
mock.module('../src/utils/execFileNoThrow.ts', () => ({
  ...execModule,
  execFileNoThrow,
}))

const { sendNotification } = await import('../src/services/notifier.ts')
const { PushNotificationTool } = await import(
  '../src/tools/PushNotificationTool/PushNotificationTool.ts'
)
const { env } = await import('../src/utils/env.ts')
const { getGlobalConfig, saveGlobalConfig } = await import(
  '../src/utils/config.ts'
)
const { getEmptyToolPermissionContext } = await import('../src/Tool.ts')
const { createFileStateCacheWithSizeLimit } = await import(
  '../src/utils/fileStateCache.ts'
)

let originalTerminal: string | undefined
let originalWebhook: string | undefined
let originalChannel: string

beforeEach(() => {
  originalTerminal = env.terminal
  originalWebhook = process.env.CLAUDE_NOTIFICATION_WEBHOOK_URL
  originalChannel = getGlobalConfig().preferredNotifChannel
  axiosPost.mockReset()
  executeNotificationHooks.mockClear()
  execFileNoThrow.mockReset()
  delete process.env.CLAUDE_NOTIFICATION_WEBHOOK_URL
})

afterEach(() => {
  env.terminal = originalTerminal
  if (originalWebhook === undefined) {
    delete process.env.CLAUDE_NOTIFICATION_WEBHOOK_URL
  } else {
    process.env.CLAUDE_NOTIFICATION_WEBHOOK_URL = originalWebhook
  }
  saveGlobalConfig(current => ({
    ...current,
    preferredNotifChannel: originalChannel,
  }))
})

function terminalDouble() {
  return {
    notifyITerm2: mock(() => {}),
    notifyKitty: mock(() => {}),
    notifyGhostty: mock(() => {}),
    notifyBell: mock(() => {}),
  }
}

function toolContext(sendOSNotification = mock(() => {})) {
  const abortController = new AbortController()
  return {
    abortController,
    sendOSNotification,
    toolUseId: 'offline-tool-use',
    agentId: undefined,
    options: {
      commands: [],
      tools: [],
      verbose: false,
      safeMode: false,
      forkNumber: 0,
      messages: [],
      readFileState: createFileStateCacheWithSizeLimit(10),
      toolPermissionContext: getEmptyToolPermissionContext(),
      sessionId: 'offline-session',
      isNonInteractiveSession: true,
    },
  }
}

describe('OS notification channels', () => {
  test('terminal_bell invokes only the bell adapter after hooks', async () => {
    saveGlobalConfig(current => ({
      ...current,
      preferredNotifChannel: 'terminal_bell',
    }))
    const terminal = terminalDouble()

    await sendNotification(
      { message: 'offline message', notificationType: 'info' },
      terminal,
    )

    expect(executeNotificationHooks).toHaveBeenCalledTimes(1)
    expect(terminal.notifyBell).toHaveBeenCalledTimes(1)
    expect(terminal.notifyITerm2).not.toHaveBeenCalled()
    expect(terminal.notifyKitty).not.toHaveBeenCalled()
  })

  test('notifications_disabled executes hooks without an OS adapter', async () => {
    saveGlobalConfig(current => ({
      ...current,
      preferredNotifChannel: 'notifications_disabled',
    }))
    const terminal = terminalDouble()

    await sendNotification(
      { message: 'offline message', notificationType: 'info' },
      terminal,
    )

    expect(executeNotificationHooks).toHaveBeenCalledTimes(1)
    expect(terminal.notifyBell).not.toHaveBeenCalled()
    expect(terminal.notifyITerm2).not.toHaveBeenCalled()
  })

  test('Apple Terminal auto sends a compensating bell only when the profile disables it', async () => {
    saveGlobalConfig(current => ({
      ...current,
      preferredNotifChannel: 'auto',
    }))
    env.terminal = 'Apple_Terminal'
    execFileNoThrow.mockImplementation(async (...args: unknown[]) => {
      const command = args[0]
      if (command === 'osascript') {
        return { code: 0, stdout: 'OfflineProfile\n', stderr: '' }
      }
      return {
        code: 0,
        stdout: `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>Window Settings</key><dict><key>OfflineProfile</key><dict><key>Bell</key><false/></dict></dict></dict></plist>`,
        stderr: '',
      }
    })
    const terminal = terminalDouble()

    await sendNotification(
      { message: 'offline message', notificationType: 'info' },
      terminal,
    )

    expect(terminal.notifyBell).toHaveBeenCalledTimes(1)
    expect(terminal.notifyITerm2).not.toHaveBeenCalled()
  })
})

describe('PushNotificationTool adapters', () => {
  test('posts webhook fields and returns webhook delivery', async () => {
    process.env.CLAUDE_NOTIFICATION_WEBHOOK_URL =
      'http://127.0.0.1/offline-webhook'
    axiosPost.mockResolvedValue({ status: 200 })
    const context = toolContext()

    const result = await PushNotificationTool.call(
      { message: 'offline message', title: 'Offline title', url: 'https://example.com' },
      context as never,
    )

    expect(result.data).toEqual({
      message: 'Notification delivered by webhook.',
      deliveredVia: 'webhook',
    })
    const [url, body, config] = axiosPost.mock.calls[0]!
    expect(url).toBe('http://127.0.0.1/offline-webhook')
    expect(body).toEqual({
      text: 'offline message',
      title: 'Offline title',
      url: 'https://example.com',
    })
    expect(config).toMatchObject({
      timeout: 10000,
      signal: context.abortController.signal,
    })
  })

  test('webhook failure does not fall back to the OS adapter', async () => {
    process.env.CLAUDE_NOTIFICATION_WEBHOOK_URL =
      'http://127.0.0.1/offline-webhook'
    axiosPost.mockResolvedValue({ status: 503 })
    const context = toolContext()

    await expect(
      PushNotificationTool.call({ message: 'offline message' }, context as never),
    ).rejects.toThrow('Notification webhook failed (503)')
    expect(context.sendOSNotification).not.toHaveBeenCalled()
  })

  test('uses OS delivery only without a webhook and rejects when no adapter exists', async () => {
    const context = toolContext()
    await expect(
      PushNotificationTool.call(
        { message: 'offline message', title: 'Offline title' },
        context as never,
      ),
    ).resolves.toEqual({
      data: { message: 'Notification sent to the OS.', deliveredVia: 'os' },
    })
    expect(context.sendOSNotification).toHaveBeenCalledWith({
      message: 'Offline title: offline message',
      notificationType: 'info',
    })

    const withoutAdapter = {
      ...toolContext(),
      sendOSNotification: undefined,
    }
    await expect(
      PushNotificationTool.call(
        { message: 'offline message' },
        withoutAdapter as never,
      ),
    ).rejects.toThrow('No notification adapter is configured')
  })
})
