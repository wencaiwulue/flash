import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: 'e90042354c2cb902b033cf9e06b39d9c67c1b111',
  title: 'Skip desktop validation without self-hosted runner',
  kind: 'component',
  status: 'implemented',
  beforeState:
    '父提交已删除 model/cloud/desktop 三个 job if，并由 model/cloud 脚本输出缺配置跳过标记。desktop 没有 job gate，会选择 self-hosted；一旦执行脚本，步骤中的 CLAUDE_DESKTOP_LIVE=1 使既有 guard 进入 screenshot，而非 DESKTOP_LIVE_SKIPPED。',
  problem:
    '需要让未配置 desktop live 的仓库在 runner 分配前略过 self-hosted job。实际实现是恢复 vars.CLAUDE_DESKTOP_LIVE == 1 的 opt-in 条件，并非查询 runner 库存；变量开启但无 runner 时不能声称会自动跳过。',
  goals: [
    '只给 desktop 添加仓库/组织配置变量控制的 job if。',
    '在变量不等于 1 时于 checkout、安装和脚本之前跳过 desktop job。',
    '保留 model/cloud 的脚本级 guard 和 desktop 既有 screenshot probe。',
  ],
  nonGoals: [
    '不恢复 model/cloud 的 job if，不修改任何验证脚本、job env 或步骤 env。',
    '不创建 GitHub Environment，不实现 self-hosted runner 自动发现，也不声明原生桌面验证已经执行或通过。',
  ],
  architecture: [
    'desktop 有两层独立开关：vars job if 在 runner 前决定是否调度；进程内 CLAUDE_DESKTOP_LIVE guard 只在步骤启动后生效。前者为假时不会打印后者的 DESKTOP_LIVE_SKIPPED。',
  ],
  decisions: [
    '仅插入 if: vars.CLAUDE_DESKTOP_LIVE == 1 这一行，保留 runs-on: self-hosted 和字面量步骤环境。',
    'model/cloud 继续先占用 ubuntu runner，再由脚本判断配置；此次不把三种 job 重新统一成 workflow gate。',
  ],
  alternatives: [
    '仅靠 desktop 脚本 guard 无法避免 self-hosted runner 分配；真正按 runner 库存自动跳过需要额外发现机制，本提交没有引入。',
  ],
  security: ['条件只读取布尔配置变量，不读取或输出凭据；contents: read、secret 映射和隔离目录均保持不变。'],
  acceptance: [
    'diff 恰有一行新增，位置在 desktop job 的 runs-on 之前，其他 job 和脚本零变化。',
    '变量非 1 时可在 runner 前跳过；变量为 1 且 job 获配 runner 后，脚本仍因步骤 env=1 执行 screenshot 路径。',
  ],
  evidence: [
    {
      kind: 'diff-observed',
      statement: 'at-commit desktop job 的唯一新增门控是 vars.CLAUDE_DESKTOP_LIVE 等值表达式，runner 仍为 self-hosted。',
      source: { path: '.github/workflows/live-checks.yml', role: 'evidence', revision: 'e90042354c2cb902b033cf9e06b39d9c67c1b111', symbol: "if: vars.CLAUDE_DESKTOP_LIVE == '1'", note: '实际机制是配置变量 opt-in，不是 runner 查询。' },
    },
    {
      kind: 'diff-observed',
      statement: '同一 workflow 的 desktop 步骤继续显式设置 CLAUDE_DESKTOP_LIVE 为 1。',
      source: { path: '.github/workflows/live-checks.yml', role: 'evidence', revision: 'e90042354c2cb902b033cf9e06b39d9c67c1b111', symbol: "CLAUDE_DESKTOP_LIVE: '1'", note: 'job 被调度后既有脚本 guard 不会走 skip 分支。' },
    },
    {
      kind: 'diff-observed',
      statement: 'desktop 脚本复用父版本的 skip/screenshot 分支，本提交没有新增原生桌面探针。',
      source: { path: 'scripts/live-desktop-validation.ts', role: 'evidence', revision: '97b13fd5279b917c69462da929db00bba942de6a', symbol: 'DESKTOP_LIVE_SKIPPED', note: '脚本级跳过标记只可能在脚本实际运行时输出。' },
    },
    {
      kind: 'diff-observed',
      statement: 'model 的缺密钥 guard 来自父提交，e900423 未恢复其 job if。',
      source: { path: 'scripts/live-model-validation.ts', role: 'evidence', revision: '97b13fd5279b917c69462da929db00bba942de6a', symbol: 'MODEL_LIVE_SKIPPED', note: '保留 script-gating 中间结果。' },
    },
    {
      kind: 'diff-observed',
      statement: 'cloud 的缺 token guard 同样保持父提交实现，未因 desktop 条件而变化。',
      source: { path: 'scripts/live-cloud-validation.ts', role: 'evidence', revision: '97b13fd5279b917c69462da929db00bba942de6a', symbol: 'CLOUD_LIVE_SKIPPED', note: 'desktop-only 一行补丁的脚本边界。' },
    },
    {
      kind: 'diff-observed',
      statement: 'at-commit STATUS 仍要求真实授权桌面会话，不能将 opt-in gate 解释为 native desktop 验证。',
      source: { path: 'docs/STATUS.md', role: 'evidence', revision: 'e90042354c2cb902b033cf9e06b39d9c67c1b111', symbol: 'Native Computer Use desktop control', note: '当时文档明确保留原生桌面验证边界。' },
    },
    { kind: 'not-recorded', statement: '本提交未附带变量两种取值下的 Actions 日志、self-hosted runner 分配结果或 screenshot 输出。' },
  ],
  remaining: ['变量值与 runner 是否登记之间没有自动同步；启用后的真实交互桌面 screenshot 仍需独立授权环境证据。'],
  references: [
    { path: '.github/workflows/live-checks.yml', role: 'changed', note: '仅恢复 desktop 的 vars job gate。' },
    { path: 'scripts/live-desktop-validation.ts', role: 'reused', symbol: "process.env.CLAUDE_DESKTOP_LIVE !== '1'", note: '复用脚本 guard；job 运行时步骤 env 固定为 1。' },
    { path: 'scripts/live-model-validation.ts', role: 'reused', symbol: 'MODEL_LIVE_SKIPPED', note: 'model 继续使用父提交的脚本级缺密钥跳过。' },
    { path: 'scripts/live-cloud-validation.ts', role: 'reused', symbol: 'CLOUD_LIVE_SKIPPED', note: 'cloud 继续使用父提交的脚本级缺 token 跳过。' },
    { path: 'scripts/live-skillhub-validation.ts', role: 'reused', symbol: 'SKILLHUB_LIVE_OK', note: 'skillhub job 和脚本不在此次改动中。' },
    { path: 'docs/RELEASE.md', role: 'reused', symbol: '## CI live validation', note: '当时发布说明未提供本提交的独立运行编号。' },
    { path: 'docs/STATUS.md', role: 'reused', symbol: 'Native Computer Use desktop control', note: '原生桌面仍需独立授权会话。' },
  ],
  plan: {
    preconditions: ['以三个 job if 已删除、model/cloud 脚本 guard 已存在的父版本为基准。', '确认 desktop 步骤 env 的字面量 1 与脚本 guard 的先后关系。'],
    reuse: ['复用 vars 配置、self-hosted 标签、现有安装步骤及四个 live 脚本，不添加 runner 管理组件。'],
    steps: [
      { title: '添加 desktop job gate', detail: '在 live-checks.yml 的 desktop 下、runs-on 前插入 vars 等值 if，不修改 model/cloud 条件。', paths: ['.github/workflows/live-checks.yml'] },
      { title: '核对 desktop 两阶段行为', detail: '对照脚本确认变量非 1 时不会进入 runner/脚本，变量为 1 时步骤字面量 env 选择 screenshot 分支。', paths: ['.github/workflows/live-checks.yml', 'scripts/live-desktop-validation.ts'] },
      { title: '确认其他脚本保持复用', detail: '逐文件比较 model、cloud、skillhub，保留已有 skip/success 路径，不混入新的 job gate。', paths: ['scripts/live-model-validation.ts', 'scripts/live-cloud-validation.ts', 'scripts/live-skillhub-validation.ts'] },
    ],
    compatibility: [
      'desktop 变量非 1 时，新行为是在 runner 前跳过且没有 DESKTOP_LIVE_SKIPPED 日志；变量为 1 时后续步骤与父版本相同。',
      'model/cloud 仍在 ubuntu 上启动脚本后处理缺省配置，skillhub 仍无 job if。',
    ],
    risks: [
      '该条件不会探测 self-hosted runner；变量误设为 1 时，无 runner 的 job 仍可能等待或失败，而不是自动 skipped。',
      'job 级 skip 不含脚本输出，若运营流程依赖 DESKTOP_LIVE_SKIPPED 标记需另行区分。',
      '获得 runner 不等于具有授权交互桌面，screenshot 的成功与失败均无随提交记录。',
    ],
    verification: ['检查一行 patch 和脚本零差异，并读取 at-commit STATUS 的原生桌面限制；执行结论需另附具体 Actions 运行来源。'],
    completed: ['desktop 的变量 opt-in job gate 已加入，model/cloud 脚本门控与 desktop 成功路径保持不变。'],
    incomplete: ['runner 自动发现、变量真假运行矩阵以及真实 native desktop screenshot 验证均未实现或未记录。'],
  },
})
