import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: '335b217899a7b0920f972973a92363db436f158f',
  slug: 'commit-docs-finalization',
  title: 'Finalize previous commit documentation',
  kind: 'metadata-migration',
  status: 'implemented',
  beforeState: '直接父提交 d802331 尚无自身条目，本次目标是其父提交 55f7c7e66db7653d2afaa546162a6dc486c547d7。父快照含 f355de1 但不含 55f7c7e SPEC/PLAN；INDEX Implemented 为 53，JSON commits 为 55 项。',
  problem: '55f7c7e 已为 2fe47f6 写入 80 行目标范围的文档，现在需要补自己的身份。这个中间环节既要与直接父 d802331 分开，也要保留目标与当前提交不同的 diff 统计。',
  goals: [
    '新建 55f7c7e SPEC/PLAN，记录完整 SHA、Finalize documentation for previous change、2026-11-11T11:03:24+08:00 和 implemented。',
    '准确保存目标四文件、78 行新增、1 行删除及 2fe47f6 两个产物，并同步 INDEX 和 status JSON。',
  ],
  nonGoals: [
    '不为直接父 d802331 或当前 335b217 建文档，不调整已有 f355de1 记录。',
    '不修改产品实现。',
  ],
  architecture: [
    '本次迁移用 55f7c7e 的两个新文档扩展说明层，再分别更新 Markdown 表格和 JSON commits，仍无运行时数据流。',
    '新条目接在 f355de1 后，self 被顺移但保持末尾；INDEX 不含 self 的 Implemented 与 JSON 含 self 的计数保持一项差。',
  ],
  decisions: [
    'SPEC 的目标统计采用 78 行新增；55f7c7e 描述的 2fe47f6 才是 80 行新增，当前 335b217 自身也为 78 行新增、1 行删除。',
    '在 INDEX 中，53 个 implemented 增至 54 个，partial/unimplemented 保持 1/0；在 JSON 中，self 前插入使 commits 55→56，同时 implemented（含 self）54→55。',
    '新增对象在原零基下标 54、self 前；当前提交没有自我 SHA 记录或 SPEC/PLAN，两个 self 文档和 changeId 均未改。',
  ],
  alternatives: ['把 55f7c7e 所描述的 2fe47f6 的 80 行统计套到本层，会把目标自身的 78 行误增两行；改为登记直接父 d802331 则会抢占 0640471 的实际工作，因此只补 55f7c7e。'],
  security: ['只有文档与状态元数据变化，不新增凭据、私有协议、依赖或权限绕过。'],
  acceptance: [
    '两个 frontmatter 与 55f7c7e 的完整身份一致，Actual scope 为 2fe47f6 文档组和 78 行新增。',
    'INDEX 新行与 JSON 对象的链接、主题、日期、状态一致，self 仍为表格和数组末项。',
  ],  remaining: ['直接父 d802331 与当前 335b217 的文档分别由后续环节处理，本提交仅完成 55f7c7e 元数据闭合。'],
  references: [
    { path: 'docs/INDEX.md', role: 'changed', note: 'Implemented 53→54，新增 55f7c7e 行。' },
    { path: 'docs/plans/55f7c7e-PLAN.md', role: 'changed', note: '新建的 55f7c7e 实施计划。' },
    { path: 'docs/specs/55f7c7e-SPEC.md', role: 'changed', note: '记录目标身份及 2fe47f6 文档组的 78 行统计。' },
    { path: 'docs/status/index.json', role: 'changed', note: 'commits 55→56，self 前插入目标对象。' },
  ],
  plan: {
    preconditions: ['确认目标为祖父提交 55f7c7e，核对其 2fe47f6 两个产物和 78 行目标 diff。'],
    reuse: ['沿用 f355de1 之后的表格与数组顺序，复用既有 frontmatter、对象字段和 self 占位。'],
    steps: [
      { title: '编写 55f7c7e SPEC', detail: '记录目标为 2fe47f6 建文档的四条路径，并保留其 78 行新增统计。', paths: ['docs/specs/55f7c7e-SPEC.md'] },
      { title: '编写 55f7c7e PLAN', detail: '以同一身份描述目标实施、风险、验证建议和完成状态。', paths: ['docs/plans/55f7c7e-PLAN.md'] },
      { title: '推进 INDEX 位置', detail: '在 f355de1 后添加 55f7c7e 行，把 Implemented 从 53 调为 54。', paths: ['docs/INDEX.md'] },
      { title: '推进 JSON 位置', detail: '在原 self 下标插入新对象，使 commits 达到 56 项且 self 仍居末位。', paths: ['docs/status/index.json'] },
    ],
    compatibility: ['既有 f355de1 及更早链接不变，self 文档、changeId 和路径字段格式不变。'],
    risks: ['当前与目标统计均为 78，目标内部的 2fe47f6 统计才是 80；父提交与祖父提交身份也容易在连续 finalization 中错位。'],
    acceptanceSequence: ['核对目标 frontmatter 和 Actual scope，比较父/当前 INDEX 与 JSON，并检查 self 仅发生位置移动。'],
    completed: ['55f7c7e 两个文档及两个索引入口已创建，四个变更路径无遗漏。'],
    incomplete: ['没有执行日志或 CI 结果；implemented 仅表示写入的元数据状态。'],
  },
})
