import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: 'fe3c177c28b7581e93f7496c58b98bafa10dbb03',
  slug: 'commit-docs-finalization',
  title: 'Complete self documentation for previous commit',
  kind: 'metadata-migration',
  status: 'implemented',
  beforeState: '直接父提交 7740a1d28b70629f41d49116a8e6007eb46c72aa 已为 17c9196 建立文档，INDEX 是 Implemented 44、Partial 1、Unimplemented 0；祖父提交 f210ce9c2dc51a30f98514628b07538a969f21aa 尚未有自己的 SPEC/PLAN。',
  problem: '需要把 f210ce9 的四文件元数据变更固化为可发现文档，其 SPEC 必须指向 c4e19ce 文档对，而不是误写直接父 7740a1d 所处理的 17c9196。',
  goals: [
    '新建 f210ce9 SPEC/PLAN，记录 4 files、78 insertions、1 deletion 及 c4e19ce 两个文档路径。',
    '在两个索引中登记 f210ce9，将 Implemented 从 44 调到 45。',
  ],
  nonGoals: [
    '本提交不为直接父 7740a1d 建文档，也不登记 fe3c177 自身。',
    '不修改生成器或检查器，不把模板列出的测试和 CI 项视为已执行。',
  ],
  architecture: [
    'SPEC 的 Actual scope 把 f210ce9 映射为 INDEX、status JSON、c4e19ce-SPEC 和 c4e19ce-PLAN；其中 c4e19ce 的 169 行新增是被描述提交的内部事实，不改变 f210ce9 自身的 78 行统计。',
    'PLAN 与 SPEC 共享 f210ce9 身份，INDEX 和 JSON 分别在 17c9196 后、self 前增加同一提交的人类与机器入口。',
  ],
  decisions: [
    '本提交只处理 f210ce9：frontmatter 使用其完整 SHA 和 2026-11-11T10:50:48+08:00，不使用直接父 7740a1d 的元数据。',
    'INDEX 的三类计数成为 45/1/0；status JSON 只新增一个 f210ce9 对象，spec/plan 路径与新文件同名。',
  ],
  alternatives: ['把本提交写成 7740a1d 的定稿会重复其父提交已经完成的工作；将 169 行误记为 f210ce9 的统计又会混淆描述内容与其自身 diff。'],
  security: ['变更不包含产品源码、协议或权限逻辑，只有历史元数据与文档链接。'],
  acceptance: [
    'f210ce9 SPEC 的 78/1 统计与 Git diff 一致，文件清单明确包含 c4e19ce 的 SPEC 和 PLAN。',
    'PLAN frontmatter、INDEX 行和 JSON 对象都使用同一 f210ce9 fullSha，self 保持最后一个条目。',
  ],  remaining: ['7740a1d 的文档仍待下一提交补齐；fe3c177 自己的索引会先于其文档出现，后续再回填。'],
  references: [
    { path: 'docs/INDEX.md', role: 'changed', note: 'Implemented 44 到 45，加入 f210ce9 行。' },
    { path: 'docs/plans/f210ce9-PLAN.md', role: 'changed', note: '新建 f210ce9 的计划文件。' },
    { path: 'docs/specs/f210ce9-SPEC.md', role: 'changed', note: '记录 f210ce9 为 c4e19ce 补文档的实际范围。' },
    { path: 'docs/status/index.json', role: 'changed', note: '新增 f210ce9 的机器可读条目。' },
  ],
  plan: {
    preconditions: ['确认父版本已有 17c9196 文档和 44/1/0 摘要，并读取 f210ce9 的实际四文件 diff。'],
    reuse: ['沿用现有文档模板和 self 末尾约定，复用 f210ce9 已确定的 c4e19ce 路径名称。'],
    steps: [
      { title: '建立 f210ce9 SPEC', detail: '记录其 78/1 diff，并把实际路径锁定到 c4e19ce 文档对和两个索引。', paths: ['docs/specs/f210ce9-SPEC.md'] },
      { title: '建立 f210ce9 PLAN', detail: '使用同一完整身份新增计划，保留模板章节但不虚构执行记录。', paths: ['docs/plans/f210ce9-PLAN.md'] },
      { title: '登记表格记录', detail: '在 17c9196 后插入 f210ce9 链接，Implemented 增至 45。', paths: ['docs/INDEX.md'] },
      { title: '登记 JSON 记录', detail: '在 self 前写入 f210ce9 的日期、标题、状态和两个文档路径。', paths: ['docs/status/index.json'] },
    ],
    compatibility: ['已有 c4e19ce、17c9196 条目顺序不动，新路径沿用 docs/specs 与 docs/plans 命名。'],
    risks: ['相邻提交具有相同四文件统计，必须用文档对象和内部路径区分，而不能只比较 diff 数字。'],
    acceptanceSequence: ['检查 SPEC 内 c4e19ce 路径和 f210ce9 frontmatter，再比较 INDEX/JSON 的单项增量。'],
    completed: ['f210ce9 的两个产物与两个索引入口已在本提交闭合。'],
    incomplete: ['未保存生成器运行或任何自动化验证的可追溯输出。'],
  },
})
