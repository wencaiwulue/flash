import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: 'beee034523510ac0425461bb4ffce3250514d693',
  kind: 'component',
  status: 'partial',
  beforeState: '父提交的 live model 脚本只接受 ANTHROPIC_API_KEY；只有 Bearer settings 的环境会输出 MODEL_LIVE_SKIPPED。核心 getAnthropicApiKeyWithSource 在缺少 API key 时，即使已有 ANTHROPIC_AUTH_TOKEN，也仍可能进入“缺少 API key 或 Claude OAuth”的错误分支。CI model job 同样只映射 API-key secret。',
  problem: '需要让 live validation 复用既有 Bearer 通道完成模型验证，同时防止 API key 与 AUTH_TOKEN 同时存在时由调用顺序决定身份。提交文档把执行描述为 settings-based，但 standalone 脚本只检查启动时已有的 process.env，并未实现 settings.env 注入。Bearer 既不是 x-api-key，也不是 Claude OAuth，不能用变量改名混淆三种凭据语义。',
  goals: [
    '让核心 CI/test API-key 检查承认既有 ANTHROPIC_AUTH_TOKEN，避免该分支错误要求额外 API key/OAuth。',
    '让 live 脚本接受任一已注入进程环境的模型凭据、拒绝两种凭据并存，并在两者都缺失时保留 skip。',
    '让 CI model job 与 step 传递同名 AUTH_TOKEN secret，并保留 settings-based 四个 live-script sentinel 的历史记录及其证据边界。',
  ],
  nonGoals: [
    '不把 ANTHROPIC_AUTH_TOKEN 映射为 CLAUDE_CODE_OAUTH_TOKEN，也不将其作为 x-api-key 发送。',
    '不因此完成 Cloud Files、Remote Control、perpetual 服务端或原生桌面的 OAuth/授权环境验收。',
    '不新增独立认证协议或输出 settings/token 内容。',
  ],
  architecture: [
    '正常 CLI 初始化可由 managedEnv 将 settings.env 注入 process.env，但本提交修改的 standalone live 脚本没有调用 applySafeConfigEnvironmentVariables() 或 applyConfigEnvironmentVariables()；它在 enableConfigs() 前检查环境，而 enableConfigs() 本身只开放/读取配置，不做该注入。因此 token 仅存在于 ~/.claude/settings.json 时，这个脚本会走 MODEL_LIVE_SKIPPED。',
    'src/utils/auth.ts 只在 CI=true 或 NODE_ENV=test 的“没有可用凭据”判定中增加 AUTH_TOKEN；getAnthropicApiKeyWithSource() 仍不返回 Bearer source，仅有 AUTH_TOKEN 时返回 key:null/source:none。Bearer 识别属于 getAuthTokenSource()，实际 Authorization: Bearer header 由 configureApiKeyHeaders() 注入；API key 与 Claude OAuth 仍是不同来源和协议路径。',
    'live-model-validation.ts 在 enableConfigs 前先做互斥检查，再做双缺失 skip；任一凭据存在才进入 Workflow、proactive、context-collapse 和 reactive-compaction 四个检查。其中 Workflow、context-collapse、reactive-compaction 是 model-backed probes，PROACTIVE_LIVE_OK 只检查 proactive 激活和本地 SleepTool 计时，不发起模型请求。workflow 的 job/step 环境与进程环境输入契约对齐，STATUS/RELEASE 记录 sentinel 和认证类型。',
  ],
  decisions: [
    'live 脚本中双凭据并存直接抛错，而不是让 AUTH_TOKEN 静默覆盖 API key；这样该脚本的配置歧义在发起模型请求前暴露，但核心 resolver 和普通 CLI 未新增全局互斥。',
    '保留 MODEL_LIVE_SKIPPED 仅用于两者都缺失，避免把“认证方式不受支持”误报成“未配置”。',
    '核心只增加一个存在性条件，复用现有 Bearer source、provider 和模型调用，不复制认证实现。',
  ],
  alternatives: ['回溯来看，把 Bearer 塞进 ANTHROPIC_API_KEY 虽能减少脚本分支，却会改变 header 与凭据类型；只做 CI secret 改名而不修核心存在性检查，则仍会在后续认证路径失败。'],
  security: [
    '在 live-model-validation.ts 中，非空的 ANTHROPIC_API_KEY 与 ANTHROPIC_AUTH_TOKEN 同时存在时，会在 enableConfigs() 前抛出互斥错误；核心 resolver 和普通 CLI 未新增全局互斥，其他认证组合也未由本提交统一拒绝。',
    '新增认证 guard 不显式打印 token；双缺失认证分支打印 MODEL_LIVE_SKIPPED 后返回，四个成功点打印固定 sentinel。脚本仍可能输出异常、依赖或 cleanup 日志，因此不概括为“日志只输出固定 sentinel”；本 diff 未新增 settings/token 内容输出，CI secret 名与 Bearer 类型一致。',
    'Claude OAuth 继续是独立身份来源，本次模型 Bearer 结果不能替代 Cloud/remote-control 授权。',
  ],
  acceptance: [
    '在 CI=true 或 NODE_ENV=test、没有 API key/FD key 且存在非空 ANTHROPIC_AUTH_TOKEN 时，getAnthropicApiKeyWithSource() 不再抛出缺少 API key/Claude OAuth 的错误，并返回 key:null/source:none；--bare 和其他 resolver 分支未因此变成通用 Bearer API-key source。',
    '仅凭据通过 guard 后，脚本进入 Workflow、context-collapse、reactive-compaction 三个 model-backed probes，以及不发起模型请求的 proactive SleepTool 本地计时检查。',
    'live 脚本中两种变量同时设置时在配置初始化前抛出明确互斥错误；都未设置时，该认证分支只打印 MODEL_LIVE_SKIPPED 后返回。',
    'workflow 的 job 与 run step 都引用 ANTHROPIC_AUTH_TOKEN secret，不再把该 secret 交给 API-key 变量。',
  ],
  evidence: [
    {
      kind: 'diff-observed',
      statement: '核心 CI/test 缺少凭据条件新增 !process.env.ANTHROPIC_AUTH_TOKEN，live 脚本新增互斥与双缺失两个独立分支。',
      source: { path: 'src/utils/auth.ts', role: 'evidence', revision: 'commit', symbol: '!process.env.ANTHROPIC_AUTH_TOKEN', note: 'Bearer 被纳入既有凭据存在性判定。' },
    },
    {
      kind: 'recorded-command-pass',
      statement: 'at-commit RELEASE 的 Settings-based authentication 小节声称本地 settings-based validation 返回全部四个 model sentinels；STATUS 将 WORKFLOW_LIVE_OK、PROACTIVE_LIVE_OK、CONTEXT_COLLAPSE_LIVE_OK 和 REACTIVE_COMPACTION_LIVE_OK 四个具名结果归因于 settings-based auth。按实现，其中 PROACTIVE_LIVE_OK 仅是本地 Sleep 检查，不构成 Bearer 或 OAuth 验证。',
      source: { path: 'docs/STATUS.md', role: 'evidence', revision: 'commit', symbol: 'Settings-based auth returned', note: '四个具名 sentinel 的历史记录；RELEASE 仅概括全部四个 model sentinels，未逐一列名。' },
    },
    {
      kind: 'not-recorded',
      statement: '本提交没有新增 Claude OAuth、Cloud/remote-control 或原生桌面 round trip，也没有独立 auth 单元测试文件。',
    },
  ],
  remaining: ['standalone live 脚本尚未把仅存在于 settings.json 的 token 注入 process.env；该路径会在 guard 处 skip，且历史输出无法证明 token 仅来自 settings 文件。', '真实 Claude OAuth 与原生桌面仍需各自授权环境；本次仅有 at-commit 文档记录支持三个 model-backed Bearer 路径，PROACTIVE_LIVE_OK 是本地 Sleep 结果，不构成 Bearer 或 OAuth 验证。'],
  references: [
    { path: 'src/utils/auth.ts', role: 'changed', symbol: '!process.env.ANTHROPIC_AUTH_TOKEN', note: '避免 CI/test 分支已有 Bearer 时仍进入缺少 API key/OAuth 的错误。' },
    { path: 'scripts/live-model-validation.ts', role: 'changed', symbol: 'mutually exclusive', note: '实现双认证互斥、双缺失 skip 和单凭据进入 probes。' },
    { path: '.github/workflows/live-checks.yml', role: 'changed', symbol: 'secrets.ANTHROPIC_AUTH_TOKEN', note: '在 job 与 step 两层传递匹配的 Bearer secret。' },
    { path: 'docs/STATUS.md', role: 'changed', symbol: 'Settings-based auth returned', note: '把三个 model-backed 能力和本地 proactive Sleep 对应表行的证据来源改为 settings-based auth。' },
    { path: 'docs/RELEASE.md', role: 'changed', symbol: '## Settings-based authentication', note: '记录认证互斥、CI guard 和本地四个 sentinel，并区分 Bearer 与 OAuth；其中 model sentinels 的概括比实现证据更宽。' },
  ],
  plan: {
    preconditions: ['本提交只识别 live 脚本开始执行 main() 时已经存在于 process.env 的 ANTHROPIC_AUTH_TOKEN。脚本在 enableConfigs() 前执行互斥和 skip guard，且未调用 applySafeConfigEnvironmentVariables() 或 applyConfigEnvironmentVariables()；enableConfigs() 本身不注入 settings.env。因此，token 仅写在 ~/.claude/settings.json、但未预先进入进程环境的 standalone 路径，不由本 diff 实现或验证。'],
    reuse: ['复用 getAuthTokenSource() 对 ANTHROPIC_AUTH_TOKEN 的 hasToken/source 识别，以及 configureApiKeyHeaders() 的 Authorization: Bearer 注入；getAnthropicApiKeyWithSource() 仍不返回 AUTH_TOKEN source，在仅有 AUTH_TOKEN 时返回 key:null/source:none。同时复用既有三个 model-backed probes、本地 proactive Sleep 检查、runCleanupFunctions 和 CI 隔离目录。'],
    steps: [
      { title: '修正核心 CI/test 凭据存在性检查', detail: '在 CI/test 缺少 API key 的判断中加入 AUTH_TOKEN 不存在条件，使该分支能沿用既有 Bearer source/provider 路径；--bare 与其他 resolver 分支不变。', paths: ['src/utils/auth.ts'] },
      { title: '定义 live 脚本认证矩阵', detail: '先拒绝 API key 与 AUTH_TOKEN 并存，再在双缺失时 skip，其余情况进入原四个 probes。', paths: ['scripts/live-model-validation.ts'] },
      { title: '对齐 CI 环境变量', detail: '把 job env 和模型 run step 的 secret 引用同时改为 ANTHROPIC_AUTH_TOKEN，保留 base URL 与隔离目录。', paths: ['.github/workflows/live-checks.yml'] },
      { title: '记录实际验证与边界', detail: '在 STATUS 更新四个 sentinel 的认证来源，在 RELEASE 说明互斥、Bearer/OAuth 区别及仍需独立环境的范围。', paths: ['docs/STATUS.md', 'docs/RELEASE.md'] },
    ],
    compatibility: ['直接运行 live 脚本时，预先进入 process.env 的仅 API-key 或仅 AUTH_TOKEN 配置仍被 guard 接受；两者并存仅在该脚本中变成显式错误。CI model job 改为只映射 ANTHROPIC_AUTH_TOKEN secret，因此旧有仅配置 ANTHROPIC_API_KEY secret 的 workflow 不再继承该 API key，并会在无其他凭据时 skip。'],
    risks: ['若只改脚本不改核心，后续 API-key 检查仍会失败；若允许双凭据并存，则请求身份依赖不可见优先级。'],
    verification: ['按仅 API key、仅 AUTH_TOKEN、两者并存、两者缺失四种矩阵检查分支，再依据 STATUS/RELEASE 记录核对四个 live-script sentinel，其中三个对应 model-backed 路径，PROACTIVE_LIVE_OK 仅证明本地 proactive Sleep 检查；本记录不新增在线执行声明。'],
    completed: ['核心 CI/test 分支、live 脚本和 CI 已接受同一 process.env Bearer 输入契约，文档记录了 settings-based 四个 live-script sentinel；该记录没有本次命令、时间、环境或原始输出，不能独立重建凭据来源。'],
    incomplete: ['standalone 脚本未实现认证 guard 前的 settings.env 注入，仅凭 settings.json 的路径会 skip；未新增 auth 单元测试，也未完成独立 Claude OAuth 或桌面授权验证。'],
  },
})
