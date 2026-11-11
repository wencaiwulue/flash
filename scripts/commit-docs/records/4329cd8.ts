import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: '4329cd8296630e2e5334d4b410cc8fe1cca273b6',
  title: 'Finalize previous commit documentation',
  kind: 'metadata-migration',
  status: 'implemented',
  beforeState: '父版本 8a248e3 已登记 a4edc60，INDEX 为 Implemented 77。被补档的祖父提交 e0cbbe1 自身仍无 SPEC/PLAN 与 status 项，且它特有的 Finalize documentation for previous commit 标题需要保留。',
  problem: '本次要为 e0cbbe1 补齐元数据，其 SPEC 内层对象应为 1fe1430。当前提交标题比目标标题少了 documentation 一词，若按当前 subject 填模板，会造成 frontmatter 和索引主题错误。',
  goals: [
    '以 e0cbbe14182f93a59bd7e28a4dcd0776e05831f0 创建 e0cbbe1-SPEC.md 与 e0cbbe1-PLAN.md，保留目标完整标题。',
    '将 e0cbbe1 加入两个索引，Implemented 从 77 到 78，Partial 1、Unimplemented 0 和 self 尾部行为不变。',
  ],
  nonGoals: [
    '不改写 8a248e3、a4edc60 或 1fe1430 的文档，也不扩展产品代码。',
    '不把新文件中的命令和 CI 检查列表当成执行事实。',
  ],
  architecture: [
    '4329cd8 建立 e0cbbe1 的说明节点，而 e0cbbe1-SPEC 再描述它曾为 1fe1430 建立的双文档；这两种短 SHA 在路径中承担不同层级。',
    'INDEX 新行需使用 e0cbbe1 的 Finalize documentation 标题，status 也保存同一主题；两个新 frontmatter 与这两个索引共同锁定目标身份。',
  ],
  decisions: [
    '目标日期采用 2026-11-11T11:17:15+08:00，Actual scope 列出 1fe1430-SPEC/PLAN、INDEX/status 及 78 增 1 删统计。',
    '新增条目排在 a4edc60 后、self 前，implemented 变为 78；当前提交的较简短标题不会传入目标文件。',
  ],
  alternatives: ['按当前提交标题生成目标 PLAN 会丢失 documentation 一词；复制 8a248e3 的 dc3f075 内层清单又会使范围错误，所以需以 e0cbbe1 metadata 和 diff 双重校验。'],
  security: ['本提交只有 Markdown 与 JSON 文档变更，没有凭据、访问控制或协议实现，安全相关文字不是执行证据。'],
  acceptance: [
    '两个 frontmatter 与 e0cbbe1 的 full SHA、日期和 Finalize documentation for previous commit 标题一致。',
    'SPEC 指向 1fe1430 内层文档，INDEX 为 78/1/0，status 主题和路径一致，self 不变且仍最后。',
  ],
  evidence: [
    {
      kind: 'diff-observed',
      statement: 'e0cbbe1-SPEC 的标题包含 documentation，Actual scope 同时列出 1fe1430 的计划路径。',
      source: { path: 'docs/specs/e0cbbe1-SPEC.md', role: 'evidence', revision: '4329cd8296630e2e5334d4b410cc8fe1cca273b6', symbol: '# Finalize documentation for previous commit', note: '标题证据用于区分当前提交 subject。' },
    },
    {
      kind: 'diff-observed',
      statement: '新 PLAN frontmatter 使用 e0cbbe1 完整 SHA，与目标而非 4329cd8 自身身份绑定。',
      source: { path: 'docs/plans/e0cbbe1-PLAN.md', role: 'evidence', revision: '4329cd8296630e2e5334d4b410cc8fe1cca273b6', symbol: 'commit: e0cbbe14182f93a59bd7e28a4dcd0776e05831f0', note: '计划在当前提交新增。' },
    },
    {
      kind: 'diff-observed',
      statement: 'INDEX 新行保留 e0cbbe1 的完整标题，Implemented 汇总从 77 变为 78。',
      source: { path: 'docs/INDEX.md', role: 'evidence', revision: '4329cd8296630e2e5334d4b410cc8fe1cca273b6', symbol: '| e0cbbe1 | Finalize documentation for previous commit | implemented |', note: '人工索引包含准确主题与双链接。' },
    },
    {
      kind: 'diff-observed',
      statement: 'status 中 e0cbbe1 对象保存相同完整 SHA、主题和文档路径，self 仍随后出现。',
      source: { path: 'docs/status/index.json', role: 'evidence', revision: '4329cd8296630e2e5334d4b410cc8fe1cca273b6', symbol: '"fullSha": "e0cbbe14182f93a59bd7e28a4dcd0776e05831f0"', note: '机器索引证据固定在 4329cd8。' },
    },
    { kind: 'not-recorded', statement: 'SPEC/PLAN 所列 bun 命令与 CI 没有输出或状态存档，不能据此报告通过。' },
  ],
  remaining: ['e0cbbe1 的计划内容仍较概括；除标题、范围和索引关系外，没有更多实现或验证材料可据以扩展。'],
  references: [
    { path: 'docs/INDEX.md', role: 'changed', note: '新增 e0cbbe1 完整标题行，Implemented 达 78。' },
    { path: 'docs/plans/e0cbbe1-PLAN.md', role: 'changed', note: '新建带 documentation 字样的目标计划。' },
    { path: 'docs/specs/e0cbbe1-SPEC.md', role: 'changed', note: '记录 e0cbbe1 身份及 1fe1430 内层范围。' },
    { path: 'docs/status/index.json', role: 'changed', note: 'self 前增加 e0cbbe1 机器注册。' },
  ],
  plan: {
    preconditions: ['确认 8a248e3 基线为 77，比较当前与目标标题，并读取 e0cbbe1 为 1fe1430 建文档的原始 diff。'],
    reuse: ['复用四文件注册布局，frontmatter、表格主题和 JSON subject 全部采用 e0cbbe1 的完整标题。'],
    steps: [
      { title: '编写 e0cbbe1 规格', detail: '保留 Finalize documentation 标题，列出 1fe1430 两份历史文档作为 Actual scope。', paths: ['docs/specs/e0cbbe1-SPEC.md'] },
      { title: '编写 e0cbbe1 计划', detail: '使用目标全 SHA 和带 documentation 的标题创建 PLAN，不沿用当前提交措辞。', paths: ['docs/plans/e0cbbe1-PLAN.md'] },
      { title: '推进人工索引至 78', detail: '在 a4edc60 后加入 e0cbbe1 完整主题行，implemented 加一并保留 self 尾行。', paths: ['docs/INDEX.md'] },
      { title: '登记 e0cbbe1 机器状态', detail: '把相同 full SHA、长标题、日期和新文件路径写入 self 前的 JSON 对象。', paths: ['docs/status/index.json'] },
    ],
    compatibility: ['已有 77 项历史记录及 self bootstrap 字段不变，状态计数继续只改变 implemented。'],
    risks: ['当前与目标标题仅一词之差，校验若忽略标题会漏错；内层 1fe1430 也不能误写成 dc3f075。'],
    verification: ['检查两个 frontmatter 的长标题、e0cbbe1 全 SHA、1fe1430 清单、78/1/0 汇总和 JSON/self 顺序。'],
    completed: ['e0cbbe1 的两个文档和双索引入口均按目标元数据落盘，无额外路径。'],
    incomplete: ['提交未记录真实验证执行，完成状态不覆盖测试或 CI 结果。'],
  },
})
