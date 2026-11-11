import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: '064047104f5156043604afd50f2793e1b336950a',
  slug: 'commit-docs-finalization',
  title: 'Complete documentation for current and previous commits',
  kind: 'metadata-migration',
  status: 'implemented',
  beforeState: '直接父提交为 335b217，实际新增文档只属于祖父提交 d8023311609efec07cdedba3484a7cec0f84deb4。父快照已登记 55f7c7e，INDEX Implemented 为 54，JSON commits 为 56；d802331 的 SPEC/PLAN 尚不存在。',
  problem: '提交主题写着 current and previous commits，但实际 diff 既没有当前 0640471 的 SHA 文档，也没有直接父 335b217 的条目。记录必须以四路径事实为准，只闭合 d802331，而不能按主题扩张范围。',
  goals: [
    '新建 d802331 SPEC/PLAN，记录完整 SHA、Complete commit documentation for previous commit、2026-11-11T11:03:52+08:00 和 implemented。',
    '保存目标为 f355de1 建文档的四文件、78 行新增、1 行删除范围，并同步两个索引。',
  ],
  nonGoals: [
    '不因标题中的 current 而为 0640471 自我建档，也不补直接父 335b217 的文档。',
    '不修改产品行为。',
  ],
  architecture: [
    '实际结构仍是单层元数据迁移：d802331 SPEC/PLAN 为说明层，INDEX 和 status JSON 为两个发现层，没有第二组 current/previous 文档。',
    '新条目位于 55f7c7e 后、通用 self 前；self 不代表当前 SHA，其文档与对象内容不变，INDEX 汇总继续排除它。',
  ],
  decisions: [
    'SPEC 列出 f355de1-SPEC、f355de1-PLAN、INDEX 和 status JSON，目标与当前提交恰好都为 78 行新增，但两者路径不同。',
    '本次只让 d802331 贡献一个 implemented：INDEX 54→55，Partial/Unimplemented 仍为 1/0；JSON 数组 56→57，包含 self 时该状态计数 55→56。',
    '新对象在原零基下标 55，self 移至 56；没有 0640471 自我记录，self-SPEC、self-PLAN 和 changeId 均未改。',
  ],
  alternatives: ['按标题再创建当前提交文档会制造 diff 中不存在的文件，并引入 SHA 自引用；补直接父也不符合实际，因此仅依据现有四路径登记 d802331。'],
  security: ['变更仅为文档元数据，没有凭据、可执行逻辑、协议或权限边界变化。'],
  acceptance: [
    'SPEC/PLAN frontmatter 均指向 d802331 而非当前 0640471，目标和日期准确。',
    'INDEX 与 JSON 各只增加一个 d802331 入口，计数同步且 self 仍在末尾。',
  ],  remaining: ['标题未覆盖为实际额外工作：335b217 和 0640471 的文档仍由后续提交处理，本次仅 d802331 完成。'],
  references: [
    { path: 'docs/INDEX.md', role: 'changed', note: 'Implemented 54→55，只新增 d802331 行。' },
    { path: 'docs/plans/d802331-PLAN.md', role: 'changed', note: '新建的 d802331 计划，标题与目标主题一致。' },
    { path: 'docs/specs/d802331-SPEC.md', role: 'changed', note: '记录目标身份及 f355de1 文档组范围。' },
    { path: 'docs/status/index.json', role: 'changed', note: 'commits 56→57，唯一新增对象为 d802331。' },
  ],
  plan: {
    preconditions: ['以实际 diff 校正 current and previous 主题，确认目标是祖父 d802331 且只创建其两个文档。'],
    reuse: ['复用既有文档模板和索引结构，保持 55f7c7e 与 self 的相对位置及内容。'],
    steps: [
      { title: '编写 d802331 SPEC', detail: '记录目标为 f355de1 新建文档的四路径范围，不加入当前提交身份。', paths: ['docs/specs/d802331-SPEC.md'] },
      { title: '编写 d802331 PLAN', detail: '使用目标主题和元数据，补齐实施、风险、验证建议和完成状态。', paths: ['docs/plans/d802331-PLAN.md'] },
      { title: '只添加目标表格行', detail: '在 55f7c7e 后插入 d802331，Implemented 增至 55，不另加 current 行。', paths: ['docs/INDEX.md'] },
      { title: '只添加目标状态对象', detail: '把 d802331 完整身份放到 self 前，令数组达到 57 项而非增加两项。', paths: ['docs/status/index.json'] },
    ],
    compatibility: ['通用 self 机制继续解决当前 SHA 自引用，既有文档和索引路径完全保留。'],
    risks: ['主题是本次最大误导来源；按字面写两层文档会与 diff、SHA 和 self 语义全部冲突。'],
    acceptanceSequence: ['检查新 frontmatter 均为 d802331，确认 INDEX/JSON 只新增一项，并核对 self 和既有条目未改。'],
    completed: ['d802331 的 SPEC/PLAN 和双索引登记已落盘，没有标题暗示的额外文件。'],
    incomplete: ['新文档只列出验收条件，不保存历史命令或 CI 执行结果。'],
  },
})
