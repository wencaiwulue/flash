import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: 'b160aef6c60e6ef3ef0d4bfdf7f97dae7532e02b',
  title: 'Use explicit expressions for live gating',
  kind: 'component',
  status: 'partial',
  beforeState:
    '父版本已经建立 model/cloud job env，并把对应 if 改成未包裹的 env context 表达式；desktop 仍是 vars 条件。脚本状态也尚未变化：model 无密钥 guard、cloud 缺 token 抛错、desktop 由字面量步骤 env 进入 live 分支。',
  problem:
    '需要明确表达式定界，但 jobs.<job_id>.if 本身已隐式求值，添加 ${{ ... }} 不会改变可用上下文。父版本 env context 不受支持的问题因此仍然存在。',
  goals: [
    '把 model 的单个 env 比较包进一对显式表达式定界符。',
    '把 cloud 含 && 的三项比较包进同一对定界符，其他字符保持不变。',
    '不调整 job env、desktop/skillhub、runner 或验证脚本。',
  ],
  nonGoals: [
    '不创建或修改环境变量，不替换 env context，也不新增 GitHub Environment。',
    '不把语法改动写成 CI 通过、脚本跳过或原生 desktop probe 通过。',
  ],
  architecture: [
    '这是 workflow 表达式语法层修改：job env 仍由父提交提供，if 只求值既有 env 名称；没有新的运行时组件或脚本控制流。',
  ],
  decisions: [
    'cloud 整段布尔表达式只使用一对 opening/closing 定界符，而非分别包裹三个比较。',
    'desktop 的隐式 vars 表达式不在 diff 中，self-hosted runner 与 CLAUDE_DESKTOP_LIVE=1 步骤环境均原样保留。',
  ],
  alternatives: [
    '保留隐式 if 也能表达同样布尔式；若改为受支持的变量来源则属于语义修复，不是本次纯定界符编辑。',
  ],
  security: ['补丁只增加表达式符号，不改变 secrets 映射、权限、输出或凭据生命周期，记录不含任何配置值。'],
  acceptance: [
    'diff 只有 model/cloud 两行替换，新增与删除各 2 行。',
    'job env 和步骤 env 数量不变，model/cloud/desktop 脚本 guard 行为与父提交一致。',
  ],
  evidence: [
    {
      kind: 'diff-observed',
      statement: 'model if 的 env 比较被显式 ${{ ... }} 包裹，job env 块仍在相邻位置。',
      source: { path: '.github/workflows/live-checks.yml', role: 'evidence', revision: 'b160aef6c60e6ef3ef0d4bfdf7f97dae7532e02b', symbol: "if: ${{ env.ANTHROPIC_API_KEY != '' }}", note: '只证明表达式形式变化。' },
    },
    {
      kind: 'diff-observed',
      statement: 'cloud 的三项 env 比较和 && 被放入同一个显式表达式，没有更换变量来源。',
      source: { path: '.github/workflows/live-checks.yml', role: 'evidence', revision: 'b160aef6c60e6ef3ef0d4bfdf7f97dae7532e02b', symbol: "if: ${{ env.CLAUDE_CODE_OAUTH_TOKEN != '' && env.CLAUDE_CODE_ORG_UUID != '' && env.CLAUDE_CODE_BASE_URL != '' }}", note: '复合表达式的精确保留。' },
    },
    {
      kind: 'diff-observed',
      statement: 'desktop 仍是未包裹的 vars 条件，此次显式语法没有覆盖第三个 live job。',
      source: { path: '.github/workflows/live-checks.yml', role: 'evidence', revision: 'b160aef6c60e6ef3ef0d4bfdf7f97dae7532e02b', symbol: "if: vars.CLAUDE_DESKTOP_LIVE == '1'", note: '保留该提交自己的 desktop 状态。' },
    },
    {
      kind: 'diff-observed',
      statement: 'model 脚本入口尚未包含 MODEL_LIVE_SKIPPED，不能把后续脚本门控提前归入本提交。',
      source: { path: 'scripts/live-model-validation.ts', role: 'evidence', revision: '4c04383cd5a2ee8953031948453d99da6d080946', symbol: 'async function main()', note: '父脚本入口用于核对复用边界。' },
    },
    {
      kind: 'diff-observed',
      statement: '当时 STATUS 仍明确指出原生 Computer Use 需要另行授权的桌面会话。',
      source: { path: 'docs/STATUS.md', role: 'evidence', revision: 'b160aef6c60e6ef3ef0d4bfdf7f97dae7532e02b', symbol: 'Native Computer Use desktop control', note: '语法 patch 未改变验证边界。' },
    },
    { kind: 'not-recorded', statement: '没有该语法版本的 Actions 解析结果、job 调度记录或 live 命令日志。' },
  ],
  remaining: ['显式表达式仍未解决 job if 的 env context 限制，实际 workflow 是否被接受需要平台证据。'],
  references: [
    { path: '.github/workflows/live-checks.yml', role: 'changed', note: '仅给 model/cloud 的 env if 增加显式定界符。' },
    { path: 'scripts/live-model-validation.ts', role: 'reused', symbol: 'async function main()', note: '没有新增 model 缺省配置 guard。' },
    { path: 'scripts/live-cloud-validation.ts', role: 'reused', symbol: 'Claude OAuth is required for cloud validation', note: 'cloud 仍在缺 token 时抛错。' },
    { path: 'scripts/live-desktop-validation.ts', role: 'reused', symbol: 'DESKTOP_LIVE_SKIPPED', note: '既有 guard 未改，workflow 运行步骤时传入 1。' },
    { path: 'scripts/live-skillhub-validation.ts', role: 'reused', symbol: 'SKILLHUB_LIVE_OK', note: 'skillhub 及其 job 均不参与语法修改。' },
    { path: 'docs/RELEASE.md', role: 'reused', symbol: '## CI live validation', note: '既有发布段不能充当这次表达式修改的执行证据。' },
    { path: 'docs/STATUS.md', role: 'reused', symbol: 'Live validation gaps', note: '当时仍列有授权环境与原生桌面缺口。' },
  ],
  plan: {
    preconditions: ['以含 job env、未包裹 env if 的父 workflow 为起点，不把后续脚本 guard 当作已有实现。'],
    reuse: ['复用全部变量定义、布尔操作数、runner 与 live 脚本，只编辑条件文本。'],
    steps: [
      { title: '定界 model 表达式', detail: '在 model if 的完整比较两侧加入显式表达式符号，不触碰相邻 env 块。', paths: ['.github/workflows/live-checks.yml'] },
      { title: '定界 cloud 表达式', detail: '将 cloud 的三比较复合式整体包裹，保留操作数顺序与 &&。', paths: ['.github/workflows/live-checks.yml'] },
      { title: '复核行为未迁移', detail: '比较 desktop/skillhub 和四个脚本，确认没有同时改成脚本 guard、runner 检测或 vars gate。', paths: ['.github/workflows/live-checks.yml', 'scripts/live-model-validation.ts', 'scripts/live-cloud-validation.ts', 'scripts/live-desktop-validation.ts', 'scripts/live-skillhub-validation.ts'] },
    ],
    compatibility: ['表达式的布尔结构、变量映射和脚本接口均不变；runner 后果继承父版本，不能因括号更明确而推定 job 会正常跳过。'],
    risks: [
      'job if 仍读取不受支持的 env context，语法显式化不修复平台求值问题。',
      'desktop 为变量开启时仍选择 self-hosted；变量未开启时在脚本前跳过，两种路径都不是 runner 自动探测。',
      '若 cloud 进入脚本且没有 token，依旧抛错，本提交没有 CLOUD_LIVE_SKIPPED。',
    ],
    verification: ['用 word diff 确认仅增加两对定界符，再核对脚本和文档无差异；执行结论必须另有 Actions 记录。'],
    completed: ['两个目标条件的显式表达式写法已精确落入 workflow，其他中间行为未改。'],
    incomplete: ['有效 job gate、workflow 运行、脚本 skip/success 矩阵及原生桌面验证仍未证明。'],
  },
})
