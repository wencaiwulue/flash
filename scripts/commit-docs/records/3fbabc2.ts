import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: '3fbabc2d43b99236cae4c232c6730bb6bc0a19ef',
  title: 'Finalize previous commit documentation',
  kind: 'metadata-migration',
  status: 'implemented',
  beforeState: '本提交直接父为 d472e5c，实际定稿目标是祖父提交 2f55f199acfd26b90c81c5de3c5ca6fcfe167dfc。父快照已登记 501672c，尚无 2f55f19 SPEC/PLAN；INDEX Implemented 为 58，JSON commits 为 60 项。',
  problem: '2f55f19 已为主题特殊的 0640471 建立文档，现在需要补自己的身份。该环节是这十步链条中 Implemented 达到 59 的一次迁移，不能把直接父 d472e5c 或当前 3fbabc2 混入新增条目。',
  goals: [
    '创建 2f55f19 SPEC/PLAN，记录完整 SHA、Finalize previous commit documentation、2026-11-11T11:05:45+08:00 和 implemented。',
    '记录目标为 0640471 新建文档的四文件、78 行新增、1 行删除范围，并同步 INDEX 与 status JSON。',
  ],
  nonGoals: [
    '不补直接父 d472e5c 或当前 3fbabc2 的文档，不改写上一轮 501672c 条目。',
    '不修改产品代码，不从文档中的测试、构建或 CI 文字推断执行通过。',
  ],
  architecture: [
    '新增 2f55f19 SPEC/PLAN 保存目标说明，INDEX 与 commits 数组分别追加入口，构成本次全部四路径元数据变化。',
    '新条目位于 501672c 和 self 之间；self 被顺移到第 61 项及表格末行，固定占位内容和两个 self 文档不变。',
  ],
  decisions: [
    'SPEC 列出 0640471-SPEC、0640471-PLAN、INDEX 和 status JSON，目标统计与当前提交均为 78 行新增、1 行删除，但路径对象不同。',
    '本次新增一个 implemented 对象：表格从 58 增至 59，JSON 从 60 个元素增至 61 个；self 计入后 implemented 为 60，partial 始终为 1。',
    '没有为 3fbabc2 自身创建 SPEC/PLAN 或 SHA 对象，通用 self 仍为 commit-docs-bootstrap，未替换为当前 SHA。',
  ],
  alternatives: ['把 d472e5c 当作目标会使链条倒退一层；同时登记当前提交又会产生 diff 之外的文件，因此仅新增祖父 2f55f19 的两个产物和一个索引身份。'],
  security: ['变更只含公开提交元数据，不涉及凭据、接口、权限、feature gating 或私有协议。'],
  acceptance: [
    '两个 frontmatter 与 2f55f19 的完整 SHA、主题、日期和 implemented 一致，Actual scope 对应 0640471 文档组。',
    'INDEX 新行和 JSON 新对象使用相同链接，Implemented 为 59、commits 为 61，self 仍在最后。',
  ],
  evidence: [
    {
      kind: 'diff-observed',
      statement: '新 SPEC 固定 2f55f19 完整身份，并记录 0640471 文档组及 78 行新增、1 行删除。',
      source: { path: 'docs/specs/2f55f19-SPEC.md', role: 'evidence', revision: 'commit', symbol: 'commit: 2f55f199acfd26b90c81c5de3c5ca6fcfe167dfc', note: '目标 frontmatter 与实际范围。' },
    },
    {
      kind: 'diff-observed',
      statement: '新 PLAN 包含目标实施步骤、风险和 implemented 完成状态。',
      source: { path: 'docs/plans/2f55f19-PLAN.md', role: 'evidence', revision: 'commit', symbol: '## Implementation steps', note: '新计划文件的步骤锚点。' },
    },
    {
      kind: 'diff-observed',
      statement: 'INDEX patch 将 Implemented 调为 59，并在 501672c 后、self 前新增 2f55f19。',
      source: { path: 'docs/INDEX.md', role: 'evidence', revision: 'commit', symbol: '- Implemented: 59', note: '本链条位置的表格计数与入口。' },
    },
    {
      kind: 'diff-observed',
      statement: 'status patch 将 2f55f19 插到 self 前，commits 从 60 增至 61。',
      source: { path: 'docs/status/index.json', role: 'evidence', revision: 'commit', symbol: '"fullSha": "2f55f199acfd26b90c81c5de3c5ca6fcfe167dfc"', note: '完整目标身份及新文档路径。' },
    },
    { kind: 'not-recorded', statement: '没有测试、typecheck、build 或 CI 执行输出；验证 prose 不是通过证据。' },
  ],
  remaining: ['直接父 d472e5c 与当前 3fbabc2 的文档不在本次范围，分别留给后续 finalization 提交。'],
  references: [
    { path: 'docs/INDEX.md', role: 'changed', note: 'Implemented 58→59，新增 2f55f19 行。' },
    { path: 'docs/plans/2f55f19-PLAN.md', role: 'changed', note: '新建的 2f55f19 实施计划。' },
    { path: 'docs/specs/2f55f19-SPEC.md', role: 'changed', note: '记录目标身份及 0640471 文档组范围。' },
    { path: 'docs/status/index.json', role: 'changed', note: 'commits 60→61，新对象位于 self 前。' },
  ],
  plan: {
    preconditions: ['确认祖父 2f55f19 是目标，核对其 0640471 两个产物和 78 行目标 diff。'],
    reuse: ['沿用 501672c 后的索引顺序、既有 frontmatter 和 JSON 字段，保留固定 self。'],
    steps: [
      { title: '编写 2f55f19 SPEC', detail: '记录目标为 0640471 创建的两个文档和两个索引，标明 78 行新增。', paths: ['docs/specs/2f55f19-SPEC.md'] },
      { title: '编写 2f55f19 PLAN', detail: '使用目标身份补齐实施、风险、验证建议和完成状态。', paths: ['docs/plans/2f55f19-PLAN.md'] },
      { title: '登记第 59 个表格 implemented', detail: '在 501672c 后插入 2f55f19 行，使不含 self 的 Implemented 从 58 增至 59。', paths: ['docs/INDEX.md'] },
      { title: '登记第 61 项数组边界', detail: '把目标对象放在 self 前，令 commits 总数达到 61，self 顺移到最后一项。', paths: ['docs/status/index.json'] },
    ],
    compatibility: ['既有 501672c 及更早链接不变，self 文档、changeId、主题和路径格式均保持原样。'],
    risks: ['末段提交标题与统计高度相似，必须靠完整 SHA、0640471 路径和 60→61 数组变化识别本记录。'],
    verification: ['核对目标 SPEC/PLAN frontmatter 与范围，比较 INDEX/JSON 父当前版本，并确认 self 内容和末位。'],
    completed: ['2f55f19 两个新产物及双索引登记已完成，所有四个变更路径均有覆盖。'],
    incomplete: ['未记录命令执行或 CI 结果，元数据 implemented 不代表验证通过。'],
  },
})
