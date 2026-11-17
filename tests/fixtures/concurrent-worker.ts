#!/usr/bin/env bun

/**
 * Worker script for concurrent session write testing
 * This worker uses the real session storage infrastructure to write
 * context collapse snapshots to a shared session.
 */

// IMPORTANT: This worker MUST be spawned with cwd set to project root!

import { setInterval } from 'node:timers'
import { randomUUID } from 'node:crypto'

// Load environment from the parent process
const workerId = process.env.WORKER_ID || 'unknown'
const sharedSessionId = process.env.SHARED_SESSION_ID || randomUUID()
const tempDir = process.env.TEST_TEMP_DIR

console.log(`[worker-${workerId}] Starting with session: ${sharedSessionId}`)

// Set up environment
if (tempDir) {
  process.env.CLAUDE_CONFIG_DIR = require('node:path').join(tempDir, 'config')
  process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
  process.env.NODE_ENV = 'test'
}

// Import modules from the project using relative paths (cwd must be project root)
const { switchSession } = require('./src/bootstrap/state.ts')
const {
  recordTranscript,
  recordContextCollapseSnapshot,
  flushSessionStorage,
} = require('./src/utils/sessionStorage.ts')

// Switch to the shared session
switchSession(sharedSessionId as any, tempDir ? require('node:path').join(tempDir, 'project') : undefined)

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
    await new Promise(r => setTimeout(r, 50))

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

      // Very short delay to increase chance of interleaving
      await new Promise(r => setTimeout(r, 1))
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
