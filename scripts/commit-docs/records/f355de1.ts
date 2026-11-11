import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: 'f355de14f9baeccda3b49eed9e8e020fcae68e39',
  title: 'Finalize documentation for previous commit',
  kind: 'metadata-migration',
  status: 'implemented',
  beforeState: '本提交紧跟 2fe47f6，但实际补写的是其父提交 f251df9151d7a7c054fa662c4b50f0d09c1bf305。父快照已有 7ca78c1 条目，尚无 f251df9 的 SPEC/PLAN；INDEX Implemented 为 50，JSON commits 为 52 项。',
  problem: 'f251df9 已为 80e6def 建立文档，却仍没有自己的文档入口。此次要沿链条向前补一层，而不是误把刚完成 7ca78c1 登记的直接父提交 2fe47f6 当作目标。',
  goals: [
    '创建 f251df9 的 SPEC/PLAN，准确记录其完整 SHA、2026-11-11T10:59:48+08:00、Finalize previous commit documentation records 和 implemented。',
    '把目标提交为 80e6def 新建文档的四文件、77 行新增和 1 行删除范围同步到两个索引。',
  ],
  nonGoals: [
    '不补写直接父 2fe47f6 或 f355de1 自身的文档，也不改变已有 7ca78c1 条目。',
    '不修改运行时代码，不从 PLAN 的验证序列推导测试或 CI 已通过。',
  ],
  architecture: [
    '新增 SPEC/PLAN 承担 f251df9 的历史说明，INDEX 与 status JSON 分别提供人类和机器发现入口，构成四路径元数据闭合。',
    '新条目排在 7ca78c1 后、self 前；self 是独立占位身份，不会被替换成 f355de1，也不纳入 INDEX Implemented 汇总。',
  ],
  decisions: [
    '目标 SPEC 使用 77 行新增而非前一提交文档中的 145 行或本提交最终 diff 的 78 行，并列出 80e6def 的两个产物和两个索引。',
    'INDEX Implemented 50→51，其他状态计数不变；JSON commits 52→53，含 self 的 implemented 51→52，新对象为倒数第二项。',
    '本提交自身是 78 行新增、1 行删除的四文件变更，没有额外路径；self 行、self 对象及两个 self 文档均未改写。',
  ],
  alternatives: ['复制 2fe47f6 的六文件说明会错误扩大 f251df9 范围；把直接父作为新 frontmatter 又会让链条错位，所以保留祖父提交身份和 77 行统计。'],
  security: ['变更仅增加公开提交元数据和索引链接，没有密钥、权限边界或可执行内容变化。'],
  acceptance: [
    'SPEC 与 PLAN 的完整 SHA、标题、日期和 implemented 与 f251df9 一致。',
    'INDEX 新行、JSON 新对象和磁盘上的 f251df9 SPEC/PLAN 路径相互对应，self 仍在最后。',
  ],
  evidence: [
    {
      kind: 'diff-observed',
      statement: '新 SPEC 以完整 f251df9 SHA 为 frontmatter 身份，并记录目标四文件、77 行新增和 1 行删除。',
      source: { path: 'docs/specs/f251df9-SPEC.md', role: 'evidence', revision: 'commit', symbol: 'commit: f251df9151d7a7c054fa662c4b50f0d09c1bf305', note: 'frontmatter 与 Actual scope 固定目标身份和统计。' },
    },
    {
      kind: 'diff-observed',
      statement: '新 PLAN 包含实现步骤、验证序列及 implemented 完成状态。',
      source: { path: 'docs/plans/f251df9-PLAN.md', role: 'evidence', revision: 'commit', symbol: '## Completion status and remaining work', note: '计划的状态小节可直接核对。' },
    },
    {
      kind: 'diff-observed',
      statement: 'INDEX patch 将 Implemented 调整为 51，并在 7ca78c1 后、self 前加入 f251df9。',
      source: { path: 'docs/INDEX.md', role: 'evidence', revision: 'commit', symbol: '- Implemented: 51', note: '汇总和人类入口同步变化。' },
    },
    {
      kind: 'diff-observed',
      statement: 'status patch 新增 f251df9 对象，commits 总数由 52 变为 53，self 保持末位。',
      source: { path: 'docs/status/index.json', role: 'evidence', revision: 'commit', symbol: '"fullSha": "f251df9151d7a7c054fa662c4b50f0d09c1bf305"', note: '机器对象包含完整身份和 spec/plan 路径。' },
    },
    { kind: 'not-recorded', statement: '本提交没有 bun test、typecheck、build 或 CI 的执行日志，只有文档中的建议命令。' },
  ],
  remaining: ['直接父 2fe47f6 的文档此时尚未建立，当前 f355de1 也没有自我记录；两者不属于本次 f251df9 定稿范围。'],
  references: [
    { path: 'docs/INDEX.md', role: 'changed', note: 'Implemented 50→51，新行位于 7ca78c1 与 self 之间。' },
    { path: 'docs/plans/f251df9-PLAN.md', role: 'changed', note: '新建的 f251df9 实施与完成状态文档。' },
    { path: 'docs/specs/f251df9-SPEC.md', role: 'changed', note: '记录目标完整身份及 77 行新增的四文件范围。' },
    { path: 'docs/status/index.json', role: 'changed', note: 'commits 52→53，在 self 前注册 f251df9。' },
  ],
  plan: {
    preconditions: ['确认目标是直接父 2fe47f6 的父提交 f251df9，并核对其 80e6def 文档产物和 77 行统计。'],
    reuse: ['复用前一提交确立的文档字段与索引布局，已有 7ca78c1 和 self 条目保持顺序。'],
    steps: [
      { title: '编写 f251df9 SPEC', detail: '填入目标身份，围绕 80e6def 的两个文档和两个索引说明四文件范围。', paths: ['docs/specs/f251df9-SPEC.md'] },
      { title: '编写 f251df9 PLAN', detail: '用同一元数据承载目标实施步骤、风险、验证建议及完成状态。', paths: ['docs/plans/f251df9-PLAN.md'] },
      { title: '追加表格入口', detail: '在既有 7ca78c1 行之后插入 f251df9，并只把 Implemented 增至 51。', paths: ['docs/INDEX.md'] },
      { title: '追加机器对象', detail: '在 self 前登记完整 f251df9 SHA、日期、主题、状态和新文档路径。', paths: ['docs/status/index.json'] },
    ],
    compatibility: ['现有 7ca78c1 链接不改，self 的 changeId、文档 blob 和末尾位置保持兼容。'],
    risks: ['77、78 和前一目标的 145 行统计来源不同；若混用会使目标范围与本提交范围同时失真。'],
    verification: ['读取父/当前快照，核对新文件 frontmatter、目标 diff 统计、两个索引计数和 self 位置。'],
    completed: ['f251df9 的 SPEC/PLAN 已创建，INDEX 与 JSON 均已注册且计数一致。'],
    incomplete: ['验证命令没有实际输出可供本提交引用，未记录任何 CI 通过结论。'],
  },
})
