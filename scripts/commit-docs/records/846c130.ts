import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: '846c13000bb120adf83febaf0732e704446a0e02',
  slug: 'commit-docs-finalization',
  title: 'Complete previous commit documentation',
  kind: 'metadata-migration',
  status: 'implemented',
  beforeState: 'parent 69d3596 的 INDEX 最后一个历史条目是 3c4b6f2，Implemented 为 84；c8338e1be21cdc792f1c69a5bf3c0094d3c29261 尚无自己的 SPEC/PLAN，status 数组也没有该 fullSha。',
  problem: 'c8338e1 的文档内容围绕 fdffe9e，但当前缺失的是 c8338e1 这一层的文档身份。需要同时避免把它与实际 parent 69d3596、历史对象 fdffe9e 混为同一提交。',
  goals: [
    '落盘 docs/specs/c8338e1-SPEC.md 与 docs/plans/c8338e1-PLAN.md，记录 c8338e1 的 Complete 标题和 implemented 状态。',
    '将 INDEX 的 Implemented 由 84 增至 85，并在 status JSON 中建立 c8338e1 到两个新文件的路径映射。',
  ],
  nonGoals: [
    '不改写 fdffe9e 的已有产物，也不在本提交中为 69d3596 新建文档。',
    '不将文档建议的验证步骤描述为已执行的测试或构建。',
  ],
  architecture: [
    '本提交继续以四路径元数据单元扩展文档链：c8338e1 SPEC 引用 fdffe9e 的两个历史文件，新 PLAN 与 SPEC 共同对应当前被补档身份。',
    '表格和 JSON 都在 3c4b6f2 后追加 c8338e1；self 的 changeId 和既有双链接没有被计入此次 Implemented 增量的额外变化。',
  ],
  decisions: [
    'frontmatter 使用 c8338e1 的完整 SHA、2026-11-11T11:21:15+08:00 与 Complete subject，范围统计仍忠实记录其原提交的 4 文件、78+1。',
    '计数仅从 84 变为 85，Partial 1 和 Unimplemented 0 不动；JSON 新对象放在 self 前，路径使用 c8338e1 而非 fdffe9e。',
  ],
  alternatives: ['只补 c8338e1 的 Markdown 会使机器查询漏项；把条目附加到 fdffe9e 又会丢失一代提交，因此四个路径需要一致提交。'],
  security: ['没有产品代码、脚本、秘密或访问控制变更；新增文档不会引入运行时攻击面。'],
  acceptance: [
    'SPEC/PLAN 和 JSON 均锁定 c8338e1be21cdc792f1c69a5bf3c0094d3c29261，时间与 Complete 标题一致。',
    'INDEX 为 85/1/0，c8338e1 行紧随 3c4b6f2，两个索引均指向本次创建的 SPEC/PLAN，self 保持在末尾。',
  ],  remaining: ['生成的背景、风险与实施步骤较泛化，未说明 c8338e1 补丁中各字段为何这样变化。'],
  references: [
    { path: 'docs/INDEX.md', role: 'changed', note: 'Implemented 84→85，新增 c8338e1 行。' },
    { path: 'docs/plans/c8338e1-PLAN.md', role: 'changed', note: '新建 c8338e1 的 Complete 计划。' },
    { path: 'docs/specs/c8338e1-SPEC.md', role: 'changed', note: '新建含 fdffe9e 历史路径的 c8338e1 SPEC。' },
    { path: 'docs/status/index.json', role: 'changed', note: '在 self 前注册 c8338e1 及其文档。' },
  ],
  plan: {
    preconditions: ['分清实际 parent 69d3596、被补档 c8338e1 和 SPEC 内历史对象 fdffe9e 三种身份。'],
    reuse: ['沿用 3c4b6f2 后的索引尾部结构以及已有 SPEC/PLAN frontmatter。'],
    steps: [
      { title: '编写 c8338e1 SPEC', detail: '写入 Complete 身份，并保留其 fdffe9e 两个历史文件与 78+1 范围。', paths: ['docs/specs/c8338e1-SPEC.md'] },
      { title: '编写 c8338e1 PLAN', detail: '以相同 SHA 和日期建立计划小节，不改用当前提交的时间。', paths: ['docs/plans/c8338e1-PLAN.md'] },
      { title: '将表格增至 85', detail: '在 3c4b6f2 行后添加 c8338e1，保持其他状态计数不变。', paths: ['docs/INDEX.md'] },
      { title: '登记机器映射', detail: '在 self 前写入 c8338e1 fullSha 及两个以 c8338e1 命名的新路径。', paths: ['docs/status/index.json'] },
    ],
    compatibility: ['旧文档和旧 JSON 对象保持原样，self 的路径格式及末尾排序继续兼容读取方。'],
    risks: ['Complete 标题与多层 parent 关系容易造成日期或路径错代，验证模板也不能替代真实证据。'],
    acceptanceSequence: ['对照 c8338e1 的原始 metadata 和路径块，检查 current SPEC/PLAN、85 计数及 JSON 对象是否同源。'],
    completed: ['c8338e1 的两个新文档和两个索引入口已经同步落盘。'],
    incomplete: ['没有保存验证执行结果，生成文本也未提供更具体的设计过程。'],
  },
})
