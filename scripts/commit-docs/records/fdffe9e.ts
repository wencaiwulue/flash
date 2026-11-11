import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: 'fdffe9e872a6bdf9ef41623b532f512f1846ab3a',
  slug: 'commit-docs-finalization',
  title: 'Complete previous commit documentation',
  kind: 'metadata-migration',
  status: 'implemented',
  beforeState: 'parent e8d8c06 的 INDEX 已收录 4329cd8 且 Implemented 为 80，但 f5b097b742b8e9d68acce71c9b2fa38e19c6088a 没有专属 SPEC/PLAN，也没有表格或 JSON 条目。',
  problem: 'f5b097b 的提交标题是 Complete previous commit documentation，其实际工作对象却是 8a248e3。本次要补的是 f5b097b 的文档身份，而非再次描述 8a248e3 或刚收录的 4329cd8。',
  goals: [
    '新增 docs/specs/f5b097b-SPEC.md 和 docs/plans/f5b097b-PLAN.md，记录 f5b097b 的完整 SHA、时间与 implemented 状态。',
    '使 INDEX 汇总达到 Implemented 81、Partial 1、Unimplemented 0，并让 status JSON 能解析到同一组文档路径。',
  ],
  nonGoals: [
    '不重写 f5b097b 文档中提到的 8a248e3 历史产物，也不替 e8d8c06 提前建档。',
    '不声称模板中列出的本地命令或 CI 已在本提交运行。',
  ],
  architecture: [
    '本提交在 4329cd8 条目之后扩展文档链：SPEC 内嵌的 8a248e3 路径属于 f5b097b 的 Actual scope，而本次真正新增的是 f5b097b 两个 Markdown 文件。',
    '表格与 JSON 分别人工可读、机器可读地承载同一身份；二者都把新项置于 self 之前，未引入产品组件。',
  ],
  decisions: [
    '采用 f5b097b 的 Complete 标题和 2026-11-11T11:18:59+08:00，不与相邻 4329cd8 的 Finalize 标题混用；范围统计保留 4 文件、78+1。',
    'INDEX 只把一个 implemented 计数从 80 增为 81；status 新对象同时记录完整/短 SHA、subject、date 和两个新路径。',
  ],
  alternatives: ['把 f5b097b 合并进 4329cd8 的条目会破坏一提交一身份；复制 8a248e3 的旧文档则无法表达这一代文档链，故分别新增并登记。'],
  security: ['diff 只添加文档说明和索引字段，没有密钥、网络协议、依赖或访问控制改动。'],
  acceptance: [
    'SPEC 与 PLAN 均使用 f5b097b742b8e9d68acce71c9b2fa38e19c6088a，且标题为 Complete previous commit documentation。',
    '表格计数为 81/1/0，新增行及 JSON 对象的链接与磁盘路径一致，self 行和 self 对象未被改写。',
  ],  remaining: ['SPEC 对 f5b097b 的设计背景仍为模板化句子，未展开 8a248e3 文档链之外的分析。'],
  references: [
    { path: 'docs/INDEX.md', role: 'changed', note: '新增 f5b097b 行，Implemented 80→81。' },
    { path: 'docs/plans/f5b097b-PLAN.md', role: 'changed', note: '新建 Complete 标题的 f5b097b 计划。' },
    { path: 'docs/specs/f5b097b-SPEC.md', role: 'changed', note: '新建含 8a248e3 历史范围的 f5b097b SPEC。' },
    { path: 'docs/status/index.json', role: 'changed', note: '注册 f5b097b 的完整身份及两个路径。' },
  ],
  plan: {
    preconditions: ['确认 f5b097b 的标题、日期和完整 SHA，并将其历史对象 8a248e3 与本提交对象分开。'],
    reuse: ['复用前一提交的文档骨架及索引格式，让新项紧随 4329cd8。'],
    steps: [
      { title: '编写 f5b097b SPEC', detail: '记录 Complete 标题，并把 8a248e3 的两个路径放入 Actual scope。', paths: ['docs/specs/f5b097b-SPEC.md'] },
      { title: '编写配套 PLAN', detail: '沿用 f5b097b 的日期和状态，补齐计划、风险及完成状态段落。', paths: ['docs/plans/f5b097b-PLAN.md'] },
      { title: '递增表格计数', detail: '在 4329cd8 后添加 f5b097b 链接行，只调整 Implemented 为 81。', paths: ['docs/INDEX.md'] },
      { title: '追加状态对象', detail: '将 f5b097b 的 fullSha、shortSha、subject 和文档字段写在 self 前。', paths: ['docs/status/index.json'] },
    ],
    compatibility: ['保留 4329cd8 等已有入口，self 的 bootstrap 身份与排序约定不变。'],
    risks: ['Finalize 与 Complete 标题交替出现，若只复制前一文件会写错 subject、date 和嵌套范围。'],
    acceptanceSequence: ['解析当前 JSON 并核对 f5b097b 对象；对照 parent/current INDEX 检查单行新增及 80→81。'],
    completed: ['f5b097b 的 SPEC、PLAN、表格行和 JSON 对象已同步添加。'],
    incomplete: ['验证命令仅为文档内容，本提交未记录它们的实际结果。'],
  },
})
