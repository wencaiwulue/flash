import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: '1fe14300c3b0a9eced6c5c3b3bf4615c7ca43361',
  slug: 'commit-docs-finalization',
  title: 'Finalize previous commit documentation',
  kind: 'metadata-migration',
  status: 'implemented',
  beforeState: '父版本 dc3f075 已完成 5c5bc03 注册，INDEX 为 Implemented 73；目标祖父提交 c771f05 还没有自己的两份 Markdown 和 status 项，已有 self 行继续占据末尾。',
  problem: '本次要把 c771f05 接入文档序列，并在其 SPEC 中还原 c771f05 为 6b0ce9d 创建文档的四路径范围，不能误用 dc3f075 所描述的 787b2dc 范围。',
  goals: [
    '新建 c771f05-SPEC.md 和 c771f05-PLAN.md，frontmatter 采用 c771f05fa4971b361de9a9b1dbfc880972154583。',
    '新增对应 INDEX/status 入口并把 Implemented 提至 74，保持 Partial 1、Unimplemented 0 以及 self 原位置。',
  ],
  nonGoals: [
    '不重写 dc3f075 或 c771f05 的历史内容，也不触及应用程序行为。',
    '不把文档建议的测试、构建与 CI 检查当作本提交已执行事项。',
  ],
  architecture: [
    '本次变更沿文档链再前进一个节点：c771f05 是 frontmatter 主体，6b0ce9d 是其实际范围里的文档对象，1fe1430 则是写入这些说明的当前提交。',
    '两个新文件提供 c771f05 的内容载体，INDEX 将其实现为第 74 个 implemented 链接，status JSON 提供同一映射供工具读取。',
  ],
  decisions: [
    'Actual scope 列出 6b0ce9d-PLAN、6b0ce9d-SPEC、INDEX 和 status，并记录 c771f05 的四文件 78 增 1 删统计。',
    '新增表格行与 JSON 对象紧邻既有 5c5bc03 项之后、self 之前；只增加 implemented 计数，不调整历史状态。',
  ],
  alternatives: ['如果只把上一记录替换为 c771f05 短 SHA，会残留 5c5bc03 的 787b2dc 内层路径；如果只创建 SPEC/PLAN，则第 74 项没有双索引发现能力。'],
  security: ['提交不包含代码执行面、秘密或权限变化，纯文档中的安全承诺不被解释为实际系统保证。'],
  acceptance: [
    '两个 frontmatter 与 c771f05 的 full SHA、2026-11-11T11:15:03+08:00、Finalize 标题及 implemented 一致。',
    'SPEC 指向 6b0ce9d 内层文档，INDEX 为 74/1/0，status 新对象与文件相符，self 未改动且仍最后。',
  ],  remaining: ['c771f05 的新文档仍采用简要模板，对更早设计取舍覆盖有限；现有 diff 不能提供额外运行证据。'],
  references: [
    { path: 'docs/INDEX.md', role: 'changed', note: '新增 c771f05 导航，Implemented 从 73 到 74。' },
    { path: 'docs/plans/c771f05-PLAN.md', role: 'changed', note: '目标祖父提交 c771f05 的新建计划。' },
    { path: 'docs/specs/c771f05-SPEC.md', role: 'changed', note: '新规格记录 c771f05 及其 6b0ce9d 范围。' },
    { path: 'docs/status/index.json', role: 'changed', note: '将 c771f05 状态对象插入 self 前。' },
  ],
  plan: {
    preconditions: ['确认 dc3f075 基线为 73，读取 c771f05 完整 metadata，并核对其自身涉及 6b0ce9d 文档的四路径 diff。'],
    reuse: ['复用现有 frontmatter 字段和双索引结构，正文范围改用 c771f05 的 6b0ce9d 关系。'],
    steps: [
      { title: '编写 c771f05 规格', detail: '用 c771f05 身份开篇，把 6b0ce9d 两份文档列作其历史 Actual scope。', paths: ['docs/specs/c771f05-SPEC.md'] },
      { title: '编写 c771f05 计划', detail: '以 Finalize previous commit documentation 建立匹配计划，区分计划验证与真实结果。', paths: ['docs/plans/c771f05-PLAN.md'] },
      { title: '加入第 74 个链接', detail: '在 5c5bc03 行之后登记 c771f05，保留 self 尾行并同步 implemented 汇总。', paths: ['docs/INDEX.md'] },
      { title: '加入对应 JSON 状态', detail: '将 c771f05 的完整 SHA、日期和 spec/plan 映射写入 self 前的数组位置。', paths: ['docs/status/index.json'] },
    ],
    compatibility: ['既有 73 个 implemented 项及 Partial/Unimplemented 记录保持，self 的 changeId 和链接不受影响。'],
    risks: ['6b0ce9d 与 787b2dc 是相邻记录的不同内层对象，混用会造成表面格式正确但历史内容错误。'],
    acceptanceSequence: ['比对 c771f05 frontmatter 和 metadata，检查 6b0ce9d 路径清单、74/1/0 汇总、JSON 链接及 self 末位。'],
    completed: ['c771f05 的两个新文档与两个索引变更全部落盘，四路径范围完整。'],
    incomplete: ['没有实际命令输出可审计，完成仅表示元数据与索引同步。'],
  },
})
