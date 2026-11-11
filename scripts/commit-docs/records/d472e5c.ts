import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: 'd472e5c963d799ffa51192e7358ecaba45de8c7a',
  title: 'Complete previous commit documentation',
  kind: 'metadata-migration',
  status: 'implemented',
  beforeState: '直接父提交为 2f55f19，实际定稿对象是其父提交 501672c99b9338a35a2f7f261adc395a9b829dd2。父快照已登记 0640471，尚无 501672c SPEC/PLAN；INDEX Implemented 为 57，JSON commits 为 59 项。',
  problem: '501672c 已记录 335b217 的 finalization，但自身缺少文档身份。本提交沿链条补这一层，需避免把刚写入 0640471 的直接父 2f55f19 误作为新 frontmatter。',
  goals: [
    '创建 501672c SPEC/PLAN，记录完整 SHA、Complete documentation for previous commit、2026-11-11T11:05:14+08:00 和 implemented。',
    '保存目标为 335b217 新建文档的四文件、78 行新增、1 行删除范围，并同步两个索引。',
  ],
  nonGoals: [
    '不为直接父 2f55f19 或当前 d472e5c 建档，不修改既有 0640471 条目。',
    '不改变产品行为，不把生成文档中的验证命令或 CI 清单当成实际证据。',
  ],
  architecture: [
    '501672c 的两个新文档构成说明层，INDEX 表格与 commits 数组构成发现层；本提交没有运行时代码和额外文件。',
    '新条目紧接 0640471、位于 self 前，self 对象与行仅顺移一位，内容和固定占位含义不变。',
  ],
  decisions: [
    'SPEC 将目标范围绑定到 335b217-SPEC、335b217-PLAN 及两个索引，统计为 78 行新增、1 行删除。',
    'INDEX 的 implemented 计数随 501672c 从 57 增至 58；status 数组长度 59→60，状态分布从 58 implemented 加 1 partial 变为 59 implemented 加 1 partial。',
    '新对象是第 59 项、self 是第 60 项；当前 d472e5c 没有自我文档或 SHA 状态对象，self 两个文档未改。',
  ],
  alternatives: ['选择直接父会重复后续 3fbabc2 才处理的 2f55f19 对象；同时补两层会超出实际四文件，因此只记录祖父 501672c。'],
  security: ['仅文档元数据落盘，没有敏感值、依赖、协议、权限或可执行内容变化。'],
  acceptance: [
    'SPEC/PLAN frontmatter 与 501672c 完整身份一致，Actual scope 对应 335b217 文档组。',
    'INDEX 和 JSON 分别新增一个入口，计数正确，self 保持在第 60 项和表格末行。',
  ],
  evidence: [
    {
      kind: 'diff-observed',
      statement: '新 SPEC 固定 501672c 完整 SHA，Actual scope 记录 335b217 文档组及 78 行新增、1 行删除。',
      source: { path: 'docs/specs/501672c-SPEC.md', role: 'evidence', revision: 'commit', symbol: 'commit: 501672c99b9338a35a2f7f261adc395a9b829dd2', note: '目标身份和范围可在新文件核对。' },
    },
    {
      kind: 'diff-observed',
      statement: '新 PLAN 提供实施步骤、风险与 implemented 完成状态。',
      source: { path: 'docs/plans/501672c-PLAN.md', role: 'evidence', revision: 'commit', symbol: '## Completion status and remaining work', note: '计划完成状态的直接锚点。' },
    },
    {
      kind: 'diff-observed',
      statement: 'INDEX patch 将 Implemented 调为 58，并在 0640471 后新增 501672c。',
      source: { path: 'docs/INDEX.md', role: 'evidence', revision: 'commit', symbol: '- Implemented: 58', note: '不含 self 的新汇总与表格入口。' },
    },
    {
      kind: 'diff-observed',
      statement: 'status patch 把 501672c 插到 self 前，commits 总数由 59 变为 60。',
      source: { path: 'docs/status/index.json', role: 'evidence', revision: 'commit', symbol: '"fullSha": "501672c99b9338a35a2f7f261adc395a9b829dd2"', note: '机器对象的完整身份和文档路径。' },
    },
    { kind: 'not-recorded', statement: '本提交没有测试、typecheck、build 或 CI 结果，验证章节不构成执行证据。' },
  ],
  remaining: ['直接父 2f55f19 与当前 d472e5c 的文档仍属后续环节，本提交只完成 501672c 的元数据迁移。'],
  references: [
    { path: 'docs/INDEX.md', role: 'changed', note: 'Implemented 57→58，新增 501672c 表格行。' },
    { path: 'docs/plans/501672c-PLAN.md', role: 'changed', note: '新建的 501672c 实施计划。' },
    { path: 'docs/specs/501672c-SPEC.md', role: 'changed', note: '记录目标身份及 335b217 文档组范围。' },
    { path: 'docs/status/index.json', role: 'changed', note: 'commits 59→60，self 前插入 501672c。' },
  ],
  plan: {
    preconditions: ['确认祖父 501672c 是文档目标，并核对其 335b217 产物及 78 行统计。'],
    reuse: ['复用既有 frontmatter、索引字段和 0640471 后的顺序，保留 self 占位。'],
    steps: [
      { title: '编写 501672c SPEC', detail: '列出目标为 335b217 创建的两个文档和两个索引，记录 78 行新增。', paths: ['docs/specs/501672c-SPEC.md'] },
      { title: '编写 501672c PLAN', detail: '按同一身份补齐实施步骤、风险、验证建议和完成状态。', paths: ['docs/plans/501672c-PLAN.md'] },
      { title: '追加 INDEX 行', detail: '在 0640471 后添加 501672c，将不含 self 的 Implemented 增至 58。', paths: ['docs/INDEX.md'] },
      { title: '追加 JSON 对象', detail: '把完整 501672c 对象放到 self 前，使其成为第 59 项、self 成为第 60 项。', paths: ['docs/status/index.json'] },
    ],
    compatibility: ['0640471 及更早条目不改，self 文档、changeId、路径格式和末尾位置保持兼容。'],
    risks: ['连续提交主题近似，若只看 previous 字样而不核对祖父关系，会把 2f55f19 与 501672c 对调。'],
    verification: ['对照目标 diff 检查 SPEC，核对 PLAN 元数据、两个索引计数和 self 的最终下标。'],
    completed: ['501672c SPEC/PLAN 与双索引入口已同步落盘，无额外文件。'],
    incomplete: ['没有实际验证或 CI 记录，implemented 只表示元数据声明。'],
  },
})
