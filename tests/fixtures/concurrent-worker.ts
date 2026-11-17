#!/usr/bin/env bun

/**
 * Worker script for concurrent session write testing
 * This worker uses the real session storage infrastructure to write
 * context collapse snapshots to a shared session.
 */

import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'

// Load environment from the parent process
const workerId = process.env.WORKER_ID || 'unknown'
const sharedSessionId = process.env.SHARED_SESSION_ID || randomUUID()
const testProjectRoot = process.env.TEST_PROJECT_ROOT
const testTempDir = process.env.TEST_TEMP_DIR

if (!testProjectRoot) {
  console.error(`[worker-${workerId}] TEST_PROJECT_ROOT is required`)
  process.exit(1)
}

if (!testTempDir) {
  console.error(`[worker-${workerId}] TEST_TEMP_DIR is required`)
  process.exit(1)
}

console.log(`[worker-${workerId}] Starting with session: ${sharedSessionId}`)

// Set up environment - use temp dir for session files
process.env.CLAUDE_CONFIG_DIR = join(testTempDir, 'config')
process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
process.env.NODE_ENV = 'test'

// Import modules from the project using absolute paths
const { switchSession } = require(join(testProjectRoot, 'src/bootstrap/state.ts'))
const {
  recordTranscript,
  recordContextCollapseSnapshot,
  flushSessionStorage,
} = require(join(testProjectRoot, 'src/utils/sessionStorage.ts'))

// Switch to the shared session - use temp dir for project
switchSession(sharedSessionId as any, join(testTempDir, 'project'))

let writeCount = 0
const maxWrites = 50

// First, ensure the session file exists by writing a transcript
const initMsg = {
  type: 'user',
  uuid: randomUUID(),
  parentUuid: null,
  message: { role: 'user', content: `init from worker ${workerId}` },
  isMeta: false,
}

async function runWorker() {
  try {
    // Initial write to materialize the session file
    console.log(`[worker-${workerId}] Initializing session file...`)
    await recordTranscript([initMsg])
    await flushSessionStorage()

    // Wait a bit for the other worker to also initialize
    await new Promise(r => setTimeout(r, Math.random() * 30))

    // Now write the context collapse snapshots
    for (let i = 0; i < maxWrites; i++) {
      const startUuid = randomUUID()
      const endUuid = randomUUID()

      await recordContextCollapseSnapshot({
        staged: [{
          startUuid,
          endUuid,
          summary: `snapshot-${writeCount} from worker-${workerId}`,
          risk: 0.5,
          stagedAt: Date.now(),
        }],
        armed: writeCount % 2 === 0,
        lastSpawnTokens: 100 + writeCount,
      })

      writeCount++

      // Send progress update
      process.send?.({
        type: 'snapshot',
        workerId,
        writeCount,
        startUuid,
        endUuid,
      })

      // Short random delay to increase chance of interleaving
      await new Promise(r => setTimeout(r, Math.random() * 2))
    }

    await flushSessionStorage()
    console.log(`[worker-${workerId}] Completed ${writeCount} writes`)
    process.send?.({ type: 'done', workerId, writeCount })
    process.exit(0)
  } catch (error) {
    console.error(`[worker-${workerId}] Fatal error:`, error)
    process.exit(1)
  }
}

runWorker()
