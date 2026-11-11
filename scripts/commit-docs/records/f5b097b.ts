import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: 'f5b097b742b8e9d68acce71c9b2fa38e19c6088a',
  slug: 'commit-docs-finalization',
  title: 'Complete previous commit documentation',
  kind: 'metadata-migration',
  status: 'implemented',
  beforeState: '父版本 4329cd8 已把 e0cbbe1 纳入索引，Implemented 为 78；被补档的祖父提交 8a248e3 自己仍缺 SPEC、PLAN 和 status 对象，self 继续保持既有 bootstrap 入口。',
  problem: '本提交应补登记 8a248e3，并在新 SPEC 中还原它为 a4edc60 创建文档的四路径范围。目标与当前提交同为 Complete 标题，必须依赖完整 SHA、日期及内层 a4edc60 路径区分。',
  goals: [
    '创建 8a248e3-SPEC.md 与 8a248e3-PLAN.md，提交身份固定为 8a248e3a57a3121e5e0bfeb7dbdeefb1551ac9b3。',
    '在 INDEX/status 的 self 前新增 8a248e3，将 Implemented 从 78 改为 79，其他状态计数保持。',
  ],
  nonGoals: [
    '不修改 4329cd8、e0cbbe1 或 a4edc60 的既有说明，也不改变任何产品行为。',
    '不根据新文档的验证序列声称测试、构建或 CI 已实际运行。',
  ],
  architecture: [
    'f5b097b 是这段链中的最后一层四文件元数据迁移：8a248e3 双文档为新增内容，INDEX 和 status 分别提供第 79 个入口。',
    '8a248e3-SPEC 的 Actual scope 向下记录 a4edc60-SPEC/PLAN，而 f5b097b 自身只创建 8a248e3 文件；当前与目标相同标题并不合并其身份。',
  ],
  decisions: [
    '目标文档采用 8a248e3 的 2026-11-11T11:17:45+08:00 时间和 Complete 标题，内层清单固定为 a4edc60 两个文档及双索引。',
    '表格行与 JSON 对象接在 e0cbbe1 后、self 前，最终汇总为 Implemented 79、Partial 1、Unimplemented 0。',
  ],
  alternatives: ['只替换上一提交的 e0cbbe1 短 SHA 会遗留 1fe1430 内层范围；只增加 status 又无法补齐 SPEC、PLAN 和人工导航，因此继续采用完整四文件注册。'],
  security: ['变更仅涉及说明文件与索引，没有敏感信息、可执行权限或网络协议修改，文档安全声明不代表控制实施。'],
  acceptance: [
    '两个 frontmatter 使用 8a248e3 全 SHA、准确日期、Complete previous commit documentation 和 implemented。',
    'Actual scope 列出 a4edc60 双文档，INDEX 为 79/1/0，status 路径正确，self 内容和末位不变且无额外 diff。',
  ],  remaining: ['8a248e3 的生成文档仍缺少深入设计说明；本记录只确认四路径事实，不增加未经记录的验证结论。'],
  references: [
    { path: 'docs/INDEX.md', role: 'changed', note: '加入 8a248e3 行并把 Implemented 提至 79。' },
    { path: 'docs/plans/8a248e3-PLAN.md', role: 'changed', note: '为祖父提交 8a248e3 新建 Complete 计划。' },
    { path: 'docs/specs/8a248e3-SPEC.md', role: 'changed', note: '记录 8a248e3 身份与 a4edc60 内层范围。' },
    { path: 'docs/status/index.json', role: 'changed', note: '在 self 前添加 8a248e3 状态对象。' },
  ],
  plan: {
    preconditions: ['以 4329cd8 的 78 项汇总为基线，读取 8a248e3 metadata，并核对其历史 diff 中的 a4edc60 双文档。'],
    reuse: ['沿用四文件元数据格式和 self 尾部约定，重新填写 8a248e3 身份与 a4edc60 范围。'],
    steps: [
      { title: '编写 8a248e3 规格', detail: '将目标完整身份与 a4edc60 两份历史文档范围写入新 SPEC。', paths: ['docs/specs/8a248e3-SPEC.md'] },
      { title: '编写 8a248e3 计划', detail: '用目标自身的 Complete 标题和 full SHA 建立 PLAN，保留未执行验证的边界。', paths: ['docs/plans/8a248e3-PLAN.md'] },
      { title: '完成第 79 项人工索引', detail: '在 e0cbbe1 后加入 8a248e3 双链接行，将 implemented 更新为 79。', paths: ['docs/INDEX.md'] },
      { title: '完成对应机器索引', detail: '把 8a248e3 的日期、主题、完整 SHA 和两项路径登记到 self 前。', paths: ['docs/status/index.json'] },
    ],
    compatibility: ['保留此前 78 个 implemented 项、Partial/Unimplemented 计数和 self 的全部字段，新增路径遵循现有约定。'],
    risks: ['相同 Complete 标题和 78 增 1 删统计不能用于识别目标，必须依靠 8a248e3 full SHA 与 a4edc60 范围。'],
    acceptanceSequence: ['在 f5b097b 版本比对 frontmatter、a4edc60 清单、79/1/0 汇总、JSON 新对象和 self 末位，并核对四文件 diff。'],
    completed: ['8a248e3 的 SPEC、PLAN、INDEX 行及 status 对象全部落盘，self 未改变。'],
    incomplete: ['没有真实测试或 CI 执行记录，文档中的检查清单仍待独立验证。'],
  },
})
