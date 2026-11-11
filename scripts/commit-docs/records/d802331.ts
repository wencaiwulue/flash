import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: 'd8023311609efec07cdedba3484a7cec0f84deb4',
  slug: 'commit-docs-finalization',
  title: 'Complete commit documentation for previous commit',
  kind: 'metadata-migration',
  status: 'implemented',
  beforeState: '当前提交的直接父是 55f7c7e，实际定稿对象是其父提交 f355de14f9baeccda3b49eed9e8e020fcae68e39。父快照中 2fe47f6 已登记，f355de1 的两个文档尚不存在；INDEX Implemented 为 52，JSON commits 为 54。',
  problem: 'f355de1 曾以 77 行目标统计记录 f251df9，现在需要为它自己补文档。若按标题粗略选择直接父 55f7c7e，或按当前 diff 反推目标统计，都会破坏连续元数据链。',
  goals: [
    '创建 f355de1 SPEC/PLAN，frontmatter 使用完整 SHA、Finalize documentation for previous commit、2026-11-11T11:02:53+08:00 和 implemented。',
    '记录目标为 f251df9 新建文档的四文件、77 行新增、1 行删除，并增加一致的 INDEX/JSON 入口。',
  ],
  nonGoals: [
    '不登记直接父 55f7c7e 或当前 d802331，不修改上一轮新增的 2fe47f6 文档。',
    '不引入产品行为变化，不宣称文档建议的测试、构建或 CI 已执行。',
  ],
  architecture: [
    '两个新文件承载 f355de1 的历史说明，INDEX 表格和 commits 数组分别追加入口，仍是无运行时代码的四路径迁移。',
    '新条目位于 2fe47f6 与 self 之间；self 不参与 INDEX Implemented，但仍是 JSON 中最后一个 implemented 对象。',
  ],
  decisions: [
    '目标 SPEC 保留 77 行新增及 f251df9 两个文档路径，与本提交 78 行新增的四文件 diff 分开叙述。',
    'INDEX Implemented 52→53，其他两项不变；JSON commits 54→55，含 self 的 implemented 53→54。',
    '当前提交没有自我 SPEC/PLAN 或 SHA 状态对象，通用 self 的内容不变并继续垫底；没有额外文件。',
  ],
  alternatives: ['把 77 行“修正”为本提交的 78 行会篡改 f355de1 的历史范围；同时补 55f7c7e 又会超出实际 diff，因此只闭合祖父提交一层。'],
  security: ['变更仅限公开文档元数据，没有敏感信息、依赖、协议或权限改动。'],
  acceptance: [
    'SPEC/PLAN frontmatter 与 f355de1 完整身份一致，Actual scope 指向 f251df9 文档组。',
    'INDEX 计数、表格链接、JSON 数组计数和对象字段同步，self 保持最后。',
  ],  remaining: ['55f7c7e 与 d802331 自身的文档不在此次范围内，分别留给后续 335b217 和 0640471 的定稿流程。'],
  references: [
    { path: 'docs/INDEX.md', role: 'changed', note: 'Implemented 52→53，新增 f355de1 入口。' },
    { path: 'docs/plans/f355de1-PLAN.md', role: 'changed', note: '新建的 f355de1 计划与状态说明。' },
    { path: 'docs/specs/f355de1-SPEC.md', role: 'changed', note: '记录目标身份及 f251df9 文档组的 77 行统计。' },
    { path: 'docs/status/index.json', role: 'changed', note: 'commits 54→55，在末尾 self 前注册目标。' },
  ],
  plan: {
    preconditions: ['核对祖父提交 f355de1 的身份和 77 行 diff，并确认父快照已有 2fe47f6 而无目标文档。'],
    reuse: ['复用前次 SPEC/PLAN 格式及两个索引布局，保持已有历史顺序和 self 占位。'],
    steps: [
      { title: '编写 f355de1 SPEC', detail: '以目标提交为主语，记录它为 f251df9 创建的文档及 77 行统计。', paths: ['docs/specs/f355de1-SPEC.md'] },
      { title: '编写 f355de1 PLAN', detail: '补齐相同身份下的实施步骤、风险、验证建议和完成状态。', paths: ['docs/plans/f355de1-PLAN.md'] },
      { title: '注册表格行', detail: '把 f355de1 放在 2fe47f6 后、self 前，只递增 Implemented 汇总。', paths: ['docs/INDEX.md'] },
      { title: '注册 JSON 对象', detail: '写入完整 f355de1 身份与两个新路径，使数组由 54 项变为 55 项。', paths: ['docs/status/index.json'] },
    ],
    compatibility: ['2fe47f6 及更早条目保持不动，self 文档和 changeId 不变，路径规范延续。'],
    risks: ['目标统计 77 与当前统计 78 只差一点，且“previous commit”标题不足以识别真实目标。'],
    acceptanceSequence: ['逐项比对目标 diff 与 SPEC，检查 PLAN 元数据、索引计数和链接，并确认 self 未改。'],
    completed: ['f355de1 新文档和双索引登记已完成，四个变更路径全部覆盖。'],
    incomplete: ['没有可引用的命令或 CI 执行记录，不能扩展 implemented 的验证含义。'],
  },
})
