import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: '85028f74ed5ec110dcfd0a0933f615f88cc4600e',
  title: '临时缩减 live workflow 的 job 解析面',
  kind: 'component',
  status: 'partial',
  beforeState:
    '父提交仍有 model、skillhub、cloud、desktop 四个 job，但 model/cloud/desktop 已不再绑定 named Environment。model/cloud 的 secrets job-if 文本仍保留且不受该位置支持，desktop 的 vars 条件保留，四个验证脚本也都存在。',
  problem:
    '提交主题把变化称为隔离 live workflow 的 job 解析，实际做法是从 workflow 删除 Cloud 与 desktop 两个完整 job，只留下 model 和 skillhub。没有解析错误或平台日志可用于进一步解释原因；可确定的是两类验证在 CI 编排中消失，而脚本和四 job 文档仍保留。',
  goals: [
    '从 live-validation.yml 删除 cloud 与 desktop 的完整 job 定义，共 31 行。',
    '保持 model 和 skillhub 的条件、runner、安装步骤、脚本命令与环境映射逐字不变。',
  ],
  nonGoals: [
    '不把 Cloud/desktop 描述为已执行但被跳过：此 revision 的 workflow 中根本没有这两个 job。',
    '不删除或修改 Cloud/desktop 脚本，不将脚本存在等同于 CI 覆盖仍存在。',
    '不推断具体 YAML 解析故障，不改变 model/SkillHub gate，也不声明 workflow 注册或运行通过。',
    '不提前记录后续的条件下放、脚本 skip guard 或 live-checks.yml 重命名。',
  ],
  architecture: [
    'at-commit workflow 只有 model 与 skillhub 两个 ubuntu-latest job。model 的 if 文本仍要求非 pull_request 且 API key 非空，但 secrets context 在 jobs.<job_id>.if 不受支持；skillhub 仍要求非 pull_request。二者都没有 Environment 字段，该状态继承自父提交而非本提交新删。',
    'cloud 与 desktop 的 runner、步骤和 env 映射随 job 整段消失。对应 scripts/live-cloud-validation.ts 与 scripts/live-desktop-validation.ts 仍在仓库，可独立调用，但此 workflow 不再引用它们，因此没有 Cloud OAuth job 或 self-hosted desktop job 可参与汇总。',
  ],
  decisions: [
    '以删除 CI job 而不是给脚本加 guard 来缩小当次 workflow 范围；这使解析面缩减与验证覆盖缩减同时发生。',
    '保留两个外部能力脚本以便后续复用，但本提交没有恢复入口或更新 RELEASE，故只能记为 partial。',
    '仅依据补丁描述中间态，不把提交主题的 parsing 字样扩写成已证实的具体解析器缺陷。',
  ],
  alternatives: [
    '保留 job 并用条件跳过，或给脚本增加缺省配置分支，都能保留可见编排；它们不是此 revision 的实现，且与当前“job absent”语义不同。',
    '同步缩减 RELEASE 的四 job 描述可避免文档偏差，但本提交没有修改文档。',
  ],
  security: [
    'Cloud secret 与 self-hosted desktop 执行面从该 workflow 移除，但脚本本身的授权要求没有变化，直接调用仍须遵循原边界。',
    'model 和 SkillHub 的凭据映射、隔离目录及 contents: read 权限未改；补丁不包含凭据值。',
  ],
  acceptance: [
    'diff 仅删除 cloud 与 desktop 两个 job，model/skillhub 内容和 workflow 触发器保持原样；model 遗留的 secrets job-if 限制必须明确保留。',
    '当前 workflow 搜索不到 cloud: 或 desktop: job，且不能把 absent 写成 skipped。',
    '两个被移除 job 的脚本仍存在且未改，RELEASE 的四 job 文案与实际编排不一致被明确保留为缺陷。',
  ],
  evidence: [
    {
      kind: 'diff-observed',
      statement: '补丁恰好删除 cloud 和 desktop 共 31 行；at-commit 文件只剩 model 与 skillhub，其中 model 仍带不受支持的 secrets job-if。',
      source: { path: '.github/workflows/live-validation.yml', role: 'evidence', revision: 'commit', symbol: 'jobs:', note: '中间态二 job 编排的直接来源。' },
    },
    {
      kind: 'diff-observed',
      statement: 'Cloud 脚本仍包含 bridge resume 与 CLOUD_LIVE_OK，证明被移除的是 workflow 入口而不是脚本实现。',
      source: { path: 'scripts/live-cloud-validation.ts', role: 'evidence', revision: 'commit', symbol: 'CLOUD_LIVE_OK', note: '未修改的 Cloud 能力边界。' },
    },
    {
      kind: 'diff-observed',
      statement: 'desktop 脚本仍有 DESKTOP_LIVE_SKIPPED 与 screenshot 路径，但此 sentinel 不会由已不存在于 workflow 的 desktop job 产生。',
      source: { path: 'scripts/live-desktop-validation.ts', role: 'evidence', revision: 'commit', symbol: 'DESKTOP_LIVE_SKIPPED', note: '脚本保留不等于 CI job 存在或执行。' },
    },
    {
      kind: 'diff-observed',
      statement: 'RELEASE 仍描述 separate model、SkillHub、Cloud、desktop jobs，与当前二 job workflow 不符。',
      source: { path: 'docs/RELEASE.md', role: 'evidence', revision: 'commit', symbol: 'with separate model, SkillHub, Cloud, and desktop', note: '本提交未修改的遗留四 job 描述。' },
    },
    {
      kind: 'not-recorded',
      statement: '没有 YAML 解析诊断、Actions run 或 Cloud/desktop sentinel；无法从该补丁证明隔离后平台注册成功。',
    },
  ],
  remaining: [
    'Cloud 与 desktop 的 CI 入口在此 revision 缺失，后续必须重新编排才能恢复相应检查。',
    'model 的 secrets job-if 仍不受支持，RELEASE 四 job 描述也未修正；没有平台证据证明这次解析隔离达到主题所指效果。',
  ],
  references: [
    { path: '.github/workflows/live-validation.yml', role: 'changed', symbol: 'jobs:', note: '删除 cloud 与 desktop 完整 job，仅保留 model 和 skillhub。' },
    { path: 'scripts/live-cloud-validation.ts', role: 'reused', revision: 'commit', symbol: 'CLOUD_LIVE_OK', note: '脚本仍在，但当前 workflow 不再调用。' },
    { path: 'scripts/live-desktop-validation.ts', role: 'reused', revision: 'commit', symbol: 'DESKTOP_LIVE_SKIPPED', note: '脚本 guard 仍在，但当前没有 desktop job 可产生 skip。' },
    { path: 'docs/RELEASE.md', role: 'reused', revision: 'commit', symbol: 'with separate model, SkillHub, Cloud, and desktop', note: '遗留四 job 说明，与中间态二 job 编排不一致。' },
  ],
  plan: {
    preconditions: [
      '读取 6ef3352651472a951a3779f7b9f906fbc5ca86ca 的完整四 job 文件，确认 Environment 已在父提交移除，本步只处理 Cloud/desktop job。',
    ],
    reuse: [
      '保留 model 与 SkillHub 的既有命令、隔离目录和 gate，并保留两个外部能力脚本供直接调用或后续恢复。',
    ],
    steps: [
      {
        title: '确定要保留的二 job 基线',
        detail: '核对 model 与 skillhub 的起止范围及其 if，明确本提交不重排或改写这两段，也不重新添加 Environment。',
        paths: ['.github/workflows/live-validation.yml'],
      },
      {
        title: '整段移除 Cloud 与 desktop 编排',
        detail: '先删除 cloud 的 runner、安装、OAuth env 和脚本步骤，再删除 desktop 的 self-hosted runner、变量 gate、隔离 env 与 screenshot 脚本步骤。',
        paths: ['.github/workflows/live-validation.yml'],
      },
      {
        title: '核对脚本留存与覆盖缺口',
        detail: '读取两个脚本确认实现未删，再把它们标记为 workflow 未引用；对照 RELEASE 记录四 job 文案偏差，且没有运行证据时不声称解析已修复。',
        paths: ['scripts/live-cloud-validation.ts', 'scripts/live-desktop-validation.ts', 'docs/RELEASE.md'],
      },
    ],
    compatibility: [
      '手动和定时触发、model/SkillHub 的既有路径不变；model 的 secrets job-if 上下文缺陷也未在本提交处理。',
      'Cloud 与 desktop 从 CI job 变为仅脚本可调用；absent 不代表条件求值为 skipped。',
      '原 Environment 解除状态保持不变，本提交没有重命名 workflow 或改变内部 name。',
    ],
    risks: [
      '仅看脚本和 RELEASE 会误以为 Cloud/desktop 仍由 CI 覆盖，实际已没有相应 job。',
      '若后续只复制最终四 job 状态而不记录此中间态，会丢失此次隔离对验证范围的真实影响。',
    ],
    verification: [
      '检查 diff 为单文件 31 行删除，并在 at-commit YAML 中确认仅 model、skillhub 两个 job。',
      '分别确认 Cloud/desktop 脚本 blob 未改，且不为其虚构 skip 或 live 成功日志。',
      '后续若恢复 job，应以新的 revision 和运行记录证明，不回填为本提交结果。',
    ],
    completed: [
      'Cloud/desktop 的 31 行 CI 编排已移除，model 与 SkillHub 保持原条件及步骤。',
      '两个被移除入口对应的脚本仍完整保留。',
    ],
    incomplete: [
      'Cloud/desktop CI 覆盖与文档一致性尚未恢复，model 的 secrets job-if 仍无效，平台解析和 workflow 执行均无证据。',
    ],
  },
})
