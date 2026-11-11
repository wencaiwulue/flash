import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: '2f55f199acfd26b90c81c5de3c5ca6fcfe167dfc',
  slug: 'commit-docs-finalization',
  title: 'Finalize previous commit documentation',
  kind: 'metadata-migration',
  status: 'implemented',
  beforeState: '直接父提交为 501672c，本次定稿目标是祖父提交 064047104f5156043604afd50f2793e1b336950a。父快照已有 335b217 条目，但没有 0640471 SPEC/PLAN；INDEX Implemented 为 56，JSON commits 为 58。',
  problem: '0640471 的主题声称处理 current and previous commits，实际却只登记 d802331。现在为 0640471 自己补文档时，需要保留这个特殊主题，同时把它的真实四文件范围写清楚。',
  goals: [
    '创建 0640471 SPEC/PLAN，frontmatter 记录完整 SHA、Complete documentation for current and previous commits、2026-11-11T11:04:47+08:00 和 implemented。',
    '记录目标实际只创建 d802331 SPEC/PLAN 并修改两个索引的四文件、78 行新增、1 行删除范围。',
  ],
  nonGoals: [
    '不补直接父 501672c 或当前 2f55f19 的文档，不因目标主题虚构第二组历史产物。',
    '不修改产品实现，不宣称目标 PLAN 中的命令或 CI 已有执行结果。',
  ],
  architecture: [
    '本提交新增 0640471 的说明层，并在 INDEX 与 status JSON 各增一个入口；说明层保留目标特殊主题，范围层只承认真实 diff。',
    '新条目排在 335b217 后、self 前，self 仍是独立占位而非当前提交；两种索引的 self 计数口径不变。',
  ],
  decisions: [
    'SPEC 的标题使用 current and previous commits，但 Actual scope 仅列 d802331 两个文档、INDEX 和 status JSON，避免主题与范围混同。',
    '新增 0640471 后，INDEX 的 Implemented 由 56 增至 57，另外两项仍是 1 和 0；JSON commits 58→59，含 self 的 implemented 57→58。',
    '当前提交自身仍为四文件、78 行新增和 1 行删除，没有额外路径或自我状态对象，self 文档与 changeId 未改。',
  ],
  alternatives: ['将目标主题简化成普通 previous commit 会丢失原始元数据；按主题写成两组文档又会违背 0640471 的实际范围，因此主题照录、范围按 diff。'],
  security: ['变更仅涉及文档与索引，不含凭据、权限变更、私有协议或可执行逻辑。'],
  acceptance: [
    '0640471 的完整 SHA、特殊主题、日期和 implemented 在两个 frontmatter 中一致。',
    'SPEC 范围只含 d802331 文档组，INDEX/JSON 新入口和计数匹配，self 保持最后。',
  ],  remaining: ['直接父 501672c 和当前 2f55f19 尚未在本提交建档，分别由后续环节处理。'],
  references: [
    { path: 'docs/INDEX.md', role: 'changed', note: 'Implemented 56→57，新增特殊主题的 0640471 行。' },
    { path: 'docs/plans/0640471-PLAN.md', role: 'changed', note: '新建并保留目标原始主题的计划。' },
    { path: 'docs/specs/0640471-SPEC.md', role: 'changed', note: '记录目标身份及仅含 d802331 文档组的范围。' },
    { path: 'docs/status/index.json', role: 'changed', note: 'commits 58→59，在 self 前注册 0640471。' },
  ],
  plan: {
    preconditions: ['读取 0640471 元数据与真实 diff，区分其 current/previous 主题和唯一 d802331 目标。'],
    reuse: ['沿用 335b217 后的索引位置和通用文档结构，保留 self 占位不变。'],
    steps: [
      { title: '编写 0640471 SPEC', detail: '完整保留目标特殊主题，Actual scope 只列 d802331 两个产物和两个索引。', paths: ['docs/specs/0640471-SPEC.md'] },
      { title: '编写 0640471 PLAN', detail: '使用同一主题与身份，补齐目标实施、风险、验证建议和完成状态。', paths: ['docs/plans/0640471-PLAN.md'] },
      { title: '增加特殊主题表格行', detail: '在 335b217 后添加 0640471，只将 Implemented 调整为 57。', paths: ['docs/INDEX.md'] },
      { title: '增加对应 JSON 对象', detail: '把完整 0640471 对象插入 self 前，使数组总数达到 59。', paths: ['docs/status/index.json'] },
    ],
    compatibility: ['目标主题原样保留，既有路径、条目顺序、self 文档和 changeId 均不变。'],
    risks: ['特殊主题容易诱导记录者写出不存在的一组文档，必须让 frontmatter 忠实与 Actual scope 忠实同时成立。'],
    acceptanceSequence: ['比对目标主题与 frontmatter，核对范围仅四条路径，检查索引计数和 self 末位。'],
    completed: ['0640471 的新 SPEC/PLAN 和双索引登记已完成，四个变更路径全部覆盖。'],
    incomplete: ['未记录任何命令或 CI 执行结果，implemented 不被解释为验证通过。'],
  },
})
