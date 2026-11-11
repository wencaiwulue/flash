import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: 'fe2ced6af51deecae060e1729f1b5ebe5f871f27',
  slug: 'commit-docs-finalization',
  title: 'Complete previous commit documentation',
  kind: 'metadata-migration',
  status: 'implemented',
  beforeState: 'parent 0e2559a 的 INDEX 已包含 69d3596，计数为 Implemented 86、Partial 1、Unimplemented 0；846c13000bb120adf83febaf0732e704446a0e02 尚无自己的两个文档或索引身份。',
  problem: '846c130 为 c8338e1 做过补档，现在需要把文档对象提升到 846c130 本身。本提交标题与 846c130 都是 Complete，但真正的识别依据是其完整 SHA、时间和 SPEC 内的 c8338e1 范围。',
  goals: [
    '新增 docs/specs/846c130-SPEC.md 和 docs/plans/846c130-PLAN.md，保存 846c130 的提交 metadata 与历史范围。',
    '将 INDEX Implemented 更新为 87，并让 status JSON 在 self 前提供同一提交及 SPEC/PLAN 路径。',
  ],
  nonGoals: [
    '不改动 c8338e1 的既有文档，也不替 parent 0e2559a 创建后续提交才负责的产物。',
    '不把生成文档中的验证建议或 implemented 字段解释为测试执行结果。',
  ],
  architecture: [
    '本提交是四文件元数据追加：846c130 SPEC 承载其对 c8338e1 文档工作的追溯，PLAN 复用同一身份，两个索引分别服务于表格浏览和机器读取。',
    '69d3596 保持前一历史项，846c130 被插入它和 self 之间；self 的 commit-docs-bootstrap 描述与文件路径均未改动。',
  ],
  decisions: [
    'frontmatter 采用 846c130 的 2026-11-11T11:22:18+08:00、Complete subject 和 implemented，SPEC 记录原提交 4 文件、78+1 及 c8338e1 两个路径。',
    'INDEX 仅将 implemented 从 86 调整为 87；JSON 新增 fullSha、shortSha、date、subject、status、spec、plan 七字段，旧对象保持原序。',
  ],
  alternatives: ['复用 c8338e1 的条目无法表达 846c130 的独立身份；只加表格而不加 JSON 会破坏双索引一致性，因此完整追加四个路径。'],
  security: ['diff 不含代码执行、权限调整、秘密或外部协议，新增内容仅是静态文档元数据。'],
  acceptance: [
    '两个 frontmatter 与 JSON fullSha 都等于 846c13000bb120adf83febaf0732e704446a0e02，日期和 Complete 标题匹配。',
    'INDEX 为 87/1/0，846c130 行位于 69d3596 和 self 之间；JSON spec/plan 与两个实际新文件一致。',
  ],  remaining: ['846c130 的计划仍采用通用步骤，未逐条说明其原提交 SPEC、PLAN 和索引补丁的实现过程。'],
  references: [
    { path: 'docs/INDEX.md', role: 'changed', note: 'Implemented 86→87，追加 846c130 行。' },
    { path: 'docs/plans/846c130-PLAN.md', role: 'changed', note: '新建 846c130 的 Complete 计划。' },
    { path: 'docs/specs/846c130-SPEC.md', role: 'changed', note: '新建追溯 c8338e1 范围的 846c130 SPEC。' },
    { path: 'docs/status/index.json', role: 'changed', note: '在 self 前注册 846c130 及两个路径。' },
  ],
  plan: {
    preconditions: ['确认实际 parent 0e2559a、被补档 846c130 及其历史对象 c8338e1，避免标题相同造成错认。'],
    reuse: ['沿用 69d3596 后的尾部追加位置和已有 frontmatter、表格列及 JSON 字段。'],
    steps: [
      { title: '编写 846c130 SPEC', detail: '固定 Complete 身份，列入 c8338e1 两个历史文档及四路径统计。', paths: ['docs/specs/846c130-SPEC.md'] },
      { title: '编写 846c130 PLAN', detail: '使用 846c130 的时间生成计划、风险、验证序列与剩余项。', paths: ['docs/plans/846c130-PLAN.md'] },
      { title: '把汇总推进到 87', detail: '在 69d3596 行后添加 846c130 链接，保留 self 为最后一行。', paths: ['docs/INDEX.md'] },
      { title: '添加 846c130 状态', detail: '将完整 SHA、Complete subject 和新 SPEC/PLAN 路径写入 self 前对象。', paths: ['docs/status/index.json'] },
    ],
    compatibility: ['已有历史项、self changeId 和路径格式均保持，新增内容可沿用现有读取方式。'],
    risks: ['当前提交与被补档提交都使用 Complete 标题；日期、嵌套路径或 fullSha 任一项复制错误都会造成错代。'],
    acceptanceSequence: ['核对 846c130 原始 metadata、diff 路径与 SPEC，再检查 current INDEX 的 87 计数及 JSON 字段。'],
    completed: ['846c130 的两个新产物及两个索引入口已在本提交同步建立。'],
    incomplete: ['没有验证执行日志，通用计划也未补充更细的设计说明。'],
  },
})
