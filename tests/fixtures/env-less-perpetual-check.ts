import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { join, resolve } from 'path'

const root = resolve(import.meta.dir, '../..')
const configDir = await mkdtemp(join('/tmp', 'claude-env-less-'))
const posts: Array<{ url: string; data: unknown }> = []
const transports: Array<Record<string, unknown>> = []
let bridgeCalls = 0

function transportFor(options: Record<string, unknown>) {
  const callbacks: Record<string, (...args: unknown[]) => void> = {}
  const transport = {
    options,
    callbacks,
    setOnConnect(callback: () => void) {
      callbacks.connect = callback
    },
    setOnData(callback: (data: string) => void) {
      callbacks.data = callback
    },
    setOnClose(callback: (code?: number) => void) {
      callbacks.close = callback
    },
    connect() {},
    close() {},
    isConnectedStatus: () => true,
    getStateLabel: () => 'connected',
    getLastSequenceNum: () => 42,
    droppedBatchCount: 0,
    write: async () => {},
    writeBatch: async () => {},
    reportState: () => {},
    reportMetadata: () => {},
    reportDelivery: () => {},
    flush: async () => {},
  }
  transports.push(transport)
  return transport
}

mock.module('axios', () => ({
  default: {
    post: async (url: string, data: unknown) => {
      posts.push({ url, data })
      if (url.endsWith('/v1/code/sessions')) {
        return { status: 201, data: { session: { id: 'cse_test' } } }
      }
      if (url.endsWith('/bridge')) {
        bridgeCalls++
        return {
          status: 200,
          data: {
            worker_jwt: `jwt-${bridgeCalls}`,
            api_base_url: 'https://example.invalid',
            expires_in: 3600,
            worker_epoch: bridgeCalls,
          },
        }
      }
      return { status: 200, data: {} }
    },
    isAxiosError: () => false,
  },
}))
mock.module(resolve(root, 'src/bridge/replBridgeTransport.ts'), () => ({
  createV2ReplTransport: async (options: Record<string, unknown>) =>
    transportFor(options),
}))
mock.module(resolve(root, 'src/bridge/envLessBridgeConfig.ts'), () => ({
  getEnvLessBridgeConfig: async () => ({
    init_retry_max_attempts: 1,
    init_retry_base_delay_ms: 1,
    init_retry_jitter_fraction: 0,
    init_retry_max_delay_ms: 1,
    http_timeout_ms: 10,
    uuid_dedup_buffer_size: 100,
    heartbeat_interval_ms: 1000,
    heartbeat_jitter_fraction: 0,
    token_refresh_buffer_ms: 1000,
    teardown_archive_timeout_ms: 10,
    connect_timeout_ms: 10,
    min_version: '1.0.0',
    should_show_app_upgrade_message: false,
  }),
}))
const actualEnv = await import(resolve(root, 'src/utils/envUtils.ts'))
mock.module(resolve(root, 'src/utils/envUtils.ts'), () => ({
  ...actualEnv,
  getClaudeConfigHomeDir: () => configDir,
}))

async function init(cwd: string) {
  const { initEnvLessBridgeCore } = await import(
    resolve(root, 'src/bridge/remoteBridgeCore.ts')
  )
  return initEnvLessBridgeCore({
    baseUrl: 'https://example.invalid',
    orgUUID: 'org-test',
    title: 'test',
    getAccessToken: () => 'oauth-test',
    toSDKMessages: () => [],
    initialHistoryCap: 0,
    perpetual: true,
    cwd,
  })
}

try {
  const cwd = join(configDir, 'project')
  const first = await init(cwd)
  assert.equal(first?.bridgeSessionId, 'cse_test')
  assert.equal(posts.filter(post => post.url.endsWith('/v1/code/sessions')).length, 1)
  await first?.teardown()
  assert.equal(posts.some(post => post.url.endsWith('/archive')), false)

  const second = await init(cwd)
  assert.equal(second?.bridgeSessionId, 'cse_test')
  assert.equal(posts.filter(post => post.url.endsWith('/v1/code/sessions')).length, 1)
  assert.equal(transports[1]?.options.initialSequenceNum, 42)
  await second?.archive()
  assert.equal(posts.some(post => post.url.endsWith('/archive')), true)
  const { readEnvLessBridgePointer } = await import(
    resolve(root, 'src/bridge/envLessBridgePointer.ts')
  )
  assert.equal(await readEnvLessBridgePointer(cwd), null)

  posts.length = 0
  transports.length = 0
  bridgeCalls = 0
  const recoveryCwd = join(configDir, 'project-401')
  const handle = await init(recoveryCwd)
  assert.notEqual(handle, null)
  const close = transports[0]!.callbacks.close as (code: number) => void
  close(401)
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(bridgeCalls, 2)
  assert.equal(transports[1]?.options.initialSequenceNum, 42)
  await handle?.archive()
  console.log('ENV_LESS_PERPETUAL_OK')
} finally {
  await rm(configDir, { recursive: true, force: true })
}
