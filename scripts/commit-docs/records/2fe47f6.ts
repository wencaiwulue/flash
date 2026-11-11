import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: '2fe47f6e46a3add0a3ee9bdd57bda9feac2220a7',
  title: 'Complete documentation for previous commit',
  kind: 'metadata-migration',
  status: 'implemented',
  beforeState: '直接父提交是 f251df9，但本次实际定稿对象为其父提交 7ca78c1a18a7f05e1740f701b256079bb4cc2c2e。父快照没有 7ca78c1 的 SPEC/PLAN，INDEX 的 Implemented 为 49，status commits 数组为 51 项。',
  problem: '7ca78c1 已一次补齐两组历史文档，自己却缺少可发现的身份与范围说明；需要把该六文件提交登记到 Markdown 和 JSON 两套索引，同时保留直接父提交 f251df9 的后续补写位置。',
  goals: [
    '新建 7ca78c1 的 SPEC/PLAN，frontmatter 固定其完整 SHA、2026-11-11T10:57:38+08:00、原主题和 implemented 状态。',
    '登记目标提交的六文件、145 行新增和 1 行删除范围，并同步 INDEX 与 status JSON。',
  ],
  nonGoals: [
    '不在本提交补写直接父 f251df9 或当前提交自身的 SPEC/PLAN。',
    '不修改产品代码，也不把生成文档中的测试、构建或 CI 文字视为执行结果。',
  ],
  architecture: [
    '这是纯元数据迁移：两个新文档描述 7ca78c1，两个既有索引增加同一身份；没有运行时组件或协议数据流。',
    'INDEX 的 Implemented 不计 self，status JSON 则保留 self 对象；新增项插在 self 前，因此两种计数口径相差一项。',
  ],
  decisions: [
    'SPEC 明确列出 63e138f 与 fe3c177 两组 SPEC/PLAN，加 INDEX 和 status JSON 共六条目标路径，避免套用普通四文件 finalization 的范围。',
    'INDEX Implemented 从 49 调整为 50，Partial 1 与 Unimplemented 0 不动；JSON commits 从 51 增至 52，含 self 的 implemented 从 50 增至 51。',
    '本提交自身只有四文件、80 行新增和 1 行删除；self 文档及 self 索引内容不变，self 行和对象继续位于末尾。',
  ],
  alternatives: ['同时补写 f251df9 会把另一次 finalization 混入本提交；只记录常见四文件模板又会丢失 7ca78c1 的六文件事实，因此按目标真实 diff 单独建档。'],
  security: ['四个变更路径均为文档元数据，不引入凭据、可执行逻辑、私有协议或权限变化。'],
  acceptance: [
    '两个 frontmatter 与 7ca78c1 的完整 SHA、主题、日期和 implemented 状态一致。',
    'INDEX 链接与 JSON spec/plan 字段指向新文件，汇总、表格行和数组对象使用同一身份。',
  ],
  evidence: [
    {
      kind: 'diff-observed',
      statement: '新 SPEC 的 frontmatter 锁定 7ca78c1，Actual scope 记录六文件及 145 行新增、1 行删除。',
      source: { path: 'docs/specs/7ca78c1-SPEC.md', role: 'evidence', revision: 'commit', symbol: 'commit: 7ca78c1a18a7f05e1740f701b256079bb4cc2c2e', note: '目标提交身份与范围可在新 SPEC 核对。' },
    },
    {
      kind: 'diff-observed',
      statement: '新 PLAN 提供实施步骤、风险、验证序列和 implemented 完成状态。',
      source: { path: 'docs/plans/7ca78c1-PLAN.md', role: 'evidence', revision: 'commit', symbol: '## Implementation steps', note: '计划文件由本提交新建。' },
    },
    {
      kind: 'diff-observed',
      statement: 'INDEX patch 将 Implemented 改为 50，并在 self 前增加 7ca78c1 链接行。',
      source: { path: 'docs/INDEX.md', role: 'evidence', revision: 'commit', symbol: '- Implemented: 50', note: '人类索引的计数与新增入口。' },
    },
    {
      kind: 'diff-observed',
      statement: 'status patch 在末尾 self 对象前插入 7ca78c1，数组总数由 51 变为 52。',
      source: { path: 'docs/status/index.json', role: 'evidence', revision: 'commit', symbol: '"fullSha": "7ca78c1a18a7f05e1740f701b256079bb4cc2c2e"', note: '机器索引保存完整目标 SHA 和文档路径。' },
    },
    { kind: 'not-recorded', statement: '文档列出的 bun test、typecheck、build 和 CI 检查没有随附输出或通过记录。' },
  ],
  remaining: ['直接父 f251df9 与当前提交的文档不在本次四文件范围内，分别由后续 finalization 流程处理。'],
  references: [
    { path: 'docs/INDEX.md', role: 'changed', note: 'Implemented 49→50，并在 self 前新增 7ca78c1 行。' },
    { path: 'docs/plans/7ca78c1-PLAN.md', role: 'changed', note: '新建的 7ca78c1 实施计划。' },
    { path: 'docs/specs/7ca78c1-SPEC.md', role: 'changed', note: '新建目标身份及六文件实际范围说明。' },
    { path: 'docs/status/index.json', role: 'changed', note: 'commits 51→52，新对象插在末尾 self 前。' },
  ],
  plan: {
    preconditions: ['区分直接父 f251df9 与实际目标 7ca78c1，并读取目标六文件 diff 和父快照索引。'],
    reuse: ['沿用既有 SPEC/PLAN frontmatter、INDEX 表格和 status 对象结构，不重排历史条目。'],
    steps: [
      { title: '记录六文件 SPEC', detail: '写入 7ca78c1 身份，并逐项列出两组历史 SPEC/PLAN 与两个索引。', paths: ['docs/specs/7ca78c1-SPEC.md'] },
      { title: '记录对应 PLAN', detail: '复用相同 frontmatter，概述目标提交的实施、风险和完成状态。', paths: ['docs/plans/7ca78c1-PLAN.md'] },
      { title: '更新表格索引', detail: '仅递增 Implemented，在 self 前添加指向 7ca78c1 新文档的一行。', paths: ['docs/INDEX.md'] },
      { title: '更新状态数组', detail: '把同一完整 SHA 和路径对象插到原 self 位置，使 self 顺移到数组末尾。', paths: ['docs/status/index.json'] },
    ],
    compatibility: ['既有文档路径和条目顺序不变；self 的 changeId、内容和末尾语义保持原样。'],
    risks: ['目标六文件与本提交四文件容易混淆，INDEX 与 JSON 的 self 计数口径也可能被错误等同。'],
    verification: ['对照目标 diff 检查六条路径和统计，解析 JSON 并核对 INDEX 计数、链接及 self 末位。'],
    completed: ['7ca78c1 的两个新产物及两套索引登记已落盘，目标身份和范围一致。'],
    incomplete: ['没有命令或 CI 执行证据；本记录只验收元数据变更，不为文档中的验证 prose 背书。'],
  },
})
