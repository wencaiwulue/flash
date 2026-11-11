import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: 'f210ce9c2dc51a30f98514628b07538a969f21aa',
  slug: 'commit-docs-finalization',
  title: 'Finalize commit documentation for previous change',
  kind: 'metadata-migration',
  status: 'implemented',
  beforeState: '直接父提交 17c91967ada4424f164da8e2699e3ee90d587036 已为 8117aaa 建文档，INDEX 为 Implemented 42、Partial 1、Unimplemented 0；祖父提交 c4e19cee451ce0a5a43e78475d40f2e079b350df 的 SPEC/PLAN 和索引项仍未建立。',
  problem: '本次文档对象是 c4e19ce，不是直接父 17c9196；需要保留 c4e19ce 为 587c466 建立 127 行 SPEC 等造成的 169 行新增规模，避免套用普通 78 行记录。',
  goals: [
    '新建 c4e19ce 的 SPEC/PLAN，准确记录其四个文档路径和 169 insertions、1 deletion。',
    '把 c4e19ce 注册到两个索引的 self 前，Implemented 从 42 更新为 43。',
  ],
  nonGoals: [
    '不补写直接父 17c9196 的文档，也不更改 587c466 已生成的长清单。',
    '不修改生成器、checker、CI，不将计划中的验证文字当作执行证据。',
  ],
  architecture: [
    '新 SPEC 将 c4e19ce 的实际范围映射为 INDEX、status JSON 和 587c466 SPEC/PLAN；169 行新增主要来自那份 127 行的初始化 SPEC。',
    '新 PLAN 与 SPEC 使用同一 c4e19ce fullSha、标题、日期和 implemented；INDEX 行与 JSON 对象提供相同身份和文件链接。',
  ],
  decisions: [
    'Actual scope 使用 c4e19ce 自身的 4 files、169 insertions、1 deletion，而不是 587c466 的 95 文件或 17c9196 的 75 行新增。',
    'c4e19ce 行位于 8117aaa 后、self 前；Partial 1 和 Unimplemented 0 不变，机器索引字段顺序保持原样。',
  ],
  alternatives: ['若按标题把直接父 17c9196 当作对象，会重复其已有记录；若只记录“四个文件”而省略 169 行规模，则会抹平 c4e19ce 长 SPEC 的实际差异。'],
  security: ['diff 仅涉及历史说明和索引，不更改程序执行面；文档中的安全与验证声明不被视为新的 enforcement。'],
  acceptance: [
    '两个新文件的 frontmatter 均指向完整 c4e19ce SHA，SPEC 路径清单包含 587c466 的两个产物。',
    'INDEX 为 43/1/0，JSON 在 self 前登记 c4e19ce 且 spec/plan 字段与实际文件一致。',
  ],  remaining: ['直接父 17c9196 的文档由后续提交处理；c4e19ce 的计划正文仍是生成模板，未增加实施细节或验证日志。'],
  references: [
    { path: 'docs/INDEX.md', role: 'changed', note: 'Implemented 42 到 43，加入 c4e19ce。' },
    { path: 'docs/plans/c4e19ce-PLAN.md', role: 'changed', note: '新建 c4e19ce 的生成计划。' },
    { path: 'docs/specs/c4e19ce-SPEC.md', role: 'changed', note: '记录 c4e19ce 的 169 行新增及 587c466 文档范围。' },
    { path: 'docs/status/index.json', role: 'changed', note: '注册 c4e19ce 的完整元数据。' },
  ],
  plan: {
    preconditions: ['读取直接父 17c9196 的索引状态，并以 c4e19ce 自身 diff 核实 169 行新增的来源。'],
    reuse: ['复用 c4e19ce 已采用的 SPEC/PLAN 结构和索引 schema，保持 8117aaa 与 self 的相对位置。'],
    steps: [
      { title: '描述 c4e19ce 实际范围', detail: '新建 SPEC，列出 587c466 文档对及两个索引，并保存 169/1 统计。', paths: ['docs/specs/c4e19ce-SPEC.md'] },
      { title: '补齐 c4e19ce 计划', detail: '以相同提交身份新增 PLAN，不改写历史执行事实。', paths: ['docs/plans/c4e19ce-PLAN.md'] },
      { title: '更新表格入口', detail: '在 8117aaa 后登记 c4e19ce，Implemented 单独加一。', paths: ['docs/INDEX.md'] },
      { title: '更新状态对象', detail: '在 self 前加入相同 fullSha、implemented 和 spec/plan 路径。', paths: ['docs/status/index.json'] },
    ],
    compatibility: ['既有 587c466 与 8117aaa 条目保持不变，新文件沿用原命名和 frontmatter 约定。'],
    risks: ['三层提交相互嵌套，最容易误用 17c9196 的 75 行统计或 587c466 的 95 文件统计。'],
    acceptanceSequence: ['以 c4e19ce 的 Git diff 对照 SPEC，再交叉检查新 PLAN、INDEX 计数与 JSON 字段。'],
    completed: ['c4e19ce 的文档对和两个索引注册已按 169 行新增的实际范围完成。'],
    incomplete: ['没有可追溯的命令执行或 CI 结果，验证序列仅是文档内容。'],
  },
})
