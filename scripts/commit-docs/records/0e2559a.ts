import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: '0e2559ac8ac23b99ff705b51372d2eb97a8487d6',
  title: 'Finalize previous commit documentation',
  kind: 'metadata-migration',
  status: 'implemented',
  beforeState: 'parent 846c130 已完成 c8338e1 的登记，INDEX 为 Implemented 85、Partial 1、Unimplemented 0；69d3596e99fa57a97ac37628d1aab22880b5a060 则仍缺 SPEC、PLAN、表格行和 JSON 对象。',
  problem: '69d3596 的原始工作是为 3c4b6f2 补文档，本提交再次向上为 69d3596 补文档。新 SPEC 中会出现 3c4b6f2 路径，但本提交实际创建的必须是 69d3596 路径。',
  goals: [
    '新建 docs/specs/69d3596-SPEC.md 与 docs/plans/69d3596-PLAN.md，使用 69d3596 的完整身份、日期和 Finalize 标题。',
    '把 INDEX implemented 计数更新为 86，并在 status JSON 的 self 前注册 69d3596 及两个新产物。',
  ],
  nonGoals: [
    '不修改 3c4b6f2 的已有 SPEC/PLAN，也不为实际 parent 846c130 同时补档。',
    '不把文档中写出的验证命令、剩余项为“无”等文字当作额外执行或设计证据。',
  ],
  architecture: [
    '这一提交构成两代文档关系的桥接：69d3596 的 SPEC 描述其 3c4b6f2 历史范围，本次 diff 则新增 69d3596 自身文档并扩展两个索引。',
    'c8338e1 仍是追加前最后一个历史项，新增 69d3596 排在它之后；self 对象和 self 表格行不被历史提交计数吞并或重命名。',
  ],
  decisions: [
    '两个 frontmatter 使用 2026-11-11T11:21:43+08:00、Finalize subject 和 implemented；SPEC 保留 69d3596 原提交 4 文件、78 insertions、1 deletion。',
    'INDEX 只把 Implemented 85 改为 86；status 新增对象的 fullSha、shortSha、date、subject、spec、plan 与同一被补档提交一致。',
  ],
  alternatives: ['直接把 3c4b6f2 条目替换成 69d3596 会破坏上一代链接；仅增加计数则产生无入口统计，所以保留旧项并追加完整四路径。'],
  security: ['此次 diff 无运行时代码、凭据、依赖或权限语义变化，只有文档和索引元数据。'],
  acceptance: [
    '69d3596 完整 SHA 在新 SPEC、新 PLAN 和 status 中一致，嵌套历史路径为 3c4b6f2。',
    'INDEX 显示 86/1/0，新行和 JSON 对象均位于 self 前，并指向实际存在的 69d3596 SPEC/PLAN。',
  ],
  evidence: [
    {
      kind: 'diff-observed',
      statement: '69d3596 SPEC 的 frontmatter 固定其完整 SHA，Actual scope 中的两个文档路径则使用 3c4b6f2 前缀。',
      source: { path: 'docs/specs/69d3596-SPEC.md', role: 'evidence', revision: 'commit', symbol: 'docs/specs/3c4b6f2-SPEC.md', note: 'frontmatter 与范围路径共同区分两代提交。' },
    },
    {
      kind: 'diff-observed',
      statement: '新 PLAN 带有 69d3596 的 Finalize 标题和 2026-11-11T11:21:43+08:00，状态为 implemented。',
      source: { path: 'docs/plans/69d3596-PLAN.md', role: 'evidence', revision: 'commit', symbol: 'date: 2026-11-11T11:21:43+08:00', note: '该日期属于被补档提交 69d3596。' },
    },
    {
      kind: 'diff-observed',
      statement: 'INDEX patch 把 Implemented 从 85 改为 86，并在 c8338e1 后新增 69d3596 行。',
      source: { path: 'docs/INDEX.md', role: 'evidence', revision: 'commit', symbol: '| 69d3596 | Finalize previous commit documentation | implemented |', note: 'Partial 与 Unimplemented 仍为 1、0，self 行不变。' },
    },
    {
      kind: 'diff-observed',
      statement: 'status JSON 在 self 前加入 69d3596 完整对象，两个文档字段使用 69d3596 文件名。',
      source: { path: 'docs/status/index.json', role: 'evidence', revision: 'commit', symbol: '"fullSha": "69d3596e99fa57a97ac37628d1aab22880b5a060"', note: '机器可读身份与新文件路径同步。' },
    },
    { kind: 'not-recorded', statement: 'SPEC 和 PLAN 的验证文字没有日志支撑，本提交不记录测试、构建或 CI 结果。' },
  ],
  remaining: ['生成的 PLAN 没有按 69d3596 的真实四路径展开，背景和剩余工作也仍为通用表述。'],
  references: [
    { path: 'docs/INDEX.md', role: 'changed', note: 'Implemented 85→86，新增 69d3596 行。' },
    { path: 'docs/plans/69d3596-PLAN.md', role: 'changed', note: '新建 69d3596 的 Finalize 计划。' },
    { path: 'docs/specs/69d3596-SPEC.md', role: 'changed', note: '新建范围指向 3c4b6f2 的 69d3596 SPEC。' },
    { path: 'docs/status/index.json', role: 'changed', note: '在 self 前添加 69d3596 对象。' },
  ],
  plan: {
    preconditions: ['核对 69d3596 的完整 SHA 和原 diff，并明确 3c4b6f2 只出现在其历史范围中。'],
    reuse: ['沿用 c8338e1 后的追加顺序、frontmatter 字段和 self 末尾约定。'],
    steps: [
      { title: '建立 69d3596 规格', detail: '记录 Finalize 身份及 3c4b6f2 两个历史产物，保留四路径统计。', paths: ['docs/specs/69d3596-SPEC.md'] },
      { title: '建立 69d3596 计划', detail: '以 69d3596 的日期和状态生成目标、步骤、风险与验证小节。', paths: ['docs/plans/69d3596-PLAN.md'] },
      { title: '更新到 86 项', detail: '在 c8338e1 行之后加入 69d3596，并只增加 implemented 汇总。', paths: ['docs/INDEX.md'] },
      { title: '注册 69d3596 对象', detail: '把完整 SHA、Finalize subject 和 69d3596 文档路径放在 self 前。', paths: ['docs/status/index.json'] },
    ],
    compatibility: ['既有 c8338e1 等条目不被替换，新增文件命名与链接规范保持一致。'],
    risks: ['69d3596 与 3c4b6f2 都是 Finalize，混淆两代会使 SPEC 范围与 JSON 路径相互矛盾。'],
    verification: ['比较 69d3596 原提交的 name-status 与新 SPEC，并检查 INDEX 86 汇总和 JSON 的路径映射。'],
    completed: ['69d3596 的两个新文档、表格入口及 JSON 登记已闭合。'],
    incomplete: ['验证序列未附执行输出，计划内容也未提供逐文件实现细节。'],
  },
})
