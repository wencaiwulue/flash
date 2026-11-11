import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: '9cd4c63193ded6eb916bf734f65a427da193faf0',
  title: '新增 live 验证工作流并兼容 SkillHub 响应',
  kind: 'component',
  status: 'partial',
  beforeState:
    '父提交没有 live-validation workflow，也没有四个专用验证脚本。SkillHub 搜索在 namespace 缺失时回填 default，只接受字符串 latestVersion，并仅从 name、description 读取显示信息；STATUS 仍把真实 registry、Cloud 和原生桌面往返列为待验证边界。',
  problem:
    '需要把已有模型、SkillHub、Cloud 与桌面能力分别接入可手动或定时运行的 CI 探针，同时让公共 SkillHub 的实际响应字段映射到现有搜索结果。每类检查需要隔离配置并给出可识别 sentinel，但本地脚本记录、hosted workflow 结果以及需要 OAuth 或交互桌面的验证必须分别陈述。model/cloud 还在 jobs.<job_id>.if 使用不受支持的 secrets context，因此新增 workflow 不能记为完整可靠的 CI 门控。',
  goals: [
    '新增 workflow_dispatch 与每日 schedule 的只读 workflow，编排 model、skillhub、cloud、desktop 四个独立 job。',
    '以 job 条件控制模型凭据、Cloud 三项配置和桌面开关，并为 model、cloud、desktop 绑定 live-validation Environment。',
    '为各 job 设置独立 HOME 与 CLAUDE_CONFIG_DIR，运行对应 Bun 脚本并输出固定成功标记。',
    '覆盖模型 workflow、proactive/Sleep、context collapse、reactive compaction，以及 SkillHub 搜索、下载和版本缓存命中。',
    '保留 Cloud bridge 持久会话恢复、文件持久化、归档与清理链，以及桌面 screenshot 和客户端关闭。',
    '兼容 global namespace、对象或字符串 latestVersion、displayName/name 与 summary/description 回退，并记录真实证据边界。',
  ],
  nonGoals: [
    '不把 RELEASE 中的本地模型和公共 SkillHub sentinel 写成 GitHub Actions workflow 已通过。',
    '不宣称 Cloud OAuth、Cloud Files、bridge resume 或桌面 screenshot 已在此提交执行成功。',
    '不把公共 registry 成功扩展为私有或 self-hosted SkillHub 已验证。',
    '不引入后续提交才有的 model/cloud 脚本缺省跳过逻辑，也不改变现有 agent、bridge 或桌面协议。',
  ],
  architecture: [
    'CI 层新增单一 live-validation.yml：model/cloud 的 job if 直接使用 secrets，desktop 使用 vars，skillhub 只检查事件。jobs.<job_id>.if 不支持 secrets context，故 model/cloud 不能表述为缺凭据时可靠跳过；desktop 的 vars 与 skillhub 的 github 条件才是受支持的输入。skillhub 不绑定 named Environment，也不要求 token；其余三个 job 在该 revision 显式使用 live-validation Environment。',
    '每个 job 都 checkout、安装 Bun 1.3.14、冻结锁文件安装依赖，再用独立 HOME 和 CLAUDE_CONFIG_DIR 启动脚本。这里的隔离是不同 job 使用不同路径；cloud 与 SkillHub 另以 mkdtemp 管理工作目录或缓存，不能据此推断 self-hosted runner 上的固定配置目录每次都会全新创建。',
    'model 脚本先启用配置并解析主模型，再串行执行四个探针：真实 workflow 完成、proactive 激活后的 Sleep、100 token 窗口下的一次 context collapse、以及 reactive compaction。任一状态或结果断言失败都会抛错，四项分别输出 WORKFLOW_LIVE_OK、PROACTIVE_LIVE_OK、CONTEXT_COLLAPSE_LIVE_OK、REACTIVE_COMPACTION_LIVE_OK，外层 finally 统一清理。',
    'SkillHub 适配层保持现有请求、解包和列表提取，只扩展记录字段归一化：缺省 namespace 改为 global；版本依次取 version、latestVersion.version、字符串 latestVersion；名称依次取 displayName、name、slug；摘要依次取 summary、description、空串。live 脚本用默认公共地址或显式地址搜索 code，构造 namespace/slug 下载，再读同一缓存目录验证第二次 cacheHit。',
    'Cloud 脚本独立于模型与桌面：从既有 OAuth 配置取 access token，组织 UUID 可由环境或接口获得，base URL 可直接回退既有 OAuth 配置。它创建并写回首个 perpetual bridge session， teardown 后恢复并比较 session ID，再设置 Cloud Files 所需环境、写入嵌套文件、执行 persistence 和 archive，最后清理注册资源与临时目录。不过 workflow 的三项 secret gate 比脚本回退更严格。',
    'desktop 脚本保留独立开关：直接调用时变量非 1 只输出 DESKTOP_LIVE_SKIPPED；workflow 一旦通过变量 gate，又在步骤中显式传 1，因此会取得 computer-use client、调用 screenshot、检查 isError 并关闭客户端。该路径需要 self-hosted 与交互桌面，和 hosted model/SkillHub 证据不可混算。',
  ],
  decisions: [
    '初始 revision 试图用 job 级条件阻止未配置探针，而不是在 model/cloud 脚本内输出跳过标记；但 secrets 不是 jobs.<job_id>.if 的受支持上下文，只有 desktop 的 vars gate 可按该语义分析，model/cloud 不能宣称会可靠 job-skip。',
    '模型四个检查共用一个隔离脚本和最终清理，SkillHub、Cloud、desktop 则分别保有自身临时资源与成功条件，避免一个总脚本混淆外部依赖。',
    'SkillHub 新字段按明确优先级回退，保留显式旧字段和字符串 latestVersion 的兼容性；只有缺省 namespace 的返回值从 default 改为 global。',
    'STATUS 只把 SkillHub 提升为 live public registry，并继续列出 Cloud 与原生桌面的授权环境需求；RELEASE 的五项 sentinel 只归属于模型四项和 SkillHub 一项。',
  ],
  alternatives: [
    '回溯性比较：把所有探针放进一个 job 能减少重复安装步骤，却会共享配置、凭据和失败面；实际采用四 job 隔离，代价是 workflow 编排重复。',
    '回溯性比较：只放宽 SkillHub 类型而不规定字段优先级会留下不确定映射；实际实现使用逐级回退，保留旧响应但优先使用公共 registry 的新字段。',
    '回溯性比较：可以让 Cloud workflow 依赖脚本的 org/base URL 回退而减少 gate；本 revision 仍要求三项 secret 全非空，不能把直接调用能力当作 CI 条件。',
  ],
  security: [
    'workflow 权限仅为 contents: read，凭据通过既有 secrets/vars 映射进入对应步骤；记录只写字段名和固定 sentinel，不包含任何凭据值。',
    'SkillHub token 仍由既有 client 转成 Authorization 头，live 脚本只输出成功标记；URL、namespace 和 slug 路径段按既有方式编码。',
    'model、Cloud、desktop 使用分离配置目录，SkillHub 缓存由 finally 删除；Cloud 只有进入 live try/finally 后才清理临时目录，缺 token 或组织解析失败发生在该块之前。self-hosted desktop 的固定目录仍需运行环境自行保证隔离。',
    '移除或绕过外部授权不属于本提交；Cloud 与 desktop 没有执行证据时继续保持未验证状态。',
  ],
  acceptance: [
    'workflow 含四个指定 job、两个触发器、只读权限及各自身份条件，model/cloud/desktop 的 Environment 与 runner 选择符合补丁。',
    '模型脚本严格按四个探针顺序检查真实结果并输出四个 sentinel，任何失败不会被改写为成功。',
    'SkillHub 搜索无结果、下载内容异常或第二次未命中缓存都会失败，成功才输出 SKILLHUB_LIVE_OK。',
    'Cloud 恢复后的 session ID 必须一致，持久化必须返回至少一个文件，archive 后才输出 CLOUD_LIVE_OK。',
    'desktop 仅在开关为 1 时调用 screenshot，错误结果会抛错并关闭客户端；skip 与成功是不同标记。',
    'SkillHub 字段回退顺序和 global 缺省值与 at-commit 实现一致，显式旧字段仍可使用。',
    '提交文档只记录模型与公共 SkillHub live sentinel；Cloud、desktop 和 hosted workflow 均无伪造成功结论。',
  ],
  evidence: [
    {
      kind: 'recorded-command-pass',
      statement: 'at-commit RELEASE 记录 live 脚本返回 WORKFLOW_LIVE_OK、PROACTIVE_LIVE_OK、CONTEXT_COLLAPSE_LIVE_OK、REACTIVE_COMPACTION_LIVE_OK 与 SKILLHUB_LIVE_OK；这是历史文档中的模型四项和公共 SkillHub 一项结果，不是本次记录编写重新执行。',
      source: { path: 'docs/RELEASE.md', role: 'evidence', revision: 'commit', symbol: 'Live script checks returned', note: '五个 sentinel 及其公共 SkillHub 范围的直接来源。' },
    },
    {
      kind: 'diff-observed',
      statement: '初始 workflow 的 model/cloud 在 job if 使用不受支持的 secrets context，desktop 使用 vars，且只有 model、cloud、desktop 声明 live-validation Environment。',
      source: { path: '.github/workflows/live-validation.yml', role: 'evidence', revision: 'commit', symbol: 'jobs:', note: 'at-commit 编排、隔离路径和触发器证据。' },
    },
    {
      kind: 'diff-observed',
      statement: 'SkillHub client 在该 revision 使用 global 缺省 namespace，并支持对象 latestVersion.version、displayName 和 summary 的优先回退。',
      source: { path: 'src/services/skillSearch/skillhubClient.ts', role: 'evidence', revision: 'commit', symbol: 'const latest = value.latestVersion', note: '响应字段兼容的直接实现。' },
    },
    {
      kind: 'diff-observed',
      statement: 'Cloud 脚本包含 bridge 重建、同 ID 恢复、文件持久化和 archive 断言，desktop 脚本包含独立 skip 分支与 screenshot 检查；代码存在不等于探针已运行。',
      source: { path: 'scripts/live-cloud-validation.ts', role: 'evidence', revision: 'commit', symbol: 'Bridge session resume failed', note: 'Cloud 代码路径证据；desktop 另由变更引用覆盖。' },
    },
    {
      kind: 'diff-observed',
      statement: 'STATUS 将 SkillHub 标为 live public registry，同时仍要求授权 Claude OAuth 环境和授权交互桌面/VM，明确两类后续验证边界。',
      source: { path: 'docs/STATUS.md', role: 'evidence', revision: 'commit', symbol: 'Run native Computer Use control', note: 'Cloud 与桌面后续步骤及公共 registry 状态来源。' },
    },
    {
      kind: 'not-recorded',
      statement: '此提交没有 GitHub Actions run ID，也没有 CLOUD_LIVE_OK 或 DESKTOP_LIVE_OK 的执行记录；不能把脚本新增或后续运行倒记为当时证据。',
    },
  ],
  remaining: [
    'model/cloud 的 secrets job-if 不受支持，需要改用有效门控或脚本 guard；不能依赖当前条件获得可预测的 CI 跳过。',
    'Cloud OAuth、perpetual bridge、Cloud Files 与原生桌面 screenshot 仍需各自授权环境的真实执行结果。',
    '私有或 self-hosted SkillHub 仍是可选的独立验证，公共 registry 成功不覆盖其认证和部署差异。',
    '初始 workflow 是否被平台注册以及四个 job 的实际执行或跳过情况，此提交没有平台侧记录。',
  ],
  references: [
    { path: '.github/workflows/live-validation.yml', role: 'changed', symbol: 'name: live-validation', note: '新增四 job 的手动/定时 live 编排、条件、Environment、runner 和隔离环境。' },
    { path: 'scripts/live-model-validation.ts', role: 'changed', symbol: 'WORKFLOW_LIVE_OK', note: '新增模型 workflow、proactive、context collapse 与 reactive compaction 四段探针。' },
    { path: 'scripts/live-skillhub-validation.ts', role: 'changed', symbol: 'SKILLHUB_LIVE_OK', note: '新增公共或显式 registry 的搜索、下载、内容检查及缓存命中验证。' },
    { path: 'scripts/live-cloud-validation.ts', role: 'changed', symbol: 'CLOUD_LIVE_OK', note: '新增 OAuth bridge 恢复、Cloud Files 持久化、归档与清理验证。' },
    { path: 'scripts/live-desktop-validation.ts', role: 'changed', symbol: 'DESKTOP_LIVE_SKIPPED', note: '新增独立桌面开关、screenshot 探针和客户端关闭。' },
    { path: 'src/services/skillSearch/skillhubClient.ts', role: 'changed', symbol: 'const latest = value.latestVersion', note: '扩展 global namespace 和新旧响应字段的确定性归一化。' },
    { path: 'docs/RELEASE.md', role: 'changed', symbol: '## CI live validation', note: '记录四 job 设计、隔离配置及模型/公共 SkillHub sentinel，不包含 Cloud/desktop 成功。' },
    { path: 'docs/STATUS.md', role: 'changed', symbol: 'Verified (live public registry)', note: '提升公共 SkillHub 证据状态，同时保留私有 registry、Cloud 和桌面边界。' },
    { path: 'src/services/skillSearch/remoteSkillLoader.ts', role: 'reused', revision: 'commit', symbol: 'loadRemoteSkill', note: '复用既有远程技能下载和版本缓存，不在 live 脚本重写加载协议。' },
    { path: 'src/bridge/remoteBridgeCore.ts', role: 'reused', revision: 'commit', symbol: 'initEnvLessBridgeCore', note: '复用既有 env-less perpetual bridge 实现完成 Cloud 探针。' },
  ],
  plan: {
    preconditions: [
      '以父提交缺少 workflow/四个脚本及旧 SkillHub 字段归一化为基线，先核对现有模型、bridge、remote loader 与 computer-use API。',
      '准备独立的外部验证矩阵：本地模型与公共 SkillHub、OAuth Cloud、self-hosted 交互桌面、hosted Actions 分别留证。',
    ],
    reuse: [
      '复用 startWorkflowTask、proactive/Sleep、context collapse 和 reactive compaction 的生产入口，不建立模型测试旁路。',
      '复用 SkillHubClient、loadRemoteSkill、initEnvLessBridgeCore、runFilePersistence 和 open computer-use client。',
      '沿用 cleanupRegistry、OAuth 配置、任务上下文及现有 STATUS/RELEASE 证据格式。',
    ],
    steps: [
      {
        title: '归一化公共 SkillHub 响应',
        detail: '先调整 namespace 缺省值，再按既定优先级加入 latestVersion 对象、displayName 与 summary 回退，保持已有搜索请求和显式旧字段兼容。',
        paths: ['src/services/skillSearch/skillhubClient.ts'],
      },
      {
        title: '实现模型与 SkillHub 探针',
        detail: '依次串接四个模型检查及各自断言，再实现 SkillHub 搜索、远程内容读取和第二次缓存命中；两者只输出固定 sentinel，并保留模型清理与 SkillHub 临时缓存删除。',
        paths: ['scripts/live-model-validation.ts', 'scripts/live-skillhub-validation.ts', 'src/services/skillSearch/remoteSkillLoader.ts'],
      },
      {
        title: '实现 Cloud 与桌面独立探针',
        detail: 'Cloud 依次创建、写入、恢复并核对 session，再持久化文件和归档；desktop 保留开关分支，启用时调用 screenshot 并关闭客户端。两条路径分别处理资源，不共享模型成功结论。',
        paths: ['scripts/live-cloud-validation.ts', 'scripts/live-desktop-validation.ts', 'src/bridge/remoteBridgeCore.ts'],
      },
      {
        title: '编排四个隔离 CI job',
        detail: '新增手动和定时 workflow，逐 job 配置条件、runner、必要的 Environment、依赖安装及独立 HOME/CLAUDE_CONFIG_DIR；skillhub 保持公共默认，同时核对 model/cloud 的 secrets job-if 不受支持，不能与 desktop 的 vars gate 混为可靠执行条件。',
        paths: ['.github/workflows/live-validation.yml'],
      },
      {
        title: '记录分层验证结果与边界',
        detail: '在 RELEASE 写入已有模型四项和 SkillHub 一项 sentinel，在 STATUS 仅提升公共 registry 状态，并保留 Cloud、交互桌面与私有 registry 的后续步骤；没有 run ID 时不声明 hosted CI 通过。',
        paths: ['docs/RELEASE.md', 'docs/STATUS.md'],
      },
    ],
    compatibility: [
      'SkillHub 显式 namespace、version、name、description 和字符串 latestVersion 仍可解析，仅缺省 namespace 和新字段优先级发生变化。',
      'Cloud 脚本直接调用可回退组织查询和默认 base URL；初始 workflow 的 if 文本虽列出三项 secret，但该位置不支持 secrets context，不能把文本门槛当作有效 CI 条件。',
      'desktop 直接调用可在变量非 1 时跳过；workflow 通过 gate 后显式传 1，因此该 job 内执行的是 live 分支。',
      '既有功能入口不变，新增脚本和 workflow 是独立验证面；模型/SkillHub 的历史 sentinel 不构成 Cloud/desktop 回归证据。',
    ],
    risks: [
      '四个 job 的外部依赖差异很大，统一 workflow 成功可能被误读；必须逐 job 记录 executed、skipped 与 absent，而非只看汇总状态。',
      'self-hosted desktop 使用固定配置路径，若 runner 复用目录，隔离强度不同于全新 hosted runner。',
      'model/cloud 初始判断只写在不受支持的 secrets job-if 中，脚本没有 skip guard；既不能推断有效 job skip，也不会得到脚本 skip sentinel。',
      '公共响应字段回退可能掩盖异常数据类型，缺失 slug 的记录仍被过滤，版本字段仅在非空字符串时进入结果。',
    ],
    verification: [
      '静态比较父提交与当前提交，确认八个路径、四个新脚本和 SkillHub 四处字段映射全部覆盖。',
      '依据 at-commit RELEASE 引用模型四项与 SkillHub sentinel，不将该记录改写为本次重新运行或 Actions 结果。',
      '分别在授权 OAuth 与交互桌面环境运行对应脚本时，应检查 session ID、持久化文件、archive、screenshot 和清理，而非只等待进程退出。',
      '后续 hosted run 应逐 job 核对条件求值、runner、sentinel 和 skip；缺省或跳过不能提升为 live round trip 通过。',
      '以临时 registry 响应覆盖 global、latestVersion 对象/字符串、displayName/name 和 summary/description 的优先顺序。',
    ],
    completed: [
      '四个 live 脚本、四 job workflow 和独立配置路径已经加入。',
      'SkillHub global namespace 与响应字段兼容已经落地，远程加载继续复用既有 loader。',
      'at-commit 文档已经记录模型四项和公共 SkillHub sentinel，并保留 Cloud/desktop 的未验证边界。',
    ],
    incomplete: [
      'model/cloud 的有效 CI 门控尚未实现；Cloud 和桌面实际往返、私有 SkillHub 以及该 revision 的 hosted Actions 执行均没有随提交证据。',
    ],
  },
})
