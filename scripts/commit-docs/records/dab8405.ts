import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: 'dab8405a36c2cb18c22b58235c8124265666b162',
  slug: 'implementation-boundaries-status',
  title: 'Document remaining implementation boundaries',
  kind: 'evidence-update',
  status: 'implemented',
  beforeState:
    '父提交的 STATUS 尚未设独立的 Remaining implementation boundaries 小节，Next implementation order 也只有三项；下一步直接从模型、Cloud/remote 验证开始，尚未集中列出 stub、缺失协议与确定性测试缺口。',
  problem:
    '需要把仍未实现的系统与仅缺验证的项目分开写清，并重排后续工作，避免已有 Verified 项被误读为所有特性均已完成。本提交只更新状态文档，不实现这些边界中的任何功能。',
  goals: [
    '逐项记录 HISTORY_SNIP、REVIEW_ARTIFACT、远程 canonical skills、MonitorMcpTask、KAIROS/Buddy/Fork 与私有 computer-use 的剩余边界。',
    '列出 changed-file、cron、LSP 三类确定性生命周期测试缺口，并把实现和回归排在授权环境验证之前。',
  ],
  nonGoals: [
    '不修改产品代码、feature flag、测试或构建配置。',
    '不宣称新增文档中的后续任务已经执行，也不把既有 live 记录扩展到未验证环境。',
  ],
  architecture: [
    '本提交没有运行时架构变化。STATUS 以 Remaining implementation boundaries 保存静态能力边界，以 Next implementation order 保存工作先后；两部分都只描述规划和证据状态。',
  ],
  decisions: [
    '把 Monitor 工具已验证的 local-shell 路径与不可用的 legacy MonitorMcpTask 后端并列说明，避免将整个 Monitor 能力误记为 stub。',
    '把纯 env-less perpetual 保持在有条件项目的末位，同时保留已有 env-based bridge 提供连续性的限定。',
  ],
  alternatives: [
    '回溯性比较：只在能力表增加一行会丢失各 stub 和测试缺口的具体范围；把所有项目混写为未实现又会抹掉 local-shell Monitor 与 env-based continuity 的既有证据。',
  ],
  security: [
    'diff 仅包含 Markdown 状态和计划文字，没有新增凭据、权限、网络入口或代码执行路径。',
  ],
  acceptance: [
    '新增边界清单准确区分未实现 stub、缺失外部协议、替代实现和验证缺口。',
    '实施顺序由三项扩为五项，新增 HISTORY_SNIP/ReviewArtifact、changed-file/cron/LSP 回归及 reactive-compaction 模型验证，原有 Cloud 与 env-less 条件不变。',
  ],  remaining: [
    '清单中的 HISTORY_SNIP、ReviewArtifact、远程 canonical skills 和其他私有后端在该 revision 仍是边界，而非本次交付物。',
    'changed-file、cron、LSP 回归以及授权环境中的模型、Cloud、remote 验证仍按文档顺序待办。',
  ],
  references: [
    {
      path: 'docs/STATUS.md',
      role: 'changed',
      symbol: '## Remaining implementation boundaries',
      note: '唯一变更文件；新增剩余边界清单并扩写后续实施顺序。',
    },
  ],
  plan: {
    preconditions: [
      '对照父提交能力表和 Verified evidence，区分已经验证的替代路径与仍不可用的目标实现。',
    ],
    reuse: [
      '沿用 STATUS 的现有小节、表格和验证证据约定，不另建状态存储或索引。',
    ],
    steps: [
      {
        title: '补全边界并重排后续工作',
        detail:
          '在 STATUS.md 增加六条精确边界，再把实现 HISTORY_SNIP/ReviewArtifact、补 changed-file/cron/LSP 回归置于授权环境验证之前；保留 Cloud/remote 任务和纯 env-less perpetual 的产品条件。',
        paths: ['docs/STATUS.md'],
      },
    ],
    compatibility: [
      '既有 Verified evidence 表和状态定义不变，只增加边界说明并调整下一步编号。',
    ],
    risks: [
      '规划动词容易被误读为实现结果；正文必须使用 still、need 等边界措辞，并避免新增无来源的执行声明。',
    ],
    acceptanceSequence: [
      '逐行比较父提交与 at-commit STATUS，核对新增六条边界、五项顺序及唯一变更路径。',
    ],
    completed: [
      '剩余实现/验证边界和新的后续顺序已经写入 STATUS。',
    ],
    incomplete: [
      '文档没有完成所列实现、回归或授权环境验证，也没有新增执行日志。',
    ],
  },
})
