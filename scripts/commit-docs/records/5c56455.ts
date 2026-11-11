import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: '5c5645575a79226d0a103b896681c9941d687d82',
  slug: 'commit-docs-finalization',
  title: 'Finalize previous commit documentation',
  kind: 'metadata-migration',
  status: 'implemented',
  beforeState: '父版本尚无 0e2559a 的 SPEC、PLAN 或 status 条目，INDEX 的 Implemented 为 87。0e2559a 自身是在为更早的 69d3596 补齐文档，不能把两层对象混淆。',
  problem: '需要为目标祖父提交补齐可发现的文档身份，并同步人类索引和机器索引；仅创建两个 Markdown 文件会留下断链与计数不一致。',
  goals: [
    '新建 0e2559a 的 SPEC/PLAN，frontmatter 使用目标祖父提交 0e2559a 的身份，并概述该提交实际的文档变更。',
    '让 INDEX 与 status/index.json 都能定位这两个产物，且状态统计同步。',
  ],
  nonGoals: [
    '不修改产品源码，也不重写 69d3596 或 0e2559a 的历史内容。',
    '不把新文档列出的 test、typecheck、build 或 CI 命令当成已经执行的证据。',
  ],
  architecture: [
    '产品架构不适用：四个变更路径全是文档元数据，没有运行时代码、协议或状态机。',
    'SPEC/PLAN 保存祖父提交说明，INDEX 提供表格入口，status JSON 提供 fullSha、日期、状态和文件路径的机器可读映射。',
  ],
  decisions: [
    'SPEC 记录 0e2559a 的四文件、78 行新增和 1 行删除范围，其中包括 69d3596 的两个文档产物。',
    '两个索引的新增项放在 self 前；INDEX 只把 Implemented 从 87 调到 88，Partial 1 与 Unimplemented 0 不动。',
  ],
  alternatives: ['事后看，只写 Markdown 会使两个索引遗漏祖父提交；只改 INDEX 又缺少机器可读注册，因此四类路径需要作为一次元数据闭合处理。'],
  security: ['diff 不含凭据、可执行逻辑或权限变更；生成文档中的安全表述不代表 enforcement 发生变化。'],
  acceptance: [
    '两个 frontmatter 的 SHA、标题、时间和 implemented 状态与目标祖父提交一致。',
    'INDEX 链接、JSON 的 spec/plan 字段与实际新文件相符，摘要、表格和 JSON 状态一致。',
  ],  remaining: ['生成文档对祖父提交的说明仍较概括；若要更深入的设计分析，需要另行补充内容而非扩大本提交事实范围。'],
  references: [
    { path: 'docs/INDEX.md', role: 'changed', note: '更新 implemented 汇总并增加祖父提交文档入口。' },
    { path: 'docs/plans/0e2559a-PLAN.md', role: 'changed', note: '新建的祖父提交实施计划。' },
    { path: 'docs/specs/0e2559a-SPEC.md', role: 'changed', note: '新建的祖父提交身份与实际范围说明。' },
    { path: 'docs/status/index.json', role: 'changed', note: '新增祖父提交的机器可读状态和文档路径。' },
  ],
  plan: {
    preconditions: ['核对目标祖父提交 metadata 与 diff，并确认其文档对象和 69d3596 的层级关系。'],
    reuse: ['沿用现有 SPEC/PLAN frontmatter、INDEX 表格列和 status 对象字段，self 继续保持在末尾。'],
    steps: [
      { title: '编写祖父提交 SPEC', detail: '填入目标祖父提交身份，列出其四个实际路径与 diff 统计。', paths: ['docs/specs/0e2559a-SPEC.md'] },
      { title: '编写祖父提交 PLAN', detail: '使用相同 frontmatter，补齐目标、步骤、风险、验证和完成状态。', paths: ['docs/plans/0e2559a-PLAN.md'] },
      { title: '同步人类索引', detail: '调整 implemented 汇总，在 self 前加入链接到新文件的祖父提交行。', paths: ['docs/INDEX.md'] },
      { title: '同步机器索引', detail: '在 commits 数组的 self 前登记同一身份、状态和两个文档路径。', paths: ['docs/status/index.json'] },
    ],
    compatibility: ['既有条目顺序不变；Markdown 链接沿用 ../docs 形式，JSON 继续使用 repository-relative 路径。'],
    risks: ['相同主题容易造成不同代际对象错位；只增行不改汇总会使统计失配，验证散文也可能被误读为执行记录。'],
    acceptanceSequence: ['比对 frontmatter 与目标祖父提交 0e2559a 的 metadata，核对 SPEC 路径列表和目标祖父提交 0e2559a 的 diff，并解析 JSON 检查新增对象及链接。'],
    completed: ['四个文档元数据路径均按目标祖父提交闭合，两个索引均可发现新产物。'],
    incomplete: ['文档所列命令没有随附执行日志，本记录仅验收元数据落盘与关联一致性。'],
  },
})
