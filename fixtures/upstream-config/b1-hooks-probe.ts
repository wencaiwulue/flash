/**
 * B1 hooks 黑盒实测 probe（上游 2.1.311 原生二进制）。
 *
 * 对六个事件逐一记录 stdin payload、stdout 决策与 exit code 行为：
 *   UserPromptExpansion / PostToolBatch / MessageDisplay /
 *   DirectoryAdded / PreModelSwitch / PostModelSwitch
 *
 * 隔离：每次运行使用临时 HOME + CLAUDE_CONFIG_DIR + project，
 * 仅继承 ANTHROPIC_* 后端环境，不读写用户真实配置。
 *
 * 用法：
 *   bun fixtures/upstream-config/b1-hooks-probe.ts <event> [mode]
 *   bun fixtures/upstream-config/b1-hooks-probe.ts all
 *
 * 结果写入 fixtures/upstream-config/2.1.311/probes/b1-<event>.json。
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const UPSTREAM = process.env.UPSTREAM_BIN ?? '/tmp/flash-upstream-2.1.311.hQPPEu/native/package/claude'
const OUT_DIR = join(import.meta.dir, '2.1.311', 'probes')
const NODE = process.execPath // bun 亦可执行记录器（兼容 node API）

/** 通用 hook 记录器：读 stdin 追加到 <out>/<event>.stdin.jsonl，按 RECORDER_MODE 决策。 */
const RECORDER = `
const fs=require('fs'),path=require('path');
const [event,out]=process.argv.slice(2);
let buf='';
process.stdin.on('data',d=>buf+=d);
process.stdin.on('end',()=>{
  fs.mkdirSync(out,{recursive:true});
  fs.appendFileSync(path.join(out,event+'.stdin.jsonl'),buf+'\\n');
  const mode=process.env.RECORDER_MODE||'record';
  const hso=(o)=>({hookSpecificOutput:{hookEventName:event,...o}});
  const sleep=(ms)=>{const t=Date.now()+ms;while(Date.now()<t){}};
  switch(mode){
    case 'record': process.exit(0); break;
    case 'context': process.stdout.write(JSON.stringify(hso({additionalContext:'PROBE_CONTEXT'})));process.exit(0);break;
    case 'block': process.stderr.write('PROBE_BLOCKED');process.exit(2);break;
    case 'display': process.stdout.write(JSON.stringify(hso({displayContent:'PROBE_DISPLAY'})));process.exit(0);break;
    case 'deny': process.stdout.write(JSON.stringify(hso({permissionDecision:'deny',permissionDecisionReason:'PROBE_DENY'})));process.exit(0);break;
    case 'ask': process.stdout.write(JSON.stringify(hso({permissionDecision:'ask',permissionDecisionReason:'PROBE_ASK'})));process.exit(0);break;
    case 'allow': process.stdout.write(JSON.stringify(hso({permissionDecision:'allow'})));process.exit(0);break;
    case 'badjson': process.stdout.write('not-json{');process.exit(0);break;
    case 'exit1': process.stderr.write('PROBE_ERR');process.exit(1);break;
    case 'slow': sleep(Number(process.env.RECORDER_SLEEP||'35000'));process.exit(0);break;
    default: process.exit(0);
  }
});
`

type ProbeResult = { event: string; cases: unknown[] }

function setup(event: string, mode: string, extra: { sleep?: string } = {}) {
  const home = mkdtempSync(join(tmpdir(), `b1-${event}-`))
  const configDir = join(home, '.claude')
  const project = join(home, 'project')
  const out = join(home, 'out')
  mkdirSync(configDir, { recursive: true })
  mkdirSync(project, { recursive: true })
  mkdirSync(out, { recursive: true })
  const recorderPath = join(home, 'recorder.js')
  writeFileSync(recorderPath, RECORDER)
  // 预写全局 config（CLAUDE_CONFIG_DIR/.claude.json）：跳过 onboarding 与 trust 对话框。
  // project key 同时写原始路径与 realpath（macOS /var→/private/var），覆盖 getCwd 的两种形态。
  const { realpathSync } = require('node:fs') as typeof import('node:fs')
  const realProject = realpathSync(project)
  const trust = { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true }
  writeFileSync(join(configDir, '.claude.json'), JSON.stringify({
    hasCompletedOnboarding: true,
    projects: { [project]: trust, [realProject]: trust },
  }))
  const env = {
    ...process.env,
    HOME: home,
    CLAUDE_CONFIG_DIR: configDir,
    RECORDER_MODE: mode,
    ...(extra.sleep ? { RECORDER_SLEEP: extra.sleep } : {}),
  }
  // 清除可能干扰的 hook 注入
  delete env.CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION
  return { home, configDir, project, out, recorderPath, env }
}

function writeHooks(configDir: string, hooks: unknown) {
  writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ hooks }, null, 2))
}

function cmdHook(event: string, recorderPath: string, out: string, matcher?: string) {
  const entry = { hooks: [{ type: 'command', command: NODE, args: [recorderPath, event, out] }] }
  return matcher ? { matcher, ...entry } : entry
}

function readStdin(out: string, event: string): unknown[] {
  const f = join(out, `${event}.stdin.jsonl`)
  if (!existsSync(f)) return []
  return readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return { _raw: l } } })
}

function runHeadless(env: NodeJS.ProcessEnv, project: string, args: string[]) {
  const r = spawnSync(UPSTREAM, args, { env, cwd: project, encoding: 'utf8', timeout: 120000 })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

function save(event: string, cases: unknown[]) {
  mkdirSync(OUT_DIR, { recursive: true })
  const result: ProbeResult = { event, cases }
  writeFileSync(join(OUT_DIR, `b1-${event}.json`), JSON.stringify({ schemaVersion: 1, upstreamVersion: '2.1.311', ...result }, null, 2))
}

/** PostToolBatch：headless 并行两个 Read（一现存一缺失），记录 tool_calls，再 block 验证停 loop。 */
function probePostToolBatch() {
  const cases: unknown[] = []
  for (const mode of ['record', 'context', 'block', 'exit1']) {
    const s = setup('PostToolBatch', mode)
    writeHooks(s.configDir, { PostToolBatch: [cmdHook('PostToolBatch', s.recorderPath, s.out)] })
    writeFileSync(join(s.project, 'exist.txt'), 'hello\n')
    const r = runHeadless(s.env, s.project, [
      '-p',
      'In a SINGLE response, call the Read tool twice in parallel: once for exist.txt and once for missing.txt. Do not retry.',
      '--output-format', 'json',
      '--permission-mode', 'bypassPermissions',
    ])
    cases.push({ mode, stdin: readStdin(s.out, 'PostToolBatch'), status: r.status, stdoutTail: r.stdout.slice(-400), stderrTail: r.stderr.slice(-300) })
    rmSync(s.home, { recursive: true, force: true })
  }
  save('PostToolBatch', cases)
}

/** MessageDisplay：headless 每条 assistant 文本完成后单次 index=0/final=true/delta=全文；display 替换屏幕但 transcript 存原文。 */
function probeMessageDisplay() {
  const cases: unknown[] = []
  for (const mode of ['record', 'display', 'block', 'exit1']) {
    const s = setup('MessageDisplay', mode)
    writeHooks(s.configDir, { MessageDisplay: [cmdHook('MessageDisplay', s.recorderPath, s.out)] })
    const r = runHeadless(s.env, s.project, ['-p', 'Reply with one short sentence.', '--output-format', 'json'])
    cases.push({ mode, stdin: readStdin(s.out, 'MessageDisplay'), status: r.status, stdoutTail: r.stdout.slice(-500), stderrTail: r.stderr.slice(-300) })
    rmSync(s.home, { recursive: true, force: true })
  }
  save('MessageDisplay', cases)
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\[[0-9;?]*[a-zA-Z]|\][^\x07]*\x07|\r/g, '')
}

type Step = { send?: string; keys?: string; wait: number }
/** onboarding/trust 已由 setup 预写的 .claude.json 跳过，无需按键导航。 */
const TRUST: Step[] = []

/** 交互驱动：python pty 启动 REPL，先过 trust 对话框，再按序发命令。 */
function runInteractive(env: NodeJS.ProcessEnv, project: string, steps: Step[], startupWait = 9) {
  const scriptPath = join(project, 'script.json')
  writeFileSync(scriptPath, JSON.stringify({ steps, startup_wait: startupWait }))
  const r = spawnSync('python3', [join(import.meta.dir, 'b1-interactive.py'), UPSTREAM, project, scriptPath], { env, encoding: 'utf8', timeout: 200000 })
  const transcript = existsSync(scriptPath + '.transcript.txt') ? readFileSync(scriptPath + '.transcript.txt', 'utf8') : ''
  return { status: r.status, transcript: stripAnsi(transcript), stderr: r.stderr ?? '' }
}

/** UserPromptExpansion：项目命令 .claude/commands/probe.md，matcher=probe，交互 /probe a b。 */
function probeUserPromptExpansion() {
  const cases: unknown[] = []
  for (const mode of ['record', 'context', 'block', 'exit1']) {
    const s = setup('UserPromptExpansion', mode)
    const cmdDir = join(s.project, '.claude', 'commands')
    mkdirSync(cmdDir, { recursive: true })
    writeFileSync(join(cmdDir, 'probe.md'), '---\ndescription: probe command\n---\nExpand these args: $ARGUMENTS\n')
    writeHooks(s.configDir, { UserPromptExpansion: [cmdHook('UserPromptExpansion', s.recorderPath, s.out, 'probe')] })
    const r = runInteractive(s.env, s.project, [...TRUST, { keys: '/probe a b', wait: 2 }, { keys: '\r', wait: 12 }])
    cases.push({ mode, stdin: readStdin(s.out, 'UserPromptExpansion'), transcriptTail: r.transcript.slice(-700) })
    rmSync(s.home, { recursive: true, force: true })
  }
  save('UserPromptExpansion', cases)
}

/** DirectoryAdded：交互 /add-dir 添加工作区外 sibling；本地操作，无需模型响应。 */
function probeDirectoryAdded() {
  const cases: unknown[] = []
  for (const mode of ['record', 'block', 'exit1']) {
    const s = setup('DirectoryAdded', mode)
    const sibling = join(s.home, 'sibling')
    mkdirSync(sibling, { recursive: true })
    writeHooks(s.configDir, { DirectoryAdded: [cmdHook('DirectoryAdded', s.recorderPath, s.out)] })
    const r = runInteractive(s.env, s.project, [...TRUST, { keys: `/add-dir ${sibling}`, wait: 2 }, { keys: '\r', wait: 8 }])
    cases.push({ mode, stdin: readStdin(s.out, 'DirectoryAdded'), transcript: r.transcript })
    rmSync(s.home, { recursive: true, force: true })
  }
  save('DirectoryAdded', cases)
}

/** PreModelSwitch：交互 /model 切换前同步；deny/ask/allow/block 决策。 */
function probePreModelSwitch() {
  const cases: unknown[] = []
  for (const mode of ['record', 'deny', 'ask', 'allow', 'block', 'exit1']) {
    const s = setup('PreModelSwitch', mode)
    writeHooks(s.configDir, { PreModelSwitch: [cmdHook('PreModelSwitch', s.recorderPath, s.out)] })
    const r = runInteractive(s.env, s.project, [...TRUST, { keys: '/model opus', wait: 2 }, { keys: '\r', wait: 6 }, { keys: '\r', wait: 8 }])
    cases.push({ mode, stdin: readStdin(s.out, 'PreModelSwitch'), transcript: r.transcript })
    rmSync(s.home, { recursive: true, force: true })
  }
  save('PreModelSwitch', cases)
}

/** PostModelSwitch：交互 /model 切换成功后异步；context 在下一请求投递。 */
function probePostModelSwitch() {
  const cases: unknown[] = []
  for (const mode of ['record', 'context', 'block', 'exit1']) {
    const s = setup('PostModelSwitch', mode)
    writeHooks(s.configDir, { PostModelSwitch: [cmdHook('PostModelSwitch', s.recorderPath, s.out)] })
    const r = runInteractive(s.env, s.project, [...TRUST, { keys: '/model opus', wait: 2 }, { keys: '\r', wait: 6 }, { keys: '\r', wait: 8 }])
    cases.push({ mode, stdin: readStdin(s.out, 'PostModelSwitch'), transcriptTail: r.transcript.slice(-700) })
    rmSync(s.home, { recursive: true, force: true })
  }
  save('PostModelSwitch', cases)
}

const probes: Record<string, () => void> = {
  PostToolBatch: probePostToolBatch,
  MessageDisplay: probeMessageDisplay,
  UserPromptExpansion: probeUserPromptExpansion,
  DirectoryAdded: probeDirectoryAdded,
  PreModelSwitch: probePreModelSwitch,
  PostModelSwitch: probePostModelSwitch,
}

const target = process.argv[2]
if (target === 'all') {
  for (const k of Object.keys(probes)) { console.log(`\n=== ${k} ===`); probes[k]() }
} else if (target && probes[target]) {
  probes[target]()
  console.log(`done: ${target} -> ${join(OUT_DIR, `b1-${target}.json`)}`)
} else {
  console.log(`usage: bun b1-hooks-probe.ts <${Object.keys(probes).join('|')}|all>`)
}
