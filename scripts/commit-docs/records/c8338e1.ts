import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: 'c8338e1be21cdc792f1c69a5bf3c0094d3c29261',
  slug: 'commit-docs-finalization',
  title: 'Complete previous commit documentation',
  kind: 'metadata-migration',
  status: 'implemented',
  beforeState: 'parent 3c4b6f2 留下的是 82 个 Implemented，最后一项历史条目为 e8d8c06；fdffe9e872a6bdf9ef41623b532f512f1846ab3a 本身仍没有专属文档文件或索引记录。',
  problem: 'fdffe9e 曾把 f5b097b 纳入文档链，现在需要为 fdffe9e 建立下一代入口。其 Complete 标题与 f5b097b 相同，只有完整 SHA、日期和嵌套的 f5b097b 路径能明确区分。',
  goals: [
    '新增 docs/specs/fdffe9e-SPEC.md 及 docs/plans/fdffe9e-PLAN.md，保存 fdffe9e 的提交身份。',
    '把 INDEX 的 Implemented 从 82 更新到 83，并在 status JSON 内同步登记 fdffe9e 的两个产物。',
  ],
  nonGoals: [
    '不改动 fdffe9e 当时新建的 f5b097b 文档，也不为实际 parent 3c4b6f2 提前创建条目。',
    '不把 Acceptance and verification 中的命令名称当作验收执行记录。',
  ],
  architecture: [
    '新 SPEC 的 Actual scope 指向 f5b097b 两个文件，说明 fdffe9e 的过往变更；本提交自己的 changed paths 则是 fdffe9e 两个新文件加两个索引。',
    '新增元数据沿数组和表格尾部扩展，e8d8c06 保持前一历史项，self 仍承担独立的 bootstrap 描述而非历史提交。',
  ],
  decisions: [
    '两个 frontmatter 采用 fdffe9e 的 Complete subject 和 2026-11-11T11:20:02+08:00，并统一标记 implemented。',
    'SPEC 记录 fdffe9e 原提交的 4 文件、78+1 统计；表格仅将 implemented 改为 83，JSON 新增同身份对象而不调整既有对象。',
  ],
  alternatives: ['若仅把 f5b097b 条目改名，会覆盖已有历史并留下失效链接；另建 fdffe9e 条目才能保留连续两层文档关系。'],
  security: ['本提交没有脚本、依赖、凭据或权限变化，文档中的安全句子只是声明性文本。'],
  acceptance: [
    'fdffe9e 完整 SHA 在两个 frontmatter 与 JSON fullSha 中一致，日期和 Complete 标题无错位。',
    'INDEX 计数为 83/1/0，fdffe9e 的链接可对应两个新文件；e8d8c06 与 self 的既有内容不被替换。',
  ],  remaining: ['fdffe9e 的规格背景和实施步骤没有针对其具体索引补丁展开，仍是概括性生成文本。'],
  references: [
    { path: 'docs/INDEX.md', role: 'changed', note: 'Implemented 82→83，追加 fdffe9e 行。' },
    { path: 'docs/plans/fdffe9e-PLAN.md', role: 'changed', note: '新建 fdffe9e 的 Complete 计划。' },
    { path: 'docs/specs/fdffe9e-SPEC.md', role: 'changed', note: '新建含 f5b097b 历史范围的 SPEC。' },
    { path: 'docs/status/index.json', role: 'changed', note: '在 self 前注册 fdffe9e。' },
  ],
  plan: {
    preconditions: ['核实 fdffe9e 的完整 metadata，并确认 f5b097b 是其历史文档对象而非本提交新文件。'],
    reuse: ['保留 e8d8c06 条目和 self 尾部结构，套用相同 SPEC/PLAN 字段。'],
    steps: [
      { title: '记录 fdffe9e 规格', detail: '以 Complete 标题建立 frontmatter，并列入 f5b097b 两个历史产物。', paths: ['docs/specs/fdffe9e-SPEC.md'] },
      { title: '记录 fdffe9e 计划', detail: '生成与 SPEC 同身份的目标、步骤、风险及完成状态说明。', paths: ['docs/plans/fdffe9e-PLAN.md'] },
      { title: '扩展表格到 83', detail: '把 fdffe9e 行放到 e8d8c06 之后，不改 Partial 和 Unimplemented。', paths: ['docs/INDEX.md'] },
      { title: '扩展机器状态', detail: '写入 fdffe9e 的完整 SHA、日期、subject、状态与两个新路径。', paths: ['docs/status/index.json'] },
    ],
    compatibility: ['历史对象无需迁移，新增项遵循现有排序和路径格式。'],
    risks: ['Complete 标题在前一代 f5b097b 已出现，单看标题会混淆；链接代际也必须随 SHA 更新。'],
    acceptanceSequence: ['逐项比较 fdffe9e 原 diff 和 SPEC 范围，并检查 current JSON 的新对象及 parent/current 计数差。'],
    completed: ['fdffe9e 的两个文档产物和两类索引登记已形成一致集合。'],
    incomplete: ['未记录生成文档所列检查的实际执行，具体步骤也仍为模板。'],
  },
})
