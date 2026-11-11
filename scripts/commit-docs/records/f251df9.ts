import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: 'f251df9151d7a7c054fa662c4b50f0d09c1bf305',
  slug: 'commit-docs-finalization',
  title: 'Finalize previous commit documentation records',
  kind: 'metadata-migration',
  status: 'implemented',
  beforeState: '直接父提交 7ca78c1a18a7f05e1740f701b256079bb4cc2c2e 已补齐 fe3c177 与 63e138f 两对文档，INDEX 为 Implemented 48、Partial 1、Unimplemented 0；祖父提交 80e6defe99a3ce09a3d2b4229458fed0fbde5dbc 尚无自己的 SPEC/PLAN。',
  problem: '需要为 80e6def 建文档，准确保存其两个索引加生成器的三文件、22 行新增范围，并解释 previousHead 只生成文档而主循环负责索引的分工。',
  goals: [
    '新建 80e6def SPEC/PLAN，Actual scope 列出 INDEX、status JSON 和 scripts/document-commits.ts。',
    '在 self 前注册 80e6def，将 Implemented 从 48 增至 49，其余状态计数不变。',
  ],
  nonGoals: [
    '不修改 previousHead 代码，也不补直接父 7ca78c1 或当前 f251df9 的文档。',
    '不把生成器行为描述当作本提交再次执行生成器的证据，只列出验收条件。',
  ],
  architecture: [
    '80e6def 的主循环用 slice(0, -1) 排除 HEAD并负责计数、INDEX 行和 JSON；其后 previousHead = commits().at(-2) 只通过 documents.set 输出前一 HEAD 的 SPEC/PLAN，不直接注册索引。',
    '在生成当前变更前的历史位置，HEAD 为 7ca78c1、at(-2) 为 80e6def；提交后重跑则 at(-2) 会改变，不能将该表达式解释为永久指向 80e6def。',
  ],
  decisions: [
    '新 SPEC 使用 80e6def 自身的 3 files、22 insertions、1 deletion，而不是直接父 7ca78c1 的六文件、145 行新增。',
    '80e6def 的 INDEX/JSON 注册在本提交各新增一次，位于 63e138f 后、self 前；previousHead 代码不追加索引，因此不会带来额外计数。',
  ],
  alternatives: ['把 previousHead 当成完整注册循环会错误推导计数和 JSON 副作用；把本提交对象设为直接父 7ca78c1 又会漏掉其实际三文件生成器范围。'],
  security: ['本提交仅添加文档和索引，未改变生成器、CI 或运行时代码；历史代码说明不构成新的权限或执行行为。'],
  acceptance: [
    '80e6def SPEC/PLAN 使用相同 fullSha、标题、日期和 implemented，SPEC 统计为 22/1。',
    'INDEX 为 49/1/0，JSON 的 spec/plan 字段指向新文件；previousHead 不被描述为额外索引来源。',
  ],  remaining: ['直接父 7ca78c1 的文档仍未建立；80e6def 的 PLAN 继续使用概括模板，previousHead 行为没有随附运行日志。'],
  references: [
    { path: 'docs/INDEX.md', role: 'changed', note: 'Implemented 48 到 49，加入 80e6def。' },
    { path: 'docs/plans/80e6def-PLAN.md', role: 'changed', note: '新建 previousHead 变更提交的计划。' },
    { path: 'docs/specs/80e6def-SPEC.md', role: 'changed', note: '记录 80e6def 三文件、22/1 的实际范围。' },
    { path: 'docs/status/index.json', role: 'changed', note: '注册 80e6def 的机器可读条目。' },
  ],
  plan: {
    preconditions: ['核对直接父 7ca78c1 的 48/1/0 索引，并读取 80e6def 的三文件 diff 和 previousHead 代码。'],
    reuse: ['沿用 80e6def 已加入的 previousHead 文档输出与主循环索引注册，复用现有 SPEC/PLAN 格式。'],
    steps: [
      { title: '建立 80e6def SPEC', detail: '保存 22/1 统计及 INDEX、status JSON、生成器三个路径。', paths: ['docs/specs/80e6def-SPEC.md'] },
      { title: '建立 80e6def PLAN', detail: '使用同一历史身份新增计划，不把 previousHead 代码描述写成运行证据。', paths: ['docs/plans/80e6def-PLAN.md'] },
      { title: '更新表格索引', detail: '在 63e138f 后加入 80e6def，Implemented 单项增至 49。', paths: ['docs/INDEX.md'] },
      { title: '更新机器索引', detail: '在 self 前插入 80e6def 的完整字段，不重复 previousHead 计数。', paths: ['docs/status/index.json'] },
    ],
    compatibility: ['previousHead 源码和既有 fe3c177、63e138f 条目不修改，self 继续位于两个索引末尾。'],
    risks: ['at(-2) 随 HEAD 移动，且文档输出与索引注册分属不同代码路径，静态阅读时容易误判其副作用。'],
    acceptanceSequence: ['固定到 80e6def revision 核对生成器，再检查新 SPEC 的 22/1 统计和两个索引的单项增量。'],
    completed: ['80e6def 的 SPEC/PLAN 与两个索引入口已落盘，本提交没有生成器源码差异。'],
    incomplete: ['未记录 previousHead 实际生成过程、测试、typecheck、build 或 CI 结果。'],
  },
})
