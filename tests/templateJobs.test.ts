import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { randomUUID } from 'crypto'
import { EventEmitter } from 'events'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { createTemplateJob, replyToJob } from '../src/jobs/operations.js'
import { resolveTemplate } from '../src/jobs/discovery.js'
import type { JobClassification } from '../src/jobs/schema.js'
import {
  getJobPaths,
  readJob,
  readJobState,
  resolveJobId,
  withJobLock,
  writeJobState,
} from '../src/jobs/state.js'
import { runJobSupervisor, spawnSupervisorProcess } from '../src/jobs/supervisor.js'
import { loadMarkdownFilesForSubdir } from '../src/utils/markdownConfigLoader.js'

const roots = new Set<string>()
const previousConfig = process.env.CLAUDE_CONFIG_DIR
const previousHome = process.env.HOME
const previousNative = process.env.CLAUDE_CODE_USE_NATIVE_FILE_SEARCH

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'local-template-jobs-'))
  roots.add(root)
  const config = join(root, 'config')
  const cwd = join(root, 'project')
  await mkdir(join(config, 'templates'), { recursive: true })
  await mkdir(join(cwd, '.claude', 'templates'), { recursive: true })
  process.env.CLAUDE_CONFIG_DIR = config
  process.env.HOME = join(root, 'home')
  await mkdir(process.env.HOME, { recursive: true, mode: 0o700 })
  process.env.CLAUDE_CODE_USE_NATIVE_FILE_SEARCH = '1'
  loadMarkdownFilesForSubdir.cache.clear()
  return { root, config, cwd }
}

beforeEach(() => loadMarkdownFilesForSubdir.cache.clear())

afterEach(async () => {
  loadMarkdownFilesForSubdir.cache.clear()
  await Promise.all([...roots].map(root => rm(root, { recursive: true, force: true })))
  roots.clear()
  if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfig
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  if (previousNative === undefined) delete process.env.CLAUDE_CODE_USE_NATIVE_FILE_SEARCH
  else process.env.CLAUDE_CODE_USE_NATIVE_FILE_SEARCH = previousNative
  delete process.env.CLAUDE_JOB_DIR
})

const noSpawn = async () => ({ pid: 999_999, startToken: null })

function completedClassification(generation: number): JobClassification {
  return {
    category: 'completed', summary: 'Structured result', confidence: 1,
    question: null, evidence: { assistant_message_uuids: [], tool_use_ids: [] },
    classified_at: new Date().toISOString(), generation, model: 'fake-structured-model', status: 'ok',
  }
}

function fakeChild(script: string) {
  return () => ({ command: process.execPath, args: ['-e', script] })
}

describe('local-template-jobs-v1', () => {
  test('uses loader priority, validates cwd and freezes the selected template', async () => {
    const { config, cwd, root } = await fixture()
    await writeFile(join(config, 'templates', 'same.md'), '---\ndescription: user template\n---\nuser {{args}}\n')
    await writeFile(join(cwd, '.claude', 'templates', 'same.md'), '---\ndescription: project template\n---\nproject\n')
    const selected = await resolveTemplate('same', cwd)
    expect(selected.snapshot.body).toBe('user {{args}}\n')
    expect(selected.snapshot.config.description).toBe('user template')

    await writeFile(join(cwd, '.claude', 'templates', 'escape.md'), '---\ncwd: ..\n---\nno escape\n')
    loadMarkdownFilesForSubdir.cache.clear()
    await expect(resolveTemplate('escape', cwd)).rejects.toMatchObject({ code: 'TEMPLATE_INVALID' })
    const outside = join(root, 'outside')
    await mkdir(outside)
    await symlink(outside, join(cwd, 'linked'))
    await writeFile(join(cwd, '.claude', 'templates', 'symlink.md'), '---\ncwd: linked\n---\nno escape\n')
    loadMarkdownFilesForSubdir.cache.clear()
    await expect(resolveTemplate('symlink', cwd)).rejects.toMatchObject({ code: 'TEMPLATE_INVALID' })
    await writeFile(join(cwd, '.claude', 'templates', 'bad.md'), '---\ndescription: [not, scalar]\n---\ninvalid\n')
    loadMarkdownFilesForSubdir.cache.clear()
    await expect(resolveTemplate('bad', cwd)).rejects.toMatchObject({ code: 'TEMPLATE_INVALID' })
  })

  test('persists request/reply idempotency, busy state and immutable snapshots', async () => {
    const { config, cwd } = await fixture()
    const templatePath = join(config, 'templates', 'review.md')
    await writeFile(templatePath, '---\nmodel: inherit\npermission-mode: plan\nallowed-tools: Read, Grep\n---\nReview {{args}}\n')
    const requestId = randomUUID()
    let launches = 0
    const deps = { spawnSupervisor: async () => { launches++; return noSpawn() } }
    const created = await createTemplateJob({ template: 'review', prompt: 'change A', requestId, cwd }, deps)
    expect(created.state.status).toBe('queued')
    expect(launches).toBe(1)
    const replay = await createTemplateJob({ template: 'review', prompt: 'change A', requestId, cwd }, deps)
    expect(replay.job.job_id).toBe(created.job.job_id)
    expect(launches).toBe(1)
    await expect(createTemplateJob({ template: 'review', prompt: 'change B', requestId, cwd }, deps)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
    expect((await resolveJobId(created.job.job_id.slice(0, 12))).endsWith(created.job.job_id)).toBeTrue()

    await writeFile(templatePath, '---\npermission-mode: default\n---\nEdited later\n')
    expect((await readJob(created.jobDirectory)).template.body).toBe('Review {{args}}\n')
    const waiting = await readJobState(created.jobDirectory)
    await writeJobState(created.jobDirectory, { ...waiting, status: 'waiting_for_input', pid: null, ended_at: new Date().toISOString(), exit_code: 0 })
    const replyId = randomUUID()
    const accepted = await replyToJob({ jobId: created.job.job_id, prompt: 'continue', replyId }, deps)
    expect(accepted.state).toMatchObject({ status: 'running', generation: 2, active_reply_id: replyId })
    expect(launches).toBe(2)
    const acceptedReplay = await replyToJob({ jobId: created.job.job_id, prompt: 'continue', replyId }, deps)
    expect(acceptedReplay.reply.prompt_hash).toBe(accepted.reply.prompt_hash)
    expect(launches).toBe(2)
    await expect(replyToJob({ jobId: created.job.job_id, prompt: 'different', replyId }, deps)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
    await expect(replyToJob({ jobId: created.job.job_id, prompt: 'parallel' }, deps)).rejects.toMatchObject({ code: 'JOB_BUSY' })
    const files = await readdir(created.jobDirectory)
    expect(files.some(file => file.endsWith('.tmp'))).toBeFalse()
  })

  test('records spawn failure instead of a false running job', async () => {
    const { config, cwd } = await fixture()
    await writeFile(join(config, 'templates', 'review.md'), 'Review\n')
    let jobId = ''
    await expect(createTemplateJob({ template: 'review', cwd }, {
      spawnSupervisor: async () => { throw new Error('injected spawn failure') },
    })).rejects.toMatchObject({ code: 'SPAWN_FAILED', details: { job_id: expect.any(String) } })
    const requestDirs = await readdir(join(config, 'jobs'))
    const id = requestDirs.find(name => name.length === 36)
    jobId = id!
    expect((await readJobState(join(config, 'jobs', jobId))).status).toBe('failed')
  })

  test('preserves an explicitly empty supervisor script args override', async () => {
    const { config, cwd } = await fixture()
    await writeFile(join(config, 'templates', 'review.md'), 'Review\n')
    const created = await createTemplateJob(
      { template: 'review', cwd },
      { spawnSupervisor: noSpawn },
    )
    const child = Object.assign(new EventEmitter(), {
      pid: 999_998,
      unref: () => {},
    })
    const spawnProcess = mock((..._args: unknown[]) => {
      queueMicrotask(() => child.emit('spawn'))
      return child
    })
    await spawnSupervisorProcess(created.jobDirectory, null, {
      scriptArgs: [],
      spawnProcess: spawnProcess as never,
    })
    expect(spawnProcess).toHaveBeenCalledWith(
      process.execPath,
      ['template-job-supervisor', created.jobDirectory],
      expect.objectContaining({ detached: true }),
    )
  })

  test('runs a real fake child and falls back to waiting when classification is unavailable', async () => {
    const { config, cwd } = await fixture()
    await writeFile(join(config, 'templates', 'review.md'), 'Review {{args}}\n')
    const created = await createTemplateJob({ template: 'review', prompt: 'this change', cwd }, { spawnSupervisor: noSpawn })
    const final = await runJobSupervisor(created.jobDirectory, {
      env: { ...process.env, CLAUDE_JOB_DIR: created.jobDirectory },
      buildChildCommand: fakeChild(`console.log(JSON.stringify({type:'assistant',uuid:crypto.randomUUID()})); console.log(JSON.stringify({type:'result',subtype:'success'}));`),
    })
    expect(final).toMatchObject({ status: 'waiting_for_input', exit_code: 0, classification: { status: 'unavailable' } })
    const child = JSON.parse(await readFile(getJobPaths(created.jobDirectory).child, 'utf8'))
    expect(child.exit_code).toBe(0)
    expect(child.argv.at(-1)).toBe('<prompt>')
    const lines = (await readFile(getJobPaths(created.jobDirectory).transcript, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(lines.map(line => line.seq)).toEqual(lines.map((_, index) => index + 1))
    expect(lines.some(line => line.direction === 'inbound' && line.kind === 'sdk')).toBeTrue()
    expect(lines[0].payload.prompt).toBe('Review this change\n')
  })

  test('resumes the same session for replies and lets nonzero exit override classification', async () => {
    const { config, cwd } = await fixture()
    await writeFile(join(config, 'templates', 'review.md'), 'Review\n')
    const created = await createTemplateJob({ template: 'review', cwd }, { spawnSupervisor: noSpawn })
    const classifyAndExit = (exitCode: number) => `
      const fs=require('fs'); const path=require('path'); const dir=process.env.CLAUDE_JOB_DIR;
      const file=path.join(dir,'state.json'); const state=JSON.parse(fs.readFileSync(file,'utf8'));
      state.classification=${JSON.stringify(completedClassification(1))}; state.classification.generation=state.generation;
      const tmp=file+'.child-tmp'; fs.writeFileSync(tmp,JSON.stringify(state)); fs.renameSync(tmp,file);
      console.log(JSON.stringify({type:'result',subtype:'success'})); process.exit(${exitCode});
    `
    const first = await runJobSupervisor(created.jobDirectory, {
      env: { ...process.env, CLAUDE_JOB_DIR: created.jobDirectory },
      buildChildCommand: fakeChild(classifyAndExit(1)),
    })
    expect(first).toMatchObject({ status: 'failed', exit_code: 1, last_error: { code: 'CHILD_EXIT' } })

    const second = await createTemplateJob({ template: 'review', cwd }, { spawnSupervisor: noSpawn })
    let seenArgv: string[] = []
    const initial = await runJobSupervisor(second.jobDirectory, {
      env: { ...process.env, CLAUDE_JOB_DIR: second.jobDirectory },
      buildChildCommand: fakeChild(classifyAndExit(0)),
    })
    expect(initial.status).toBe('completed')
    const reply = await replyToJob({ jobId: second.job.job_id, prompt: 'follow up' }, { spawnSupervisor: noSpawn })
    const final = await runJobSupervisor(second.jobDirectory, {
      env: { ...process.env, CLAUDE_JOB_DIR: second.jobDirectory },
      buildChildCommand: context => {
        seenArgv = context.argv
        return fakeChild(classifyAndExit(0))(context)
      },
    })
    expect(final.status).toBe('completed')
    expect(seenArgv).toContain('--resume')
    expect(seenArgv[seenArgv.indexOf('--resume') + 1]).toBe(second.job.session_id)
    expect(seenArgv.at(-1)).toBe('follow up')
    expect((await readFile(getJobPaths(second.jobDirectory).transcript, 'utf8')).includes('follow up')).toBeTrue()
    expect(reply.state.generation).toBe(2)
  })

  test('reports corrupt state and serializes writers under the job lock', async () => {
    const { config, cwd } = await fixture()
    await writeFile(join(config, 'templates', 'review.md'), 'Review\n')
    const created = await createTemplateJob({ template: 'review', cwd }, { spawnSupervisor: noSpawn })
    const order: number[] = []
    await Promise.all([
      withJobLock(created.jobDirectory, async () => { order.push(1); await new Promise(resolve => setTimeout(resolve, 20)); order.push(2) }),
      withJobLock(created.jobDirectory, async () => { order.push(3) }),
    ])
    expect([[1, 2, 3], [3, 1, 2]]).toContainEqual(order)
    await writeFile(getJobPaths(created.jobDirectory).state, '{broken')
    await expect(readJobState(created.jobDirectory)).rejects.toMatchObject({ code: 'JOB_CORRUPT' })
  })
})
