import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: '612cc40e519f48121614051611d16b054823c24c',
  title: 'Finalize previous commit documentation',
  kind: 'metadata-migration',
  status: 'implemented',
  beforeState: '父提交 0dabf466a5db43caa9890f5e0a031d00505a0008 刚补 be5c03e，INDEX Implemented 为 64，JSON 为 66 项。实际目标是祖父 2a4aa6c36263b3b17c6c5f188b03cc9a6a7e3cff，其 SPEC/PLAN 和索引项在父树尚缺。',
  problem: '本提交应为 2a4aa6c 建档，并保留它记录 1329f79 文档对的实际范围；若按直接父 0dabf46 生成，会错误换成 be5c03e 范围。',
  goals: [
    '新建 2a4aa6c SPEC/PLAN，使用 Finalize documentation for previous commit、2026-11-11T11:09:50+08:00 和 implemented。',
    '记录 1329f79 文档对、两个索引与 78 行新增、1 行删除，并在两个索引中注册 2a4aa6c。',
  ],
  nonGoals: [
    '不登记直接父 0dabf46 或当前 612cc40，不修改已有 be5c03e 条目。',
    '不修改生成器，不将 PLAN 的测试、构建和 CI 清单当成已执行检查。',
  ],
  architecture: [
    '2a4aa6c 的两个新文件提供历史说明，INDEX 与 status JSON 提供链接和结构化状态；没有运行时代码路径。',
    '新增历史项位于 be5c03e 与 self 之间，self 的身份、状态和文档路径不因当前提交而改写。',
  ],
  decisions: [
    'Actual scope 使用 1329f79-SPEC/PLAN，四文件统计 78/1，区别于 be5c03e 的 1bc02bf 范围。',
    '2a4aa6c 注册使不含 self 的 Implemented 从 64 升至 65；commits 长度由 66 变为 67，Partial 1 与 Unimplemented 0 保持，self 仍贡献一个 implemented。',
    '2a4aa6c 成为 JSON 第 66 项，self 成为第 67 项；生成器源文件未出现在本 diff。',
  ],
  alternatives: ['提前选择 0dabf46 会遗漏 2a4aa6c 并造成两层范围错位；只新增 Markdown 则不能让 Implemented 65 和 JSON 67 项获得真实入口。'],
  security: ['变更范围仅为文档和索引，没有敏感数据、权限模型、依赖或协议处理变化。'],
  acceptance: [
    '2a4aa6c 两份 frontmatter 身份一致，Actual scope 明确包含 1329f79 两个文档路径。',
    '人类和机器索引各增加一个 implemented 对象，be5c03e 保持前一项，self 保持最后。',
  ],
  evidence: [
    { kind: 'diff-observed', statement: '2a4aa6c SPEC 使用完整目标 SHA，并列出 1329f79 文档组和 78/1 统计。', source: { path: 'docs/specs/2a4aa6c-SPEC.md', role: 'evidence', revision: 'commit', symbol: 'docs/plans/1329f79-PLAN.md', note: 'Actual scope 的目标路径锚点。' } },
    { kind: 'diff-observed', statement: '2a4aa6c PLAN 保留实现步骤、验证序列与完成状态。', source: { path: 'docs/plans/2a4aa6c-PLAN.md', role: 'evidence', revision: 'commit', symbol: '# Implementation plan: Finalize documentation for previous commit', note: '标题与目标提交 subject 一致。' } },
    { kind: 'diff-observed', statement: 'INDEX 汇总变为 Implemented 65，并加入 2a4aa6c 行。', source: { path: 'docs/INDEX.md', role: 'evidence', revision: 'commit', symbol: '- Implemented: 65', note: 'Partial 和 Unimplemented 未同步增加。' } },
    { kind: 'diff-observed', statement: 'JSON 在 self 前插入 2a4aa6c，指向本次新增的两个文件。', source: { path: 'docs/status/index.json', role: 'evidence', revision: 'commit', symbol: '"fullSha": "2a4aa6c36263b3b17c6c5f188b03cc9a6a7e3cff"', note: '机器身份与 INDEX 短 SHA 对应。' } },
    { kind: 'not-recorded', statement: '本提交没有附带测试、typecheck、build、生成或 CI 输出，验证小节只是计划文本。' },
  ],
  remaining: ['0dabf46 和当前 612cc40 的文档不在本次范围；2a4aa6c 的生成计划仍无实际执行记录。'],
  references: [
    { path: 'docs/INDEX.md', role: 'changed', note: 'Implemented 64→65，新增 2a4aa6c。' },
    { path: 'docs/plans/2a4aa6c-PLAN.md', role: 'changed', note: '新建 2a4aa6c 计划。' },
    { path: 'docs/specs/2a4aa6c-SPEC.md', role: 'changed', note: '记录 2a4aa6c 及 1329f79 范围。' },
    { path: 'docs/status/index.json', role: 'changed', note: '总数 66→67，self 前加入 2a4aa6c。' },
  ],
  plan: {
    preconditions: ['核对 2a4aa6c 是祖父目标，并确认其原始 diff 包含 1329f79 文档对。'],
    reuse: ['沿用 be5c03e 后的追加顺序、self 占位和已有七字段对象与 Markdown 模板。'],
    steps: [
      { title: '记录 2a4aa6c 设计', detail: '在 SPEC 中写入目标身份、1329f79 文档组及 78/1 统计。', paths: ['docs/specs/2a4aa6c-SPEC.md'] },
      { title: '记录 2a4aa6c 计划', detail: '用同一 frontmatter 建立步骤、风险、验证序列与状态小节。', paths: ['docs/plans/2a4aa6c-PLAN.md'] },
      { title: '添加 INDEX 项', detail: '在 be5c03e 后添加 2a4aa6c 链接，只把 Implemented 改为 65。', paths: ['docs/INDEX.md'] },
      { title: '添加 JSON 项', detail: '把 2a4aa6c 插入第 66 位，保留 self 为第 67 项。', paths: ['docs/status/index.json'] },
    ],
    compatibility: ['be5c03e 及更早条目保持原序，self 字段和生成器行为不变，索引 schema 无新增。'],
    risks: ['0dabf46 与 2a4aa6c 都是相邻元数据提交，误用直接父会把 1329f79 和 be5c03e 两组范围对调。'],
    verification: ['对照 2a4aa6c 原始元数据与 diff，检查两个新文件及父/当前索引的单项变化。'],
    completed: ['2a4aa6c 的 SPEC、PLAN、INDEX 行和 JSON 对象已全部落盘。'],
    incomplete: ['没有可审查的命令或 CI 运行结果，implemented 只表示文档产物完成。'],
  },
})
