import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: '8a248e3a57a3121e5e0bfeb7dbdeefb1551ac9b3',
  title: 'Complete previous commit documentation',
  kind: 'metadata-migration',
  status: 'implemented',
  beforeState: '父版本 e0cbbe1 已补好 1fe1430，INDEX 汇总为 Implemented 76；被补档的祖父提交 a4edc60 自己没有 SPEC/PLAN 和 status 对象，self 仍位于新增历史项之后。',
  problem: '需要为 a4edc60 建立文档身份并保留其内层 dc3f075 范围。本提交与目标都叫 Complete previous commit documentation，但 SHA、日期和 Actual scope 不同，不能因标题相同而复用内容。',
  goals: [
    '新建 a4edc60-SPEC.md 和 a4edc60-PLAN.md，完整身份使用 a4edc60de4da2600197f59e1b032d5e4a754e19b。',
    '为 a4edc60 同步添加 INDEX 与 JSON 注册，将 Implemented 从 76 调为 77，保持 self 最后及其他计数不变。',
  ],
  nonGoals: [
    '不修改 e0cbbe1、1fe1430 或 dc3f075 的既有文件，也不涉及应用实现。',
    '不将生成的验证命令清单表述成实际 test、build 或 CI 通过。',
  ],
  architecture: [
    'a4edc60 是当前文档化对象，dc3f075 是其 SPEC 内 Actual scope 的下一层对象，8a248e3 则是执行四文件写入的提交，三层身份各自独立。',
    'Markdown 双文件承载目标身份和历史范围，INDEX 增加第 77 个 implemented 链接，status 保存同 SHA 的机器映射。',
  ],
  decisions: [
    '目标文档采用 a4edc60 的 2026-11-11T11:16:45+08:00 时间，内层文件清单写 dc3f075-SPEC/PLAN 加 INDEX/status。',
    '新增行位于 1fe1430 后、self 前，status 对象采用相同顺序；Partial 1 和 Unimplemented 0 完全不动。',
  ],
  alternatives: ['相同 Complete 标题容易让人只替换 SHA 后保留 5c5bc03 内层清单，这不符合 a4edc60 实际 diff；单建 SPEC 也无法提供计划和双索引。'],
  security: ['本 diff 仅是文档元数据，没有权限决策、敏感数据或协议变更；通用安全措辞不构成新增保证。'],
  acceptance: [
    'SPEC/PLAN frontmatter 与 a4edc60 的 full SHA、日期、Complete 标题和 implemented 状态一致。',
    'Actual scope 为 dc3f075 两个文档，INDEX 达 77/1/0，JSON 路径正确，self 保留末位且无额外变更。',
  ],
  evidence: [
    {
      kind: 'diff-observed',
      statement: 'a4edc60-SPEC 的 Actual scope 明确列出 dc3f075 的 PLAN，frontmatter 则使用 a4edc60 身份。',
      source: { path: 'docs/specs/a4edc60-SPEC.md', role: 'evidence', revision: '8a248e3a57a3121e5e0bfeb7dbdeefb1551ac9b3', symbol: 'docs/plans/dc3f075-PLAN.md', note: '内层计划路径将本规格与相邻 Complete 文档区分。' },
    },
    {
      kind: 'diff-observed',
      statement: 'a4edc60-PLAN 以目标完整 SHA 新建，标题与目标 Git subject 一致。',
      source: { path: 'docs/plans/a4edc60-PLAN.md', role: 'evidence', revision: '8a248e3a57a3121e5e0bfeb7dbdeefb1551ac9b3', symbol: 'commit: a4edc60de4da2600197f59e1b032d5e4a754e19b', note: '计划身份固定在 8a248e3 文件版本。' },
    },
    {
      kind: 'diff-observed',
      statement: 'INDEX patch 增加 a4edc60 双链接行，并把 implemented 汇总从 76 更新到 77。',
      source: { path: 'docs/INDEX.md', role: 'evidence', revision: '8a248e3a57a3121e5e0bfeb7dbdeefb1551ac9b3', symbol: '- Implemented: 77', note: '汇总计数来自实际 INDEX diff。' },
    },
    {
      kind: 'diff-observed',
      statement: 'status JSON 新对象记录 a4edc60 完整 SHA 及其 SPEC/PLAN 路径，插入于 self 前。',
      source: { path: 'docs/status/index.json', role: 'evidence', revision: '8a248e3a57a3121e5e0bfeb7dbdeefb1551ac9b3', symbol: '"fullSha": "a4edc60de4da2600197f59e1b032d5e4a754e19b"', note: '机器对象与两个新文件相对应。' },
    },
    { kind: 'not-recorded', statement: '没有随提交记录的命令输出或持续集成状态，不能宣称任何验证已经通过。' },
  ],
  remaining: ['生成文档没有展开 a4edc60 的更细设计背景；本记录只补足可观察的元数据关系与无执行证据边界。'],
  references: [
    { path: 'docs/INDEX.md', role: 'changed', note: '新增 a4edc60 行，Implemented 76→77。' },
    { path: 'docs/plans/a4edc60-PLAN.md', role: 'changed', note: '为同标题的祖父提交 a4edc60 创建独立计划。' },
    { path: 'docs/specs/a4edc60-SPEC.md', role: 'changed', note: '记录 a4edc60 身份与 dc3f075 内层清单。' },
    { path: 'docs/status/index.json', role: 'changed', note: '在 self 前添加 a4edc60 机器状态对象。' },
  ],
  plan: {
    preconditions: ['读取 e0cbbe1 的 76 项索引，核对 a4edc60 metadata 和其面向 dc3f075 的历史四文件 diff。'],
    reuse: ['复用文档与索引格式，但重新填写 a4edc60 的 SHA、日期及 dc3f075 范围，避免相同标题造成复制。'],
    steps: [
      { title: '编写 a4edc60 规格', detail: '将目标 a4edc60 的身份和 dc3f075 两个历史文档范围分别列清。', paths: ['docs/specs/a4edc60-SPEC.md'] },
      { title: '编写 a4edc60 计划', detail: '以相同 Complete 标题但不同 full SHA 创建 PLAN，维持验证文字的证据边界。', paths: ['docs/plans/a4edc60-PLAN.md'] },
      { title: '增加第 77 个表格项', detail: '把 a4edc60 行接在 1fe1430 后，更新 implemented 数字且保留 self 最后一行。', paths: ['docs/INDEX.md'] },
      { title: '增加 a4edc60 JSON 项', detail: '向 self 前的 commits 数组加入目标身份、时间、主题和两项新路径。', paths: ['docs/status/index.json'] },
    ],
    compatibility: ['已有 Complete/Finalize 混合历史项均保留，状态分布除 implemented 加一外没有变化。'],
    risks: ['相同标题削弱了标题校验作用，若不看 full SHA 和 dc3f075 内层文件，错误记录也可能表面一致。'],
    verification: ['核对 8a248e3 版本中的 a4edc60 全 SHA、dc3f075 清单、77/1/0 汇总、JSON 对象与 self 顺序。'],
    completed: ['a4edc60 已获得两个新文档及两个索引入口，所有实际变更路径均被覆盖。'],
    incomplete: ['测试、构建和 CI 均无随提交输出，本记录不声称执行。'],
  },
})
