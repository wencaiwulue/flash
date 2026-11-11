import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: 'd5a675a4df66ff620d7577aaf167bb5749cc08a2',
  slug: 'open-kairos-functionality',
  title: 'Implement open KAIROS functionality',
  kind: 'component',
  status: 'implemented',
  beforeState:
    '父提交中的 KAIROS 多数外部入口只是禁用边界：assistant gate 固定返回 false，团队初始化直接抛错，session discovery 永远为空，session chooser 一挂载便取消。文件上传、通知和 PR 订阅没有开放工具实现，dream 也没有注册。构建虽保留若干条件注册点，但 KAIROS 与 KAIROS_GITHUB_WEBHOOKS 未进入外部特性档，因而这些 stub 不只是缺少 UI，而是缺少从本机团队上下文到远程会话、文件和事件适配器的完整组件。',
  problem:
    '需要在不伪造私有后端的前提下，把开放运行时的 assistant 模式接到既有 in-process team、OAuth session API、daemon supervisor、Brief 上传、OS 回调和消息通知队列。PR 功能还要避免第一次轮询把历史评论、review 和 check-run 全部当成新事件，并在后续轮询中按事件身份去重。实现必须区分本机状态初始化与真实远端可用性：隔离目录中的团队文件、mock 通知和 fake GitHub 响应可以离线验证，Cloud 文件上传、通知投递及 GitHub 往返则不能由这些测试推定成功。',
  goals: [
    '实现 assistant 激活来源、forced latch、运行时开关和 in-process leader team 初始化，并保留既有信任与 OAuth 检查位置。',
    '通过 OAuth sessions API 发现、规范化并排序远程会话，提供可选择的真实会话列表和 assistant 命令。',
    '提供受权限约束的 daemon 安装向导，以私有目录和配置文件启动既有 assistant supervisor。',
    '新增 SendUserFile 与 PushNotification，复用 Brief 上传、FileRead 权限、webhook 和 OS 通知适配器。',
    '以 GitHub REST 轮询评论、review 和 check-run，建立首次基线、按类型前缀 ID 去重并接入通知队列。',
    '注册 dream、assistant、subscribe-pr 及三个工具，在外部构建和独立特性档中验证真实注册结果。',
  ],
  nonGoals: [
    '不把 leader team 文件初始化解释为已经启动多个模型 teammate 或完成多代理协作。',
    '不实现 launchd/systemd 服务安装；向导只写配置并调用现有 detached daemon supervisor。',
    '不实现入站 GitHub webhook 服务端，PR 功能是由 gh api 驱动的三十秒轮询。',
    '不让 dream 在后台自动改写记忆；该 skill 只生成用户显式调用时的 consolidation prompt。',
    '不宣称 OAuth session discovery、真实上传、OS/webhook 投递或 GitHub 在线往返已在此提交验收。',
  ],
  architecture: [
    'assistant/index.ts 将激活状态拆成进程内 forced、CLAUDE_CODE_ASSISTANT 和 settings.assistant 三种来源，并以 getAssistantActivationPath 保留可观察的来源。isKairosRuntimeEnabled 默认开放，只有 CLAUDE_KAIROS 被显式定义为假时关闭；gate.ts 仅委托这一运行时开关，不把开放 gate 当作 OAuth entitlement。既有 main 启动路径仍负责信任对话框、组织和凭据检查，因此项目设置不能在未受信目录中越过原有边界。',
    'initializeAssistantTeam 用 session ID 前八位生成经过 sanitize 的 assistant 团队名，写包含 leadSessionId、主循环模型、cwd 和单个 leader member 的既有 team 文件，再注册 session cleanup、重置任务目录并设置 leader team。setCliTeammateModeOverride 固定为 in-process，返回的 leader layout 使用空 tmux 标识。这个上下文让现有 Agent/team 路径可以工作，但它本身只建立 leader 基础设施，不创建额外模型进程。',
    'sessionDiscovery.ts 通过 prepareApiRequest 取得 OAuth token 与 orgUUID，以 ccr-byoc beta、组织头和十五秒超时请求 /v1/sessions 的一页五十条数据。解析器兼容 data 包装或顶层数组、三种 ID 字段和 snake/camel 活跃时间字段，丢弃无有效 ID 项并按最近活跃排序。AssistantSessionChooser 用 Dialog/Select 展示标题或 ID 及主机线索；/assistant 则分别提供 start、status、sessions，start 先 forced 激活再建立团队。',
    'assistant.tsx 的 NewInstallWizard 将安装位置固定为 ~/.claude/assistant，用户选择后以 mode 0700 调用 mkdir、以 mode 0600 写入仅含版本和时间的 daemon.json，随后调用 startDaemon(\'assistant\')；这些 mode 只约束新建对象，不会 chmod 已有目录或文件。成功回调仅表示配置写入、detached 子进程已 spawn 且 PID registry 已写入，不确认 supervisor 持续存活，也不代表 worker、bridge 或 Cloud session 已就绪；错误统一交回 onError，而不是显示虚假的安装成功。',
    'SendUserFileTool 先把读取授权委托给 FileReadTool.checkPermissions，再要求活动 Remote Control bridge。路径相对 cwd 解析，lstat 只接受普通文件，实际上传复用 uploadBriefAttachment 的 OAuth、30 MiB 上限、超时、AbortSignal 和 file_uuid 校验。只有返回 fileId 才形成成功结果。该实现没有额外把路径限制在 cwd 内，cwd 外及绝对路径仍依赖 FileRead 的权限判定，而不是上传工具另设隐蔽放行。',
    'PushNotificationTool 优先使用 CLAUDE_NOTIFICATION_WEBHOOK_URL，发送 text、可选 title/url，只有 2xx 算 webhook 成功；没有 webhook 时调用上下文 sendOSNotification，两个适配器都缺失则抛错。OS 回调是既有 fire-and-forget 边界，所以 deliveredVia=os 表示已经交给本机适配器，不等于确认用户看到系统通知。工具提示也要求失败不得描述为已发送。',
    'PRSubscriptionManager 为每个 owner/repo#number 保存 timer、seen 和 initialized。每轮先取 PR head SHA，再并行读取 issue comments、reviews 和该 SHA 的 check-runs，分别形成 comment:、review:、check: 前缀 ID。首轮只填充基线，后续只把未见过的新 ID 送入既有 task-notification/later 队列并加入 seen；重复 poll 不再产生事件。timer unref，unsubscribe 清理计时器和状态，工具与 slash command 共享同一进程级 manager。',
    'dream.ts 复用 auto-memory 路径、项目 transcript 目录和 buildConsolidationPrompt 生成可调用 prompt。build.ts 与独立特性夹具同时打开 KAIROS、KAIROS_GITHUB_WEBHOOKS，使既有条件注册点加载 assistant、subscribe-pr、dream 和三个新工具；enabledFeatures 在干净 Bun 子进程固定 41 个非空工具及 assistant command，避免源文件存在但构建仍裁掉实现。',
  ],
  decisions: [
    '开放的是运行时与适配器，不新造一套 assistant 协议；team、daemon、OAuth、上传和通知均落在既有模块边界上。',
    '团队初始化只创建 leader 上下文，把实际 teammate 创建留给现有 Agent 路径，避免安装阶段隐式产生模型工作量。',
    '文件发送复用 FileRead 权限和 Brief 上传，而不是把 file_path 直接交给无授权的网络客户端；只有 file ID 能作为上传成功凭据。',
    'webhook 优先于 OS 适配器，使远程或 headless 环境有明确投递通道；无适配器时失败优于静默丢失。',
    'PR 首轮采用基线而非立即通知，防止订阅动作重放全部历史；以带类型前缀的服务端 ID 去重，而非比较易变摘要。',
    '构建与特性夹具同步打开两个 flag，并以编译后的工具/命令数量验收，防止只修改源码却没有外部可见能力。',
  ],
  alternatives: [
    '回溯性比较：可以为 assistant 另写团队存储和进程编排，但会分裂既有 Agent、task 和 cleanup 语义；实际实现只生成既有 team 文件及 in-process mode snapshot。',
    '回溯性比较：可以实现独立文件上传协议，但会重复 OAuth、大小限制、MIME 和错误处理；实际复用 Brief 上传并保留 FileRead 权限。',
    '回溯性比较：可以把首次 PR 结果全部推送以快速展示状态，但会制造历史通知风暴；实际牺牲首轮即时信息，换取后续事件的新增语义。',
    '回溯性比较：可以引入持久化 PR 事件数据库和 GitHub webhook 服务以获得跨重启及更新语义；实际选择内存轮询，范围更小，但重启重新基线且同 ID 内容变化不会再次通知。',
  ],
  security: [
    'assistant runtime gate 不替代既有信任、OAuth 和组织检查；远程 discovery 必须提供 OAuth token 与 orgUUID。',
    'daemon 配置目录和文件仅在新建时分别使用 mode 0700/0600，已有路径不会被 chmod；写入内容不含令牌。startDaemon 只确认 spawn/PID registry，不确认 supervisor 持续存活或远端会话成功。',
    'SendUserFile 继承 FileRead 权限并拒绝非普通文件，上传具有 30 MiB 限制、AbortSignal 和严格响应 ID 校验。',
    'webhook 仅在 2xx 时报告成功，非 2xx、网络错误和无适配器均显式失败；通知正文不用于推断投递结果。',
    'PR ID 按事件类型命名空间隔离，首次基线抑制历史事件；GitHub 凭据由 gh CLI 管理，代码不保存 token。',
    'PR 去重只按 ID，不跟踪同 ID 的编辑或 check 状态迁移；评论/review 每类只取一百条且无分页，这些是有意的实现边界而非完整事件档案。',
  ],
  acceptance: [
    'forced assistant 首次激活返回 true、重复调用返回 false，激活来源和系统提示能反映 in-process team 语义。',
    '隔离配置目录中的初始化写出 assistant-* 团队文件，包含真实 leadSessionId 和单个 leader member，并设置 in-process 模式。',
    'session discovery 能规范不同响应外形并按活跃时间排序，chooser 与 /assistant sessions 使用同一 AssistantSession 数据。',
    '安装向导只在用户确认后以新建 mode 0700/0600 写配置并调用 startDaemon，已有路径权限不保证被修正；异常通过 onError 暴露。',
    '无 bridge 时 SendUserFile 在上传前失败；通知在 OS 适配器上传递正确标题和消息，无适配器时明确报错。',
    'PR 首次 poll 不通知，新增 ID 只通知一次，重复 poll 为空，unsubscribe 后列表移除且 timer 被清理。',
    'dream prompt 含 consolidation 指令和用户参数；外部特性档包含 41 个非空工具、三个新工具及 assistant command。',
    '提交内文档记录 140 tests/604 assertions 和构建结果，同时保留 Cloud、通知、GitHub live 往返未验证的边界。',
  ],  remaining: [
    '真实 OAuth session 列表、远程 viewer、daemon worker/bridge 就绪、文件上传、通知投递和 GitHub 往返仍需授权环境逐项验证。',
    '新增六项测试没有专项覆盖 session discovery、安装向导或 webhook 请求；STATUS 对这些组件统一使用 tested 的表述比实际直接证据更宽。',
    'PR 订阅状态仅存内存，重启会重新建立基线；同 ID 内容更新不会再次通知，评论和 review 没有分页，后台 poll 也没有防重入。',
    'SendUserFile 没有新增 cwd containment，绝对路径及 cwd 外路径依赖 FileRead 权限；提交测试只覆盖无 bridge 的前置失败。',
    '/subscribe-pr 的实际解析要求显式 subscribe action，与参数提示中的直接 owner/repo#N 形式不完全一致，且没有命令解析专项测试。',
  ],
  references: [
    {
      path: 'docs/RELEASE.md',
      role: 'changed',
      symbol: '## Open KAIROS functionality',
      note: '记录开放 KAIROS 的组件范围、140/604 和在线未验证边界。',
    },
    {
      path: 'docs/STATUS.md',
      role: 'changed',
      symbol: 'Open KAIROS adapters',
      note: '记录 offline/build 状态、140/604 和 41-tool 特性档；但 STATUS 的 tested 表述超出新增测试范围，session discovery、安装向导和 webhook 没有专项测试。',
    },
    {
      path: 'scripts/build.ts',
      role: 'changed',
      symbol: 'KAIROS_GITHUB_WEBHOOKS',
      note: '在外部构建启用 KAIROS 与 GitHub 适配器条件注册。',
    },
    {
      path: 'src/assistant/AssistantSessionChooser.tsx',
      role: 'changed',
      symbol: 'AssistantSessionChooser',
      note: '把自动取消的占位组件替换为真实 Dialog/Select 会话选择界面。',
    },
    {
      path: 'src/assistant/gate.ts',
      role: 'changed',
      symbol: 'isKairosRuntimeEnabled',
      note: '将固定禁用 gate 委托给可显式关闭的开放运行时开关。',
    },
    {
      path: 'src/assistant/index.ts',
      role: 'changed',
      symbol: 'initializeAssistantTeam',
      note: '实现激活状态、团队提示、leader team 文件及 in-process mode 初始化。',
    },
    {
      path: 'src/assistant/sessionDiscovery.ts',
      role: 'changed',
      symbol: 'discoverAssistantSessions',
      note: '实现 OAuth sessions 请求、响应字段规范化、无效项过滤和活跃时间排序。',
    },
    {
      path: 'src/commands/assistant/assistant.tsx',
      role: 'changed',
      symbol: 'NewInstallWizard',
      note: '实现默认安装路径、私有配置写入、supervisor 启动和错误回调。',
    },
    {
      path: 'src/commands/assistant/index.ts',
      role: 'changed',
      symbol: "name: 'assistant'",
      note: '提供 start/status/sessions 三个动作，将 forced 激活、团队建立和远程发现接入命令。',
    },
    {
      path: 'src/commands/subscribe-pr.ts',
      role: 'changed',
      symbol: "name: 'subscribe-pr'",
      note: '提供共享 manager 的订阅、退订和列表命令，并声明非交互支持。',
    },
    {
      path: 'src/services/prSubscriptions.ts',
      role: 'changed',
      symbol: 'PRSubscriptionManager',
      note: '承载 gh api 轮询、首次基线、分类 ID 去重、通知和 timer 生命周期。',
    },
    {
      path: 'src/skills/bundled/dream.ts',
      role: 'changed',
      symbol: 'registerDreamSkill',
      note: '注册用户可调用的记忆整合 prompt，而非自动后台写入器。',
    },
    {
      path: 'src/tools/PushNotificationTool/PushNotificationTool.ts',
      role: 'changed',
      symbol: 'PushNotificationTool',
      note: '实现 webhook 优先、OS 回退和无适配器失败的通知工具。',
    },
    {
      path: 'src/tools/SendUserFileTool/SendUserFileTool.ts',
      role: 'changed',
      symbol: 'SendUserFileTool',
      note: '把 FileRead 权限、bridge 活动状态和普通文件检查接到 Brief 上传。',
    },
    {
      path: 'src/tools/SubscribePRTool/SubscribePRTool.ts',
      role: 'changed',
      symbol: 'SubscribePRTool',
      note: '提供严格工具输入、origin 仓库推导及与命令共享的 PR 订阅单例。',
    },
    {
      path: 'tests/enabledFeatures.test.ts',
      role: 'changed',
      symbol: 'hasAssistantCommand',
      note: '验证 41 个非空工具、三个新增工具和 assistant 命令进入编译特性档。',
    },
    {
      path: 'tests/fixtures/verify-enabled-features.ts',
      role: 'changed',
      symbol: 'hasAssistantCommand',
      note: '在独立构建中开启相同 KAIROS flags 并输出 assistant 注册信息。',
    },
    {
      path: 'tests/kairos.test.ts',
      role: 'changed',
      symbol: "describe('assistant mode'",
      note: '以隔离目录、子进程和 fake adapters 固定团队、通知、上传前置和 PR 去重行为。',
    },
    {
      path: 'src/tools/BriefTool/upload.ts',
      role: 'reused',
      symbol: 'uploadBriefAttachment',
      note: '复用既有 OAuth multipart 上传、30 MiB 上限、超时、取消及 file_uuid 响应校验。',
    },
    {
      path: 'src/daemon/main.ts',
      role: 'reused',
      symbol: 'startDaemon',
      note: '复用 daemon PID/registry 与 detached supervisor，不在向导重写服务生命周期。',
    },
    {
      path: 'src/utils/teleport/api.ts',
      role: 'reused',
      symbol: 'prepareApiRequest',
      note: '复用 OAuth access token、orgUUID 和认证头准备逻辑。',
    },
    {
      path: 'src/utils/swarm/teamHelpers.ts',
      role: 'reused',
      symbol: 'writeTeamFileAsync',
      note: '复用团队文件路径、名称清理和 session cleanup 注册协议。',
    },
    {
      path: 'src/utils/messageQueueManager.ts',
      role: 'reused',
      symbol: 'enqueuePendingNotification',
      note: '复用既有任务通知队列及 later 优先级，不建立 PR 专用通知旁路。',
    },
  ],
  plan: {
    preconditions: [
      '确认父提交的 assistant gate、团队初始化和 session discovery 是禁用 stub，既有 main/dialog/command 条件注册点可以复用。',
      '确认 team、daemon、Brief 上传、OAuth teleport 和通知队列已经提供可组合接口，不需要发明新协议。',
      '将本机初始化、fake adapter 回归与 OAuth/Cloud/GitHub 在线验收分开，测试环境不使用真实凭据。',
      '确认 PR 的产品语义是轮询新增事件而非完整历史同步，首轮必须只建立基线。',
    ],
    reuse: [
      '复用 teamHelpers、tasks 和 teammateModeSnapshot 建立 leader team 与 in-process Agent 上下文。',
      '复用 prepareApiRequest/getOAuthHeaders 和既有 trust/OAuth 调用点，不在 gate 中另做 entitlement 判断。',
      '复用 startDaemon、uploadBriefAttachment、FileReadTool.checkPermissions 和 sendOSNotification。',
      '复用 gh api、parseGitHubRepository、enqueuePendingNotification 与 registerBundledSkill。',
      '复用 Bun feature profile 和独立子进程构建测试验证外部注册，而非只检查源文件。',
    ],
    steps: [
      {
        title: '实现 assistant 运行时与团队上下文',
        detail:
          '先在 assistant/index.ts 实现 forced/env/settings 激活、KAIROS runtime 开关和系统提示，再以现有 team helper 写 leader 配置、任务目录和 in-process layout。gate.ts 只委托运行时开关，保留原有信任与 OAuth 边界。随后让 /assistant start/status/sessions 使用这些状态与初始化函数。',
        paths: [
          'src/assistant/index.ts',
          'src/assistant/gate.ts',
          'src/commands/assistant/index.ts',
        ],
      },
      {
        title: '接通远程会话发现、选择和安装向导',
        detail:
          '在 sessionDiscovery.ts 实现 OAuth 请求和响应规范化，在 AssistantSessionChooser.tsx 用统一数据生成可选择列表。随后实现 NewInstallWizard 的默认目录、0700/0600 配置及 startDaemon 调用，让无远程会话时的安装路径与已有会话选择路径共享明确错误反馈。',
        paths: [
          'src/assistant/sessionDiscovery.ts',
          'src/assistant/AssistantSessionChooser.tsx',
          'src/commands/assistant/assistant.tsx',
        ],
      },
      {
        title: '实现文件上传与通知适配器',
        detail:
          '新增 SendUserFileTool，将 FileRead 权限、bridge 活动检查、lstat 普通文件约束和 Brief 上传组合，只有 fileId 才返回成功。新增 PushNotificationTool，按 webhook、OS、无适配器失败的顺序分发，并传递超时、取消及非 2xx 错误。',
        paths: [
          'src/tools/SendUserFileTool/SendUserFileTool.ts',
          'src/tools/PushNotificationTool/PushNotificationTool.ts',
        ],
      },
      {
        title: '实现 PR 订阅与 dream 注册',
        detail:
          '先实现 PRSubscriptionManager 的 head SHA 查询、三类事件拉取、首轮基线、ID 去重和通知，再让 SubscribePRTool 与 subscribe-pr 命令共享 manager 并处理默认仓库和 timer 清理。最后注册 dream prompt，把 auto-memory、项目目录和用户参数交给既有 consolidation builder。',
        paths: [
          'src/services/prSubscriptions.ts',
          'src/tools/SubscribePRTool/SubscribePRTool.ts',
          'src/commands/subscribe-pr.ts',
          'src/skills/bundled/dream.ts',
        ],
      },
      {
        title: '启用外部构建并验证注册',
        detail:
          '在正式构建和独立特性夹具中同时加入 KAIROS、KAIROS_GITHUB_WEBHOOKS，使已有条件注册点生效。更新 enabledFeatures 的工具总数、三个新工具和 assistant command 断言，在干净 Bun 进程检查 41 个非空工具，防止裁剪后的产物仍缺实现。',
        paths: [
          'scripts/build.ts',
          'tests/fixtures/verify-enabled-features.ts',
          'tests/enabledFeatures.test.ts',
        ],
      },
      {
        title: '补离线回归并记录真实证据边界',
        detail:
          '在 kairos.test.ts 用隔离配置目录和子进程验证真实团队文件，用 fake OS/fetchJson 验证通知及 PR 语义，用无 bridge 调用验证上传前置条件，并检查 dream prompt。STATUS/RELEASE 只记录实际 140/604、类型检查、构建和特性档结果，同时保留 Cloud、通知、GitHub 与多模型协作未在线验证的范围。',
        paths: [
          'tests/kairos.test.ts',
          'docs/STATUS.md',
          'docs/RELEASE.md',
        ],
      },
    ],
    compatibility: [
      '保留既有 assistant 命令、session viewer、team 文件和 Agent 调用约定，新实现填入原禁用位置。',
      'KAIROS 默认开放但可用 CLAUDE_KAIROS 显式关闭；既有 trust/OAuth 检查不被新的 runtime gate 替代。',
      'SendUserFile 沿用 FileRead 权限与 Brief 的 30 MiB/file_id 协议，调用方无需学习另一套上传配置。',
      'SubscribePR 工具与 slash command 共享单例，list/unsubscribe 对两个入口看到相同进程内状态。',
      'env-based bridge 和其他外部特性保持原路径，本提交只增加 KAIROS flags 与适配器。',
    ],
    risks: [
      '开放 gate 可能被误当作授权；通过保留信任、OAuth、org 检查并在设计中明确职责分离降低风险。',
      '团队初始化成功可能被误读为 teammate 已运行；返回结构和文档都限定为 leader 上下文。',
      '上传路径越权或虚假成功会暴露本地文件；FileRead 权限、普通文件检查及 fileId 成功条件是必要防线。',
      'PR 首次重放和重复通知会打扰用户；initialized 与 seen 必须在对 fresh 求值前后按正确顺序更新。',
      '基于 ID 的去重会漏掉同 ID 内容变化，内存订阅也无法跨重启；这些限制必须保留在剩余工作中。',
      'fake adapters 不能发现真实 OAuth、Cloud、GitHub 和 OS 时序问题，发布状态只能标 offline/build。',
    ],
    acceptanceSequence: [
      '运行 KAIROS 定向测试，检查 forced latch、隔离 team 文件、dream prompt 和 assistant 系统提示。',
      '验证 OS adapter 收到正确标题/消息、无适配器失败，以及无 bridge 时不会尝试上传。',
      '用可控 PR 响应执行首轮、新增、重复和退订四轮，观察通知队列与 manager.list。',
      '在干净 Bun 子进程构建特性档，核对 41 个非空工具、三个新工具和 assistant command。',
      '依据 at-commit STATUS 引用 140/604、typecheck、build/declarations，不把本记录的静态校验写成历史测试。',
      '在授权环境分别验收 OAuth session discovery、daemon/bridge 就绪、30 MiB 内实际上传、webhook/OS 投递及 gh/GitHub 往返，并单独记录结果。',
    ],
    completed: [
      'assistant gate、激活状态、leader team 初始化、session discovery 和 chooser 已从 stub 变为实际组件。',
      'assistant 命令与私有配置的 daemon 安装向导已接通既有 supervisor。',
      'SendUserFile、PushNotification、SubscribePR 及共享 PR 轮询管理器已经实现。',
      'dream、assistant、subscribe-pr 和三个工具已进入外部构建，特性档断言为 41 个非空工具。',
      '六项 KAIROS 离线回归和构建回归已经加入，at-commit 文档记录 140/604 与类型检查/构建。',
    ],
    incomplete: [
      'Cloud/OAuth session、文件上传、通知和 GitHub 的真实在线往返未在该提交执行。',
      '多 teammate 模型协作、远程 viewer 和 daemon worker 就绪没有由离线团队文件测试证明。',
      'PR 持久化、分页、同 ID 更新及后台防重入未实现，命令参数提示与显式 subscribe 解析仍有不一致。',
    ],
  },
})
