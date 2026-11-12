import { afterEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { OpenRunnerClient } from '../src/open-runner/client.js'
import type { OpenRunnerServer } from '../src/open-runner/server.js'
import { startOpenRunnerServer } from '../src/open-runner/server.js'
import { OpenRunnerWorker, runOpenRunnerWorker } from '../src/open-runner/worker.js'

const workerToken = 'worker-token-0123456789abcdef0123456789abcdef'
const adminToken = 'admin-token-abcdef0123456789abcdef0123456789'
const roots = new Set<string>()
const servers = new Set<OpenRunnerServer>()

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'open-runner-worker-'))
  roots.add(root)
  const instance = await startOpenRunnerServer({
    stateDir: join(root, 'server'),
    workerToken,
    adminToken,
    heartbeatIntervalMs: 15,
    leaseMs: 10_000,
    retryBaseMs: 0,
    drainTimeoutMs: 100,
  })
  servers.add(instance)
  return {
    root,
    instance,
    worker: new OpenRunnerClient({ serverUrl: instance.url, token: workerToken }),
    admin: new OpenRunnerClient({ serverUrl: instance.url, token: adminToken }),
  }
}

function fakeChild(script: string) {
  return () => ({ command: process.execPath, args: ['-e', script] })
}

const successfulChild = `
let input='';
process.stdin.on('data', c => input += c);
process.stdin.on('end', () => {
  const crypto = require('crypto');
  console.log(JSON.stringify({type:'assistant',uuid:crypto.randomUUID(),message:{content:[{type:'text',text:'done'}]},secret:process.env.OPEN_RUNNER_SECRET ?? null}));
  console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'ok',input}));
});
`

afterEach(async () => {
  await Promise.all([...servers].map(server => server.stop()))
  servers.clear()
  await Promise.all([...roots].map(root => rm(root, { recursive: true, force: true })))
  roots.clear()
})

describe('Open Runner worker child lifecycle', () => {
  test('persists accepted work, flushes SDK events, then completes', async () => {
    const { root, worker, admin } = await setup()
    const workId = randomUUID()
    await admin.submit({
      work_id: workId,
      input: { prompt: 'perform structured work', cwd: '.', permission_mode: 'default' },
      max_runtime_ms: 5_000,
    })
    const records = await runOpenRunnerWorker({
      client: worker,
      runnerId: randomUUID(),
      workspace: root,
      stateDir: join(root, 'worker'),
      once: true,
      buildChildCommand: fakeChild(successfulChild),
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        OPEN_RUNNER_SECRET: 'must-not-reach-child',
        ANTHROPIC_API_KEY: 'offline-test-placeholder',
      },
    })
    expect(records[0]).toMatchObject({ work_id: workId, state: 'succeeded', attempt: 1 })
    const events = await admin.readEvents(workId)
    expect(events.events.map(event => event.seq)).toEqual(events.events.map((_, index) => index + 1))
    expect(events.events.some(event => event.kind === 'sdk' && (event.message as { type?: string }).type === 'result')).toBeTrue()
    expect(events.events.at(-1)?.message).toMatchObject({ event: 'exit', exit_code: 0 })
    expect(JSON.stringify(events)).not.toContain('must-not-reach-child')
    expect(JSON.stringify(events)).toContain('perform structured work')
    await expect(readFile(join(root, 'worker', 'active-work.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readFile(join(root, 'worker', 'instance.json'), 'utf8')).includes(workerToken)).toBeFalse()
  })

  test('does not treat exit zero or malformed NDJSON as success', async () => {
    const { root, worker, admin } = await setup()
    const workId = randomUUID()
    await admin.submit({
      work_id: workId,
      input: { prompt: 'no result', cwd: '.', permission_mode: 'default' },
      max_attempts: 1,
    })
    const [record] = await runOpenRunnerWorker({
      client: worker, runnerId: randomUUID(), workspace: root, stateDir: join(root, 'worker'), once: true,
      buildChildCommand: fakeChild(`process.stdin.resume(); process.stdin.on('end',()=>{ console.log('not-json'); console.log(JSON.stringify({type:'result',subtype:'success',is_error:false})); process.exit(0); });`),
    })
    expect(record).toMatchObject({ state: 'failed', error: { code: 'CHILD_PROTOCOL_ERROR' } })
    const events = await admin.readEvents(workId)
    expect(events.events.at(-1)?.kind).toBe('process')
  })

  test('interrupts on cancellation and completes as cancelled', async () => {
    const { root, worker, admin } = await setup()
    const workId = randomUUID()
    await admin.submit({
      work_id: workId,
      input: { prompt: 'long work', cwd: '.', permission_mode: 'default' },
      max_runtime_ms: 5_000,
    })
    const running = runOpenRunnerWorker({
      client: worker, runnerId: randomUUID(), workspace: root, stateDir: join(root, 'worker'), once: true,
      buildChildCommand: fakeChild(`process.stdin.resume(); process.stdin.on('end',()=>{ setInterval(()=>{},1000); });`),
    })
    for (let index = 0; index < 100; index++) {
      if ((await admin.getWork(workId)).state === 'running') break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    await admin.cancel(workId, 'test cancellation')
    const [record] = await running
    expect(record).toMatchObject({ state: 'cancelled', cancel_requested: true })
    expect((await admin.readEvents(workId)).events.at(-1)?.kind).toBe('process')
  })

  test('enforces max runtime and never reports timeout as success', async () => {
    const { root, worker, admin } = await setup()
    const workId = randomUUID()
    await admin.submit({
      work_id: workId,
      input: { prompt: 'timeout', cwd: '.', permission_mode: 'default' },
      max_attempts: 5,
      max_runtime_ms: 30,
    })
    const [record] = await runOpenRunnerWorker({
      client: worker, runnerId: randomUUID(), workspace: root, stateDir: join(root, 'worker'), once: true,
      buildChildCommand: fakeChild(`process.stdin.resume(); process.stdin.on('end',()=>{ setInterval(()=>{},1000); });`),
    })
    expect(record).toMatchObject({ state: 'failed', error: { code: 'WORK_TIMEOUT' } })
  })

  test('isolates active-work records for concurrent assignments', async () => {
    const { root, worker, admin } = await setup()
    const workIds = [randomUUID(), randomUUID()]
    for (const workId of workIds) {
      await admin.submit({
        work_id: workId,
        input: { prompt: `work ${workId}`, cwd: '.', permission_mode: 'default' },
        max_runtime_ms: 5_000,
      })
    }
    const stateDir = join(root, 'worker')
    const records = await runOpenRunnerWorker({
      client: worker, runnerId: randomUUID(), workspace: root, stateDir,
      maxWork: 2, once: true,
      buildChildCommand: fakeChild(`console.log(JSON.stringify({type:'assistant',uuid:crypto.randomUUID()})); console.log(JSON.stringify({type:'result',subtype:'success',is_error:false})); process.exit(0);`),
    })
    expect(records.map(record => record.state)).toEqual(['succeeded', 'succeeded'])
    expect(records.map(record => record.work_id).sort()).toEqual(workIds.sort())
    expect((await readdir(stateDir)).filter(name => name.startsWith('active-work'))).toEqual([])
    expect((await admin.readEvents(workIds[0]!)).last_seq).toBeGreaterThan(0)
    expect((await admin.readEvents(workIds[1]!)).last_seq).toBeGreaterThan(0)
  }, 15_000)

  test('refuses to signal a reused PID during recovery', async () => {
    const { root, worker } = await setup()
    const stateDir = join(root, 'worker')
    await mkdir(stateDir, { recursive: true, mode: 0o700 })
    const leaseId = randomUUID()
    await writeFile(join(stateDir, 'active-work.json'), JSON.stringify({
      protocol: 'open-runner-v1',
      assignment: {
        work_id: randomUUID(), session_id: randomUUID(), attempt: 1,
        lease_id: leaseId, lease_expires_at: new Date().toISOString(),
        input: { prompt: 'old', cwd: '.', permission_mode: 'default' }, max_runtime_ms: 1000,
      },
      identity: { runner_id: randomUUID(), instance_id: randomUUID(), worker_epoch: 1, lease_id: leaseId },
      phase: 'prompt_sent', pid: process.pid, start_token: 'not-the-current-process-token',
      connection_generation: 1, prompt_sent: true, delivery_unknown: false,
      pending_event: null, updated_at: new Date().toISOString(),
    }), { mode: 0o600 })
    const recovered = new OpenRunnerWorker({ client: worker, runnerId: randomUUID(), workspace: root, stateDir })
    await expect(recovered.initialize()).rejects.toMatchObject({ code: 'RECOVERY_CONFLICT' })
    expect(process.kill(process.pid, 0)).toBeTrue()
  })

  test('reports prompt delivery uncertainty instead of auto-replaying after reconnect', async () => {
    const { root, worker, admin } = await setup()
    const runnerId = randomUUID()
    const oldInstance = randomUUID()
    const registration = await worker.register({ runner_id: runnerId, instance_id: oldInstance })
    const workId = randomUUID()
    await admin.submit({
      work_id: workId,
      input: { prompt: 'uncertain delivery', cwd: '.', permission_mode: 'default' },
      max_attempts: 3,
    })
    const assignment = (await worker.poll({
      runner_id: runnerId, instance_id: oldInstance, worker_epoch: registration.worker_epoch,
    }, 1, 0)).work[0]!
    const identity = {
      runner_id: runnerId, instance_id: oldInstance,
      worker_epoch: registration.worker_epoch, lease_id: assignment.lease_id,
    }
    await worker.acknowledge(workId, identity)
    const stateDir = join(root, 'worker')
    await mkdir(stateDir, { recursive: true, mode: 0o700 })
    await writeFile(join(stateDir, 'active-work.json'), JSON.stringify({
      protocol: 'open-runner-v1', assignment, identity, phase: 'prompt_sending',
      pid: null, start_token: null, connection_generation: 1,
      prompt_sent: false, delivery_unknown: false, pending_event: null,
      updated_at: new Date().toISOString(),
    }), { mode: 0o600 })
    const recovered = new OpenRunnerWorker({ client: worker, runnerId, workspace: root, stateDir })
    await recovered.initialize()
    expect((await admin.getWork(workId))).toMatchObject({
      state: 'failed', error: { code: 'DELIVERY_UNKNOWN' }, attempt: 1,
    })
    expect((await readdir(stateDir)).includes('active-work.json')).toBeFalse()
  })
})
