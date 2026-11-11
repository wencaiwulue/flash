import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: '5c5bc03abc666d111ae5e4227224884bbaafd340',
  title: 'Complete previous commit documentation',
  kind: 'metadata-migration',
  status: 'implemented',
  beforeState: '直接父版本 6b0ce9d 已把 b6bf982 登入索引，汇总达到 Implemented 70；但目标祖父提交 787b2dc 自己仍没有 SPEC、PLAN 和 status 记录，三条文档层级需分别辨认。',
  problem: '本次对象为 787b2dc，而不是父版本刚登记的 b6bf982。新规格还必须如实呈现 787b2dc 当时为 96283ae 新建两份文档的范围，不能沿用上一提交的 6c3c1e4 内容。',
  goals: [
    '创建 787b2dc-SPEC.md 和 787b2dc-PLAN.md，完整 SHA 使用 787b2dcef6629be82036283cc709384b56e6d981。',
    '为 787b2dc 增加表格及 JSON 入口，将 implemented 总数推进到 71，同时保留 Partial 1、Unimplemented 0 和末尾 self。',
  ],
  nonGoals: [
    '不补改 b6bf982 或 96283ae 的文档正文，不处理该四文件提交之外的代码行为。',
    '不声称新 PLAN 中的测试、构建和 CI 建议已经运行成功。',
  ],
  architecture: [
    '该提交是在已有文档树上增加一个目标祖父提交节点：SPEC/PLAN 为内容节点，INDEX 与 status 分别提供人类和程序访问入口。',
    '787b2dc-SPEC 的四个 Actual scope 路径包含 96283ae 的两个产物，这是被描述提交的范围；5c5bc03 自身的范围则是 787b2dc 两个新文件加双索引。',
  ],
  decisions: [
    '规格采用 787b2dc 的 Complete previous commit documentation 标题和时间，并保存其 4 文件、78 行新增、1 行删除统计。',
    '两个索引都仅在 self 之前插入 787b2dc；计数从 70 改为 71，不重写 6b0ce9d 新增的 b6bf982 行。',
  ],
  alternatives: ['复制 6b0ce9d 的 b6bf982 文档再替换短 SHA 会留下错误的 6c3c1e4 内层范围；仅增加 INDEX 行也会缺 PLAN 和机器状态，因此需要重新核对并四处同步。'],
  security: ['本 diff 没有可执行代码、凭据或权限策略，新增的安全声明只是文档文字，不表示新增防护或放宽约束。'],
  acceptance: [
    '新文件 frontmatter 的 787b2dc 全 SHA、2026-11-11T11:12:59+08:00 日期及 implemented 状态准确。',
    'Actual scope 指向 96283ae-SPEC/PLAN，INDEX 为 71/1/0，status 对象路径有效，self 未被修改或移位。',
  ],
  evidence: [
    {
      kind: 'diff-observed',
      statement: 'SPEC 在提交中新建，frontmatter 为 787b2dc，范围清单则明确列出 96283ae 的两个历史文档。',
      source: { path: 'docs/specs/787b2dc-SPEC.md', role: 'evidence', revision: '5c5bc03abc666d111ae5e4227224884bbaafd340', symbol: 'commit: 787b2dcef6629be82036283cc709384b56e6d981', note: '完整 SHA 将本规格绑定到目标祖父提交。' },
    },
    {
      kind: 'diff-observed',
      statement: 'PLAN 与 SPEC 使用同一提交标题和状态，并给出独立的实施计划文档。',
      source: { path: 'docs/plans/787b2dc-PLAN.md', role: 'evidence', revision: '5c5bc03abc666d111ae5e4227224884bbaafd340', symbol: '# Implementation plan: Complete previous commit documentation', note: '计划标题匹配 787b2dc subject。' },
    },
    {
      kind: 'diff-observed',
      statement: 'INDEX 的 patch 只有汇总增加及 787b2dc 新行，既有 b6bf982 与 self 行保持原序。',
      source: { path: 'docs/INDEX.md', role: 'evidence', revision: '5c5bc03abc666d111ae5e4227224884bbaafd340', symbol: '- Implemented: 71', note: '当前提交版本可核对 71 的汇总。' },
    },
    {
      kind: 'diff-observed',
      statement: '机器索引新增 787b2dc 对象，其两个字段分别指向 787b2dc-SPEC 和 787b2dc-PLAN。',
      source: { path: 'docs/status/index.json', role: 'evidence', revision: '5c5bc03abc666d111ae5e4227224884bbaafd340', symbol: '"fullSha": "787b2dcef6629be82036283cc709384b56e6d981"', note: 'status 记录位于 self 对象前。' },
    },
    { kind: 'not-recorded', statement: '提交没有附上 bun test、typecheck、build 或 CI 输出，故这里不记录任何通过结论。' },
  ],
  remaining: ['787b2dc 的设计细节没有被新模板充分展开；若需补充，应基于该历史提交另写分析，而不是把验证文字升级为事实。'],
  references: [
    { path: 'docs/INDEX.md', role: 'changed', note: '新增 787b2dc 入口并将 Implemented 提至 71。' },
    { path: 'docs/plans/787b2dc-PLAN.md', role: 'changed', note: '目标祖父提交的实施计划新文件。' },
    { path: 'docs/specs/787b2dc-SPEC.md', role: 'changed', note: '记录 787b2dc 身份及其 96283ae 文档范围。' },
    { path: 'docs/status/index.json', role: 'changed', note: '登记 787b2dc 完整状态对象，self 保持末位。' },
  ],
  plan: {
    preconditions: ['确认父版本计数为 70，读取 787b2dc 的完整 metadata，并核对其 SPEC 应描述的 96283ae 两个文件。'],
    reuse: ['复用刚由 6b0ce9d 建立的四文件注册形式，但替换所有身份、日期、内层路径和计数，而非沿用正文。'],
    steps: [
      { title: '登记目标祖父提交规格', detail: '在 787b2dc 规格中写清 96283ae 的 SPEC/PLAN 才是该历史提交创建的文档。', paths: ['docs/specs/787b2dc-SPEC.md'] },
      { title: '生成对应计划', detail: '用 Complete previous commit documentation 的准确标题建立 787b2dc 计划并保留验证边界。', paths: ['docs/plans/787b2dc-PLAN.md'] },
      { title: '扩展人工导航', detail: '在 b6bf982 行之后添加 787b2dc 行，同时把 implemented 汇总改为 71。', paths: ['docs/INDEX.md'] },
      { title: '扩展状态数组', detail: '为 787b2dc 写入 fullSha、时间、主题和 spec/plan 路径，插入点固定在 self 前。', paths: ['docs/status/index.json'] },
    ],
    compatibility: ['不清空或重排历史对象；现有 b6bf982 链接、self changeId 以及索引格式均原样保留。'],
    risks: ['相邻提交都采用相同文件数与 diff 统计，最容易误复制 b6bf982 的身份或 6c3c1e4 的范围，验证命令也可能被误读。'],
    verification: ['逐项比对 787b2dc metadata 与 frontmatter，检查 96283ae 范围、71/1/0 计数、两个索引链接和 self 的位置。'],
    completed: ['目标祖父提交 787b2dc 已具备 SPEC、PLAN、INDEX 行和 status 对象，四个实际路径全部覆盖。'],
    incomplete: ['未留下可核验的命令执行或持续集成记录，完成状态仅指元数据迁移已写入。'],
  },
})
