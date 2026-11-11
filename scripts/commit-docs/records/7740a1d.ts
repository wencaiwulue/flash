import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: '7740a1d28b70629f41d49116a8e6007eb46c72aa',
  title: 'Finalize self documentation for current commit',
  kind: 'metadata-migration',
  status: 'implemented',
  beforeState: '直接父提交 f210ce9c2dc51a30f98514628b07538a969f21aa 已为 c4e19ce 建文档，INDEX 为 Implemented 43、Partial 1、Unimplemented 0；祖父提交 17c91967ada4424f164da8e2699e3ee90d587036 的 SPEC/PLAN 尚未生成。',
  problem: '本次实际定稿 17c9196，需要保存其为 8117aaa 建文档的 75 行新增范围；不能把直接父 f210ce9 的 78 行统计或 c4e19ce 文档路径带入新 SPEC。',
  goals: [
    '新建 17c9196 SPEC/PLAN，Actual scope 精确列出 8117aaa 文档对及两个索引。',
    '为 17c9196 增加 INDEX/status 注册，将 Implemented 从 43 更新到 44。',
  ],
  nonGoals: [
    '不处理直接父 f210ce9 或当前 7740a1d 的文档，也不修改 HEAD 排除代码。',
    '不增加验证日志，不把 PLAN 中的测试与 CI 序列当成已通过。',
  ],
  architecture: [
    '17c9196 SPEC 将四个历史路径和 75 insertions、1 deletion 固化，清单中的 8117aaa-SPEC/PLAN 标识了它与其他四文件文档提交的区别。',
    '当前提交自身仍是四个元数据路径：17c9196 的 SPEC/PLAN，加上 c4e19ce 后、self 前的 INDEX 行和 JSON 对象；生成器 blob 没有变化。',
  ],
  decisions: [
    '新文档 frontmatter 使用 17c91967ada4424f164da8e2699e3ee90d587036，而非直接父 f210ce9；统计采用 75/1。',
    'INDEX 三类计数变为 44/1/0，JSON 只新增 17c9196 对象，并保持 fullSha、shortSha、date、subject、status、spec、plan 字段顺序。',
  ],
  alternatives: ['仅按相同标题和四文件结构复制相邻记录会留下 78/1 或 c4e19ce 路径；把动态 HEAD 排除当作本提交新功能也会超出实际 diff。'],
  security: ['变更仅为历史说明和链接注册，没有新增可执行代码、认证材料或权限行为。'],
  acceptance: [
    'SPEC 记录 4 files、75 insertions、1 deletion，并同时列出 8117aaa-SPEC 与 8117aaa-PLAN。',
    'PLAN 与 SPEC 的 17c9196 身份一致，INDEX/JSON 链接可对应本次新文件，self 仍在末尾。',
  ],
  evidence: [
    {
      kind: 'diff-observed',
      statement: '新 SPEC 保存 17c9196 的 4 文件、75 行新增和 1 行删除统计。',
      source: { path: 'docs/specs/17c9196-SPEC.md', role: 'evidence', revision: 'commit', symbol: '- Diff statistics: 4 files changed, 75 insertions(+), 1 deletion(-)', note: '75/1 是 17c9196 自身统计，不是 f210ce9 的 78/1。' },
    },
    {
      kind: 'diff-observed',
      statement: '新 PLAN 以 17c9196 完整 SHA 建立并含实现步骤小节。',
      source: { path: 'docs/plans/17c9196-PLAN.md', role: 'evidence', revision: 'commit', symbol: 'commit: 17c91967ada4424f164da8e2699e3ee90d587036', note: 'PLAN 与 SPEC 使用相同历史身份。' },
    },
    {
      kind: 'diff-observed',
      statement: 'INDEX 新增 17c9196 行，Implemented 从 43 到 44。',
      source: { path: 'docs/INDEX.md', role: 'evidence', revision: 'commit', symbol: '- Implemented: 44', note: '其他状态计数未变化。' },
    },
    {
      kind: 'diff-observed',
      statement: 'status JSON 在 self 前加入 17c9196 及其 SPEC/PLAN 路径。',
      source: { path: 'docs/status/index.json', role: 'evidence', revision: 'commit', symbol: '"fullSha": "17c91967ada4424f164da8e2699e3ee90d587036"', note: '本 diff 只注册这一历史提交。' },
    },
    { kind: 'not-recorded', statement: '文档中的 bun test、typecheck、build 和 CI 仅为计划文本，未附执行证据。' },
  ],
  remaining: ['f210ce9 的文档由后续提交补齐；17c9196 的 PLAN 仍是概括模板，没有新的行为验证记录。'],
  references: [
    { path: 'docs/INDEX.md', role: 'changed', note: 'Implemented 43 到 44，加入 17c9196。' },
    { path: 'docs/plans/17c9196-PLAN.md', role: 'changed', note: '新建 17c9196 的计划文档。' },
    { path: 'docs/specs/17c9196-SPEC.md', role: 'changed', note: '记录 17c9196 为 8117aaa 建文档的 75/1 范围。' },
    { path: 'docs/status/index.json', role: 'changed', note: '注册 17c9196 的机器可读元数据。' },
  ],
  plan: {
    preconditions: ['核对直接父 f210ce9 的 43/1/0 索引，并读取 17c9196 自身的 75/1 diff 和 8117aaa 路径。'],
    reuse: ['沿用未修改的 HEAD 排除生成器、SPEC/PLAN 模板和索引结构，复用 8117aaa 已落盘的文件命名。'],
    steps: [
      { title: '建立 17c9196 SPEC', detail: '记录 75/1 统计，文件清单锁定 8117aaa 文档对和两个索引。', paths: ['docs/specs/17c9196-SPEC.md'] },
      { title: '建立 17c9196 PLAN', detail: '以相同 fullSha 新建 PLAN，保留模板验证与实际的区分。', paths: ['docs/plans/17c9196-PLAN.md'] },
      { title: '更新人类索引', detail: '在 c4e19ce 后添加 17c9196，只将 Implemented 增至 44。', paths: ['docs/INDEX.md'] },
      { title: '更新机器索引', detail: '在 self 前插入 17c9196 的完整字段及新文件路径。', paths: ['docs/status/index.json'] },
    ],
    compatibility: ['既有 c4e19ce、8117aaa 和 self 条目保持原顺序，生成器实现与文档 schema 均未变化。'],
    risks: ['75/1 与相邻 78/1 只差三行，必须结合 8117aaa 路径而非统计数字单独识别范围。'],
    verification: ['对照 17c9196 Git diff 和 SPEC 清单，并交叉检查 PLAN frontmatter、INDEX 摘要及 JSON 新对象。'],
    completed: ['17c9196 的文档对和两个索引入口已按 75/1 实际范围落盘。'],
    incomplete: ['本提交未记录任何测试、构建或 CI 的实际运行结果。'],
  },
})
