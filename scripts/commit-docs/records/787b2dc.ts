import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: '787b2dcef6629be82036283cc709384b56e6d981',
  slug: 'commit-docs-finalization',
  title: 'Complete previous commit documentation',
  kind: 'metadata-migration',
  status: 'implemented',
  beforeState: '父提交 b6bf9822536793efc08cd9ce4d94f1c066530d1c 已登记 6c3c1e4，INDEX Implemented 为 68，JSON 含 self 共 70 项。实际待补对象是祖父 96283aecc10afd0f0269eff9b7a3b0c543191b01，父树没有它的 SPEC/PLAN。',
  problem: '本提交需为 96283ae 补齐历史文档和入口，同时保留它为 612cc40 建档的实际范围；直接父 b6bf982 的 6c3c1e4 范围不能取而代之。',
  goals: [
    '新建 96283ae SPEC/PLAN，使用 Complete previous commit documentation、2026-11-11T11:12:02+08:00、完整 SHA 和 implemented。',
    '记录 612cc40 文档对、两个索引与 78 行新增、1 行删除，并同步 96283ae 的双索引注册。',
  ],
  nonGoals: [
    '不登记直接父 b6bf982 或当前 787b2dc，不改动 6c3c1e4 的既有入口。',
    '不修改生成器，只列出验收条件。',
  ],
  architecture: [
    '96283ae 的两个新 Markdown 文件保存历史说明，INDEX 与 status JSON 保存发现入口；diff 不含运行时代码。',
    '新历史项位于 6c3c1e4 和 self 之间，self 的 commit-docs-bootstrap 身份及 self 文档路径保持原样。',
  ],
  decisions: [
    'Actual scope 使用 612cc40-SPEC/PLAN 和两个索引，四文件统计 78/1，对应 96283ae 原提交。',
    '加入 96283ae 后，人类汇总达到 69 而 JSON 达到 71；两项差额来自既有 Partial 与 self，Unimplemented 仍为 0，含 self 的 implemented 为 70。',
    '96283ae 是第 70 个 JSON 对象，self 顺移到第 71 项；当前 787b2dc 没有新增自我 SHA 条目。',
  ],
  alternatives: ['若按直接父 b6bf982 建档会错用 6c3c1e4 范围并漏掉 96283ae；只更新两个索引则新增链接没有对应文件。'],
  security: ['全部变化是文档元数据，不涉及敏感值、执行权限、私有协议、依赖或产品安全行为。'],
  acceptance: [
    '96283ae 两份 frontmatter 的标题、日期、完整 SHA 一致，范围路径指向 612cc40。',
    'INDEX 和 JSON 各新增一个 implemented 项，6c3c1e4 保持前一项，self 继续处于末尾。',
  ],  remaining: ['b6bf982 与当前 787b2dc 在此快照仍未建档；96283ae 的模板计划没有实际验证轨迹。'],
  references: [
    { path: 'docs/INDEX.md', role: 'changed', note: 'Implemented 68→69，新增 96283ae。' },
    { path: 'docs/plans/96283ae-PLAN.md', role: 'changed', note: '新建 96283ae 计划文档。' },
    { path: 'docs/specs/96283ae-SPEC.md', role: 'changed', note: '记录 96283ae 及 612cc40 范围。' },
    { path: 'docs/status/index.json', role: 'changed', note: 'JSON 70→71，self 前加入 96283ae。' },
  ],
  plan: {
    preconditions: ['确认祖父 96283ae 为目标，核对其原始 612cc40 文档对和四文件 78/1 统计。'],
    reuse: ['沿用 6c3c1e4 后的追加顺序、self 占位、JSON 七字段和现有生成文档结构。'],
    steps: [
      { title: '编写 96283ae SPEC', detail: '写入完整身份、612cc40 文档路径及 78/1 行统计。', paths: ['docs/specs/96283ae-SPEC.md'] },
      { title: '编写 96283ae PLAN', detail: '以相同 frontmatter 保存实施步骤、风险、验证建议和完成状态。', paths: ['docs/plans/96283ae-PLAN.md'] },
      { title: '追加 INDEX 项', detail: '在 6c3c1e4 后新增 96283ae，只将 Implemented 改为 69。', paths: ['docs/INDEX.md'] },
      { title: '追加 JSON 项', detail: '把 96283ae 插入第 70 位，使 self 成为第 71 项。', paths: ['docs/status/index.json'] },
    ],
    compatibility: ['6c3c1e4 及更早历史项保持原序，self 内容和生成器行为不变，索引 schema 无调整。'],
    risks: ['96283ae 与当前提交标题相同，若忽略 fullSha 和祖父关系，会把 612cc40 范围挂到错误对象。'],
    acceptanceSequence: ['对照 96283ae 原始提交与新 SPEC/PLAN，并比较父/当前索引计数、路径和 self 下标。'],
    completed: ['96283ae 的 SPEC/PLAN 与双索引入口已在四个路径中同步完成。'],
    incomplete: ['新文档只列出验收条件，不保存历史命令或 CI 执行结果。'],
  },
})
