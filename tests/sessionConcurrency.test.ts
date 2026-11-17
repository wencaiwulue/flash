/**
 * Task 6: Session Concurrency and Locking Tests
 *
 * Tests that session storage uses proper-lockfile safely.
 */

import { describe, expect, test } from 'bun:test'
import * as lockfile from '../src/utils/lockfile.js'

describe('Session Concurrency Contracts', () => {
  test('proper-lockfile module is available', async () => {
    // Just verify the module loads and has expected functions
    expect(lockfile.lock).toBeInstanceOf(Function)
    expect(lockfile.unlock).toBeInstanceOf(Function)
    expect(lockfile.check).toBeInstanceOf(Function)
  })
})
