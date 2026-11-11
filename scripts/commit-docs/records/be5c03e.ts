import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: 'be5c03e17428c3a7f85f7c0459b49432e61ccbf4',
  title: 'Complete previous commit documentation',
  kind: 'metadata-migration',
  status: 'implemented',
  beforeState: '直接父 1329f792eb0a103eeeabea26a46566bfa9eceaba 已把 3fbabc2 放到 self 前，INDEX 为 Implemented 61、Partial 1、Unimplemented 0，JSON 共 63 项。实际欠账是祖父 1bc02bfb5271653be2dd2c2fcc498246cf111dc5 的文档对。',
  problem: '本提交需要补 1bc02bf，而非直接父 1329f79；其 SPEC 还应回看 1bc02bf 为 d472e5c 新建文档的事实，不能把 1329f79 的 3fbabc2 范围复制过来。',
  goals: [
    '创建 1bc02bf SPEC/PLAN，保存 Complete previous commit documentation、2026-11-11T11:08:23+08:00 与 implemented。',
    '将 d472e5c 文档对及两个索引的 78 行新增、1 行删除范围写入 SPEC，并完成 1bc02bf 双索引注册。',
  ],
  nonGoals: [
    '不登记 1329f79 或 be5c03e 自身，不调整已有 3fbabc2 内容。',
    '不改变生成器或产品行为，不把计划中的验证和 CI 文本当作执行日志。',
  ],
  architecture: [
    '四个变更路径形成一个历史元数据单元：1bc02bf 说明层由 SPEC/PLAN 组成，INDEX 与 JSON 提供两种检索入口。',
    '新增项位于 3fbabc2 后、self 前；self 仍使用 commit-docs-bootstrap 和原有文档路径，不代表当前 be5c03e。',
  ],
  decisions: [
    '1bc02bf 的 Actual scope 固定为 d472e5c-SPEC/PLAN 加两个索引，统计 78/1，而非本提交新建的 1bc02bf 文件本身。',
    'INDEX Implemented 61→62，Partial/Unimplemented 保持 1/0；JSON 63→64，含 self 的 implemented 62→63。',
    '1bc02bf 占 JSON 第 63 项，self 顺移到第 64 项；本 diff 不含生成器差异。',
  ],
  alternatives: ['选择 1329f79 会重复其既有范围并把文档链条提前一层；只补 Markdown 不更新计数则无法完成 1bc02bf 的可发现注册。'],
  security: ['仅历史说明与索引发生变化，没有可执行逻辑、敏感信息、协议或访问控制调整。'],
  acceptance: [
    '1bc02bf 两份 frontmatter 的 SHA、标题、时间与原提交一致，Actual scope 指向 d472e5c。',
    '新 INDEX 行和 JSON 对象路径相同，3fbabc2 保持前一项，self 保持在数组末尾。',
  ],
  evidence: [
    { kind: 'diff-observed', statement: '新 SPEC 将 1bc02bf 的范围指向 d472e5c 文档对，并记录四文件 78/1 统计。', source: { path: 'docs/specs/1bc02bf-SPEC.md', role: 'evidence', revision: 'commit', symbol: 'docs/plans/d472e5c-PLAN.md', note: '该路径证明范围属于 1bc02bf 的原始 diff。' } },
    { kind: 'diff-observed', statement: '新 PLAN 使用 1bc02bf 完整 SHA，并包含验证序列与完成状态小节。', source: { path: 'docs/plans/1bc02bf-PLAN.md', role: 'evidence', revision: 'commit', symbol: 'commit: 1bc02bfb5271653be2dd2c2fcc498246cf111dc5', note: '计划身份与 SPEC 一致。' } },
    { kind: 'diff-observed', statement: 'INDEX 新增 1bc02bf 行，Implemented 汇总达到 62。', source: { path: 'docs/INDEX.md', role: 'evidence', revision: 'commit', symbol: '- Implemented: 62', note: '仅 implemented 计数增加。' } },
    { kind: 'diff-observed', statement: 'status JSON 在 self 前登记 1bc02bf 及其 SPEC/PLAN 路径。', source: { path: 'docs/status/index.json', role: 'evidence', revision: 'commit', symbol: '"fullSha": "1bc02bfb5271653be2dd2c2fcc498246cf111dc5"', note: '完整历史身份与机器路径可核对。' } },
    { kind: 'not-recorded', statement: '没有随提交保存生成、测试、构建或 CI 输出，验证章节仅说明模板建议。' },
  ],
  remaining: ['直接父 1329f79 和当前 be5c03e 尚未在此快照建档，1bc02bf 之外的链条不在本提交完成。'],
  references: [
    { path: 'docs/INDEX.md', role: 'changed', note: '新增 1bc02bf，Implemented 61→62。' },
    { path: 'docs/plans/1bc02bf-PLAN.md', role: 'changed', note: '新建 1bc02bf 计划。' },
    { path: 'docs/specs/1bc02bf-SPEC.md', role: 'changed', note: '保存 1bc02bf 身份及 d472e5c 范围。' },
    { path: 'docs/status/index.json', role: 'changed', note: '总数 63→64，self 前新增 1bc02bf。' },
  ],
  plan: {
    preconditions: ['确认 1329f79 是直接父而非目标，并核对 1bc02bf 创建的 d472e5c 文件。'],
    reuse: ['沿用 3fbabc2 后的追加位置、历史对象七字段及 self 占位，复用已有 Markdown 模板。'],
    steps: [
      { title: '记录 1bc02bf 范围', detail: '在 SPEC 中写入 d472e5c 两个文档和两个索引及 78/1 统计。', paths: ['docs/specs/1bc02bf-SPEC.md'] },
      { title: '生成 1bc02bf 计划', detail: '用相同 frontmatter 添加实施步骤、风险、验证序列和状态。', paths: ['docs/plans/1bc02bf-PLAN.md'] },
      { title: '追加 INDEX 入口', detail: '在 3fbabc2 后添加 1bc02bf 行，只递增 Implemented 到 62。', paths: ['docs/INDEX.md'] },
      { title: '追加 JSON 入口', detail: '把 1bc02bf 作为第 63 个对象写入，保留 self 为第 64 项。', paths: ['docs/status/index.json'] },
    ],
    compatibility: ['3fbabc2 与更早历史项不改，self 内容不变；生成器和现有文档格式均保持父版本。'],
    risks: ['d472e5c 与 3fbabc2 分别是相邻两层范围，复制上一提交 SPEC 而不换路径会造成表面完整但历史错误。'],
    verification: ['比较 1bc02bf 原 diff 与新 SPEC，解析 PLAN 元数据，并核对 INDEX/JSON 的单项增量和 self 位置。'],
    completed: ['1bc02bf 的两个文档和两个索引入口已一致落盘。'],
    incomplete: ['未记录任何实际验证命令或 CI 结果，implemented 不代表这些检查已经运行。'],
  },
})
