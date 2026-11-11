import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: '96283aecc10afd0f0269eff9b7a3b0c543191b01',
  title: 'Complete previous commit documentation',
  kind: 'metadata-migration',
  status: 'implemented',
  beforeState: '父提交 6c3c1e4d3cdd8b1b8279c023575fb7a37e94a14c 已登记 0dabf46，INDEX Implemented 为 66，JSON 含 self 为 68 项。当前真正补档对象是祖父 612cc40e519f48121614051611d16b054823c24c，父树尚无其文档对。',
  problem: '需要给 612cc40 建立身份、范围和索引，而其范围是 2a4aa6c 文档组；直接父 6c3c1e4 的 0dabf46 范围不能复制到新 SPEC。',
  goals: [
    '创建 612cc40 SPEC/PLAN，使用 Finalize previous commit documentation、2026-11-11T11:10:48+08:00 和 implemented。',
    '记录 2a4aa6c 文档对、两个索引与 78 行新增、1 行删除，并同步 612cc40 的双索引入口。',
  ],
  nonGoals: [
    '不登记直接父 6c3c1e4 或当前 96283ae，不修改 0dabf46 的既有条目。',
    '不改变生成器或产品行为，不把 PLAN 的验证文本解释为执行通过。',
  ],
  architecture: [
    '612cc40 的两个 Markdown 文件承载历史说明，INDEX 和 JSON 分别提供表格与七字段机器对象；无其他实现层变化。',
    '新项位于 0dabf46 后、self 前；self 继续保留 commit-docs-bootstrap 身份和 self 文档路径。',
  ],
  decisions: [
    'Actual scope 选择 2a4aa6c-SPEC/PLAN，四文件统计 78/1，与 612cc40 原提交一致。',
    '612cc40 这一层的计数结果是 INDEX 66→67、机器对象 68→69；只有 implemented 增加，Partial 固定为 1、Unimplemented 固定为 0，self 仍贡献一个 implemented。',
    '612cc40 成为第 68 个 JSON 对象，self 为第 69 项；当前 96283ae 没有新增自我 SHA 记录。',
  ],
  alternatives: ['按直接父 6c3c1e4 建档会错误保留 0dabf46 范围；只创建 612cc40 文件则无法让 INDEX 67 和 JSON 69 项对应实际入口。'],
  security: ['本提交只修改文档元数据，没有执行代码、敏感信息、网络协议或权限边界变化。'],
  acceptance: [
    '612cc40 两份 frontmatter 的完整 SHA、标题、时间一致，Actual scope 指向 2a4aa6c。',
    'INDEX 与 JSON 新增对象状态均为 implemented，0dabf46 保持前一项，self 位于末尾。',
  ],
  evidence: [
    { kind: 'diff-observed', statement: '612cc40 SPEC 以完整目标 SHA 新建，并记录 2a4aa6c 文档组。', source: { path: 'docs/specs/612cc40-SPEC.md', role: 'evidence', revision: 'commit', symbol: 'commit: 612cc40e519f48121614051611d16b054823c24c', note: '目标身份不是直接父 6c3c1e4。' } },
    { kind: 'diff-observed', statement: '612cc40 PLAN 包含实现步骤与完成状态，标题使用目标原 subject。', source: { path: 'docs/plans/612cc40-PLAN.md', role: 'evidence', revision: 'commit', symbol: '# Implementation plan: Finalize previous commit documentation', note: '计划标题与 612cc40 原提交一致。' } },
    { kind: 'diff-observed', statement: 'INDEX Implemented 调整为 67，并新增 612cc40 的两个链接。', source: { path: 'docs/INDEX.md', role: 'evidence', revision: 'commit', symbol: '| 612cc40 | Finalize previous commit documentation | implemented |', note: '该行位于 0dabf46 与 self 之间。' } },
    { kind: 'diff-observed', statement: 'JSON 保存 612cc40 完整身份及本次新建的 SPEC/PLAN 路径。', source: { path: 'docs/status/index.json', role: 'evidence', revision: 'commit', symbol: '"fullSha": "612cc40e519f48121614051611d16b054823c24c"', note: '机器对象与 INDEX 同步新增。' } },
    { kind: 'not-recorded', statement: '本提交没有生成日志、测试输出、构建结果或 CI 记录，验证章节不构成运行证据。' },
  ],
  remaining: ['6c3c1e4 与当前 96283ae 的文档仍待后续，本提交只完成 612cc40。'],
  references: [
    { path: 'docs/INDEX.md', role: 'changed', note: 'Implemented 66→67，添加 612cc40。' },
    { path: 'docs/plans/612cc40-PLAN.md', role: 'changed', note: '新建 612cc40 实施计划。' },
    { path: 'docs/specs/612cc40-SPEC.md', role: 'changed', note: '记录 612cc40 及 2a4aa6c 范围。' },
    { path: 'docs/status/index.json', role: 'changed', note: '总数 68→69，self 前插入 612cc40。' },
  ],
  plan: {
    preconditions: ['确认祖父 612cc40 为实际目标，核对其 2a4aa6c 文档对和四文件 78/1 范围。'],
    reuse: ['沿用 0dabf46 后的索引顺序、self 占位和已有 SPEC/PLAN 与 JSON 结构。'],
    steps: [
      { title: '编写 612cc40 SPEC', detail: '写入完整身份、2a4aa6c 文档路径及 78/1 行统计。', paths: ['docs/specs/612cc40-SPEC.md'] },
      { title: '编写 612cc40 PLAN', detail: '以相同标题和时间保存计划步骤、风险、验证序列和状态。', paths: ['docs/plans/612cc40-PLAN.md'] },
      { title: '同步 INDEX', detail: '在 0dabf46 后新增 612cc40 行，仅将 Implemented 改为 67。', paths: ['docs/INDEX.md'] },
      { title: '同步 JSON', detail: '将 612cc40 插入第 68 位，使 self 顺移到第 69 项。', paths: ['docs/status/index.json'] },
    ],
    compatibility: ['0dabf46 及更早条目保持原序，self 内容不变；生成器和对象字段均无改动。'],
    risks: ['612cc40 与 6c3c1e4 的标题高度相近，若忽略祖父关系会把 2a4aa6c 与 0dabf46 范围错挂。'],
    verification: ['解析两个 frontmatter，对照 612cc40 原 diff，并比较父/当前 INDEX 与 JSON 的单项增量。'],
    completed: ['612cc40 SPEC/PLAN 与两个索引入口已同步落盘。'],
    incomplete: ['没有实际验证命令或 CI 输出，模板的无剩余项声明不作为额外完成证据。'],
  },
})
