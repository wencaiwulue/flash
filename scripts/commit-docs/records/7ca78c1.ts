import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: '7ca78c1a18a7f05e1740f701b256079bb4cc2c2e',
  title: 'Complete all commit documentation records',
  kind: 'metadata-migration',
  status: 'implemented',
  beforeState: '直接父提交 80e6defe99a3ce09a3d2b4229458fed0fbde5dbc 的 INDEX 已有 fe3c177，Implemented 为 47，但 fe3c177 的 SPEC/PLAN 尚不存在；63e138f 则连文档和两个索引条目都缺失。',
  problem: '同一次提交要处理两种历史欠账：为已登记的 fe3c177 补上断链目标，为未登记的 63e138f 同时建立文档与索引，不能把两个文档对误算成两个新增索引状态。',
  goals: [
    '新建 fe3c177 与 63e138f 两对 SPEC/PLAN，各自 frontmatter 绑定完整历史 SHA。',
    '只补 63e138f 的 INDEX/status 条目，复用 80e6def 已有的 fe3c177 注册。',
  ],
  nonGoals: [
    '不修改 scripts/document-commits.ts、checker、测试或 CI 配置。',
    '不把生成 PLAN 中的验证命令和完成声明当作实际执行证据，也不补写 80e6def 的文档。',
  ],
  architecture: [
    '六个变更路径分为两层：四个新 Markdown 文件分别描述 fe3c177 和 63e138f；INDEX 与 status JSON 只新增 63e138f，因为 fe3c177 的注册已在父版本存在。',
    '两份 SPEC 都记录各自历史提交的四文件、78 行新增和 1 行删除范围：fe3c177 指向 f210ce9 文档对，63e138f 指向 7740a1d 文档对。两份 PLAN 保留生成模板的目标、步骤、风险、验证和完成小节。',
  ],
  decisions: [
    'fe3c177 只补文件、不重复插入索引；63e138f 的两个新条目放在 self 前，Implemented 从 47 到 48，Partial 1 与 Unimplemented 0 不动。',
    '历史对象不按直接父提交收缩：本提交直接父是 80e6def，但实际落盘对象是更早的 fe3c177 和 63e138f，记录必须保持这三层身份清晰。',
  ],
  alternatives: ['若机械地为每个新 SPEC/PLAN 都新增索引，会重复登记 fe3c177 并把计数写成 49；若只处理直接父提交，又会漏掉本 diff 实际补齐的两对历史文件。'],
  security: ['全部变更都是文档与提交元数据，没有可执行产品逻辑、凭据或权限边界调整。'],
  acceptance: [
    '四个新文件分别以 fe3c177、63e138f 的 fullSha、标题、日期和 implemented 状态作为 frontmatter。',
    '两份 Actual scope 的路径分别指向 f210ce9 与 7740a1d 的文档对，不能互换。',
    'INDEX/JSON 只新增 63e138f，fe3c177 的既有注册现在能对应实际新文件，self 仍在末尾。',
  ],
  evidence: [
    {
      kind: 'diff-observed',
      statement: 'fe3c177 SPEC 新建并记录其四文件范围，其中包括 f210ce9 的 SPEC 和 PLAN。',
      source: { path: 'docs/specs/fe3c177-SPEC.md', role: 'evidence', revision: 'commit', symbol: 'docs/specs/f210ce9-SPEC.md', note: '该文件补足已有索引所指向的 SPEC。' },
    },
    {
      kind: 'diff-observed',
      statement: '63e138f SPEC 新建并记录其四文件范围，其中包括 7740a1d 的 SPEC 和 PLAN。',
      source: { path: 'docs/specs/63e138f-SPEC.md', role: 'evidence', revision: 'commit', symbol: 'docs/specs/7740a1d-SPEC.md', note: '该 SPEC 与同一提交新增 PLAN 配对。' },
    },
    {
      kind: 'diff-observed',
      statement: '两个 PLAN 均含实现步骤小节，但其命令列表只是文档内容。',
      source: { path: 'docs/plans/fe3c177-PLAN.md', role: 'evidence', revision: 'commit', symbol: '## Implementation steps', note: 'fe3c177 的计划文件在本提交新建。' },
    },
    {
      kind: 'diff-observed',
      statement: '63e138f PLAN 使用自身完整 SHA 和 implemented frontmatter。',
      source: { path: 'docs/plans/63e138f-PLAN.md', role: 'evidence', revision: 'commit', symbol: 'commit: 63e138f4eb8ea207a1aeb0806e060275ac55b4a3', note: '计划身份没有误写成直接父 80e6def。' },
    },
    {
      kind: 'diff-observed',
      statement: '父版本机器索引已含 fe3c177，说明本提交无需再次注册该历史提交。',
      source: { path: 'docs/status/index.json', role: 'evidence', revision: 'parent', symbol: '"fullSha": "fe3c177c28b7581e93f7496c58b98bafa10dbb03"', note: '既有注册解释了六文件 diff 只有 63e138f 索引增量。' },
    },
    {
      kind: 'diff-observed',
      statement: '当前 INDEX 为 Implemented 48，并只增加 63e138f 行。',
      source: { path: 'docs/INDEX.md', role: 'evidence', revision: 'commit', symbol: '- Implemented: 48', note: '两个文档对只带来一个新增索引计数。' },
    },
    { kind: 'not-recorded', statement: '两个 PLAN 的验证段落没有对应命令输出或 CI 结果，本记录只确认 diff 中的文档落盘与索引关系。' },
  ],
  remaining: ['生成的 PLAN 内容仍是通用模板，未保存实际验证轨迹；直接父 80e6def 的 SPEC/PLAN 留待下一提交。'],
  references: [
    { path: 'docs/INDEX.md', role: 'changed', note: '只为 63e138f 增加入口，Implemented 47 到 48。' },
    { path: 'docs/plans/63e138f-PLAN.md', role: 'changed', note: '新建 63e138f 的计划文档。' },
    { path: 'docs/plans/fe3c177-PLAN.md', role: 'changed', note: '补建已被索引引用的 fe3c177 计划。' },
    { path: 'docs/specs/63e138f-SPEC.md', role: 'changed', note: '记录 63e138f 为 7740a1d 补文档的四文件范围。' },
    { path: 'docs/specs/fe3c177-SPEC.md', role: 'changed', note: '记录 fe3c177 为 f210ce9 补文档的四文件范围。' },
    { path: 'docs/status/index.json', role: 'changed', note: '只新增 63e138f 的完整状态和文档路径。' },
  ],
  plan: {
    preconditions: ['分别检查 80e6def 父版本的文件树与两个索引，区分 fe3c177 的缺文件和 63e138f 的全缺状态。'],
    reuse: ['复用父版本已有的 fe3c177 索引注册，并沿用 SPEC/PLAN frontmatter 与生成文档小节。'],
    steps: [
      { title: '修复 fe3c177 文档断链', detail: '新增其 SPEC/PLAN，并在 SPEC 中保留 f210ce9 文档对的实际历史范围。', paths: ['docs/specs/fe3c177-SPEC.md', 'docs/plans/fe3c177-PLAN.md'] },
      { title: '建立 63e138f 文档对', detail: '新增绑定 63e138f 身份的 SPEC/PLAN，Actual scope 指向 7740a1d 文档对。', paths: ['docs/specs/63e138f-SPEC.md', 'docs/plans/63e138f-PLAN.md'] },
      { title: '单量更新人类索引', detail: '仅添加 63e138f 行，保留已有 fe3c177 行，Implemented 只加一。', paths: ['docs/INDEX.md'] },
      { title: '单量更新机器索引', detail: '在 self 前只插入 63e138f 对象，不重复写入 fe3c177。', paths: ['docs/status/index.json'] },
    ],
    compatibility: ['既有 fe3c177 链接文本与 JSON 路径不变，新文件使其变得可解析；其他历史条目顺序不受影响。'],
    risks: ['最大风险是把新文件数量等同于新增索引数量，或把两对文档错误归到直接父 80e6def。'],
    verification: ['逐个解析四份 frontmatter，对照两个历史提交的 diff 路径，并比较父/当前 INDEX 与 JSON 的新增项。'],
    completed: ['两对历史文档和 63e138f 的两个索引条目已按实际差异落盘，fe3c177 未重复注册。'],
    incomplete: ['没有可追溯的生成、测试、typecheck、build 或 CI 执行结果。'],
  },
})
