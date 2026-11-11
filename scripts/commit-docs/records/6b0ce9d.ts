import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: '6b0ce9d6834a125567ec0121caa531f5b8341101',
  slug: 'commit-docs-finalization',
  title: 'Finalize previous commit documentation',
  kind: 'metadata-migration',
  status: 'implemented',
  beforeState: '父版本 787b2dc 的 INDEX 为 Implemented 69，b6bf982 尚无 SPEC/PLAN 或 status 对象。这里的 b6bf982 是本提交的祖父提交而非直接父提交，中间的 787b2dc 不能误写进新文件身份。',
  problem: '需要补登记文档链中较早的 b6bf982，同时让它自己的 SPEC 正确描述 b6bf982 为 6c3c1e4 建文档的四路径变更；若按通常的直接父提交模板处理，会同时错置两层提交。',
  goals: [
    '以 b6bf9822536793efc08cd9ce4d94f1c066530d1c 的完整身份新建 SPEC 与 PLAN，记录其 6c3c1e4 文档产物范围。',
    '把 b6bf982 加入 INDEX 和 status/index.json，将 Implemented 从 69 调至 70，并保持 self 条目位于末尾。',
  ],
  nonGoals: [
    '不改写 787b2dc、6c3c1e4 或 b6bf982 的既有历史文档，也不增加产品功能。',
    '不把 PLAN 中的测试、构建及 CI 检查清单视作本提交留下的执行结果。',
  ],
  architecture: [
    '本次落盘完全是文档元数据：两个新 Markdown 负责祖父提交说明，两个既有索引负责人工与机器检索，没有运行时代码路径。',
    'b6bf982-SPEC 内嵌的 Actual scope 指向更下一层的 6c3c1e4-SPEC/PLAN；本提交自身则只新增 b6bf982 的两个文件并更新 INDEX/status。',
  ],
  decisions: [
    'SPEC 明确采用 b6bf982 的日期、标题和 implemented 状态，并列出其 6c3c1e4 两个文档、INDEX、status 共四个路径及 78 增 1 删。',
    '新表格行和 JSON 对象均插在 self 前，Implemented 单独增一；Partial 1、Unimplemented 0 及 self 内容不变。',
  ],
  alternatives: ['若改为给直接父提交 787b2dc 建档，会漏掉当时尚无入口的 b6bf982；若只补 SPEC，则 PLAN 与两类索引仍无法形成完整导航，因此维持四文件闭合。'],
  security: ['diff 仅含文档和索引文本，没有密钥、权限判断或协议实现变化；通用安全句子不构成安全控制已落地的证明。'],
  acceptance: [
    '两个 frontmatter 与 b6bf982 的 full SHA、2026-11-11T11:12:31+08:00 时间及标题一致。',
    'INDEX 70/1/0 汇总、新增 b6bf982 链接行和 status 中同 SHA 对象相互对应，self 仍在最后且没有额外变更路径。',
  ],  remaining: ['新 SPEC/PLAN 对 b6bf982 的设计说明较模板化；本记录只能确认其实际元数据范围和关联，不能补足未记录的验证。'],
  references: [
    { path: 'docs/INDEX.md', role: 'changed', note: 'Implemented 69→70，新增 b6bf982 表格入口。' },
    { path: 'docs/plans/b6bf982-PLAN.md', role: 'changed', note: '新建祖父提交 b6bf982 的实施计划。' },
    { path: 'docs/specs/b6bf982-SPEC.md', role: 'changed', note: '新建 b6bf982 规格并记录 6c3c1e4 嵌套文档范围。' },
    { path: 'docs/status/index.json', role: 'changed', note: '在 self 前注册 b6bf982 的机器可读对象。' },
  ],
  plan: {
    preconditions: ['先确认 787b2dc 是直接父版本、b6bf982 是目标祖父提交，并核对 b6bf982 自身的 6c3c1e4 四路径 diff。'],
    reuse: ['沿用 INDEX 的既有列结构、status 对象字段以及 SPEC/PLAN frontmatter，不重排 self。'],
    steps: [
      { title: '补写祖父提交规格', detail: '以 b6bf982 为 frontmatter 主体，单独列出其面向 6c3c1e4 的四个历史路径。', paths: ['docs/specs/b6bf982-SPEC.md'] },
      { title: '补写祖父提交计划', detail: '复用相同身份和 implemented 标记，为 b6bf982 添加计划、风险及边界段落。', paths: ['docs/plans/b6bf982-PLAN.md'] },
      { title: '更新第 70 项索引', detail: '把计数推进到 70，并将 b6bf982 链接行追加在既有历史项之后、self 之前。', paths: ['docs/INDEX.md'] },
      { title: '登记祖父提交状态', detail: '在 JSON 的 self 对象之前写入 b6bf982 完整 SHA、日期、主题和两项文档路径。', paths: ['docs/status/index.json'] },
    ],
    compatibility: ['保留前 69 个 implemented 条目及 self 字段；新增 Markdown 链接和 JSON repository-relative 路径遵循现有格式。'],
    risks: ['主要风险是把直接父版本 787b2dc 与目标祖父 b6bf982 混用，或把 SPEC 内 6c3c1e4 的范围当成本提交 diff。'],
    acceptanceSequence: ['比较两个 frontmatter 与 b6bf982 metadata，核对 6c3c1e4 路径清单，并检查 70/1/0 汇总、JSON 对象及 self 末位。'],
    completed: ['b6bf982 的两个新产物与双索引入口已落盘，四处变更均有对应身份和路径。'],
    incomplete: ['没有可归属于该提交的测试日志或 CI 结果，文档验证清单仍只是声明。'],
  },
})
