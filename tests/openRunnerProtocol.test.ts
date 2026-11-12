import { afterEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { OpenRunnerClient } from '../src/open-runner/client.js'
import { readTokenFile, validateRelativeCwd } from '../src/open-runner/protocol.js'
import { OpenRunnerServer, startOpenRunnerServer } from '../src/open-runner/server.js'

const roots = new Set<string>()
const servers = new Set<OpenRunnerServer>()
const workerToken = 'worker-token-0123456789abcdef0123456789abcdef'
const adminToken = 'admin-token-abcdef0123456789abcdef0123456789'

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'open-runner-protocol-'))
  roots.add(value)
  return value
}

async function server(leaseMs = 30_000): Promise<OpenRunnerServer> {
  const stateDir = join(await root(), 'state')
  const instance = await startOpenRunnerServer({
    stateDir,
    workerToken,
    adminToken,
    leaseMs,
    heartbeatIntervalMs: 10,
    retryBaseMs: 0,
    drainTimeoutMs: 100,
  })
  servers.add(instance)
  return instance
}

function clients(instance: OpenRunnerServer) {
  return {
    worker: new OpenRunnerClient({ serverUrl: instance.url, token: workerToken }),
    admin: new OpenRunnerClient({ serverUrl: instance.url, token: adminToken }),
  }
}

afterEach(async () => {
  await Promise.all([...servers].map(instance => instance.stop()))
  servers.clear()
  await Promise.all([...roots].map(path => rm(path, { recursive: true, force: true })))
  roots.clear()
})

describe('open-runner-v1 reference protocol', () => {
  test('authenticates scopes and completes an idempotent leased lifecycle', async () => {
    const instance = await server()
    const { worker, admin } = clients(instance)
    const health = await fetch(`${instance.url}/open-runner/v1/health`).then(r => r.json())
    expect(health.protocol).toBe('open-runner-v1')
    expect((await fetch(`${instance.url}/open-runner/v1/work`)).status).toBe(401)
    expect((await fetch(`${instance.url}/open-runner/v1/work`, {
      headers: { authorization: `Bearer ${workerToken}` },
    })).status).toBe(403)

    const runnerId = randomUUID()
    const instanceId = randomUUID()
    const registration = await worker.register({ runner_id: runnerId, instance_id: instanceId })
    const identity = {
      runner_id: runnerId,
      instance_id: instanceId,
      worker_epoch: registration.worker_epoch,
    }
    const workId = randomUUID()
    const body = { work_id: workId, input: { prompt: 'review this', cwd: '.', permission_mode: 'default' } }
    const submitted = await admin.submit(body)
    expect(submitted.state).toBe('queued')
    expect((await admin.submit(body)).created_at).toBe(submitted.created_at)
    await expect(admin.submit({ ...body, input: { ...body.input, prompt: 'different' } })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })

    const assignment = (await worker.poll(identity, 1, 0)).work[0]!
    expect(assignment.attempt).toBe(1)
    expect((await worker.poll(identity, 1, 0)).work).toHaveLength(0)
    const lease = { ...identity, lease_id: assignment.lease_id }
    expect((await worker.acknowledge(workId, lease)).state).toBe('running')
    expect((await worker.acknowledge(workId, lease)).state).toBe('running')
    expect(Date.parse((await worker.heartbeat(workId, lease)).lease_expires_at)).toBeGreaterThan(Date.now())

    const event = {
      event_id: randomUUID(), kind: 'sdk' as const,
      occurred_at: new Date().toISOString(), message: { type: 'assistant', uuid: randomUUID() },
    }
    const accepted = await worker.appendEvents(workId, lease, [event])
    expect(accepted.accepted[0]!.seq).toBe(1)
    expect((await worker.appendEvents(workId, lease, [event])).accepted[0]!.seq).toBe(1)
    await expect(worker.appendEvents(workId, lease, [{ ...event, message: { changed: true } }])).rejects.toMatchObject({ code: 'EVENT_ID_CONFLICT' })
    const replay = await admin.readEvents(workId, 0, 1)
    expect(replay.events[0]).toMatchObject({ seq: 1, event_id: event.event_id })
    expect(replay.has_more).toBeFalse()

    expect((await worker.complete(workId, lease, { outcome: 'succeeded', result: { ok: true } })).state).toBe('succeeded')
    expect((await worker.complete(workId, lease, { outcome: 'succeeded', result: { ok: true } })).state).toBe('succeeded')
    await expect(worker.complete(workId, lease, { outcome: 'failed' })).rejects.toMatchObject({ code: 'TERMINAL_CONFLICT' })
  })

  test('expires leases, fences epochs and persists events across restart', async () => {
    const instance = await server(500)
    const { worker, admin } = clients(instance)
    const runnerId = randomUUID()
    const oldInstance = randomUUID()
    const registration = await worker.register({ runner_id: runnerId, instance_id: oldInstance })
    const oldIdentity = { runner_id: runnerId, instance_id: oldInstance, worker_epoch: registration.worker_epoch }
    const workId = randomUUID()
    await admin.submit({ work_id: workId, input: { prompt: 'retry', cwd: '.', permission_mode: 'default' }, max_attempts: 2 })
    const assignment = (await worker.poll(oldIdentity, 1, 0)).work[0]!
    await worker.acknowledge(workId, { ...oldIdentity, lease_id: assignment.lease_id })
    const event = { event_id: randomUUID(), kind: 'log' as const, occurred_at: new Date().toISOString(), message: { line: 'persisted' } }
    await worker.appendEvents(workId, { ...oldIdentity, lease_id: assignment.lease_id }, [event])
    await new Promise(resolve => setTimeout(resolve, 600))
    expect((await admin.getWork(workId)).state).toBe('retry_wait')
    await expect(worker.heartbeat(workId, { ...oldIdentity, lease_id: assignment.lease_id })).rejects.toMatchObject({ code: 'STALE_LEASE' })

    const nextInstance = randomUUID()
    const nextRegistration = await worker.register({ runner_id: runnerId, instance_id: nextInstance })
    expect(nextRegistration.worker_epoch).toBe(registration.worker_epoch + 1)
    const nextIdentity = { runner_id: runnerId, instance_id: nextInstance, worker_epoch: nextRegistration.worker_epoch }
    const retry = (await worker.poll(nextIdentity, 1, 0)).work[0]!
    expect(retry.attempt).toBe(2)
    expect(retry.lease_id).not.toBe(assignment.lease_id)
    await expect(worker.appendEvents(workId, { ...oldIdentity, lease_id: assignment.lease_id }, [])).rejects.toMatchObject({ code: 'STALE_WORKER_EPOCH' })

    const stateDir = instance.serverInfo.state_dir
    await instance.stop()
    servers.delete(instance)
    const restarted = await startOpenRunnerServer({ stateDir, workerToken, adminToken, retryBaseMs: 0 })
    servers.add(restarted)
    const restartedClients = clients(restarted)
    expect((await restartedClients.admin.readEvents(workId)).events[0]).toMatchObject(event)
    expect((await restartedClients.admin.getWork(workId)).attempt).toBe(2)
  })

  test('cancels queued work and validates token files and paths', async () => {
    const instance = await server()
    const { admin } = clients(instance)
    const workId = randomUUID()
    await admin.submit({ work_id: workId, input: { prompt: 'stop', cwd: '.', permission_mode: 'default' } })
    expect((await admin.cancel(workId, 'operator request')).state).toBe('cancelled')
    expect((await admin.cancel(workId)).state).toBe('cancelled')
    expect(() => validateRelativeCwd('../escape')).toThrow()
    expect(() => validateRelativeCwd('/absolute')).toThrow()
    expect(() => validateRelativeCwd('safe/../escape')).toThrow()

    const directory = await root()
    const tokenPath = join(directory, 'token')
    await writeFile(tokenPath, `${workerToken}\n`, { mode: 0o600 })
    expect(await readTokenFile(tokenPath)).toBe(workerToken)
    await chmod(tokenPath, 0o644)
    await expect(readTokenFile(tokenPath)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await chmod(tokenPath, 0o600)
    await writeFile(tokenPath, 'too-short\n')
    await expect(readTokenFile(tokenPath)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  test('refuses non-loopback HTTP and corrupt persisted state', async () => {
    const directory = await root()
    await expect(startOpenRunnerServer({
      stateDir: join(directory, 'remote'), host: '0.0.0.0', workerToken, adminToken,
    })).rejects.toThrow('loopback')
    expect(() => new OpenRunnerClient({ serverUrl: 'http://example.com', token: workerToken })).toThrow('TLS')

    const stateDir = join(directory, 'state')
    const instance = await startOpenRunnerServer({ stateDir, workerToken, adminToken })
    await instance.stop()
    await writeFile(join(stateDir, 'state.json'), '{broken')
    await expect(startOpenRunnerServer({ stateDir, workerToken, adminToken })).rejects.toThrow('corrupt')
    const lock = await readFile(join(stateDir, 'locks', 'server.lock'), 'utf8').catch(() => '')
    expect(lock).toBe('')
  })

  test('honors Retry-After with the same registration identity', async () => {
    const delays: number[] = []
    const urls: string[] = []
    let calls = 0
    const runnerId = randomUUID()
    const instanceId = randomUUID()
    const fetchMock = async (input: string | URL | Request) => {
      calls++
      urls.push(String(input))
      if (calls === 1) {
        return new Response(JSON.stringify({
          protocol: 'open-runner-v1',
          error: { code: 'RATE_LIMITED', message: 'retry', retryable: true, details: {} },
          request_id: randomUUID(),
        }), { status: 503, headers: { 'retry-after': '1', 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({
        protocol: 'open-runner-v1', runner_id: runnerId, instance_id: instanceId,
        worker_epoch: 1, heartbeat_interval_ms: 10000, lease_ms: 30000,
        server_time: new Date().toISOString(),
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const client = new OpenRunnerClient({
      serverUrl: 'http://127.0.0.1:9999', token: workerToken,
      fetch: fetchMock as typeof fetch, maxRetries: 1,
      random: () => 1, sleep: async ms => { delays.push(ms) },
    })
    const registration = await client.register({ runner_id: runnerId, instance_id: instanceId })
    expect(registration.worker_epoch).toBe(1)
    expect(calls).toBe(2)
    expect(delays).toEqual([1000])
    expect(urls.every(url => !url.includes(workerToken))).toBeTrue()
  })

  test('drain rejects an in-flight long poll without corrupting the store', async () => {
    const instance = await server()
    const worker = new OpenRunnerClient({ serverUrl: instance.url, token: workerToken, maxRetries: 0 })
    const registration = await worker.register({ runner_id: randomUUID(), instance_id: randomUUID() })
    const polling = worker.poll({
      runner_id: registration.runner_id,
      instance_id: registration.instance_id,
      worker_epoch: registration.worker_epoch,
    }, 1, 25_000)
    const stateDir = instance.serverInfo.state_dir
    const drained = polling.then(() => null, error => error as unknown)
    await new Promise(resolve => setTimeout(resolve, 50))
    await instance.stop()
    expect(await drained).toMatchObject({ code: 'SERVER_DRAINING' })
    const state = JSON.parse(await readFile(join(stateDir, 'state.json'), 'utf8'))
    expect(state.protocol).toBe('open-runner-v1')
  }, 15_000)
})
