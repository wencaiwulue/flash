import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: 'e8d8c066c1419579fbf8bf6f653760110eaf315a',
  title: 'Finalize previous commit documentation',
  kind: 'metadata-migration',
  status: 'implemented',
  beforeState: '实际 parent 为 f5b097b；在该修订中，4329cd8 尚无自己的 SPEC、PLAN 或索引行，INDEX 的 Implemented 为 79，Partial 为 1，self 已位于表尾。',
  problem: '4329cd8 已经为 e0cbbe1 建立文档，但 4329cd8 自身仍不可发现。补档时必须区分这两个提交，不能把 SPEC 中引用的 e0cbbe1 文件当成本次新建文件。',
  goals: [
    '建立 docs/specs/4329cd8-SPEC.md 与 docs/plans/4329cd8-PLAN.md，身份锁定 4329cd8296630e2e5334d4b410cc8fe1cca273b6。',
    '把 INDEX 的 Implemented 从 79 调至 80，并在 status JSON 中登记同一提交及两个产物。',
  ],
  nonGoals: [
    '不修改 e0cbbe1 的既有 SPEC/PLAN，也不为实际 parent f5b097b 建文档。',
    '不把生成文档列举的测试、类型检查、构建或 CI 文字视为执行证据。',
  ],
  architecture: [
    '四个变更路径组成纯元数据闭包：新 SPEC 保存 4329cd8 对 e0cbbe1 文档工作的实际范围，新 PLAN 提供计划模板，两个索引负责发现性。',
    'status 对象位于 self 对象之前，self 的 changeId、SPEC/PLAN 路径和末尾位置均未改变；没有运行时代码或协议变化。',
  ],
  decisions: [
    'frontmatter 采用 4329cd8 的完整 SHA、2026-11-11T11:18:31+08:00 和 implemented；Actual scope 保留其 78 行新增、1 行删除及 e0cbbe1 两个旧文档路径。',
    'INDEX 新增 4329cd8 行且仅增加 implemented 计数；JSON 同步 shortSha、subject 与 repository-relative spec/plan 字段。',
  ],
  alternatives: ['复用 e0cbbe1 的文档会丢失 4329cd8 的身份；只添加 Markdown 又会留下索引缺项，因此采用两个新文件加两个索引补丁。'],
  security: ['变更仅限 Markdown 与 JSON 元数据，没有新增凭据、权限分支或可执行逻辑；模板中的安全声明不代表 enforcement 改变。'],
  acceptance: [
    '两个新文件的 frontmatter 与 4329cd8 的提交身份、日期和状态一致。',
    'INDEX 为 80/1/0，JSON 新对象与表格链接均指向 4329cd8 的两个新文件，self 保持原位。',
  ],
  evidence: [
    {
      kind: 'diff-observed',
      statement: '新 SPEC 锁定 4329cd8，并把 e0cbbe1-SPEC.md 与 e0cbbe1-PLAN.md 列为该被补档提交的历史范围。',
      source: { path: 'docs/specs/4329cd8-SPEC.md', role: 'evidence', revision: 'commit', symbol: 'commit: 4329cd8296630e2e5334d4b410cc8fe1cca273b6', note: 'frontmatter 和 Actual scope 共同限定文档对象。' },
    },
    {
      kind: 'diff-observed',
      statement: '新 PLAN 使用同一身份，包含目标、实施步骤、风险、验证序列和完成状态小节。',
      source: { path: 'docs/plans/4329cd8-PLAN.md', role: 'evidence', revision: 'commit', symbol: '## Implementation steps', note: '该文件在本提交新建。' },
    },
    {
      kind: 'diff-observed',
      statement: 'INDEX patch 将 Implemented 从 79 改为 80，在 self 前增加 4329cd8 的 SPEC/PLAN 链接。',
      source: { path: 'docs/INDEX.md', role: 'evidence', revision: 'commit', symbol: '- Implemented: 80', note: 'Partial 1 与 Unimplemented 0 未改。' },
    },
    {
      kind: 'diff-observed',
      statement: 'status patch 在 self 前加入 4329cd8 对象，spec/plan 字段指向本提交的两个新产物。',
      source: { path: 'docs/status/index.json', role: 'evidence', revision: 'commit', symbol: '"fullSha": "4329cd8296630e2e5334d4b410cc8fe1cca273b6"', note: '机器索引保存完整 SHA 与 implemented 状态。' },
    },
    { kind: 'not-recorded', statement: 'SPEC/PLAN 虽列出 bun test、typecheck、build 和 CI，但 diff 没有命令输出或 CI 结果。' },
  ],
  remaining: ['PLAN 的实施步骤仍是泛化模板，未进一步解释 4329cd8 的逐文件生成过程。'],
  references: [
    { path: 'docs/INDEX.md', role: 'changed', note: 'Implemented 79→80，新增 4329cd8 表格入口。' },
    { path: 'docs/plans/4329cd8-PLAN.md', role: 'changed', note: '新建 4329cd8 的计划文档。' },
    { path: 'docs/specs/4329cd8-SPEC.md', role: 'changed', note: '新建 4329cd8 的身份与范围说明。' },
    { path: 'docs/status/index.json', role: 'changed', note: '在 self 前注册 4329cd8 及文档路径。' },
  ],
  plan: {
    preconditions: ['核对实际 parent f5b097b、被补档提交 4329cd8 与其文档对象 e0cbbe1 的层级。'],
    reuse: ['沿用已有 frontmatter、INDEX 列结构和 status 对象字段，不重排 self。'],
    steps: [
      { title: '说明 4329cd8 的范围', detail: '写入其完整身份，并列出 e0cbbe1 两个文档及四项 diff 范围。', paths: ['docs/specs/4329cd8-SPEC.md'] },
      { title: '生成 4329cd8 计划', detail: '用相同 frontmatter 组织目标、步骤、风险、验证与剩余工作。', paths: ['docs/plans/4329cd8-PLAN.md'] },
      { title: '更新人类索引', detail: '把汇总改为 80，并在既有 8a248e3 行后、self 前插入 4329cd8。', paths: ['docs/INDEX.md'] },
      { title: '更新机器索引', detail: '在 8a248e3 对象后登记 4329cd8，保留 self 为最后一个对象。', paths: ['docs/status/index.json'] },
    ],
    compatibility: ['既有提交行和 JSON 对象保持顺序，新增链接使用既有 ../docs 与 repository-relative 约定。'],
    risks: ['相同标题容易造成 4329cd8 与 e0cbbe1 对象错位；验证模板也容易被误读为已经执行。'],
    verification: ['对照 4329cd8 的真实 diff 检查 SPEC 范围，并比较 parent/current 的表格、计数和 JSON 新对象。'],
    completed: ['4329cd8 的两个新产物及人类、机器索引入口均已落入本提交。'],
    incomplete: ['没有随附测试或 CI 日志，泛化计划也未增加实现细节。'],
  },
})
