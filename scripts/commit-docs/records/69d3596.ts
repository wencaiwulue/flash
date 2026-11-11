import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: '69d3596e99fa57a97ac37628d1aab22880b5a060',
  title: 'Finalize previous commit documentation',
  kind: 'metadata-migration',
  status: 'implemented',
  beforeState: '在 parent c8338e1 中，INDEX 已列到 fdffe9e，Implemented/Partial/Unimplemented 为 83/1/0；3c4b6f2752cee47fd15ead682e6016fe48174bd8 的 SPEC、PLAN 与登记项尚不存在。',
  problem: '3c4b6f2 已为 e8d8c06 建立两个文档，但它本身没有可发现入口。本次新增内容必须落在 3c4b6f2 名下，同时保留其 SPEC 对 e8d8c06 文档范围的追溯。',
  goals: [
    '创建 docs/specs/3c4b6f2-SPEC.md 和 docs/plans/3c4b6f2-PLAN.md，使用 3c4b6f2 的准确 metadata。',
    '将人类索引 implemented 数更新到 84，并在机器索引中增加 3c4b6f2 及其两个新路径。',
  ],
  nonGoals: [
    '不修改上一层 e8d8c06 的文档，也不处理 parent c8338e1 自身后续才需要的补档。',
    '不把模板中的测试、typecheck、build 或 CI 语句当成已发生事件。',
  ],
  architecture: [
    '四个补丁路径没有产品运行面：SPEC 保存 3c4b6f2 对 e8d8c06 的历史说明，PLAN 保存同身份计划，INDEX 与 status JSON 提供两个发现入口。',
    '新增历史项排在 fdffe9e 后，self 始终保留在两项索引末尾；因此 self 的语义与位置都不随 Implemented 增至 84 而改变。',
  ],
  decisions: [
    'frontmatter 采用 3c4b6f2 的 Finalize 标题、2026-11-11T11:20:31+08:00 和完整 SHA，Actual scope 包含 e8d8c06 两个路径与 78+1 统计。',
    'INDEX 只修改 83→84 并增加一行；JSON 仅追加一个 implemented 对象，spec/plan 使用 3c4b6f2 文件名而非嵌套的 e8d8c06 文件名。',
  ],
  alternatives: ['把 3c4b6f2 附加到 e8d8c06 的 JSON 对象无法保留独立提交身份；跳过任一索引则会造成两种读取方式不一致。'],
  security: ['仅新增 Markdown 文本和 JSON 元数据，不涉及凭据处理、外部输入、权限或代码执行。'],
  acceptance: [
    '两个新文档均指向 3c4b6f2752cee47fd15ead682e6016fe48174bd8，且范围中的上一代短 SHA 为 e8d8c06。',
    'INDEX 为 84/1/0，3c4b6f2 行及 JSON 对象均位于 self 前，并准确链接两个新产物。',
  ],
  evidence: [
    {
      kind: 'diff-observed',
      statement: '3c4b6f2 SPEC 记录四个历史 changed paths，其中 SPEC/PLAN 名为 e8d8c06，统计为 78 insertions 和 1 deletion。',
      source: { path: 'docs/specs/3c4b6f2-SPEC.md', role: 'evidence', revision: 'commit', symbol: 'docs/plans/e8d8c06-PLAN.md', note: '路径块保留被补档提交的实际范围。' },
    },
    {
      kind: 'diff-observed',
      statement: '3c4b6f2 PLAN 的 frontmatter 带有 2026-11-11T11:20:31+08:00，正文含标准计划与完成状态部分。',
      source: { path: 'docs/plans/3c4b6f2-PLAN.md', role: 'evidence', revision: 'commit', symbol: 'date: 2026-11-11T11:20:31+08:00', note: '日期来自被补档提交而非当前提交。' },
    },
    {
      kind: 'diff-observed',
      statement: 'INDEX patch 把 Implemented 从 83 提至 84，新增 3c4b6f2 的 Finalize 行。',
      source: { path: 'docs/INDEX.md', role: 'evidence', revision: 'commit', symbol: '- Implemented: 84', note: 'Partial 1、Unimplemented 0 保持原值。' },
    },
    {
      kind: 'diff-observed',
      statement: 'status JSON 在 self 前新增 3c4b6f2，spec 和 plan 均使用 3c4b6f2 前缀。',
      source: { path: 'docs/status/index.json', role: 'evidence', revision: 'commit', symbol: '"spec": "docs/specs/3c4b6f2-SPEC.md"', note: '完整 SHA 与日期也随对象写入。' },
    },
    { kind: 'not-recorded', statement: 'Verification sequence 仅列出建议命令，提交没有保存任何执行日志或 CI 结论。' },
  ],
  remaining: ['PLAN 仍使用通用实施措辞，没有逐步对应 3c4b6f2 的两个新文件和两处索引更新。'],
  references: [
    { path: 'docs/INDEX.md', role: 'changed', note: '新增 3c4b6f2 行，Implemented 83→84。' },
    { path: 'docs/plans/3c4b6f2-PLAN.md', role: 'changed', note: '新建 3c4b6f2 计划文档。' },
    { path: 'docs/specs/3c4b6f2-SPEC.md', role: 'changed', note: '新建追溯 e8d8c06 范围的 3c4b6f2 SPEC。' },
    { path: 'docs/status/index.json', role: 'changed', note: '在 self 前新增 3c4b6f2 状态对象。' },
  ],
  plan: {
    preconditions: ['确认本提交 parent 是 c8338e1，被补档身份是 3c4b6f2，其文档内历史对象是 e8d8c06。'],
    reuse: ['复用 fdffe9e 之后的追加位置、既有 Markdown 标题层级与 JSON 字段。'],
    steps: [
      { title: '生成 3c4b6f2 SPEC', detail: '把 e8d8c06 的两个历史产物写入范围块，并固定 3c4b6f2 的完整身份。', paths: ['docs/specs/3c4b6f2-SPEC.md'] },
      { title: '生成配套计划', detail: '按同一日期与 Finalize 标题组织计划、风险、验证和剩余项。', paths: ['docs/plans/3c4b6f2-PLAN.md'] },
      { title: '增加第 84 项', detail: '在 fdffe9e 行后添加 3c4b6f2 链接，并仅调整 implemented 汇总。', paths: ['docs/INDEX.md'] },
      { title: '添加 3c4b6f2 状态', detail: '把同身份和新文件路径序列化到 self 之前的 JSON 对象。', paths: ['docs/status/index.json'] },
    ],
    compatibility: ['不排序或改写旧条目，现有 SPEC/PLAN 链接和 self 路径保持有效。'],
    risks: ['3c4b6f2 与 e8d8c06 都是 Finalize，若只按标题查找会混淆文档主体和范围引用。'],
    verification: ['用 3c4b6f2 的真实路径列表核对 SPEC，再检查当前索引 84 计数、链接和 JSON fullSha。'],
    completed: ['3c4b6f2 的文档文件、表格链接及机器状态已经一起补齐。'],
    incomplete: ['没有实际验证输出，且计划细节未超出通用模板。'],
  },
})
