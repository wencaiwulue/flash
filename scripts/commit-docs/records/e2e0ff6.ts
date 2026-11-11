import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: 'e2e0ff6e0897141823d361204e81aef79922f33b',
  slug: 'ci-independent-feature-profile',
  title: 'Make feature profile test CI-independent',
  kind: 'component',
  status: 'implemented',
  beforeState:
    '父提交的 enabledFeatures 测试已经在独立 Bun 子进程中构建并加载真实外部特性包，且用占位 ANTHROPIC_API_KEY 和 NODE_ENV=production 避免凭据依赖及测试专用工具。但是子进程仍继承任意的 ANTHROPIC_BASE_URL 与 ENABLE_TOOL_SEARCH：ENABLE_TOOL_SEARCH=false/auto:100 或实验 beta kill switch 可强制 standard；在该变量未设置或为空且 ANTHROPIC_BASE_URL 指向非第一方代理时，代理保护也会排除 ToolSearchTool，画像因而可能预期 31 个工具。第一方端点下未显式配置仍默认 tst。fixture 的构建、特性列表和 FEATURE_PROFILE 输出协议均已存在，本提交不重写这些机制。',
  problem:
    '同一个外部构建测试需要在本机与 CI 的不同环境 overlay 下得到一致的工具注册结果。提交通过固定第一方端点和显式 tool-search 配置，使既有条件工具稳定进入画像，并把总数及必要成员更新为 32 与 ToolSearch。它解决的是这项测试的两个环境敏感输入，不证明所有继承变量都已隔离，也不把注册断言扩展成真实搜索或网络请求验证。',
  goals: [
    '在 feature-profile 子进程中覆盖继承的 ANTHROPIC_BASE_URL，固定使用 https://api.anthropic.com。',
    '显式设置 ENABLE_TOOL_SEARCH=true，使乐观门控在测试构建中选择 ToolSearchTool。',
    '把编译画像的期望更新为 32 个非空工具，并要求工具名子集包含 ToolSearch。',
    '同步 STATUS 与 RELEASE 中既有的工具池及画像数量记录。',
  ],
  nonGoals: [
    '不修改生产端点默认值、tool-search 默认模式、代理保护或实验 beta 开关。',
    '不实现 ToolSearchTool，也不调用其搜索、select 或 tool_reference 行为。',
    '不访问 Anthropic API，不验证占位 key、真实凭据、OAuth 或 provider/proxy 兼容性。',
    '不建立最小环境白名单；...process.env 及其余工具池变量仍然保留。',
    '不重新实现 proactive、Sleep 或 Coordinator worker，只复用上一提交加入画像的字段。',
  ],
  architecture: [
    '测试架构保持两级进程：外层 Bun test 用 Bun.spawn 执行 verify-enabled-features.ts，后者以 Bun.build 构造外部特性包，再动态 import 产物并输出 FEATURE_PROFILE JSON。 NODE_ENV=production 继续排除 TestingPermissionTool，占位 key 继续满足离线加载前提；新增的两个变量只是这一既有 env overlay 的覆盖项，而非 fixture 编译定义或生产配置。',
    'ToolSearch 的计数变化来自既有门控链。ENABLE_TOOL_SEARCH=true 经 getToolSearchMode 选择 tst，并使 isToolSearchEnabledOptimistic 跳过“未显式配置时的代理保护”；固定 https://api.anthropic.com 则由 isFirstPartyAnthropicBaseUrl 识别为第一方主机。getAllBaseTools 因而在条件插槽加入 ToolSearchTool，工具数由 31 变为 32。CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS 的高优先级 standard 强制路径没有被本提交改写。',
    '画像协议仍只输出注册表和少量状态字段。断言将 toolCount 固定为 32、nullCount 固定为 0，并在 arrayContaining 的必要子集中加入 ToolSearch；没有新增 expect 或测试用例，所以文档维持 77 tests、329 assertions。STATUS 的 Built-in tool pool 行与 RELEASE 的 Proactive state and Coordinator workers 验证句只同步这一总数， RELEASE 没有新增独立发布小节。',
  ],
  decisions: [
    '在现有子进程 env 中定点覆盖两个变量，而不是替换完整环境；改动小且直接对应可观察的 31/32 差异，但仍接受其他 ambient 变量影响画像的残余风险。',
    '选择官方第一方 URL 作为测试常量，以匹配现有 provider 判断；该常量不是 mock server，也不意味着测试会建立网络连接。',
    '同时断言总数和 ToolSearch 成员，避免只靠数量掩盖目标工具缺失；但没有把 32 个名称改成完整有序快照，以保留既有画像测试形态。',
    '只更新历史验证文档的数量，不把 ToolSearch 注册解释为模型支持、搜索质量或真实 API 可用性。',
  ],
  alternatives: [
    '回溯性比较：可以用最小 env allowlist 获得更强 hermetic 性，但那会扩大本提交对子进程加载条件的调整面；实际方案保留 ...process.env，仅固定已识别的端点和开关，残余变量仍需后续硬化。',
    '回溯性比较：可以在生产代码中默认开启 ToolSearch 来稳定数量，却会改变用户及代理环境行为；实际只改测试进程，生产门控保持原样。',
    '回溯性比较：可以删除 tool-search 条件或 mock getAllBaseTools 来避免环境敏感，但那会削弱真实 bundle 注册验证；实际继续构建并加载真实 registry。',
  ],
  security: [
    'ANTHROPIC_API_KEY 使用明确占位文本，测试不需要有效密钥；fixture 没有模型查询步骤。',
    '固定 URL 是真实官方端点而非禁网地址，当前无网络调用不代表未来增加调用时会自动被沙箱阻止。',
    '子进程仍继承其他环境变量，潜在认证材料没有被逐一清除；因此安全结论是无需有效 Anthropic key，而不是完全无凭据环境。',
    'fixture 继续把 USER_TYPE 编译为 external，没有引入内部用户构建或额外权限。',
  ],
  acceptance: [
    '子进程环境显式包含固定 ANTHROPIC_BASE_URL、ENABLE_TOOL_SEARCH=true、占位 key 和 production 模式。',
    '真实外部 bundle 加载后报告 32 个工具、0 个 null，且必要工具子集包含 ToolSearch。',
    '测试不要求有效 API 凭据，不发起模型或 ToolSearch 调用。',
    'STATUS 与 RELEASE 的相关数量均为 32，原 77/329 测试与断言总数不被虚增。',
  ],  remaining: [
    'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS 仍可从父环境强制 standard，其他工具池变量也仍可改变画像，完全确定性尚未建立。',
    '总数加必要子集不能发现所有同名数量替换或完整工具组成错误，也没有在该画像测试中断言名称唯一性。',
    'ToolSearch 的真实搜索行为、模型支持及不同 provider/proxy 的兼容性仍需独立测试。',
  ],
  references: [
    {
      path: 'tests/enabledFeatures.test.ts',
      role: 'changed',
      symbol: 'ENABLE_TOOL_SEARCH',
      note: '固定两个环境输入，并把真实 bundle 画像更新为 32 个非空工具和 ToolSearch 必要成员。',
    },
    {
      path: 'docs/STATUS.md',
      role: 'changed',
      symbol: 'Built-in tool pool',
      note: '将 Built-in tool pool 的外部画像数量从 31 同步为 32。',
    },
    {
      path: 'docs/RELEASE.md',
      role: 'changed',
      symbol: '## Proactive state and Coordinator workers',
      note: '在既有 proactive/coordinator 发布验证句中同步 32-tool 数量，不新增功能发布范围。',
    },
    {
      path: 'tests/fixtures/verify-enabled-features.ts',
      role: 'reused',
      symbol: 'FEATURE_PROFILE=',
      note: '复用独立 Bun.build、外部 USER_TYPE 编译定义、bundle import 和画像 JSON 输出。',
    },
    {
      path: 'tests/fixtures/feature-check.ts',
      role: 'reused',
      symbol: 'getAllBaseTools',
      note: '复用真实 registry、proactive 状态和 coordinator 定义的导出入口。',
    },
    {
      path: 'src/tools.ts',
      role: 'reused',
      symbol: 'ToolSearchTool',
      note: '复用既有乐观门控条件插槽，本提交没有修改生产工具池。',
    },
    {
      path: 'src/utils/toolSearch.ts',
      role: 'reused',
      symbol: 'isToolSearchEnabledOptimistic',
      note: '复用模式解析、实验 beta kill switch 与代理启发式来解释测试环境效果。',
    },
    {
      path: 'src/utils/model/providers.ts',
      role: 'reused',
      symbol: 'isFirstPartyAnthropicBaseUrl',
      note: '复用第一方 base URL 主机判断，固定端点与该逻辑相匹配。',
    },
    {
      path: 'src/tools/ToolSearchTool/ToolSearchTool.ts',
      role: 'reused',
      symbol: 'ToolSearchTool',
      note: '复用完整既有工具实现；画像测试只观察注册，不调用搜索。',
    },
  ],
  plan: {
    preconditions: [
      '确认父提交画像在独立子进程中构建真实外部 bundle，并已固定占位 key 与 production 模式。',
      '确认 ToolSearchTool 已存在且由 isToolSearchEnabledOptimistic 条件注册，31/32 差异可由环境门控解释。',
      '把离线注册验证与 API、搜索行为验证分开，测试常量不能被描述为真实凭据或网络结果。',
    ],
    reuse: [
      '复用 Bun.spawn 的 stdout/stderr 收集、超时终止和临时目录清理，不新增测试进程框架。',
      '复用 verify-enabled-features.ts 与 feature-check.ts 的构建、导出和 FEATURE_PROFILE 协议。',
      '复用 toolSearch.ts、providers.ts、tools.ts 和 ToolSearchTool 的生产门控及注册实现。',
      '复用 STATUS/RELEASE 已记录的离线验证结果，仅同步工具数量。',
    ],
    steps: [
      {
        title: '固定画像子进程的搜索环境',
        detail: '在 enabledFeatures.test.ts 的 Bun.spawn env overlay 中加入 ANTHROPIC_BASE_URL=https://api.anthropic.com 和 ENABLE_TOOL_SEARCH=true，保留 ...process.env、占位 key 与 NODE_ENV=production。这样只控制该测试进程的端点识别和乐观搜索门控，不改 fixture 或生产默认值。',
        paths: ['tests/enabledFeatures.test.ts'],
      },
      {
        title: '收紧真实 bundle 注册预期',
        detail: '在同一画像断言中把 toolCount 改为 32、维持 nullCount 为 0，并向 arrayContaining 加入 ToolSearch。继续复用独立构建 fixture 输出的 JSON，不调用 ToolSearchTool，也不增加测试或 expect 数量。',
        paths: ['tests/enabledFeatures.test.ts', 'tests/fixtures/verify-enabled-features.ts'],
      },
      {
        title: '同步历史能力数量',
        detail: '把 STATUS 的 Built-in tool pool 记录与 RELEASE 的编译画像验证数量同步为 32，保留 77/329 和真实 proactive/multi-worker 未运行等原有边界，不新增无来源的 CI 或 live 结论。',
        paths: ['docs/STATUS.md', 'docs/RELEASE.md'],
      },
    ],
    compatibility: [
      '生产源码和构建脚本未改，用户端点、tool-search 默认模式及代理策略保持原行为。',
      'fixture 仍以 external USER_TYPE 构建，既有 proactive、Coordinator、Monitor 等画像字段和断言继续有效。',
      '硬编码总数需要随后续真实 registry 演进同步更新，这是既有画像契约的延续。',
    ],
    risks: [
      '继承的实验 beta kill switch 可覆盖 ENABLE_TOOL_SEARCH=true，其他环境变量也可改变工具池，CI-independent 不是完全 hermetic。',
      '官方 URL 常量不具网络隔离语义；若 fixture 未来加入请求，需要另设 mock 或禁网保护。',
      '总数与九项名称子集可能遗漏未列举工具的组成回归，不能替代完整工具池测试。',
    ],
    acceptanceSequence: [
      '检查子进程 env 同时含固定端点、显式搜索开关、占位 key 和 production。',
      '运行 enabledFeatures 定向测试，读取真实 bundle 的 toolCount=32、nullCount=0 与 ToolSearch 成员。',
      '分别在继承自定义 base URL、不同 ENABLE_TOOL_SEARCH 值的环境中比较画像稳定性，并单独记录残余 kill switch 条件。',
      '依据 at-commit STATUS/RELEASE 引用 77/329、typecheck、build 和 32-tool profile，不把静态记录校验当成历史命令重跑。',
      '如需验证搜索或网络行为，另写 ToolSearch 调用与授权 provider 测试，不从本画像结果推断。',
    ],
    completed: [
      '两个环境敏感输入已在测试子进程中固定。',
      '32 个非空工具及 ToolSearch 必要成员已成为画像契约。',
      'STATUS 与 RELEASE 的工具数量已经同步。',
      'at-commit 文档保留了 77/329 离线结果及 live 验证边界。',
    ],
    incomplete: [
      '完整环境隔离和其他工具池变量的确定性尚未完成。',
      'ToolSearch 行为、真实 API 连通性及 provider/proxy 兼容性未在该提交验证。',
      '画像没有覆盖全部 32 个名称或该文件内的名称唯一性。',
    ],
  },
})
