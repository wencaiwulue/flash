import { expect, test } from 'bun:test'
import { recoverOrphanedParallelToolResults } from '../src/utils/sessionChainRecovery.ts'

function assistant(uuid: string, id: string, timestamp?: string) {
  return {
    type: 'assistant',
    uuid: uuid as never,
    parentUuid: 'user-root' as never,
    timestamp,
    message: { id },
  }
}

function toolResult(uuid: string, parentUuid: string, timestamp?: string) {
  return {
    type: 'user',
    uuid: uuid as never,
    parentUuid: parentUuid as never,
    timestamp,
    message: { content: [{ type: 'tool_result', tool_use_id: parentUuid }] },
  }
}

test('recovers siblings after the last on-chain anchor with stable order and no unrelated groups', () => {
  const a1 = assistant('a1', 'msg-1', '2026-01-01')
  const a2 = assistant('a2', 'msg-1', '2026-01-01')
  const a3 = assistant('a3', 'msg-1', '2026-01-01')
  const r1 = toolResult('r1', 'a1', '2026-01-01')
  const r2 = toolResult('r2', 'a2', '2026-01-01')
  const unrelated = assistant('x1', 'other', '2020-01-01')
  const unrelatedResult = toolResult('rx', 'x1', '2020-01-01')
  const next = { type: 'user', uuid: 'u2', parentUuid: 'a2', message: { content: 'next' } }
  const messages = new Map([
    ['a1', a1], ['a2', a2], ['a3', a3], ['r1', r1], ['r2', r2],
    ['x1', unrelated], ['rx', unrelatedResult], ['u2', next],
  ])
  const chain = [a1, a2, next]
  const seen = new Set(['a1', 'a2', 'u2'])

  const result = recoverOrphanedParallelToolResults(messages, chain, seen)
  expect(result.recoveredCount).toBe(3)
  expect(result.chain.map(message => message.uuid)).toEqual([
    'a1', 'a2', 'a3', 'r1', 'r2', 'u2',
  ])
  expect(result.chain).not.toContain(unrelated)
  expect(result.chain).not.toContain(unrelatedResult)

  const allSeen = new Set(result.chain.map(message => message.uuid))
  expect(recoverOrphanedParallelToolResults(messages, result.chain, allSeen).recoveredCount).toBe(0)
})
