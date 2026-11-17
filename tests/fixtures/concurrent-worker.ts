#!/usr/bin/env bun

/**
 * Worker script for concurrent session write testing
 * This worker uses the real session storage infrastructure to write
 * context collapse snapshots to a shared session.
 */

import { setInterval } from 'node:timers'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

// Add the project root to require path so we can import src modules
import { fileURLToPath } from 'node:url'
const __filename = fileURLToPath(import.meta.url)
const __dirname = resolve(__filename, '..', '..', '..')

// Load environment from the parent process
const workerId = process.env.WORKER_ID || 'unknown'
const sharedSessionId = process.env.SHARED_SESSION_ID || randomUUID()
const tempDir = process.env.TEST_TEMP_DIR
const projectRoot = process.env.TEST_PROJECT_ROOT || __dirname

console.log(`[worker-${workerId}] Starting with session: ${sharedSessionId}`)

// Set up environment
if (tempDir) {
  process.env.CLAUDE_CONFIG_DIR = resolve(tempDir, 'config')
  process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
  process.env.NODE_ENV = 'test'
}

// Import modules from the project
import { switchSession } from resolve(projectRoot, 'src', 'bootstrap', 'state.js')
import { recordTranscript, recordContextCollapseSnapshot, flushSessionStorage, getTranscriptPath, adoptResumedSessionFile } from resolve(projectRoot, 'src', 'utils', 'sessionStorage.js')

// Switch to the shared session
switchSession(sharedSessionId as any, tempDir ? resolve(tempDir, 'project') : undefined)

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
    const writeInterval = setInterval(async () => {
      if (writeCount >= maxWrites) {
        clearInterval(writeInterval)
        await flushSessionStorage()
        console.log(`[worker-${workerId}] Completed ${writeCount} writes`)
        process.send?.({ type: 'done', workerId, writeCount })
        return
      }

      try {
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
      } catch (error) {
        console.error(`[worker-${workerId}] Write error:`, error)
        process.send?.({ type: 'error', workerId, error: String(error) })
      }
    }, 5) // Fast writes to increase concurrency contention
  } catch (error) {
    console.error(`[worker-${workerId}] Fatal error:`, error)
    process.exit(1)
  }
}

runWorker()
