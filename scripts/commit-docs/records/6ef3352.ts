import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: '6ef3352651472a951a3779f7b9f906fbc5ca86ca',
  title: '解除 live job 的预建 Environment 依赖',
  kind: 'component',
  status: 'partial',
  beforeState:
    '父提交刚加入四个 live job，其中 model、cloud、desktop 都声明 environment: live-validation，skillhub 没有该字段。model/cloud 的 job if 仍直接使用该位置不支持的 secrets context；desktop 保留 vars 条件和 self-hosted runner。',
  problem:
    '提交主题要求允许 job 在没有预建 Environment 时运行，实际补丁只删除三个 Environment 绑定。这样可以改变平台对 named Environment 的依赖，但不会修改任何凭据或桌面开关条件，也不修复 model/cloud 在 job if 使用 secrets 的上下文错误；提交没有平台错误、运行结果或文档同步。',
  goals: [
    '删除 model、cloud、desktop 的 environment: live-validation 三行。',
    '保持四个 job、各自 if、runner、步骤、环境变量映射、触发器和 contents: read 权限不变。',
  ],
  nonGoals: [
    '不删除 model 的 secret gate、Cloud 的三项 secret gate 或 desktop 的仓库变量 gate。',
    '不修改任何验证脚本，不宣称 Cloud/desktop 已执行，也不记录 workflow 注册或 CI 通过。',
    '不处理后续提交才出现的 job 删除、无条件运行或 workflow 重命名。',
  ],
  architecture: [
    '此 revision 仍是同一 live-validation.yml 和四个 job。变化仅在 job 到 GitHub Environment 的绑定：model 与 cloud 继续是 ubuntu-latest，desktop 继续是 self-hosted，三者不再引用 live-validation Environment；skillhub 原本就没有该绑定。',
    '可用性判断仍只位于 job if，model/cloud 没有脚本 guard；但 secrets 在 jobs.<job_id>.if 不受支持，不能声称未配置时会可靠跳过。desktop 的 vars gate 保留，变量非 1 时不会进入脚本；本提交没有把这些判断迁移到脚本。',
  ],
  decisions: [
    '采用最小三行删除来解除 named Environment 依赖，而不同时改写 secret 映射或 job 条件。',
    '保留父提交文档不改，使 RELEASE 中 OAuth/desktop 仅在 protected environment 存在时运行的描述不再准确对应当前 workflow；因此本记录将提交标为 partial，而非隐去这一缺陷。',
  ],
  alternatives: [
    '保留 Environment 并另行预建它属于平台配置方案，不是本 diff；同时更新 RELEASE 或调整 gate 能保持一致性，但本提交也未采用。',
  ],
  security: [
    '删除 named Environment 绑定意味着这些 job 不再由该 Environment 提供保护边界，既有 secret 条件和变量条件仍保留。',
    '补丁不包含凭据值，不改变 contents: read，也不把 desktop 移到 hosted runner。',
  ],
  acceptance: [
    'diff 恰好删除三个 environment 字段，四个 job 及其余 YAML 保持原样。',
    'model、cloud、desktop 在该 revision 不再依赖 live-validation Environment；desktop 仍由 vars 条件控制，model/cloud 的 secrets job-if 则仍存在上下文限制。',
    '没有将移除 Environment 描述为取消凭据 gate、脚本 skip 或 live 验证成功。',
  ],
  evidence: [
    {
      kind: 'diff-observed',
      statement: 'at-commit workflow 保留 model、skillhub、cloud、desktop 及全部原 if，仅不再有 model/cloud/desktop 的 environment 行。',
      source: { path: '.github/workflows/live-validation.yml', role: 'evidence', revision: 'commit', symbol: 'jobs:', note: '三行删除后的完整 job 结构来源。' },
    },
    {
      kind: 'diff-observed',
      statement: 'RELEASE 仍声称 OAuth 和 desktop job 只在 protected environment 存在时运行，与当前不再引用 named Environment 的 workflow 不一致。',
      source: { path: 'docs/RELEASE.md', role: 'evidence', revision: 'commit', symbol: 'protected environment is present', note: '本提交未修改文档，故该来源用于确认遗留描述。' },
    },
    {
      kind: 'not-recorded',
      statement: '提交没有 Actions 解析结果、run ID 或任何 live sentinel；无法据此声称无 Environment 的 job 已在平台成功注册或执行。',
    },
  ],
  remaining: [
    'RELEASE 的 protected environment 描述尚未与三行删除同步。',
    'model/cloud 的 secrets job-if 仍不受支持；解除 Environment 绑定后的 workflow 注册、条件求值和各 job 实际运行也需要平台侧证据。',
  ],
  references: [
    { path: '.github/workflows/live-validation.yml', role: 'changed', symbol: 'jobs:', note: '仅删除 model、cloud、desktop 的 live-validation Environment 绑定。' },
    { path: 'docs/RELEASE.md', role: 'reused', revision: 'commit', symbol: 'protected environment is present', note: '未随补丁更新，保留了对 protected environment 的过时依赖描述。' },
    { path: 'scripts/live-desktop-validation.ts', role: 'reused', revision: 'commit', symbol: "process.env.CLAUDE_DESKTOP_LIVE !== '1'", note: '脚本开关未改；workflow 的仓库变量 job gate 也仍独立存在。' },
  ],
  plan: {
    preconditions: [
      '以 9cd4c63193ded6eb916bf734f65a427da193faf0 的四 job workflow 为基线，逐行确认只有三个 job 带 Environment。',
    ],
    reuse: [
      '复用现有触发器、只读权限、四个脚本入口及所有 secret/vars 映射，不新增 CI 抽象。',
    ],
    steps: [
      {
        title: '核对 Environment 与 gate 的差别',
        detail: '先区分 named Environment 绑定、model/Cloud 凭据条件和 desktop 变量条件，避免把三种控制混为一个开关。',
        paths: ['.github/workflows/live-validation.yml', 'scripts/live-desktop-validation.ts'],
      },
      {
        title: '删除三个 Environment 绑定',
        detail: '依次从 model、cloud、desktop 删除 environment: live-validation，保持相邻 runs-on、if 和 steps 原样，skillhub 不作补齐。',
        paths: ['.github/workflows/live-validation.yml'],
      },
      {
        title: '检查遗留文档与证据缺口',
        detail: '对照 RELEASE 的 protected environment 表述并标记不一致；平台运行未记录时，仅确认 YAML diff，不补写 CI 成功。',
        paths: ['.github/workflows/live-validation.yml', 'docs/RELEASE.md'],
      },
    ],
    compatibility: [
      'workflow_dispatch、cron、四 job 名称和脚本调用不变。',
      'desktop 变量非 1 仍是 job-level skip，不是脚本输出 skip；model/cloud 没有脚本 guard，且 secrets job-if 不受支持，不能承诺无凭据时有效跳过。',
      '依赖 live-validation Environment 保护或 Environment secrets 的部署语义不再由该 workflow 提供。',
    ],
    risks: [
      '把 Environment 删除误解为凭据条件删除会高估变更范围；model/cloud 虽未删除 if，但 secrets context 不受支持，条件文本存在不等于门控有效。',
      '失去 named Environment 保护是实际安全边界变化，且旧 RELEASE 会误导后续审查。',
    ],
    verification: [
      '用父提交与当前提交的 workflow diff 确认恰好三行删除，再读取当前文件核对四个 if 全部保留。',
      '若后续取得平台证据，应分别报告 job skipped 与脚本 executed；本提交自身不声明这类结果。',
    ],
    completed: [
      'model、cloud、desktop 的 named Environment 绑定已删除，其他 job 编排保持不变。',
    ],
    incomplete: [
      '文档与新的 Environment 语义未同步，model/cloud 的 secrets job-if 仍无效，workflow 注册和 live job 行为未留下运行证据。',
    ],
  },
})
