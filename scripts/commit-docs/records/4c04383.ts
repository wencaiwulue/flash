import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: '4c04383cd5a2ee8953031948453d99da6d080946',
  slug: 'env-context-live-gating',
  title: 'Use env context for live job gating',
  kind: 'component',
  status: 'partial',
  beforeState:
    '父 workflow 的 model/cloud 直接在 job if 比较 secrets，尚没有 job 级 env；desktop 已由 vars.CLAUDE_DESKTOP_LIVE 控制。model 仍无缺密钥脚本 guard，cloud 缺 token 仍抛错，desktop 步骤仍固定传 1。',
  problem:
    '此次尝试先把 secrets 映射为 job env，再从 if 读取 env，但 jobs.<job_id>.if 同样不支持 env context。创建环境变量并不会扩大该位置的上下文集合，缺陷不能记成已修复。',
  goals: [
    '为 model 新建两项 job env，并把 if 改为 env.ANTHROPIC_API_KEY 非空。',
    '为 cloud 新建三项 job env，并把三项 if 操作数从 secrets 改为 env。',
    '保留原步骤 env、desktop 条件、skillhub 和所有脚本。',
  ],
  nonGoals: [
    '本提交不添加 ${{ ... }} 包裹，也不改用 vars 或脚本 guard。',
    '没有 environment: 或平台 Environment 创建，没有 CI 运行和原生桌面验证证据。',
  ],
  architecture: [
    'job env 是传递给步骤的变量定义，env.ANTHROPIC_API_KEY 则是表达式上下文读取；两者名称相近但不是同一机制。步骤级同名映射继续覆盖同值 job env。',
  ],
  decisions: [
    '只替换 model/cloud 的 if 前缀并增加 env 块，表达式仍依赖 job-if 的隐式表达式求值。',
    'desktop 未增加 job env，仍由 vars 做 runner 前门控，并在脚本步骤显式启用 live 分支。',
  ],
  alternatives: [
    '事后看，仅移动 secret 映射不能解决条件上下文约束；选择脚本内跳过或受支持的 job-if 输入会改变语义，均超出这两处编辑。',
  ],
  security: [
    '新增的是既有 secrets 到环境变量名的映射，没有变量值、额外权限或日志回显；记录不保存任何凭据。',
  ],
  acceptance: [
    'diff 恰为 9 行新增、2 行删除，只影响 model/cloud 的 if 与 job env。',
    '两处 if 仍未使用显式 ${{ ... }}，desktop 和脚本内容逐字保留父版本行为。',
  ],  remaining: ['env context 在 job if 中仍不可用；需要另行选择有效门控机制并取得平台执行证据。'],
  references: [
    { path: '.github/workflows/live-checks.yml', role: 'changed', note: '新建 model/cloud job env，并切换对应 if 的 context。' },
    { path: 'scripts/live-model-validation.ts', role: 'reused', symbol: 'async function main()', note: '仍没有 MODEL_LIVE_SKIPPED 提前返回。' },
    { path: 'scripts/live-cloud-validation.ts', role: 'reused', symbol: 'Claude OAuth is required for cloud validation', note: '缺 token 抛错行为保持。' },
    { path: 'scripts/live-desktop-validation.ts', role: 'reused', symbol: "process.env.CLAUDE_DESKTOP_LIVE !== '1'", note: 'desktop guard 未改，job 运行时步骤 env 固定为 1。' },
    { path: 'scripts/live-skillhub-validation.ts', role: 'reused', symbol: 'SKILLHUB_LIVE_OK', note: 'skillhub 未参与此次 env 调整。' },
    { path: 'docs/RELEASE.md', role: 'reused', symbol: '## CI live validation', note: '发布说明未给这次 env 改动附带运行编号。' },
    { path: 'docs/STATUS.md', role: 'reused', symbol: 'Live validation gaps', note: '保留授权环境与原生桌面未验证说明。' },
  ],
  plan: {
    preconditions: ['从 secrets job if 的父版本开始，保留 desktop vars 条件与四个脚本的既有行为。'],
    reuse: ['复用现有 secret 名称、Bun 安装步骤、隔离目录以及所有验证函数，不新增脚本模块。'],
    steps: [
      { title: '建立 model job env', detail: '在 model 增加两项 job env，再把 if 的 secret 读取改为 env 读取，保留步骤级同名映射。', paths: ['.github/workflows/live-checks.yml'] },
      { title: '建立 cloud job env', detail: '依次加入 token、org UUID、base URL 三项 job env，并同步替换复合 if 的三个操作数。', paths: ['.github/workflows/live-checks.yml'] },
      { title: '检查未触达文件', detail: '对照 desktop、skillhub 与脚本，确认本步没有补表达式括号、脚本 guard 或 runner 探测。', paths: ['.github/workflows/live-checks.yml', 'scripts/live-desktop-validation.ts', 'scripts/live-model-validation.ts', 'scripts/live-cloud-validation.ts', 'scripts/live-skillhub-validation.ts'] },
    ],
    compatibility: ['job/step env 的值来源与脚本命令不变，但 job 是否可启动仍受不受支持的 env if 影响，不能承诺与原执行兼容。'],
    risks: [
      'jobs.<job_id>.if 不支持 env context，新增 job env 不能形成可靠的缺省配置跳过。',
      'desktop 变量只提供 opt-in；变量开启时仍要求 self-hosted runner，未开启时没有 DESKTOP_LIVE_SKIPPED 脚本日志。',
      '同名 job/step env 重复增加维护面，却没有改变脚本内的凭据读取。',
    ],
    acceptanceSequence: ['逐行检查 9+/2- patch，并比较当前与父脚本；平台行为需要单独保存的 workflow 日志，不能从 YAML 推断成功。'],
    completed: ['model/cloud 的 job env 创建与 env context 改写已完成，desktop 和脚本中间态均保留。'],
    incomplete: ['job-if 可用性缺陷尚未解决，CI 跳过矩阵和原生桌面执行均无记录。'],
  },
})
