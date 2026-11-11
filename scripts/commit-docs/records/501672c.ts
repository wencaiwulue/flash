import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: '501672c99b9338a35a2f7f261adc395a9b829dd2',
  title: 'Complete documentation for previous commit',
  kind: 'metadata-migration',
  status: 'implemented',
  beforeState: '直接父提交是 0640471，本次实际定稿对象为其父提交 335b217899a7b0920f972973a92363db436f158f。父快照已添加 d802331，尚无 335b217 SPEC/PLAN；INDEX Implemented 为 55，status commits 为 57 项。',
  problem: '335b217 已为 55f7c7e 补齐文档，自己却仍缺少身份和索引入口。本提交需要补这一环，同时保留直接父 0640471 那个“current and previous”标题提交与实际目标之间的层级差别。',
  goals: [
    '创建 335b217 SPEC/PLAN，记录完整 SHA、Finalize previous commit documentation、2026-11-11T11:04:20+08:00 和 implemented。',
    '登记目标为 55f7c7e 新建文档的四文件、78 行新增、1 行删除范围，并同步 INDEX 和 JSON。',
  ],
  nonGoals: [
    '不补直接父 0640471 或当前 501672c 的文档，不改写上一轮 d802331 条目。',
    '不修改运行时代码，不将文档验证 prose 或 CI 名称解释为实际通过。',
  ],
  architecture: [
    '两个新文档说明 335b217，INDEX 和 commits 数组各增加一个对应入口；本提交没有组件、协议或状态机改动。',
    '目标条目接在 d802331 后、self 前，self 只是固定占位并保留在末尾，不会被当前 501672c 的 SHA 替换。',
  ],
  decisions: [
    '新 SPEC 列出 55f7c7e-SPEC、55f7c7e-PLAN、INDEX 和 status JSON；目标与当前提交均为 78 行新增，但文档对象不同。',
    '表格计数的变化是 Implemented 55→56，其余汇总不变；数组则从 57 个元素变成 58 个，新增对象后含 self 的 implemented 状态为 57。',
    '新对象是数组倒数第二项；当前提交没有自我 SPEC/PLAN 或状态记录，self 对象、changeId 和两个 self 文档均未改。',
  ],
  alternatives: ['将 335b217 新 SPEC 的目标写成 0640471 会跳过一层；把更上游 2fe47f6 的 80 行 diff 套到本层也同样错误，所以以 335b217 自身的 78 行为准。'],
  security: ['只有公开文档元数据变更，不涉及凭据、权限、feature gating 或私有协议。'],
  acceptance: [
    '两个 frontmatter 的 SHA、标题、日期和 implemented 与 335b217 一致，Actual scope 指向 55f7c7e 文档组。',
    'INDEX 新行和 JSON 新对象均链接到新产物，汇总与数组计数正确，self 仍居末位。',
  ],
  evidence: [
    {
      kind: 'diff-observed',
      statement: '新 SPEC 固定 335b217 完整身份，Actual scope 记录 55f7c7e 文档组及 78 行新增、1 行删除。',
      source: { path: 'docs/specs/335b217-SPEC.md', role: 'evidence', revision: 'commit', symbol: 'commit: 335b217899a7b0920f972973a92363db436f158f', note: '目标 frontmatter 与实际范围。' },
    },
    {
      kind: 'diff-observed',
      statement: '新 PLAN 记录实施步骤、验证建议和 implemented 完成状态。',
      source: { path: 'docs/plans/335b217-PLAN.md', role: 'evidence', revision: 'commit', symbol: '# Implementation plan: Finalize previous commit documentation', note: '计划标题对应 335b217 的主题。' },
    },
    {
      kind: 'diff-observed',
      statement: 'INDEX patch 将 Implemented 调为 56，并在 d802331 后、self 前新增 335b217。',
      source: { path: 'docs/INDEX.md', role: 'evidence', revision: 'commit', symbol: '- Implemented: 56', note: '排除 self 的汇总及新表格行。' },
    },
    {
      kind: 'diff-observed',
      statement: 'status patch 将 335b217 插到 self 前，commits 由 57 增至 58。',
      source: { path: 'docs/status/index.json', role: 'evidence', revision: 'commit', symbol: '"fullSha": "335b217899a7b0920f972973a92363db436f158f"', note: '机器对象的完整身份和路径。' },
    },
    { kind: 'not-recorded', statement: '没有 bun test、typecheck、build 或 CI 执行输出，implemented 仅是写入的元数据状态。' },
  ],
  remaining: ['0640471 和 501672c 的专属文档分别留待后续 finalization，本次只完成 335b217 的四路径登记。'],
  references: [
    { path: 'docs/INDEX.md', role: 'changed', note: 'Implemented 55→56，新增 335b217 行。' },
    { path: 'docs/plans/335b217-PLAN.md', role: 'changed', note: '新建的 335b217 实施计划。' },
    { path: 'docs/specs/335b217-SPEC.md', role: 'changed', note: '记录目标身份及 55f7c7e 文档组范围。' },
    { path: 'docs/status/index.json', role: 'changed', note: 'commits 57→58，新对象位于 self 前。' },
  ],
  plan: {
    preconditions: ['确认祖父提交 335b217 是目标，核对其 55f7c7e 两个产物和 78 行 diff。'],
    reuse: ['沿用 d802331 后的索引顺序、既有文档字段和 self 占位结构。'],
    steps: [
      { title: '编写 335b217 SPEC', detail: '记录目标为 55f7c7e 建文档的四条路径和 78 行统计。', paths: ['docs/specs/335b217-SPEC.md'] },
      { title: '编写 335b217 PLAN', detail: '以目标身份补齐实施步骤、风险、验证建议和完成状态。', paths: ['docs/plans/335b217-PLAN.md'] },
      { title: '登记表格入口', detail: '在 d802331 后新增 335b217，把不含 self 的 Implemented 增至 56。', paths: ['docs/INDEX.md'] },
      { title: '登记机器入口', detail: '将完整 335b217 对象插入 self 前，使数组总数达到 58。', paths: ['docs/status/index.json'] },
    ],
    compatibility: ['既有 d802331 链接不变，self 内容、changeId、路径格式和末尾语义保持原样。'],
    risks: ['更上游 2fe47f6 为 80 行，而 335b217 及其描述的 55f7c7e 均为 78 行；嵌套 finalization 的统计不能逐层照抄。'],
    verification: ['对照 335b217 diff 检查新 SPEC，核对 PLAN frontmatter、两个索引计数和 self 未改内容。'],
    completed: ['335b217 SPEC/PLAN 与双索引入口已完成，无额外文件。'],
    incomplete: ['没有实际命令或 CI 证据，本记录只确认元数据变化。'],
  },
})
