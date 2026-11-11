import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: 'a4edc60de4da2600197f59e1b032d5e4a754e19b',
  slug: 'commit-docs-finalization',
  title: 'Complete previous commit documentation',
  kind: 'metadata-migration',
  status: 'implemented',
  beforeState: '在父版本 1fe1430 中，c771f05 已进入索引，Implemented 为 74；目标祖父提交 dc3f075 尚缺自己的 SPEC、PLAN 与 status 注册，self 条目仍保持在两种索引末尾。',
  problem: '应为 dc3f075 建立完整文档入口，其规格还要描述 dc3f075 为 5c5bc03 补文档的四文件范围。若沿用 1fe1430 的 c771f05/6b0ce9d 关系，会形成错误的相邻代际。',
  goals: [
    '以 dc3f075364391ad09070858cd0763d57e7c073c9 为身份新增 dc3f075-SPEC.md 和 dc3f075-PLAN.md。',
    '在 self 前同步加入 dc3f075 的表格行及 JSON 对象，令 Implemented 从 74 到 75，其他计数不变。',
  ],
  nonGoals: [
    '不调整 1fe1430、c771f05 或 5c5bc03 的既有说明，不增加任何产品运行时改动。',
    '不把新 PLAN 的 bun test、typecheck、build 与 CI 文本当成执行记录。',
  ],
  architecture: [
    'a4edc60 构成纯元数据增补：dc3f075 的两份新文档是内容层，INDEX 与 status 是访问层，四者共同表示一个目标祖父提交。',
    'dc3f075-SPEC 的 Actual scope 再向下指向 5c5bc03-SPEC/PLAN；a4edc60 自身并不修改那些旧文件，只修改本提交的四个路径。',
  ],
  decisions: [
    '规格写入 dc3f075 的 Complete 标题、2026-11-11T11:15:31+08:00 时间和四文件 78 增 1 删统计，内层对象固定为 5c5bc03。',
    '表格与 JSON 采用同序追加，dc3f075 位于 c771f05 后、self 前；最终摘要为 Implemented 75、Partial 1、Unimplemented 0。',
  ],
  alternatives: ['复用 c771f05 的规格结构却保留 6b0ce9d 内层路径，会与 dc3f075 实际 diff 不符；仅增加人工表格也不能满足机器发现，因此四路同时闭合。'],
  security: ['本提交仅修改文档及状态文本，没有新增凭据处理、权限逻辑或网络协议，安全段落不构成控制实现证据。'],
  acceptance: [
    '两个 frontmatter 均含 dc3f075 全 SHA、准确日期、Complete 标题和 implemented 状态。',
    'SPEC 清单指向 5c5bc03，INDEX 75/1/0 与 JSON 新对象一致，self 内容及末位不变且没有额外文件。',
  ],  remaining: ['dc3f075 的设计分析在生成文档中仍很简略；除元数据一致性外，本提交没有留下更多可验证行为证据。'],
  references: [
    { path: 'docs/INDEX.md', role: 'changed', note: 'dc3f075 行新增，implemented 汇总更新为 75。' },
    { path: 'docs/plans/dc3f075-PLAN.md', role: 'changed', note: '为目标祖父提交新建 Complete 计划。' },
    { path: 'docs/specs/dc3f075-SPEC.md', role: 'changed', note: '记录 dc3f075 身份与 5c5bc03 内层文件。' },
    { path: 'docs/status/index.json', role: 'changed', note: 'dc3f075 机器对象添加在 self 前。' },
  ],
  plan: {
    preconditions: ['从 1fe1430 的 74 项汇总出发，核实 dc3f075 完整身份以及它曾为 5c5bc03 创建两份文档的事实。'],
    reuse: ['沿用已有 SPEC/PLAN 和双索引格式，但不继承 c771f05 的 6b0ce9d 内层内容。'],
    steps: [
      { title: '建立 dc3f075 规格', detail: '把 dc3f075 的完整身份与 5c5bc03 历史产物关联，保留准确 diff 统计。', paths: ['docs/specs/dc3f075-SPEC.md'] },
      { title: '建立 dc3f075 计划', detail: '使用 Complete 标题生成同身份计划文件，验证章节仅作为待核对文本。', paths: ['docs/plans/dc3f075-PLAN.md'] },
      { title: '追加第 75 项导航', detail: '将 dc3f075 行置于 c771f05 后，并把 implemented 数字更新为 75。', paths: ['docs/INDEX.md'] },
      { title: '追加 dc3f075 状态', detail: '在 self 前登记完整 SHA、日期、主题与两个新文档的 repository-relative 路径。', paths: ['docs/status/index.json'] },
    ],
    compatibility: ['既有历史条目和 self 引导项目不变，状态计数只增加 implemented，文件命名遵循短 SHA 约定。'],
    risks: ['dc3f075 与 5c5bc03 都是 Complete 标题，短 SHA 替换不足以保证内容正确，必须检查内层对象。'],
    acceptanceSequence: ['在 a4edc60 版本比对 frontmatter、5c5bc03 清单、75/1/0 汇总和 JSON 映射，并确认 diff 只有四路径。'],
    completed: ['dc3f075 的 SPEC/PLAN 和双索引注册已完成写入，self 保持最后。'],
    incomplete: ['没有保存实际测试或 CI 输出，文档完成不代表这些外部检查完成。'],
  },
})
