import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: 'b6bf9822536793efc08cd9ce4d94f1c066530d1c',
  title: 'Finalize documentation for previous commit',
  kind: 'metadata-migration',
  status: 'implemented',
  beforeState: '直接父 96283aecc10afd0f0269eff9b7a3b0c543191b01 已补 612cc40，INDEX 为 Implemented 67、Partial 1、Unimplemented 0，JSON 含 self 共 69 项。实际目标是祖父 6c3c1e4d3cdd8b1b8279c023575fb7a37e94a14c，父树没有它的 SPEC/PLAN。',
  problem: '本提交应为 6c3c1e4 补齐文档和索引，并保存其为 0dabf46 建档的四路径范围；不能直接沿用 96283ae 的 612cc40 范围。',
  goals: [
    '新建 6c3c1e4 SPEC/PLAN，保留 Finalize documentation for previous commit、2026-11-11T11:11:31+08:00 和 implemented。',
    '记录 0dabf46 文档对、两个索引及 78 行新增、1 行删除，并增加 6c3c1e4 的双索引入口。',
  ],
  nonGoals: [
    '不为直接父 96283ae 或当前 b6bf982 建档，不重写已有 612cc40 条目。',
    '不修改生成器，不将模板中的 test、typecheck、build 或 CI 名称当成运行记录。',
  ],
  architecture: [
    '6c3c1e4 的 SPEC/PLAN 构成历史说明层，INDEX 行和 commits 对象构成发现层；本提交没有代码或生成器差异。',
    '新项位于 612cc40 后、self 前，self 的 fullSha、changeId、状态和链接均保持原值。',
  ],
  decisions: [
    'SPEC 将 Actual scope 绑定到 0dabf46-SPEC/PLAN 和两个索引，统计为四文件 78/1。',
    'INDEX Implemented 67→68，Partial/Unimplemented 仍为 1/0；JSON 总数 69→70，含 self 的 implemented 68→69。',
    '6c3c1e4 成为 JSON 第 69 项，self 为第 70 项；当前 b6bf982 自身没有文档或 SHA 状态对象。',
  ],
  alternatives: ['若选择直接父 96283ae，会把下一提交的对象提前并误用 612cc40 范围；若只加 6c3c1e4 文件，索引仍无法发现它们。'],
  security: ['变更仅限文档与提交元数据，不包含凭据、权限、协议、依赖或可执行行为调整。'],
  acceptance: [
    '6c3c1e4 的 frontmatter 完整匹配目标提交，Actual scope 的 0dabf46 路径与统计正确。',
    'INDEX 和 JSON 各新增一个 implemented 项，612cc40 保持前一项，self 仍为最后对象。',
  ],
  evidence: [
    { kind: 'diff-observed', statement: '6c3c1e4 SPEC 记录完整目标身份，Actual scope 列出 0dabf46 文档对。', source: { path: 'docs/specs/6c3c1e4-SPEC.md', role: 'evidence', revision: 'commit', symbol: 'docs/plans/0dabf46-PLAN.md', note: '范围路径对应 6c3c1e4 的原始 diff。' } },
    { kind: 'diff-observed', statement: '6c3c1e4 PLAN 使用目标完整 SHA，并提供完成状态小节。', source: { path: 'docs/plans/6c3c1e4-PLAN.md', role: 'evidence', revision: 'commit', symbol: 'commit: 6c3c1e4d3cdd8b1b8279c023575fb7a37e94a14c', note: 'frontmatter 与 SPEC 使用同一身份。' } },
    { kind: 'diff-observed', statement: 'INDEX 的 Implemented 达到 68，新增 6c3c1e4 标题与文档链接。', source: { path: 'docs/INDEX.md', role: 'evidence', revision: 'commit', symbol: '| 6c3c1e4 | Finalize documentation for previous commit | implemented |', note: '新增行位于 612cc40 后。' } },
    { kind: 'diff-observed', statement: '机器索引在 self 前登记 6c3c1e4，spec/plan 字段指向新文件。', source: { path: 'docs/status/index.json', role: 'evidence', revision: 'commit', symbol: '"fullSha": "6c3c1e4d3cdd8b1b8279c023575fb7a37e94a14c"', note: '完整身份与 INDEX 短 SHA 对应。' } },
    { kind: 'not-recorded', statement: '没有随 diff 保存生成器、测试、构建或 CI 输出，PLAN 验证序列不是执行结果。' },
  ],
  remaining: ['直接父 96283ae 和当前 b6bf982 尚未在此快照建档，本提交仅闭合 6c3c1e4。'],
  references: [
    { path: 'docs/INDEX.md', role: 'changed', note: 'Implemented 67→68，新增 6c3c1e4。' },
    { path: 'docs/plans/6c3c1e4-PLAN.md', role: 'changed', note: '新建 6c3c1e4 计划。' },
    { path: 'docs/specs/6c3c1e4-SPEC.md', role: 'changed', note: '记录 6c3c1e4 及 0dabf46 范围。' },
    { path: 'docs/status/index.json', role: 'changed', note: 'JSON 69→70，self 前加入 6c3c1e4。' },
  ],
  plan: {
    preconditions: ['识别祖父 6c3c1e4 为目标，并核对其原始 0dabf46 文档对与 78/1 统计。'],
    reuse: ['复用 612cc40 后的索引顺序、self 占位、七字段 JSON 对象和生成文档模板。'],
    steps: [
      { title: '建立 6c3c1e4 SPEC', detail: '记录完整身份、0dabf46 文档路径和四文件 78/1 统计。', paths: ['docs/specs/6c3c1e4-SPEC.md'] },
      { title: '建立 6c3c1e4 PLAN', detail: '使用同一 frontmatter 保存实施、风险、验证和完成状态小节。', paths: ['docs/plans/6c3c1e4-PLAN.md'] },
      { title: '登记 INDEX', detail: '在 612cc40 后新增 6c3c1e4 行，只把 Implemented 增至 68。', paths: ['docs/INDEX.md'] },
      { title: '登记 JSON', detail: '把 6c3c1e4 插入第 69 位，使 self 保持在第 70 项。', paths: ['docs/status/index.json'] },
    ],
    compatibility: ['612cc40 与更早条目不改，self 字段不变；生成器源码和索引 schema 保持父版本。'],
    risks: ['6c3c1e4 与当前提交标题相同，必须按完整 SHA 和 0dabf46 范围区分，不能依赖标题识别。'],
    verification: ['核对 6c3c1e4 原始提交元数据和 diff，再检查两个新 frontmatter 与双索引单项变化。'],
    completed: ['6c3c1e4 的 SPEC/PLAN 与两个索引入口已在同一提交落盘。'],
    incomplete: ['没有实际命令或 CI 运行证据，implemented 仅表示文档元数据已写入。'],
  },
})
