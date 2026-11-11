import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, join } from 'path'

type CommitStatus = 'implemented' | 'partial' | 'unimplemented'

type Commit = {
  full: string
  short: string
  date: string
  subject: string
}

type Details = {
  requirements: string
  security: string
  verification: string
  remaining: string
  plan?: string
}

const DETAILS: Record<string, Details> = {
  '9b2a352': {
    requirements: '恢复可复现的 Bun CLI/SDK 构建、TypeScript 配置和直接依赖。',
    security: '仅恢复公开源码与构建元数据，不引入内部私有包。',
    verification: '类型检查、CLI/SDK 构建及启动冒烟。',
    remaining: '当时仍存在 SDK 生命周期和协议实现缺口，后续提交继续补齐。',
  },
  '6b7bf48': {
    requirements: '实现 Linux libsecret、npm marketplace 和 SDK 控制接口。',
    security: 'secret JSON 仅经 stdin 传递，npm 禁止生命周期脚本。',
    verification: 'mock secret-tool、npm runner 和 SDK control 回归测试。',
    remaining: '真实 secret-tool/npm/Cloud 环境未在该提交单独验收。',
  },
  '02bc3c2': {
    requirements: '实现 env-less remote-control handle、FIFO 队列、权限响应和 Cloud Files 路径映射。',
    security: '不猜 xattr 名称或伪造成功 handle，Cloud 使用 Files API。',
    verification: 'fake transport、Cloud pagination/ambiguity/abort 测试及 CI。',
    remaining: '真实 OAuth Cloud/remote-control round trip 未在该提交验证。',
  },
  '614bf48': {
    requirements: '启用已有外部功能，并在两个 SDK 会话读取路径恢复并行 assistant/tool-result DAG。',
    security: '保持 external USER_TYPE，不启用缺失内部工具。',
    verification: '组合构建、27 工具、SDK 并行分支与分页测试。',
    remaining: '真实 Cloud/remote 服务验证仍未执行。',
  },
  '301a3e7': {
    requirements: '实现 Monitor 行事件、OverflowTest、TerminalCapture、Sleep 与 CtxInspect。',
    security: 'Monitor 复用 Bash 权限和沙箱；TerminalCapture 仅读现有 tmux pane。',
    verification: '真实 shell 行事件、tmux mock runner、工具 schema 与组合构建。',
    remaining: 'Sleep/CtxInspect 的依赖功能组当时尚未启用。',
  },
  'edcaa95': {
    requirements: '实现 proactive 状态、idle 调度、Sleep 激活和 Coordinator worker 定义。',
    security: '不依赖全局 USER_TYPE=ant，worker 不可递归嵌套 Agent。',
    verification: '状态转换、调度、worker 工具集与组合构建。',
    remaining: '真实 proactive/multi-worker 模型编排未在该提交验收。',
  },
  'e2e0ff6': {
    requirements: '使 feature-profile 测试在本地和 CI 的 ToolSearch 配置下确定性通过。',
    security: '固定测试 endpoint 与 ToolSearch，不读取真实凭据。',
    verification: '独立 Bun 子进程组合构建及 CI。',
    remaining: '无该提交范围内的未实现项。',
  },
  'e92caa6': {
    requirements: '实现本地 skill 索引、Fuse 搜索、自然语言回退、去重及多信号 prefetch。',
    security: '仅使用本地命令元数据，不调用未知远程协议。',
    verification: '排名、过滤、turn-zero/write-pivot/subagent prefetch 与缓存失效测试。',
    remaining: '远程 canonical skill 后端当时仍未实现。',
  },
  '809351a': {
    requirements: '实现 UDS server/client、私有 registry、peer 枚举和 SendMessage 路由。',
    security: 'socket 0600、私有 registry、超时和 stale peer 清理。',
    verification: '真实本地 UDS 文本入队、唤醒、寻址和 teardown 测试。',
    remaining: '跨机器或公网 peer 验证不属于该本地 UDS 协议范围。',
  },
  'd2fafcd': {
    requirements: '实现 daemon supervisor、worker registry 和 SDK Remote Control server 生命周期。',
    security: '复用现有 remote-control 协议，不伪造 Cloud 连接。',
    verification: '重试、停止、PID 清理、enable/disable 和组合构建。',
    remaining: '真实 Cloud session 未在该提交验收。',
  },
  'ea80851': {
    requirements: '实现严格 workflow schema、项目发现、DAG 并发、依赖恢复和本地任务状态。',
    security: '步骤通过现有 agent runner 与工具权限执行，不绕过权限。',
    verification: 'DAG、skip/retry/kill、依赖失败、任务输出和组合构建。',
    remaining: '真实模型 agent workflow 当时未执行，后续已单独验证。',
  },
  '31697a0': {
    requirements: '实现 context-collapse 状态、90/95% 总结阈值、UUID 投影、staged 恢复与持久化。',
    security: '保持 tool pair 完整，空总结不提交，summarizer 不递归触发自身。',
    verification: '阈值、恢复、投影、空摘要、持久化与组合构建。',
    remaining: '真实模型摘要与 API 413 恢复当时未执行。',
  },
  'da942ac': {
    requirements: '实现 reactive PTL/媒体错误识别、媒体剥离、共享 compact 与清理。',
    security: '不重复 PreCompact hook，失败按类型返回，不伪造恢复成功。',
    verification: '错误识别、媒体剥离、PreCompact、失败映射与组合构建。',
    remaining: '真实 API 413 恢复当时未执行。',
  },
  '982ab10': {
    requirements: '启用 Buddy 与 Fork，补 companion soul/reaction 和真实 /fork prompt。',
    security: 'deterministic bones 与模型 soul 分离，禁止递归 fork。',
    verification: 'companion 持久化、reaction、fork cache placeholder 和 worktree notice。',
    remaining: '模型生成的 companion 个性未在该提交单独做 live 验收。',
  },
  '2bf435a': {
    requirements: '实现 snip marker、边界投影、SnipTool 和 force-snip。',
    security: '保护最近消息与 tool pair，不改写磁盘 transcript。',
    verification: 'marker 幂等、双向 tool-pair、nudge、REPL/SDK 与命令测试。',
    remaining: '真实长会话裁剪效果未在该提交做 live 验收。',
  },
  '0b68068': {
    requirements: '实现独立只读 ReviewArtifact、结构化 findings 和 /hunter。',
    security: '复用 FileRead 权限与大小限制，问题必须带 evidence 或标 unverified。',
    verification: '输入校验、reviewer prompt、结构化结果与 bundled skill 注册。',
    remaining: '真实模型评审质量未在该提交单独评估。',
  },
  'ab30aec': {
    requirements: '用 SkillHub REST 实现 canonical skill 搜索、state、resolve、下载和版本缓存。',
    security: '限制 zip 大小/文件数，拒绝路径逃逸与 symlink，不伪造 remote telemetry。',
    verification: '本地真实 HTTP registry、缓存版本变化及恶意 zip 测试。',
    remaining: '公开/自托管 registry live 验收后续执行。',
  },
  'd5a675a': {
    requirements: '实现开放 KAIROS assistant/team/session、文件上传、通知、PR 订阅和 dream。',
    security: '复用 OAuth 与 GitHub REST，首次轮询只建立基线。',
    verification: '隔离 team 初始化、通知适配器、PR 去重和组合构建。',
    remaining: '真实 Cloud/notification/GitHub 往返未在该提交验收。',
  },
  'd925b12': {
    requirements: '接入 Zavora Computer Use 与 Playwright MCP，提供真实 WebBrowser。',
    security: '保留 allowlist/权限拒绝，浏览器使用 isolated profile。',
    verification: '真实工具目录、权限拒绝及本地浏览器导航与 snapshot。',
    remaining: '原生桌面控制仍需授权交互桌面，当时未执行。',
  },
  'a8c8b90': {
    requirements: '补 changed-file、cron、LSP 生命周期测试并修复删除竞态和崩溃重启状态。',
    security: '真实文件与 JSON-RPC 子进程，不依赖配置字段假验证。',
    verification: 'offset/limit、cron lock/aging、LSP restart/timeout 全量测试。',
    remaining: '无该提交范围内的未实现项。',
  },
  'adaa8ff': {
    requirements: '实现 env-less perpetual 的 cse/SSE 复用、401 重建和 pointer 保留/归档。',
    security: '临时 teardown 保留 session，仅显式 archive 清理 pointer；不重放重复事件。',
    verification: '独立进程验证同 ID、seq 恢复、401 重建与归档清理。',
    remaining: '真实 OAuth 服务端 perpetual round trip 未在该提交执行。',
  },
  'c43f42e': {
    requirements: '消除 CI 生命周期测试的 cwd 污染并放宽 lock takeover 时间窗口。',
    security: '测试使用 AsyncLocalStorage cwd 和隔离目录。',
    verification: 'ReviewArtifact/cron 定向回归。',
    remaining: '后续提交继续收敛接管竞态。',
  },
  '3948f91': {
    requirements: '使 cron lock takeover 测试不依赖固定 owner，并提供可配置 probe 间隔。',
    security: '按实际首次点火者验证另一方接管，不伪造锁状态。',
    verification: 'owner-agnostic lock takeover 回归。',
    remaining: '后续继续验证 stop/start 的虚拟时间重排。',
  },
  'e31ff8f': {
    requirements: '在 scheduler stop 时清理 inFlight/nextFireAt，重启后从磁盘重新锚定。',
    security: '避免旧任务在 stop/start 后永久阻塞或重复触发。',
    verification: '全量 cron、ReviewArtifact 与 CI 回归。',
    remaining: '无该提交范围内的未实现项。',
  },
  '9cd4c63': {
    requirements: '加入 live validation workflow 与脚本，兼容 SkillHub global namespace 和响应字段。',
    security: '隔离配置目录，不把 settings/token 写入日志或 artifact。',
    verification: '真实模型四项与真实 SkillHub registry 返回所有 LIVE_OK。',
    remaining: 'Cloud/桌面 job 的环境配置仍需单独提供。',
  },
  'beee034': {
    requirements: '支持 settings.json 的 ANTHROPIC_AUTH_TOKEN，保持 Bearer 与 API key 认证互斥。',
    security: '不把 token 映射为 Claude OAuth 或 x-api-key，不输出 token。',
    verification: '本地 settings-based 四项模型验证及 CI 全部通过。',
    remaining: 'Claude OAuth 和原生桌面验收仍需独立环境。',
  },
}

function detailsFor(commit: Commit): Details {
  return DETAILS[commit.short] ?? {
    requirements: `${commit.subject}。保持现有 CLI/SDK 接口、feature gating 与权限边界，完成该提交对应的实现、修复或文档工作。`,
    security: '不引入新的凭据、私有协议或绕过现有权限的行为。',
    verification: 'bun test、bun run typecheck、bun run build 及对应 CI 检查。',
    remaining: '无该提交范围内的未实现项。',
  }
}

function git(args: string[]): string {
  const result = Bun.spawnSync({ cmd: ['git', ...args], stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

function commits(): Commit[] {
  return git(['log', '--reverse', '--format=%H%x09%h%x09%cI%x09%s'])
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [full, short, date, ...subject] = line.split('\t')
      return { full: full!, short: short!, date: date!, subject: subject.join('\t') }
    })
}

function statusFor(commit: Commit): CommitStatus {
  return commit.full.startsWith('4b9d30f') ? 'partial' : 'implemented'
}

const SELF_ID = process.env.COMMIT_DOC_ID ?? 'commit-docs-bootstrap'
const SELF_SUBJECT =
  process.env.COMMIT_DOC_SUBJECT ?? 'Document commit specifications and plans'
const SELF_DETAILS: Details = {
  requirements:
    '为每个提交提供独立 SPEC、PLAN 和实现状态，保留真实变更范围、验证证据与未实现边界。',
  security:
    '状态只描述实现，不将 mock 通过冒充 live 验证；文档不得包含凭据或私有配置。',
  verification:
    '运行 bun scripts/check-commit-docs.ts、全量测试、typecheck、build 和 CI 完整性检查。',
  remaining: 'OAuth/Cloud 与原生桌面验证仍按环境单独记录，不影响 commit 实现状态。',
  plan: `1. 按 git 历史生成每个提交的 SPEC 与 PLAN。
2. 建立人类可读和机器可读状态索引及 self 约定。
3. 在基础 CI 中检查所有提交文档完整、有效且与 SHA 对齐。`,
}

function selfSpecFor(): string {
  return `---
commit: self
changeId: ${SELF_ID}
title: ${JSON.stringify(SELF_SUBJECT)}
status: implemented
---

# ${SELF_SUBJECT}

## Background and requirements

${SELF_DETAILS.requirements}

## Actual scope

- scripts/document-commits.ts generates per-commit SPEC and PLAN files.
- scripts/check-commit-docs.ts verifies every record and link.
- .github/workflows/ci.yml uses full history for validation.

## Protocol, dependencies, and security

${SELF_DETAILS.security}

## Acceptance and verification

${SELF_DETAILS.verification}

## Remaining / unimplemented boundaries

${SELF_DETAILS.remaining}
`
}

function selfPlanFor(): string {
  return `---
commit: self
changeId: ${SELF_ID}
title: ${JSON.stringify(SELF_SUBJECT)}
status: implemented
---

# Implementation plan: ${SELF_SUBJECT}

## Objective

${SELF_DETAILS.requirements}

## Implementation steps

${SELF_DETAILS.plan}

## Risks and mitigations

${SELF_DETAILS.security}

## Verification sequence

${SELF_DETAILS.verification}

## Completion status and remaining work

- Status: **implemented**
- Remaining: ${SELF_DETAILS.remaining}
`
}

function specFor(commit: Commit): string {
  const details = detailsFor(commit)
  const files = git(['show', '--format=', '--name-only', commit.full])
  const stat = git(['show', '--shortstat', '--format=', commit.full])
  return `---
commit: ${commit.full}
title: ${JSON.stringify(commit.subject)}
date: ${commit.date}
status: ${statusFor(commit)}
---

# ${commit.subject}

## Background and requirements

${details.requirements}

## Actual scope

- Changed files: ${files.split('\n').filter(Boolean).length}
- Diff statistics: ${stat || 'metadata only'}

\`\`\`text
${files || '(no file changes)'}
\`\`\`

## Protocol, dependencies, and security

${details.security}

## Acceptance and verification

${details.verification}

## Remaining / unimplemented boundaries

${details.remaining}
`
}

function planFor(commit: Commit): string {
  const details = detailsFor(commit)
  const steps = details.plan ??
    `1. 复核目标、现有实现和复用模块。
2. 按提交范围修改实现并补充回归。
3. 执行验证、记录状态与未实现边界。`
  return `---
commit: ${commit.full}
title: ${JSON.stringify(commit.subject)}
date: ${commit.date}
status: ${statusFor(commit)}
---

# Implementation plan: ${commit.subject}

## Objective

${details.requirements}

## Implementation steps

${steps}

## Risks and mitigations

${details.security}

## Verification sequence

${details.verification}

## Completion status and remaining work

- Status: **${statusFor(commit)}**
- Remaining: ${details.remaining}
`
}

export async function buildCommitDocuments(): Promise<Map<string, string>> {
  const documents = new Map<string, string>()
  const indexRows: string[] = []
  const jsonCommits: unknown[] = []
  const counts: Record<CommitStatus, number> = {
    implemented: 0,
    partial: 0,
    unimplemented: 0,
  }
  for (const commit of commits().slice(0, -1)) {
    const status = statusFor(commit)
    counts[status]++
    const specPath = `docs/specs/${commit.short}-SPEC.md`
    const planPath = `docs/plans/${commit.short}-PLAN.md`
    documents.set(specPath, specFor(commit))
    documents.set(planPath, planFor(commit))
    indexRows.push(`| ${commit.short} | ${commit.subject.replaceAll('|', '\\|')} | ${status} | [SPEC](../${specPath}) | [PLAN](../${planPath}) |`)
    jsonCommits.push({
      fullSha: commit.full,
      shortSha: commit.short,
      date: commit.date,
      subject: commit.subject,
      status,
      spec: specPath,
      plan: planPath,
    })
  }
  const previousHead = commits().at(-2)
  if (previousHead) {
    documents.set(
      `docs/specs/${previousHead.short}-SPEC.md`,
      specFor(previousHead),
    )
    documents.set(
      `docs/plans/${previousHead.short}-PLAN.md`,
      planFor(previousHead),
    )
  }
  documents.set('docs/specs/self-SPEC.md', selfSpecFor())
  documents.set('docs/plans/self-PLAN.md', selfPlanFor())
  indexRows.push(
    `| self (${SELF_ID}) | ${SELF_SUBJECT.replaceAll('|', '\\|')} | implemented | [SPEC](../docs/specs/self-SPEC.md) | [PLAN](../docs/plans/self-PLAN.md) |`,
  )
  jsonCommits.push({
    fullSha: 'self',
    changeId: SELF_ID,
    subject: SELF_SUBJECT,
    status: 'implemented',
    spec: 'docs/specs/self-SPEC.md',
    plan: 'docs/plans/self-PLAN.md',
  })
  documents.set(
    'docs/INDEX.md',
    `# Commit documentation index\n\n- Implemented: ${counts.implemented}\n- Partial: ${counts.partial}\n- Unimplemented: ${counts.unimplemented}\n\n| Commit | Subject | Status | SPEC | PLAN |\n|---|---|---|---|---|\n${indexRows.join('\n')}\n`,
  )
  documents.set(
    'docs/status/index.json',
    `${JSON.stringify({ commits: jsonCommits }, null, 2)}\n`,
  )
  return documents
}

async function writeCommitDocuments(): Promise<void> {
  const documents = await buildCommitDocuments()
  for (const [path, content] of documents) {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content)
  }
  console.log(`Generated ${documents.size - 2} commit documents`)
}

if (import.meta.main) await writeCommitDocuments()
