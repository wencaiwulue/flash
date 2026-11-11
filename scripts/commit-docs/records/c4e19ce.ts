import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: 'c4e19cee451ce0a5a43e78475d40f2e079b350df',
  title: 'Finalize previous self documentation',
  kind: 'metadata-migration',
  status: 'implemented',
  beforeState: '直接父提交 8117aaa81ba58bb7ddae1256712797880a6cdebd 只修改生成器的 HEAD 排除，INDEX 仍为 Implemented 40、Partial 1、Unimplemented 0。更早的 587c466f7e28e4cb59b0c4522857a7110e7b152a 建立了文档体系，却尚无自己的 SPEC/PLAN 和索引项。',
  problem: '本次实际补齐的是 587c466，而非直接父 8117aaa；其初始文档体系涉及 95 个路径，若只登记短 SHA 或省略实际清单，无法准确保存这次元数据迁移的范围。',
  goals: [
    '新建 587c466 的 SPEC/PLAN，SPEC 保存 95 文件、6620 行新增的完整路径范围。',
    '在 INDEX 和 status/index.json 中注册 587c466，并保持 self 位于末尾。',
  ],
  nonGoals: [
    '本提交不为直接父 8117aaa 建文档，也不继续修改生成器、checker 或 CI。',
    '不把 587c466 文档中的测试、构建和 CI 验证序列解释为已经执行。',
  ],
  architecture: [
    '四个变更路径构成一组文档注册：127 行 SPEC 列出 95 个实际路径，31 行 PLAN 保存生成计划，两个人类/机器索引共享同一 587c466 身份。',
    'SPEC 清单覆盖 41 对历史 SPEC/PLAN 和一对 self 文档，即各 42 个文件，另有生成器、checker、CI、package 配置、模板和项目文档；这不是普通四文件模板提交的范围。',
  ],
  decisions: [
    'frontmatter 固定 587c466f7e28e4cb59b0c4522857a7110e7b152a、原标题和 implemented，直接父 8117aaa 留待后续记录。',
    'INDEX 在 beee034 后、self 前插入 587c466；Implemented 40 到 41，Partial 1 与 Unimplemented 0 保持，JSON 登记同一对相对路径。',
  ],
  alternatives: ['只为 587c466 写一份简短 SPEC 会丢失初始迁移的 95 文件清单；把文档对象误设为 8117aaa 则会把 HEAD 排除代码与文档体系初始化混为一谈。'],
  security: ['本提交仅新增和登记文档；SPEC 所列 CI、脚本和配置是历史范围说明，并未在本提交再次修改或执行。'],
  acceptance: [
    'SPEC/PLAN frontmatter 的 fullSha、标题、日期与 587c466 一致，状态均为 implemented。',
    'SPEC 的 95 文件统计及清单与 587c466 diff 对应，INDEX/JSON 的链接字段指向两个新文件。',
  ],
  evidence: [
    {
      kind: 'diff-observed',
      statement: '新 SPEC 记录 95 files changed、6620 insertions，并包含初始化文档体系的脚本和 CI 路径。',
      source: { path: 'docs/specs/587c466-SPEC.md', role: 'evidence', revision: 'commit', symbol: '- Diff statistics: 95 files changed, 6620 insertions(+)', note: '大规格 SPEC 保存完整历史路径清单。' },
    },
    {
      kind: 'diff-observed',
      statement: '新 PLAN 使用 587c466 身份并包含实现步骤小节。',
      source: { path: 'docs/plans/587c466-PLAN.md', role: 'evidence', revision: 'commit', symbol: 'commit: 587c466f7e28e4cb59b0c4522857a7110e7b152a', note: 'PLAN 与 SPEC 绑定同一历史提交。' },
    },
    {
      kind: 'diff-observed',
      statement: 'INDEX 的 Implemented 从 40 增至 41，并加入 587c466 文档入口。',
      source: { path: 'docs/INDEX.md', role: 'evidence', revision: 'commit', symbol: '- Implemented: 41', note: '其他两个状态计数未变化。' },
    },
    {
      kind: 'diff-observed',
      statement: 'status JSON 在 self 前加入 587c466 完整身份和两个新文档路径。',
      source: { path: 'docs/status/index.json', role: 'evidence', revision: 'commit', symbol: '"fullSha": "587c466f7e28e4cb59b0c4522857a7110e7b152a"', note: '机器注册与人类索引一致。' },
    },
    { kind: 'not-recorded', statement: 'SPEC/PLAN 只列验证序列，未附 bun test、typecheck、build 或 CI 的执行输出。' },
  ],
  remaining: ['8117aaa 的文档在本提交仍缺失；587c466 的生成 PLAN 仍是概括性计划，不能代替执行记录。'],
  references: [
    { path: 'docs/INDEX.md', role: 'changed', note: '加入 587c466 行并将 Implemented 调为 41。' },
    { path: 'docs/plans/587c466-PLAN.md', role: 'changed', note: '新建文档体系初始化提交的计划。' },
    { path: 'docs/specs/587c466-SPEC.md', role: 'changed', note: '新建含 95 文件完整清单的 SPEC。' },
    { path: 'docs/status/index.json', role: 'changed', note: '在 self 前注册 587c466 的状态和路径。' },
  ],
  plan: {
    preconditions: ['区分直接父 8117aaa 与实际文档对象 587c466，并读取后者完整的 95 文件 diff。'],
    reuse: ['沿用已有 frontmatter、INDEX 表格和 status JSON 结构，不改动 self 的字段。'],
    steps: [
      { title: '保存初始化 SPEC', detail: '写入 587c466 身份、95 文件统计和逐路径清单，覆盖脚本、CI 与历史文档。', paths: ['docs/specs/587c466-SPEC.md'] },
      { title: '保存初始化 PLAN', detail: '以同一 frontmatter 新建计划，保留目标、步骤、风险、验证和完成小节。', paths: ['docs/plans/587c466-PLAN.md'] },
      { title: '增加人类索引', detail: '在 beee034 与 self 之间登记 587c466，只递增 Implemented。', paths: ['docs/INDEX.md'] },
      { title: '增加机器索引', detail: '在 self 前写入完整 SHA、原日期、implemented 和两个新路径。', paths: ['docs/status/index.json'] },
    ],
    compatibility: ['既有 beee034 及更早条目不重排，self 仍收尾；新增链接使用既有相对路径约定。'],
    risks: ['长清单容易被缩成普通四文件描述，或直接父与祖父身份错位；两种错误都会破坏历史可追溯性。'],
    verification: ['核对 SPEC 清单与 587c466 diff，解析 JSON 并检查 INDEX 计数和链接；验证散文不作为执行证据。'],
    completed: ['587c466 的大范围 SPEC、对应 PLAN 及两个索引项已完整落盘。'],
    incomplete: ['本提交没有记录文档生成、测试或 CI 的实际运行轨迹。'],
  },
})
