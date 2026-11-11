import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: '55f7c7e66db7653d2afaa546162a6dc486c547d7',
  title: 'Finalize documentation for previous change',
  kind: 'metadata-migration',
  status: 'implemented',
  beforeState: '直接父提交为 f355de1，本次定稿目标却是祖父提交 2fe47f6e46a3add0a3ee9bdd57bda9feac2220a7。父快照已登记 f251df9，但没有 2fe47f6 的 SPEC/PLAN；INDEX Implemented 为 51，status commits 为 53 项。',
  problem: '2fe47f6 已为 7ca78c1 补齐六文件范围说明，其自身仍缺乏文档身份。本提交需要沿链条补这一层，同时不能把直接父 f355de1 的 77 行目标统计或当前提交的 78 行统计误写进来。',
  goals: [
    '新建 2fe47f6 的 SPEC/PLAN，记录完整 SHA、Complete documentation for previous commit、2026-11-11T11:02:02+08:00 和 implemented。',
    '准确保留目标提交四文件、80 行新增、1 行删除及其 7ca78c1 两个产物，并同步两个索引。',
  ],
  nonGoals: [
    '不为直接父 f355de1 或当前 55f7c7e 建立文档，不改写既有 f251df9 条目。',
    '不触碰产品实现，也不将文档中的验证命令和 CI 名称当作执行证据。',
  ],
  architecture: [
    '本次四路径分为目标说明层和发现层：2fe47f6 SPEC/PLAN 是新增说明，INDEX 与 status JSON 各增加一个对应入口。',
    '条目顺序由 f251df9 延伸到 2fe47f6，self 继续作为末尾占位；INDEX 汇总排除 self，JSON 状态计数包含 self。',
  ],
  decisions: [
    'SPEC 对目标采用 80 行新增，并列出 7ca78c1-SPEC、7ca78c1-PLAN、INDEX 和 status JSON；本提交自身的 SPEC 只有 36 行，因此总增量是 78 行。',
    '人类索引仅将 Implemented 从 51 提到 52，Partial 1 和 Unimplemented 0 保持；机器数组由 53 项扩至 54 项，其中 implemented（含 self）由 52 变为 53。',
    '没有为 55f7c7e 自身添加 SHA 对象或文档，self 行、对象及 self-SPEC/self-PLAN 内容均不变。',
  ],
  alternatives: ['若沿用 f355de1 的 77 行统计，会抹去 2fe47f6 多出的 SPEC 内容；若登记直接父，则会把后续 d802331 的对象提前，因此按祖父提交实际 diff 建档。'],
  security: ['仅新增文档和索引元数据，不改变凭据处理、接口、feature gating 或权限 enforcement。'],
  acceptance: [
    '两个 frontmatter 的完整 SHA、标题、日期和状态与 2fe47f6 一致，Actual scope 为 80 行新增。',
    'INDEX 与 JSON 的新链接均指向 2fe47f6 文件，数组和表格中 self 仍最后。',
  ],
  evidence: [
    {
      kind: 'diff-observed',
      statement: '新 SPEC 固定 2fe47f6 完整身份，并记录其 7ca78c1 文档范围及 80 行新增、1 行删除。',
      source: { path: 'docs/specs/2fe47f6-SPEC.md', role: 'evidence', revision: 'commit', symbol: 'commit: 2fe47f6e46a3add0a3ee9bdd57bda9feac2220a7', note: '目标身份和 Actual scope 的直接证据。' },
    },
    {
      kind: 'diff-observed',
      statement: '新 PLAN 声明 implemented，并保留实施步骤、风险和验证序列。',
      source: { path: 'docs/plans/2fe47f6-PLAN.md', role: 'evidence', revision: 'commit', symbol: '## Completion status and remaining work', note: '完成状态小节的 at-commit 内容。' },
    },
    {
      kind: 'diff-observed',
      statement: 'INDEX patch 将 Implemented 改为 52，并在 self 前加入 2fe47f6 链接行。',
      source: { path: 'docs/INDEX.md', role: 'evidence', revision: 'commit', symbol: '- Implemented: 52', note: '排除 self 的汇总与新表格入口。' },
    },
    {
      kind: 'diff-observed',
      statement: 'status patch 在 f251df9 后、self 前加入 2fe47f6，commits 总数达到 54。',
      source: { path: 'docs/status/index.json', role: 'evidence', revision: 'commit', symbol: '"fullSha": "2fe47f6e46a3add0a3ee9bdd57bda9feac2220a7"', note: '新机器对象及其完整 SHA。' },
    },
    { kind: 'not-recorded', statement: '没有测试、typecheck、build 或 CI 运行输出；验证章节只是生成文档中的计划文字。' },
  ],
  remaining: ['直接父 f355de1 和当前 55f7c7e 的专属文档仍分别留待后续提交，本次仅完成 2fe47f6 的登记。'],
  references: [
    { path: 'docs/INDEX.md', role: 'changed', note: 'Implemented 51→52，新增 2fe47f6 表格链接。' },
    { path: 'docs/plans/2fe47f6-PLAN.md', role: 'changed', note: '新建的 2fe47f6 实施计划。' },
    { path: 'docs/specs/2fe47f6-SPEC.md', role: 'changed', note: '记录目标身份及 80 行新增的四文件范围。' },
    { path: 'docs/status/index.json', role: 'changed', note: 'commits 53→54，self 前插入目标对象。' },
  ],
  plan: {
    preconditions: ['确认 f355de1 是直接父而非文档对象，并读取 2fe47f6 的 7ca78c1 产物与 80 行统计。'],
    reuse: ['沿用现有 frontmatter 和索引字段，在 f251df9 后追加而不重排更早记录。'],
    steps: [
      { title: '编写 2fe47f6 SPEC', detail: '将目标身份与其六文件文档提交的四路径范围对应，明确 80 行新增。', paths: ['docs/specs/2fe47f6-SPEC.md'] },
      { title: '编写 2fe47f6 PLAN', detail: '记录目标提交的实施结构、风险、验证建议和 implemented 声明。', paths: ['docs/plans/2fe47f6-PLAN.md'] },
      { title: '延伸 INDEX 链条', detail: '在 f251df9 后添加 2fe47f6 行，并将不含 self 的 Implemented 增至 52。', paths: ['docs/INDEX.md'] },
      { title: '延伸 JSON 链条', detail: '把相同目标对象插入 self 前，令数组总数和含 self 的 implemented 各增一。', paths: ['docs/status/index.json'] },
    ],
    compatibility: ['已有 f251df9 链接和 self 占位保持原内容，新文档沿用既有路径命名。'],
    risks: ['目标 80 行、本提交 78 行和前一目标 77 行三个统计相近，必须分别绑定到正确 SHA。'],
    verification: ['检查目标 SPEC 的四个路径与统计，比对两套索引新增项、计数以及 self 的末位和未改内容。'],
    completed: ['2fe47f6 的 SPEC/PLAN 与两个索引入口已同步落盘，没有额外文件。'],
    incomplete: ['本提交未记录任何命令执行或 CI 结果，元数据 implemented 不等于验证通过。'],
  },
})
