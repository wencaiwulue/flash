import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: '614bf48f749df56f79562e4c64f765875f8fd880',
  title: 'Enable external features and recover SDK parallel branches',
  kind: 'component',
  status: 'implemented',
  beforeState:
    '父提交 02bc3c2 的 CLI/SDK 外部构建均为 features: []，基础工具池记录为 23；ultraplan 位于 INTERNAL_ONLY_COMMANDS 且由 internal-user 检查禁用。CLI 的 buildConversationChain 已有私有 parallel-branch 恢复逻辑，而 SDK buildMainChain 只反转 single-parent walk，无法保留同 API message.id 的 assistant siblings 及其 tool_result 分支。',
  problem:
    '需要在外部 CLI 与 SDK 包中启用一组已经存在的 feature-gated 能力，并让 ultraplan 的构建注册与 Claude-AI 可用性分层工作。同时要把 CLI 的读侧 DAG 修复提取为可移植共享模块，在 SDK 转公开消息、过滤/分页以及 V2 transcript 装载之前恢复遗漏分支，且不能把没有 on-chain anchor 的无关分支接入会话。',
  goals: [
    '为 CLI 和 SDK 外部 bundle 配置同一组七个 feature flags，并满足 voice 实现所需的 ws runtime dependency。',
    '让 ultraplan 脱离 internal-only 注册块，以 claude-ai availability 保留运行时订阅门槛。',
    '将 parallel assistant/tool-result recovery 变成 CLI 与 SDK 共用的纯读侧变换，并固定插入顺序和 recoveredCount。',
    '用独立 bundle 与临时 JSONL 回归覆盖外部 profile、两条 SDK 读取出口及 disconnected-branch 拒绝。',
  ],
  nonGoals: [
    '不构建或宣称 USER_TYPE=ant；at-commit build 和验证夹具都显式使用 external。',
    '不启用完整 KAIROS、proactive、workflow 或 computer-use，也不实现仍处于 stub 的工具和 Coordinator worker。',
    '不改变 JSONL 写入拓扑、parentUuid 或 API message.id，恢复只发生在读取已持久化消息时。',
    '不把注册测试解释为 voice、bridge、remote trigger 或 ultraplan 的在线服务验证。',
    '不宣称新增测试覆盖了完整 V2 resumed-query；直接覆盖的是 loadSdkSessionTranscript。',
  ],
  architecture: [
    '构建层在 scripts/build.ts 为 CLI 与 SDK 同时声明 AGENT_TRIGGERS、AGENT_TRIGGERS_REMOTE、VOICE_MODE、BRIDGE_MODE、ULTRAPLAN、FILE_PERSISTENCE、KAIROS_BRIEF。它们打开现有 feature(...) 分支：前两项向工具池加入 CronCreate/CronDelete/CronList/RemoteTrigger，使命中数量由 23 变为 27；VOICE_MODE、BRIDGE_MODE、ULTRAPLAN、KAIROS_BRIEF 控制命令装载，FILE_PERSISTENCE 复用已有持久化路径。process.env.USER_TYPE 继续定义为 external，声明生成仍是独立 TypeScript 阶段。',
    'voice 的启用暴露已有 voiceStreamSTT 对 ws 的运行时导入，因此 package.json 增加 ws ^7.5.11，bun.lock 只增加 root dependency 引用，解析到的 ws 7.5.11 package entry 已由其他依赖提供。这项依赖是外部 profile 能实际 bundle/load 的组成条件，而不是新的传输协议实现。',
    '命令注册分为构建与运行时两道门：commands.ts 把 feature(ULTRAPLAN) 条件下的 ultraplan 从 INTERNAL_ONLY_COMMANDS 移入普通 COMMANDS；ultraplan.tsx 用 availability: [claude-ai] 和 isEnabled: () => true 替代 internal-user 判断。getCommands 先应用 availability 再检查 enabled，所以 builtInCommandNames 的注册断言只证明 bundle 含入口，并不表示所有 external 用户都可调用。',
    '共享恢复模块 recoverOrphanedParallelToolResults 接收 transcript-shaped messages、原 chain 和 seen，只依赖 type-only crypto.UUID。它按非空 API message.id 对 on-chain assistant 分组，以组内最后一个 on-chain assistant 为 anchor；再索引同 ID 的 assistant siblings 与含 tool_result 的 user messages。对每个触及主链的组，分别收集未见 siblings 和该组所有成员的未见 tool results，按 timestamp 稳定排序，并在 anchor 后依次插入 siblings、tool results。返回值是 { chain, recoveredCount }，不改写 seen。',
    'sessionStorage.ts 删除私有算法后由 buildConversationChain 调用共享 helper，CLI 独有的 tengu_chain_parallel_tr_recovered analytics 留在外层。sdkSessions.ts 则在 parent-UUID walk reverse 之后调用同一 helper，因此修复在公共转换之前生效，同时让 CLI 与 SDK 使用同一 anchor、排序和缺失父节点规则。没有匹配 on-chain assistant 的 sibling group 不进入结果。',
    '公开读取路径由 getSessionMessages 经 getSdkSessionMessages 进入 buildMainChain，恢复完成后才执行 toSessionMessage、null/system filtering 和 offset/limit；因此分页基于补齐后的顺序。V2 resume 经 resumeSdkSession 调用 loadSdkSessionTranscript，也复用该 buildMainChain，再把恢复后的 initialMessages 交给 createSdkQuery。新增测试直接验证公开消息/分页和 transcript loader，并未把后者扩展成在线 query 测试。',
  ],
  decisions: [
    '七个标志在 CLI 与 SDK build definitions 中保持一致，避免两个外部产物对同一 feature 源码作不同裁剪；完整内部系统仍不随 KAIROS_BRIEF 自动开启。',
    '将恢复算法放在无 I/O、无 CLI analytics 的纯模块中，以可移植消息结构服务 SDK；日志副作用由 CLI 调用方根据 recoveredCount 自行保留。',
    '以同 ID 组内最后一条已在主链的 assistant 为插入锚点，而不是把所有孤儿附加到末尾，可保持 sibling/tool-result 与对应模型回复的局部关系。',
    '恢复只处理与主链有明确 message.id 关联的组；放宽到全文件搜索会把 disconnected branch 错接进当前会话。',
    'ultraplan 使用 claude-ai availability 而非把 isEnabled 直接当作订阅判断，使命名注册检查与实际命令过滤各自表达不同层次。',
  ],
  alternatives: [
    '回溯性比较：复制 CLI 私有恢复到 SDK 会少一次抽取，但两套 anchor、去重和排序规则容易漂移；共享纯函数增加泛型边界，换取两条读取链的一致行为。',
    '回溯性比较：在分页后补回遗漏消息无法修正 page 边界，也会让 transcript resume 看到不同顺序；实际把恢复放在 buildMainChain 末端，保证所有下游消费同一完整链。',
    '回溯性比较：把 ultraplan 留在 INTERNAL_ONLY_COMMANDS 可维持旧注册方式，却无法与本次外部 ULTRAPLAN 入口一致；移入普通条件注册后仍需 availability 防止无条件开放。',
  ],
  security: [
    'USER_TYPE 明确为 external，七个 flag 是逐项 allowlist；KAIROS_BRIEF 不等于开放完整 KAIROS 或其他内部实验系统。',
    'ultraplan 的 bundle 注册不绕过 Claude-AI availability，测试中的 builtInCommandNames 也不替代实际 getCommands 过滤。',
    '恢复 helper 只重组内存中的已读消息，不写 transcript、不修改 seen，也不把无 on-chain 关联的内容并入会话。',
    '外部 profile 回归在干净子进程中构建/加载 bundle；真实 voice、bridge、remote 与 OAuth 服务仍需各自授权环境验证。',
  ],
  acceptance: [
    'CLI/SDK 构建同时含指定七个 flags 和 USER_TYPE=external，独立 profile 为 27 个非空工具并含四个 trigger 工具及 ultraplan、voice、brief 注册。',
    'ws 作为 runtime dependency 被 package manifest 与 lockfile 一致引用，能够支撑启用后的 voice bundle。',
    '同一 API message.id 的遗漏 assistant siblings 与 tool results 按确定顺序插回 anchor 后，公开转换、分页和 transcript loader 得到一致链。',
    '没有匹配主链 assistant 的 disconnected branches 保持排除，CLI recovery analytics 仍能取得 recoveredCount。',
    'at-commit STATUS/RELEASE 把全量记录更新为 64 tests、261 assertions，且不把父提交的 CI run 归到本提交。',
  ],
  evidence: [
    {
      kind: 'diff-observed',
      statement: 'CLI 与 SDK 构建都列出七个外部 flags，USER_TYPE 为 external；ultraplan 注册改用 claude-ai availability。',
      source: {
        path: 'scripts/build.ts',
        role: 'evidence',
        revision: 'commit',
        symbol: 'AGENT_TRIGGERS_REMOTE',
        note: '外部 CLI/SDK feature profile 的直接实现证据。',
      },
    },
    {
      kind: 'test-added',
      statement: '新增独立 bundle 回归，固定 27 个非空工具、四个 trigger 工具和 ultraplan/voice/brief 注册；此项声明测试加入，不单独声称执行通过。',
      source: {
        path: 'tests/enabledFeatures.test.ts',
        role: 'test',
        revision: 'commit',
        symbol: 'includes real trigger, remote, voice, and brief implementations',
        note: '通过干净 Bun 子进程加载外部构建夹具。',
      },
    },
    {
      kind: 'test-added',
      statement: 'SDK 临时 JSONL 回归新增恢复后公开顺序、UUID 唯一性、transcript 顺序、两段分页，以及 missing-parent 场景不接入无关分支。',
      source: {
        path: 'tests/sdkSessions.test.ts',
        role: 'test',
        revision: 'commit',
        symbol: 'recovers parallel assistant branches before SDK conversion and pagination',
        note: '覆盖共享恢复在 SDK 两条读取出口中的位置；不是完整 V2 在线测试。',
      },
    },
    {
      kind: 'recorded-command-pass',
      statement: 'at-commit STATUS 记录 bun test 为 64 tests、261 assertions，typecheck 零错误，build 产出 CLI、SDK 与 declarations。',
      source: {
        path: 'docs/STATUS.md',
        role: 'evidence',
        revision: 'commit',
        symbol: '| `bun test` | 64 tests, 261 assertions passed |',
        note: '历史全量结果较父提交增加 3 tests、14 assertions。',
      },
    },
    {
      kind: 'recorded-command-pass',
      statement: 'RELEASE 的 External feature profile and SDK DAG recovery 段记录 64/261、typecheck、build、declarations 和 CLI/SDK smoke checks 通过。',
      source: {
        path: 'docs/RELEASE.md',
        role: 'evidence',
        revision: 'commit',
        symbol: '## External feature profile and SDK DAG recovery',
        note: '本提交发布段的验证汇总，不包含该提交的 CI run ID。',
      },
    },
    {
      kind: 'not-recorded',
      statement: '本提交没有归属于 614bf48 的 CI run 记录，也没有 voice/bridge/remote/ultraplan 在线往返或完整 V2 resumed-query 结果。',
    },
  ],
  remaining: [
    '真实 Cloud API、remote bridge、voice、trigger 与 ultraplan 服务路径仍需授权环境验证，oauth refresh 证据仍为 mocked。',
    '完整内部系统和剩余 stub/proactive/Coordinator 能力没有被七个外部 flags 自动实现。',
    'V2 测试止于 transcript loader；恢复后的消息进入完整 resumed query 的端到端行为未由新增回归覆盖。',
  ],
  references: [
    {
      path: 'package.json',
      role: 'changed',
      symbol: '"ws": "^7.5.11"',
      note: '为启用 VOICE_MODE 后既有 voiceStreamSTT 的 WebSocket import 增加 runtime dependency。',
    },
    {
      path: 'bun.lock',
      role: 'changed',
      symbol: '"ws": "^7.5.11"',
      note: '在 root packages 引用 ws ^7.5.11；复用 lockfile 已存在的解析条目。',
    },
    {
      path: 'scripts/build.ts',
      role: 'changed',
      symbol: 'KAIROS_BRIEF',
      note: '对 CLI 与 SDK 开启相同七个 feature flags，并保持 USER_TYPE=external 和独立声明构建。',
    },
    {
      path: 'src/commands.ts',
      role: 'changed',
      symbol: 'INTERNAL_ONLY_COMMANDS',
      note: '将条件 ultraplan 注册移出 internal-only block，加入普通 COMMANDS 组成。',
    },
    {
      path: 'src/commands/ultraplan.tsx',
      role: 'changed',
      symbol: "availability: ['claude-ai']",
      note: '用 Claude-AI availability 替代 internal-user enablement，保留构建 feature 与运行时订阅两层限制。',
    },
    {
      path: 'src/utils/sessionChainRecovery.ts',
      role: 'changed',
      symbol: 'recoverOrphanedParallelToolResults',
      note: '新增纯共享 DAG 恢复：同 ID 分组、anchor 插入、时间排序、seen 去重和 recoveredCount。',
    },
    {
      path: 'src/utils/sessionStorage.ts',
      role: 'changed',
      symbol: 'buildConversationChain',
      note: '删除 112 行私有恢复实现并复用共享 helper，CLI analytics 留在调用层。',
    },
    {
      path: 'src/utils/sdkSessions.ts',
      role: 'changed',
      symbol: 'buildMainChain',
      note: '在 reverse 后、公开转换/分页及 transcript 消费前执行共享恢复。',
    },
    {
      path: 'tests/fixtures/feature-check.ts',
      role: 'changed',
      symbol: 'getAllBaseTools',
      note: '为独立外部 bundle re-export 工具池与 builtInCommandNames。',
    },
    {
      path: 'tests/fixtures/verify-enabled-features.ts',
      role: 'changed',
      symbol: 'FEATURE_PROFILE=',
      note: '以相同七 flags 和 external 用户类型执行 Bun.build，加载产物并输出工具/命令 profile。',
    },
    {
      path: 'tests/enabledFeatures.test.ts',
      role: 'changed',
      symbol: 'toolCount',
      note: '新增子进程回归，检查 27/null=0、四个 trigger 工具和三个命令注册。',
    },
    {
      path: 'tests/sdkSessions.test.ts',
      role: 'changed',
      symbol: 'does not recover unrelated branches across a missing parent',
      note: '新增两个 JSONL 测试，覆盖恢复后读/分页/transcript 顺序和 disconnected branch 拒绝。',
    },
    {
      path: 'docs/STATUS.md',
      role: 'changed',
      symbol: 'parallel assistant/tool-result DAG recovery',
      note: '更新 64/261、27 工具、外部特性矩阵、DAG 证据、ultraplan availability 与后续工作。',
    },
    {
      path: 'docs/RELEASE.md',
      role: 'changed',
      symbol: '## External feature profile and SDK DAG recovery',
      note: '新增本组件的发布说明和 64/261 等验证汇总，未附本提交 CI run。',
    },
    {
      path: 'src/tools.ts',
      role: 'reused',
      symbol: 'AGENT_TRIGGERS_REMOTE',
      note: '复用现有 feature-gated 工具组装，使四个 trigger 工具进入外部基础池。',
    },
    {
      path: 'src/services/voiceStreamSTT.ts',
      role: 'reused',
      symbol: "from 'ws'",
      note: '既有 voice 实现是新增 ws runtime dependency 的直接消费者。',
    },
    {
      path: 'src/entrypoints/agentSdkTypes.ts',
      role: 'reused',
      symbol: 'getSessionMessages',
      note: '公开 SDK 消息读取经 getSdkSessionMessages 消费恢复后的链，再做转换和分页。',
    },
    {
      path: 'src/utils/sdkSessionConversation.ts',
      role: 'reused',
      symbol: 'loadSdkSessionTranscript',
      note: 'V2 resume 复用同一 transcript loader 取得恢复后的 initialMessages。',
    },
  ],
  plan: {
    preconditions: [
      '确认父构建 features 为空、工具池为 23，且 voice 的 ws import 已存在但 manifest 缺 runtime dependency。',
      '以父 sessionStorage 的私有恢复为算法基准，确认 SDK 两条读取路径都经过 buildMainChain。',
      '区分 builtInCommandNames 的注册可见性与 getCommands 的 availability 过滤，不预设 external 等于 unrestricted。',
    ],
    reuse: [
      '复用 feature(...) 分支、getAllBaseTools、builtInCommandNames 和现有 trigger/voice/bridge/file-persistence/brief 实现。',
      '复用 CLI 已有同 message.id、tool_result、timestamp 恢复规则及 tengu_chain_parallel_tr_recovered 事件。',
      '复用 getSdkSessionMessages、toSessionMessage、loadSdkSessionTranscript 和现有 JSONL 测试工具。',
    ],
    steps: [
      {
        title: '补齐 voice 运行时依赖',
        detail:
          '先在 package.json 声明 ws ^7.5.11，再更新 bun.lock 的 root 引用并复用已有解析条目，使后续 VOICE_MODE bundle 能解析既有 voiceStreamSTT import。',
        paths: ['package.json', 'bun.lock'],
      },
      {
        title: '配置外部构建与命令门槛',
        detail:
          '在 scripts/build.ts 为 CLI/SDK 同步加入七 flags 并保持 external；随后把 ultraplan 从 internal-only 注册移入普通命令数组，在命令定义中设置 claude-ai availability 和非 internal-user 的 enabled 判断。',
        paths: ['scripts/build.ts', 'src/commands.ts', 'src/commands/ultraplan.tsx'],
      },
      {
        title: '提取共享 DAG 恢复',
        detail:
          '依据父 CLI 私有实现新建 sessionChainRecovery.ts，泛化可移植消息类型，固定同 ID 分组、最后 on-chain anchor、分别排序与插入以及无 anchor 排除。让 sessionStorage.ts 改用 helper 并保留 analytics，再让 sdkSessions.ts 在 reverse 后调用，以同时覆盖公开读取和 transcript loader。',
        paths: [
          'src/utils/sessionChainRecovery.ts',
          'src/utils/sessionStorage.ts',
          'src/utils/sdkSessions.ts',
        ],
      },
      {
        title: '建立外部 profile 与 DAG 回归',
        detail:
          '用 feature-check.ts 导出注册入口，verify-enabled-features.ts 构建并加载真实外部 bundle，enabledFeatures.test.ts 固定 27 工具和命令结果。再在 sdkSessions.test.ts 构造 parallel siblings/tool results，核对公开顺序、分页、transcript 与 disconnected-parent 反例。',
        paths: [
          'tests/fixtures/feature-check.ts',
          'tests/fixtures/verify-enabled-features.ts',
          'tests/enabledFeatures.test.ts',
          'tests/sdkSessions.test.ts',
        ],
      },
      {
        title: '同步状态与发布证据',
        detail:
          '将 STATUS 的 61/247 更新为实际记录的 64/261、工具数更新为 27，并说明 external feature 与 SDK DAG 范围；RELEASE 追加组件段及命令汇总，不复制父提交 CI run，也不把 mock/offline 测试写成在线服务证据。',
        paths: ['docs/STATUS.md', 'docs/RELEASE.md'],
      },
    ],
    compatibility: [
      'feature flags 只改变外部 bundle 的既有分支裁剪，原函数和命令名称保持，声明生成流程不变。',
      '读侧恢复维持原消息对象和持久化格式；没有 orphan 的链只经过同一 helper，不改变写入协议。',
      'offset/limit 继续由公开 API 提供，但页边界现在基于恢复后的完整消息序列。',
      'CLI analytics 与 SDK 纯恢复解耦，SDK 不需要引入 CLI 日志依赖。',
    ],
    risks: [
      '同 ID sibling 与 tool_result 若混合排序会破坏局部因果；实现分组后分别排序，并固定 assistants 在前、results 在后。',
      '跨 missing parent 搜索可能纳入无关会话内容；只有触及主链的 message.id 组才允许恢复。',
      '构建注册与运行时 availability 含义不同，单看 builtInCommandNames 会高估 ultraplan 的可用用户范围。',
      '新增 feature 可能暴露未声明依赖；ws 入库和独立 bundle/load 测试用于提前发现这一问题。',
      '后续提交增加 flags/工具数时不能直接沿用本提交的 27，应以 at-commit profile 为准。',
    ],
    verification: [
      '构建干净外部夹具，检查 USER_TYPE=external、27 个非空工具、四个 trigger 工具和 ultraplan/voice/brief 注册。',
      '用临时 JSONL 验证同 ID assistant siblings 与 results 的精确顺序、UUID 唯一性和 offset/limit 页面。',
      '直接调用 loadSdkSessionTranscript，确认它与公开读取获得相同恢复顺序，并单独测试 missing-parent 排除。',
      '检查 CLI 调用仍产生 recovered_count 日志而共享 helper 不修改 seen 或持久化文件。',
      '引用 at-commit STATUS/RELEASE 的 64/261、typecheck、build 和 smoke 记录，不虚构 614bf48 的 CI 或在线服务结果。',
    ],
    completed: [
      '外部依赖、七标志构建和 ultraplan 双层门槛已经形成可加载 profile。',
      '共享纯恢复已替换 CLI 私有实现，并嵌入 SDK 主链构建的统一前置位置。',
      '三个新增离线回归覆盖 profile、消息/分页/transcript 以及 disconnected branch 反例。',
      '文档已记录本提交的 64/261 与构建验证范围。',
    ],
    incomplete: [
      '真实外部服务和完整 V2 resumed-query 没有新增在线证据。',
      '被继续禁用的内部系统及其 stub/proactive/Coordinator 工作仍待独立实现。',
    ],
  },
})
