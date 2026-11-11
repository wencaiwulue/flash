import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: '17f52b5584441f3c937f3d927acad381852159b7',
  slug: 'unconditional-live-workflow-jobs',
  title: '移除 model 与 SkillHub 的 job 条件',
  kind: 'component',
  status: 'partial',
  beforeState:
    '父提交的 workflow 只剩 model 和 skillhub 两个 job：model 的 if 文本要求非 pull_request 且 API key 非空，但 secrets context 在 jobs.<job_id>.if 不受支持；skillhub 要求非 pull_request。Cloud 与 desktop job 已被移除但脚本仍在，model 脚本此时尚无缺少密钥时的 skip guard。',
  problem:
    '提交主题说明要测试没有 job conditions 的 workflow，补丁确实删除两个 if。删除后 model 对声明的触发器不再有 job 级凭据判断，也没有对应的脚本缺省分支，因此未配置时同样会安装依赖并进入 live 探针；Cloud/desktop 仍保持上一步的 absent 状态，不能用后来的脚本 guard 或最终 CI 结果解释当前设计。',
  goals: [
    '删除 model 的非 pull_request/API key 复合条件和 skillhub 的非 pull_request 条件。',
    '保持两个 job 的 runner、安装步骤、脚本调用、env 映射以及 workflow_dispatch/schedule 不变。',
  ],
  nonGoals: [
    '不恢复 Cloud 或 desktop job，也不把它们的 absent 状态写成 skipped 或 executed。',
    '不新增 MODEL_LIVE_SKIPPED 或 CLOUD_LIVE_SKIPPED；这些属于后续 revision。',
    '不重命名 live-validation.yml、不改变 name: live-validation，不宣称重新注册或 Actions 运行成功。',
    '不修改模型、SkillHub、Cloud 或桌面脚本及其外部服务边界。',
  ],
  architecture: [
    '当前 workflow 的两个 job 都没有 if，也没有 Environment 字段。对文件实际声明的 workflow_dispatch 与 schedule 而言，原非 pull_request 合取本就始终成立；删除它不改变这两类触发来源，但删除 model 的 secret 合取会实质扩大到无 API key 的运行。',
    'model 在无密钥时也会 checkout、安装 Bun 和依赖，再调用原脚本。该脚本直接从 enableConfigs、getMainLoopModel 和 workflow probe 开始，没有 MODEL_LIVE_SKIPPED 分支，所以当前行为是尝试 live 验证并在后续配置或请求处暴露失败，而不是已定义的优雅 skip。',
    'skillhub 同样无条件进入脚本，但其脚本在 URL 未配置时使用公共地址，token 可缺省，因此它和 model 的无条件运行语义不同。Cloud/desktop 依旧不出现在 YAML 中，即使脚本文件仍保留，也不会由该 workflow 调度。',
  ],
  decisions: [
    '以最小两行删除落实无 job conditions 的中间试验，不同时引入脚本 guard 或恢复其他 job。',
    '保留公共 SkillHub 的默认 URL 和可选 token，使该 job 的无条件运行仍有公共探针路径；model 没有等价公共无凭据路径，这是本 revision 的实际缺陷。',
    '保持文档不变意味着 RELEASE 的四 job 描述继续滞后；本记录因此采用 partial，而不把试验性两行删除包装成完整 live 方案。',
  ],
  alternatives: [
    '保留 model 的凭据 gate，或先给 model 增加无密钥提前返回，都能避免未配置 runner 进入 live probe；两者都不是本提交内容。',
    '只删除非 pull_request 判断而保留 secret 判断可减少行为扩张，但不符合实际删除整行 if 的补丁。',
  ],
  security: [
    'workflow 仍只有 contents: read，secret 值没有写入补丁或日志；无条件运行不等于凭据可被公开。',
    '未配置 model 现在会启动 hosted runner 并尝试外部探针，可能产生失败和非必要资源消耗；不能把它说成安全跳过。',
    'self-hosted desktop 不在当前 workflow 中，此次删除条件不会意外启动桌面 runner。',
  ],
  acceptance: [
    'diff 仅删除 model 与 skillhub 各一行 if，两个 job 的其他字段保持父提交内容。',
    '当前 model 脚本没有缺密钥 sentinel 或提前返回，无条件 job 与无条件脚本 skip 必须明确区分。',
    'SkillHub 默认公共地址仍可用，Cloud/desktop job 仍 absent，workflow 路径与内部名称均未改变。',
    '不从此补丁推断平台已接受 workflow 或任何 live probe 已通过。',
  ],  remaining: [
    'model 缺少与无条件 job 配套的无密钥 guard，未配置运行不会按后来的固定 sentinel 优雅跳过。',
    'Cloud/desktop CI 入口仍缺失，RELEASE 四 job 描述仍过时。',
    '该试验是否改善 workflow 注册或执行没有平台侧证据。',
  ],
  references: [
    { path: '.github/workflows/live-validation.yml', role: 'changed', symbol: 'jobs:', note: '删除 model 与 skillhub 的两个 if，保留二 job 及原触发器。' },
    { path: 'scripts/live-model-validation.ts', role: 'reused', revision: 'commit', symbol: 'async function main()', note: '未改脚本尚无密钥 guard，无条件 job 会进入 live 流程。' },
    { path: 'scripts/live-skillhub-validation.ts', role: 'reused', revision: 'commit', symbol: "process.env.CLAUDE_SKILL_REGISTRY_URL || 'https://skill.xfyun.cn'", note: '未改公共探针保留默认 URL 与可选 token。' },
    { path: 'scripts/live-cloud-validation.ts', role: 'reused', revision: 'commit', symbol: 'CLOUD_LIVE_OK', note: '脚本仍在但无 Cloud job，本提交没有恢复或执行它。' },
    { path: 'scripts/live-desktop-validation.ts', role: 'reused', revision: 'commit', symbol: 'DESKTOP_LIVE_SKIPPED', note: '脚本仍在但无 desktop job，不能把该标记归给当前 workflow。' },
    { path: 'docs/RELEASE.md', role: 'reused', revision: 'commit', symbol: 'with separate model, SkillHub, Cloud, and desktop', note: '遗留四 job 描述未随中间态更新。' },
  ],
  plan: {
    preconditions: [
      '以 85028f74ed5ec110dcfd0a0933f615f88cc4600e 的二 job workflow 为基线，确认 Cloud/desktop 已 absent，且本步不负责恢复。',
      '检查 model 与 SkillHub 脚本的缺省配置路径，区分公共无 token 探针和需要模型凭据的探针。',
    ],
    reuse: [
      '复用现有手动/定时触发、Bun 安装、隔离目录、公共 SkillHub 默认地址与模型清理流程。',
    ],
    steps: [
      {
        title: '核对两个条件的实际组成',
        detail: '拆分 model 的事件与 secret 合取以及 skillhub 的事件条件，确认本步消除了不受支持的 secrets 判断，同时让无密钥运行明确进入脚本。',
        paths: ['.github/workflows/live-validation.yml', 'scripts/live-model-validation.ts', 'scripts/live-skillhub-validation.ts'],
      },
      {
        title: '删除 model 与 SkillHub job if',
        detail: '分别移除两行完整条件，让 runs-on 紧跟 job 名称；不改触发器、步骤或 env，也不向二 job 添加 Environment。',
        paths: ['.github/workflows/live-validation.yml'],
      },
      {
        title: '审视未配置执行与缺失覆盖',
        detail: '读取 model 脚本确认没有提前 skip，读取公共 SkillHub 默认配置，并再次确认 Cloud/desktop 只有脚本没有 job；对照 RELEASE 留下文档偏差，不用后续 guard 补齐当前记录。',
        paths: ['scripts/live-model-validation.ts', 'scripts/live-skillhub-validation.ts', 'scripts/live-cloud-validation.ts', 'scripts/live-desktop-validation.ts', 'docs/RELEASE.md'],
      },
    ],
    compatibility: [
      'workflow_dispatch 与 cron 仍是唯一触发器，删除非 pull_request 判断本身不增加 pull_request 触发。',
      'model 的无效 secrets if 文本被删除；当前对声明的触发器始终启动，无密钥时也没有脚本级 skip 兼容层，不能把父版本条件当作可靠的旧跳过行为。',
      'SkillHub 的公共默认路径保持，自定义 URL/token 映射不变；Cloud/desktop 的 CI absent 状态保持。',
      '文件路径与 name: live-validation 不变，本提交没有 re-registration rename。',
    ],
    risks: [
      '无密钥 model 会消耗 runner 并进入真实探针，失败位置和错误形式取决于配置及外部请求，不能预设为固定 skip。',
      '将当前二 job 与后续四 job 成功记录混合，会错误声称 Cloud/desktop 在此 revision 被验证。',
      '旧文档仍描述四 job，可能掩盖中间态的覆盖缺口。',
    ],
    acceptanceSequence: [
      '比较父/当前 YAML，确认只有两行 if 删除，并检查当前 model 文件不存在后续 MODEL_LIVE_SKIPPED 分支。',
      '分别分析 model 与 SkillHub 的无配置路径，不把公共 SkillHub 可运行推广为 model 可跳过。',
      '若后续执行，应记录每个 job 的启动、脚本输出和外部请求结果；absent 的 Cloud/desktop 不列入 executed 或 skipped。',
    ],
    completed: [
      'model 与 SkillHub 的两个 job 条件已删除，其他 workflow 内容保持原样。',
      '已确认当前模型脚本无 guard、公共 SkillHub 有默认地址，以及 Cloud/desktop job 仍缺失。',
    ],
    incomplete: [
      'model 无配置行为尚未收敛为明确跳过，Cloud/desktop 编排和文档一致性未恢复，平台运行无证据。',
    ],
  },
})
