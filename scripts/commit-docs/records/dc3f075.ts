import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: 'dc3f075364391ad09070858cd0763d57e7c073c9',
  title: 'Complete previous commit documentation',
  kind: 'metadata-migration',
  status: 'implemented',
  beforeState: '父版本 c771f05 的 INDEX 已有 72 个 implemented 条目，6b0ce9d 已完成注册；目标祖父提交 5c5bc03 自身的 SPEC/PLAN 与 status 对象仍缺席，self 还是数组和表格末尾。',
  problem: '需要给 5c5bc03 补齐四路元数据，且新 SPEC 应描述它当年为 787b2dc 建文档的范围。不能直接复制 c771f05 的 6b0ce9d 内容，也不能把 b6bf982 范围带入本次。',
  goals: [
    '创建 5c5bc03-SPEC.md 与 5c5bc03-PLAN.md，身份固定为 5c5bc03abc666d111ae5e4227224884bbaafd340。',
    '把 5c5bc03 插入 INDEX/status 的 self 前，将 Implemented 从 72 更新为 73，其余状态计数不变。',
  ],
  nonGoals: [
    '不修订 c771f05 或更早提交的文档，不引入产品代码、依赖或配置变化。',
    '不将新文档所列 bun 命令及 CI 项记录为已经取得的验证结果。',
  ],
  architecture: [
    '此提交为文档链补上祖父节点 5c5bc03：新 SPEC 保存该节点身份与历史范围，新 PLAN 保存计划，两个索引共享同一身份。',
    '5c5bc03 的历史范围包含 787b2dc-SPEC/PLAN；dc3f075 自身则创建 5c5bc03-SPEC/PLAN，二者相隔一层，不应合并路径清单。',
  ],
  decisions: [
    'SPEC 采用 Complete previous commit documentation 标题、5c5bc03 时间戳及 4 文件 78 增 1 删统计，并列出 787b2dc 两个产物。',
    'INDEX 与 JSON 都只追加一个 implemented 项；73/1/0 是最终计数，已有 6b0ce9d 条目和 self 均不改写。',
  ],
  alternatives: ['沿用上一提交的 b6bf982 内层清单会造成错误历史叙述；仅增加 status 对象则缺少可点击 INDEX 入口和 Markdown 内容，因此不接受部分注册。'],
  security: ['四条路径均为说明性文本或 JSON 元数据，不包含秘密、权限执行或外部协议，本提交没有安全边界变化。'],
  acceptance: [
    'frontmatter 使用 5c5bc03 完整 SHA、2026-11-11T11:14:17+08:00 和 implemented，两个文件标题一致。',
    '内层范围准确列出 787b2dc，INDEX 汇总为 73/1/0，JSON 路径与新增文件一致且 self 不变。',
  ],
  evidence: [
    {
      kind: 'diff-observed',
      statement: 'SPEC frontmatter 标识 5c5bc03，Actual scope 的文件名为 787b2dc-SPEC 和 787b2dc-PLAN。',
      source: { path: 'docs/specs/5c5bc03-SPEC.md', role: 'evidence', revision: 'dc3f075364391ad09070858cd0763d57e7c073c9', symbol: 'docs/specs/787b2dc-SPEC.md', note: '该符号证明内层对象不是 6b0ce9d。' },
    },
    {
      kind: 'diff-observed',
      statement: '新 PLAN 以 Complete previous commit documentation 为题，frontmatter 与 SPEC 的提交身份一致。',
      source: { path: 'docs/plans/5c5bc03-PLAN.md', role: 'evidence', revision: 'dc3f075364391ad09070858cd0763d57e7c073c9', symbol: 'commit: 5c5bc03abc666d111ae5e4227224884bbaafd340', note: 'PLAN 在 dc3f075 中首次出现。' },
    },
    {
      kind: 'diff-observed',
      statement: 'INDEX patch 把 72 改为 73，并追加带两个相对链接的 5c5bc03 行。',
      source: { path: 'docs/INDEX.md', role: 'evidence', revision: 'dc3f075364391ad09070858cd0763d57e7c073c9', symbol: '- Implemented: 73', note: 'at-commit 汇总证据，不代表运行验证。' },
    },
    {
      kind: 'diff-observed',
      statement: 'status patch 在 self 前新增 5c5bc03 对象，完整 SHA 和文档路径与 SPEC/PLAN 相符。',
      source: { path: 'docs/status/index.json', role: 'evidence', revision: 'dc3f075364391ad09070858cd0763d57e7c073c9', symbol: '"fullSha": "5c5bc03abc666d111ae5e4227224884bbaafd340"', note: '机器状态条目覆盖同一目标。' },
    },
    { kind: 'not-recorded', statement: '没有测试输出、构建日志或 CI 状态随该提交保存，文档中的验证序列只是计划文字。' },
  ],
  remaining: ['5c5bc03 文档对设计动机的说明有限；本记录依据 diff 还原范围，不推断未写出的实现过程或验证结果。'],
  references: [
    { path: 'docs/INDEX.md', role: 'changed', note: '5c5bc03 新行与 Implemented 73 同步落盘。' },
    { path: 'docs/plans/5c5bc03-PLAN.md', role: 'changed', note: '新建 Complete 类型的目标祖父提交计划。' },
    { path: 'docs/specs/5c5bc03-SPEC.md', role: 'changed', note: '新建规格，内层清单指向 787b2dc。' },
    { path: 'docs/status/index.json', role: 'changed', note: '注册 5c5bc03 状态并保持 self 为最后对象。' },
  ],
  plan: {
    preconditions: ['读取 c771f05 基线的 72 项汇总，核对 5c5bc03 metadata 及其 Actual scope 应有的 787b2dc 文件。'],
    reuse: ['沿用现有四文件元数据布局和 self 尾部约定，使用 5c5bc03 自己的标题与内层范围。'],
    steps: [
      { title: '形成 5c5bc03 规格', detail: '将目标祖父提交身份和 787b2dc 两份历史产物写入新规格，避免串用 6b0ce9d 范围。', paths: ['docs/specs/5c5bc03-SPEC.md'] },
      { title: '形成 5c5bc03 计划', detail: '以 Complete 标题和同一份 frontmatter 新建 PLAN，明确文档验证不等于执行。', paths: ['docs/plans/5c5bc03-PLAN.md'] },
      { title: '更新第 73 个人工入口', detail: '把新行排在 6b0ce9d 之后，保留 self 尾行，并将 implemented 数字改为 73。', paths: ['docs/INDEX.md'] },
      { title: '更新对应机器入口', detail: '在状态数组中补入 5c5bc03 的完整身份、日期和短 SHA 文档路径。', paths: ['docs/status/index.json'] },
    ],
    compatibility: ['旧索引行与 JSON 对象保持顺序，Partial/Unimplemented 数量及 self 的引导项目元数据不受影响。'],
    risks: ['相同的 Complete/Finalize 循环标题和相同 diff 统计容易让 5c5bc03 与相邻身份错位，需用完整 SHA 防错。'],
    verification: ['检查 dc3f075 中 frontmatter、787b2dc 文件清单、73/1/0 汇总和 JSON 新增对象，再对照四路径 diff。'],
    completed: ['5c5bc03 的双文档和双索引注册已完整加入，未修改其他文件。'],
    incomplete: ['提交没有记录实际命令结果，因此运行时质量和 CI 状态仍未被证实。'],
  },
})
