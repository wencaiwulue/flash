import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: '2a4aa6c36263b3b17c6c5f188b03cc9a6a7e3cff',
  title: 'Finalize documentation for previous commit',
  kind: 'metadata-migration',
  status: 'implemented',
  beforeState: '父提交 be5c03e17428c3a7f85f7c0459b49432e61ccbf4 已补 1bc02bf，INDEX Implemented 为 62，status JSON 含 self 为 64 项。当前 diff 的目标是祖父 1329f792eb0a103eeeabea26a46566bfa9eceaba，父树中没有它的 SPEC/PLAN。',
  problem: '要把 1329f79 接到 1bc02bf 后，同时保留它原本为 3fbabc2 写文档的范围；直接父 be5c03e 虽标题相近，却不是本提交的新 frontmatter 对象。',
  goals: [
    '建立 1329f79 SPEC/PLAN，使用 Finalize documentation for previous commit、2026-11-11T11:08:53+08:00 和 implemented。',
    '记录 3fbabc2 文档对、两个索引及 78 行新增、1 行删除，并为 1329f79 同步人类和机器入口。',
  ],
  nonGoals: [
    '不补直接父 be5c03e 或当前 2a4aa6c，不改写 1bc02bf 的 d472e5c 范围。',
    '不修改生成器源码，不声称执行 PLAN 所列测试、typecheck、build 或 CI。',
  ],
  architecture: [
    '新增 1329f79 的两个文档描述历史提交，两个索引补丁使其可发现；运行时和文档生成代码均不在 diff 内。',
    '1bc02bf 之后插入 1329f79，self 只改变下标，保留 changeId、状态和原有 self 文档链接。',
  ],
  decisions: [
    'Actual scope 使用 3fbabc2-SPEC/PLAN，明确区别于 1bc02bf 的 d472e5c 文档组。',
    'INDEX 从 62/1/0 调为 63/1/0；JSON 总数 64→65，implemented 含 self 从 63→64。',
    '1329f79 为 commits 第 64 项，self 为第 65 项，新增对象含 fullSha、shortSha、date、subject、status、spec、plan 七字段。',
  ],
  alternatives: ['把 be5c03e 作为目标会使其 1bc02bf 范围与 1329f79 的 3fbabc2 范围互换；仅创建文档则留下 63 的统计没有对应入口。'],
  security: ['本提交只有 Markdown 和 JSON 元数据，不涉及产品权限、私有协议、依赖或凭据。'],
  acceptance: [
    '1329f79 的完整身份与时间在两份 frontmatter 一致，范围路径准确指向 3fbabc2。',
    'INDEX 行与 JSON 对象均指向新建的 1329f79 文件，self 仍最后且其他状态计数不变。',
  ],
  evidence: [
    { kind: 'diff-observed', statement: '1329f79 SPEC 固定完整提交身份，Actual scope 列出 3fbabc2 文档对。', source: { path: 'docs/specs/1329f79-SPEC.md', role: 'evidence', revision: 'commit', symbol: 'commit: 1329f792eb0a103eeeabea26a46566bfa9eceaba', note: 'frontmatter 与范围在同一新文件中。' } },
    { kind: 'diff-observed', statement: '1329f79 PLAN 提供验证序列和 implemented 完成声明。', source: { path: 'docs/plans/1329f79-PLAN.md', role: 'evidence', revision: 'commit', symbol: '## Verification sequence', note: '该小节列出命令名称但没有输出。' } },
    { kind: 'diff-observed', statement: 'INDEX 新增 1329f79 的标题与链接，汇总 Implemented 为 63。', source: { path: 'docs/INDEX.md', role: 'evidence', revision: 'commit', symbol: '| 1329f79 | Finalize documentation for previous commit | implemented |', note: '新增行紧随 1bc02bf。' } },
    { kind: 'diff-observed', statement: '机器索引保存 1329f79 完整 SHA 和两个新文件路径。', source: { path: 'docs/status/index.json', role: 'evidence', revision: 'commit', symbol: '"fullSha": "1329f792eb0a103eeeabea26a46566bfa9eceaba"', note: '对象位于 1bc02bf 与 self 之间。' } },
    { kind: 'not-recorded', statement: '本 diff 没有命令结果、测试报告或 CI 状态，文档中的验证文字不能充当执行证据。' },
  ],
  remaining: ['be5c03e 与 2a4aa6c 的文档仍留给后续，本提交仅完成 1329f79 这一层。'],
  references: [
    { path: 'docs/INDEX.md', role: 'changed', note: 'Implemented 62→63，添加 1329f79。' },
    { path: 'docs/plans/1329f79-PLAN.md', role: 'changed', note: '1329f79 新建计划文档。' },
    { path: 'docs/specs/1329f79-SPEC.md', role: 'changed', note: '记录 1329f79 和 3fbabc2 范围。' },
    { path: 'docs/status/index.json', role: 'changed', note: 'JSON 64→65 项，self 前加入 1329f79。' },
  ],
  plan: {
    preconditions: ['核对祖父 1329f79 的标题、时间与其 3fbabc2 文档产物，排除直接父 be5c03e。'],
    reuse: ['复用 1bc02bf 后的索引顺序和 self 占位，沿用生成 SPEC/PLAN 的既有结构。'],
    steps: [
      { title: '建立 1329f79 SPEC', detail: '写入完整身份及 3fbabc2 文档组，保留四文件 78/1 统计。', paths: ['docs/specs/1329f79-SPEC.md'] },
      { title: '建立 1329f79 PLAN', detail: '以相同元数据保存计划步骤、风险、验证建议和完成状态。', paths: ['docs/plans/1329f79-PLAN.md'] },
      { title: '同步人类索引', detail: '在 1bc02bf 后加入 1329f79 行，将 Implemented 单项改为 63。', paths: ['docs/INDEX.md'] },
      { title: '同步机器索引', detail: '把 1329f79 作为第 64 项插入，使 self 成为第 65 项。', paths: ['docs/status/index.json'] },
    ],
    compatibility: ['已有 1bc02bf 链接和 self 字段不变；生成器行为与 JSON 七字段格式保持一致。'],
    risks: ['相邻提交标题都含 documentation，若不以完整 SHA 区分 1329f79 与 be5c03e，会错配 3fbabc2 范围。'],
    verification: ['核对 1329f79 原提交的元数据与路径，再检查两个新 frontmatter 和两个索引增量。'],
    completed: ['1329f79 SPEC/PLAN 及双索引入口已同步进入版本树。'],
    incomplete: ['没有实际验证轨迹；模板中的 implemented 和无剩余项声明不是测试通过证明。'],
  },
})
