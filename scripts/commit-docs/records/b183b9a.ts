import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: 'b183b9a76948750cf396dd36c62ad06a62221b60',
  slug: 'live-job-environment-gates',
  title: 'Gate live validation jobs on available environments',
  kind: 'component',
  status: 'partial',
  beforeState:
    '父提交的 live-checks.yml 只有 model 与 skillhub 两个 ubuntu job，二者均无 job if。model 脚本没有缺密钥跳过；cloud 脚本缺 token 会抛错；desktop 脚本虽有 CLAUDE_DESKTOP_LIVE guard，但尚未接入 workflow。',
  problem:
    '需要把 model 可用性门控并补入 cloud、desktop 编排，但实现直接在 jobs.<job_id>.if 使用 secrets；该位置不支持 secrets context，不能把新增条件描述为已验证的空值跳过。',
  goals: [
    '给 model 增加 ANTHROPIC_API_KEY 非空条件，保留原步骤级 secret 映射。',
    '新增带三项 secret 条件的 cloud job，以及带 CLAUDE_DESKTOP_LIVE 变量条件的 self-hosted desktop job。',
    '保持 skillhub、触发器、权限和四个验证脚本不变。',
  ],
  nonGoals: [
    '没有创建 GitHub Environment，也没有 environment: 配置；这里的环境可用性仅指变量和 runner 选择。',
    '不新增脚本内 model/cloud 跳过，不记录 workflow 运行、外部服务成功或原生桌面验证。',
  ],
  architecture: [
    'job if 位于 runner 分配和 checkout 之前，step env 只在步骤进程中生效；二者阶段不同。desktop 的 vars 条件控制 job，字面量步骤环境再控制既有脚本 guard。',
  ],
  decisions: [
    'model 与 cloud 采用未包裹的 secrets 表达式，desktop 采用未包裹的 vars 等值表达式；本提交尚未引入 job 级 env。',
    'cloud 要求 token、org UUID、base URL 三项均非空，尽管脚本自身对后两项另有回退；desktop 运行后强制向脚本传入 CLAUDE_DESKTOP_LIVE=1。',
  ],
  alternatives: [
    '事后看，脚本内 guard 能输出跳过标记，job if 则能避免 runner 占用；本提交没有把二者统一，也没有实现 runner 自动探测。',
  ],
  security: [
    '记录只包含变量名，不含凭据值；workflow 沿用 secrets/vars 引用与 contents: read，没有新增权限或回显步骤。',
  ],
  acceptance: [
    'diff 仅向 live-checks.yml 增加 33 行：一个 model if 和完整 cloud、desktop jobs。',
    'model/cloud 脚本仍分别是无缺省 guard、缺 token 抛错；desktop job 若进入步骤，其字面量 env 会走 screenshot 分支。',
  ],  remaining: [
    'model/cloud 的 job-if 上下文需要另行修正；desktop 变量与真实 runner 库存也未建立自动关联。',
  ],
  references: [
    { path: '.github/workflows/live-checks.yml', role: 'changed', note: '加入 model gate，并新增 cloud、desktop job。' },
    { path: 'scripts/live-model-validation.ts', role: 'reused', symbol: 'async function main()', note: '父版本脚本无密钥跳过 guard，本提交未修改。' },
    { path: 'scripts/live-cloud-validation.ts', role: 'reused', symbol: 'Claude OAuth is required for cloud validation', note: '复用缺 token 抛错的 cloud 验证。' },
    { path: 'scripts/live-desktop-validation.ts', role: 'reused', symbol: 'DESKTOP_LIVE_SKIPPED', note: '复用既有 desktop guard；workflow 步骤会显式传入 1。' },
    { path: 'scripts/live-skillhub-validation.ts', role: 'reused', symbol: 'SKILLHUB_LIVE_OK', note: 'skillhub 脚本及其无条件 job 保持原样。' },
    { path: 'docs/RELEASE.md', role: 'reused', symbol: '## CI live validation', note: '当时发布说明未给此次门控提供独立运行证据。' },
    { path: 'docs/STATUS.md', role: 'reused', symbol: 'Live validation gaps', note: '当时状态仍保留 Cloud 与原生桌面的授权环境边界。' },
  ],
  plan: {
    preconditions: [
      '以仅有 model、skillhub 的父 workflow 为基准，并确认 cloud/desktop 脚本已经存在。',
      '区分 job-if 上下文、步骤 env 和 GitHub Environment，不能把三者混写。',
    ],
    reuse: ['复用四个 live 脚本、Bun 安装序列、隔离 HOME/CLAUDE_CONFIG_DIR 及 workflow_dispatch/schedule。'],
    steps: [
      { title: '门控既有 model job', detail: '在 workflow 的 model 下加入 secret 非空 if，保留原 steps 与 step env。', paths: ['.github/workflows/live-checks.yml'] },
      { title: '接入 cloud 文件', detail: '追加 ubuntu cloud job，设置三项条件、安装步骤、脚本命令和对应 secret 映射。', paths: ['.github/workflows/live-checks.yml', 'scripts/live-cloud-validation.ts'] },
      { title: '接入 desktop 文件', detail: '追加 self-hosted desktop job 和 vars opt-in，核对既有脚本 guard 会被步骤字面量 1 绕过。', paths: ['.github/workflows/live-checks.yml', 'scripts/live-desktop-validation.ts'] },
      { title: '核对未改边界', detail: '确认 model、skillhub 脚本和 STATUS/RELEASE 无 diff，不把既有说明当成本次运行结果。', paths: ['scripts/live-model-validation.ts', 'scripts/live-skillhub-validation.ts', 'docs/STATUS.md', 'docs/RELEASE.md'] },
    ],
    compatibility: [
      'skillhub 编排不变；其余脚本主体也未改，但能否进入脚本取决于新增 job 条件，不能沿用父版本必然启动的结论。',
    ],
    risks: [
      'jobs.<job_id>.if 不支持 secrets context，model/cloud 不能据此宣称可靠跳过或 CI 可运行。',
      'desktop 变量为 1 但没有 self-hosted runner 时不会由该表达式自动跳过；为假时虽可免占 runner，却没有脚本 skip 日志。',
      'cloud job 若实际进入且缺 token，复用脚本会失败而不是输出 CLOUD_LIVE_SKIPPED。',
    ],
    acceptanceSequence: [
      '静态比较父/当前 workflow 与四个脚本，确认 33 行新增和脚本零差异。',
      '后续应分别留存 workflow 解析、条件真假、runner 选择与脚本输出；本记录不宣称这些执行已发生。',
    ],
    completed: ['初始 model 条件及 cloud、desktop 编排已落入 at-commit workflow，复用脚本和文档边界已核对。'],
    incomplete: ['有效的 model/cloud job gate、runner 可用性检测以及所有 CI/live 执行结果均未随提交证明。'],
  },
})
