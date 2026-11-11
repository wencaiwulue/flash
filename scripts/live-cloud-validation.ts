import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { enableConfigs } from '../src/utils/config.js'
import { getClaudeAIOAuthTokens } from '../src/utils/auth.js'
import { getOrganizationUUID } from '../src/services/oauth/client.js'
import { getOauthConfig } from '../src/constants/oauth.js'
import { initEnvLessBridgeCore } from '../src/bridge/remoteBridgeCore.js'
import { toSDKMessages } from '../src/utils/messages/mappers.js'
import { runFilePersistence } from '../src/utils/filePersistence/filePersistence.js'
import { createUserMessage } from '../src/utils/messages.js'
import { runCleanupFunctions } from '../src/utils/cleanupRegistry.js'

const cwd = await mkdtemp(join('/tmp', 'flash-cloud-live-'))
const token = getClaudeAIOAuthTokens()?.accessToken
if (!token) {
  console.log('CLOUD_LIVE_SKIPPED')
} else {
  const orgUUID = process.env.CLAUDE_CODE_ORG_UUID ?? (await getOrganizationUUID())
  if (!orgUUID) throw new Error('Organization UUID is required')
  const baseUrl = process.env.CLAUDE_CODE_BASE_URL ?? getOauthConfig().BASE_API_URL

  function params(sessionCwd: string) {
  return {
    baseUrl,
    orgUUID,
    title: 'flash-live-validation',
    getAccessToken: () => token,
    toSDKMessages,
    initialHistoryCap: 0,
    perpetual: true,
    cwd: sessionCwd,
  }
}

try {
  enableConfigs()
  const first = await initEnvLessBridgeCore(params(cwd))
  if (!first) throw new Error('Initial bridge session creation failed')
  first.writeSdkMessages([
    createUserMessage({ content: 'Cloud live validation', sessionId: first.bridgeSessionId }),
  ])
  await first.teardown()

  const second = await initEnvLessBridgeCore(params(cwd))
  if (!second) throw new Error('Bridge session resume failed')
  if (second.bridgeSessionId !== first.bridgeSessionId) {
    throw new Error('Perpetual resume created a different session')
  }
  process.env.CLAUDE_CODE_REMOTE_SESSION_ID = second.bridgeSessionId
  process.env.CLAUDE_CODE_ENVIRONMENT_KIND = 'byoc'
  await mkdir(join(cwd, 'nested'), { recursive: true })
  await writeFile(join(cwd, 'nested', 'live.txt'), 'cloud validation')
  const persisted = await runFilePersistence(new Date(0), new AbortController().signal)
  if (!persisted || persisted.files.length === 0) {
    throw new Error('Cloud Files did not return a persisted file')
  }
  await second.archive()
  console.log('CLOUD_LIVE_OK')
} finally {
  await runCleanupFunctions()
  await rm(cwd, { recursive: true, force: true })
}
}
