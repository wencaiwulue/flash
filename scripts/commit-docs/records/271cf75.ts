import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: '271cf757a24eb6cd7e46586fa18995759be32043',
  slug: 'final-ci-status',
  kind: 'evidence-update',
  status: 'implemented',
  beforeState: '父提交的 RELEASE 已在 env-less perpetual 与 live model validation 段记录 152 tests、645 assertions 及构建结果，但还没有把该段对应到最终实现提交和 hosted CI run。',
  problem: '离线验证数量与最终代码状态需要可追溯的提交/run 关联；缺这一行时，读者只能看到验证声明，无法从发布记录定位 e31ff8f 与 CI 42861258902。',
  goals: ['在现有验证段追加 e31ff8f 的 full SHA；CI 执行标识仅用于文档定位，不表示本次重新验证。'],
  nonGoals: ['不修改 bridge、cron 或模型验证实现，也不把这条发布记录扩展为 OAuth、Cloud 或桌面 live 验收。'],
  architecture: ['这是单点证据关联：RELEASE 的既有 Verification 行继续描述离线结果，新 Commit 行把结果归属到 e31ff8f 和 hosted run；没有产品数据流或运行时状态变化。'],
  decisions: ['只追加一行而不改写既有验证段，保留原有测试数量和功能边界，避免证据更新被误读为新的功能提交。'],
  alternatives: ['回溯来看，另建发布文件也能保存 run 关联，但会割裂同段功能与验证上下文；当前最小追加更适合单行证据补录。'],
  security: ['新增内容只有公开 commit SHA 与 CI 标识，不含 token、OAuth 配置或运行日志中的敏感值。'],
  acceptance: ['目标段同时保留 152/645 验证声明和 e31ff8f 关联，且 diff 不涉及其他文件。'],  remaining: ['该提交本身不附 hosted 日志；若需复核具体 job 输出，应查询对应 GitHub Actions run。'],
  references: [
    { path: 'docs/RELEASE.md', role: 'changed', symbol: 'e31ff8f', note: '在既有 env-less/live-model 验证段追加提交关联；CI 标识仅用于文档定位，不表示本次重新验证。' },
  ],
  plan: {
    preconditions: ['确认目标验证段已经包含 152/645，且要记录的实现 SHA 是 e31ff8f 而非当前证据提交。'],
    reuse: ['沿用 RELEASE 的 Verification/Commit 元数据格式，不另建状态表。'],
    steps: [
      { title: '定位既有验证段', detail: '找到包含 152 tests、645 assertions 的段落，确认其功能范围与待关联提交一致。', paths: ['docs/RELEASE.md'] },
      { title: '追加提交证据', detail: '在该段末尾写入 e31ff8f full SHA，不改动其他验证声明。', paths: ['docs/RELEASE.md'] },
    ],
    compatibility: ['原有段落顺序和验证数字保持不变，只增加可追溯元数据。'],
    risks: ['把当前证据提交 SHA 错写成实现提交会断开归因，因此必须核对 e31ff8f。'],
    acceptanceSequence: ['检查单文件单行 diff，并在 at-commit RELEASE 中搜索执行标识与实现 SHA。'],
    completed: ['实现提交和 hosted CI 标识已进入同一发布验证段。'],
    incomplete: ['未在此提交重新执行或抓取 CI 日志，记录本身不是新的运行环境。'],
  },
})
