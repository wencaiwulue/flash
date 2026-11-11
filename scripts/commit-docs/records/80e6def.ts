import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: '80e6defe99a3ce09a3d2b4229458fed0fbde5dbc',
  title: 'Finalize self record to previous SHA on next commit',
  kind: 'metadata-migration',
  status: 'implemented',
  beforeState: '父提交 63e138f4eb8ea207a1aeb0806e060275ac55b4a3 留下 Implemented 46、Partial 1、Unimplemented 0，索引止于 7740a1d 和 self。生成器已经排除 HEAD，但尚无 previousHead 分支，fe3c177 与 63e138f 的 SPEC/PLAN 均未落盘。',
  problem: '需要登记尚未建文件的 fe3c177，并让生成器额外输出 previous HEAD 的 SPEC/PLAN；文档文件生成与索引注册在此 diff 中并不同步。',
  goals: [
    '在 INDEX 和 status/index.json 的 self 前注册 fe3c177 及其两个预期文档路径。',
    '为 commits().at(-2) 增加 SPEC/PLAN 输出，同时保留 HEAD 排除主循环。',
  ],
  nonGoals: [
    '本提交不直接新增 fe3c177、63e138f 或 80e6def 的 Markdown 文档。',
    '不把 previousHead 代码能力写成已生成文件，也不补测试或记录 CI 结果。',
  ],
  architecture: [
    '主循环仍以 commits().slice(0, -1) 生成历史文档、索引和计数；新增 previousHead 逻辑位于该循环之后，只向 documents Map 写入两个路径。',
    'previousHead 分支调用 specFor/planFor，但不追加 indexRows、jsonCommits 或 counts；fe3c177 的两个索引项则在本提交实际落盘，63e138f 的文件并未随代码一并出现。',
  ],
  decisions: [
    'previousHead 明确定义为正序提交数组的倒数第二项；按本提交历史位置它对应 63e138f，而不是当前 HEAD 80e6def。',
    'INDEX 仅新增 fe3c177 行，Implemented 46 增至 47；Partial 1、Unimplemented 0 不变，机器索引使用同一 fullSha 和 spec/plan 路径。',
  ],
  alternatives: ['把 previousHead 也塞回主循环会混淆“排除 HEAD”和“补前一 HEAD”两种边界；本实现采用独立 Map 写入，但也留下索引与文件可分离的状态。'],
  security: ['变更只处理 Git 提交元数据与文档 Map，不增加外部输入、凭据处理或执行权限。'],
  acceptance: [
    'at(-2) 仅在存在 previousHead 时设置 SPEC/PLAN，空历史不会访问不存在的对象。',
    'fe3c177 的 INDEX 行与 JSON 对象位于 self 前，状态为 implemented，链接字段彼此一致。',
    'previousHead 分支不改变状态计数，且本提交实际变更路径仅为两个索引和生成器。',
  ],
  evidence: [
    {
      kind: 'diff-observed',
      statement: '生成器在 HEAD 排除循环之后选择倒数第二个提交，并仅设置该提交的 SPEC 与 PLAN。',
      source: { path: 'scripts/document-commits.ts', role: 'evidence', revision: 'commit', symbol: 'const previousHead = commits().at(-2)', note: 'previous HEAD 的精确数组定义。' },
    },
    {
      kind: 'diff-observed',
      statement: 'INDEX 摘要增至 47，并添加 fe3c177 的 SPEC/PLAN 链接；其他状态计数不变。',
      source: { path: 'docs/INDEX.md', role: 'evidence', revision: 'commit', symbol: '| fe3c177 | Complete self documentation for previous commit | implemented |', note: '新增人类索引行位于 self 前。' },
    },
    {
      kind: 'diff-observed',
      statement: '机器索引登记完整 fe3c177 身份与两个预期文档路径，但 diff 没有对应 Markdown 新文件。',
      source: { path: 'docs/status/index.json', role: 'evidence', revision: 'commit', symbol: '"fullSha": "fe3c177c28b7581e93f7496c58b98bafa10dbb03"', note: '新增 JSON 对象与 INDEX 使用同一路径。' },
    },
    { kind: 'not-recorded', statement: '没有 previousHead 生成命令、测试或 CI 的输出；代码存在不等于目标文件已在本提交生成。' },
  ],
  remaining: ['fe3c177 的索引已先于文件出现，63e138f 的文档和索引仍待后续补齐；80e6def 自身也未在此提交建文档。'],
  references: [
    { path: 'docs/INDEX.md', role: 'changed', note: 'Implemented 从 46 调到 47，并在 self 前加入 fe3c177。' },
    { path: 'docs/status/index.json', role: 'changed', note: '在 self 前新增 fe3c177 的机器可读条目。' },
    { path: 'scripts/document-commits.ts', role: 'changed', note: '新增 at(-2) previousHead 的 SPEC/PLAN Map 输出。' },
  ],
  plan: {
    preconditions: ['核对父版本索引尚无 fe3c177，确认正序 commits 数组中 HEAD 与 previous HEAD 的位置。'],
    reuse: ['复用 specFor、planFor 和 documents Map；索引条目沿用现有 fullSha、status、spec、plan 字段。'],
    steps: [
      { title: '输出前一 HEAD 文档', detail: '在主循环后读取 at(-2)，存在时只生成该提交的 SPEC 和 PLAN 内容。', paths: ['scripts/document-commits.ts'] },
      { title: '登记 fe3c177 人类入口', detail: '在 self 前增加文档链接行，并只递增 Implemented 计数。', paths: ['docs/INDEX.md'] },
      { title: '登记 fe3c177 机器入口', detail: '写入完整身份、implemented 状态及同一对 SPEC/PLAN 路径。', paths: ['docs/status/index.json'] },
    ],
    compatibility: ['既有 HEAD 排除与 self 末尾位置不变；新增 previousHead 写操作不声明新的索引字段。'],
    risks: ['previousHead 文件输出没有同步索引副作用，而 fe3c177 索引又先于 Markdown 落盘，短暂断链必须如实保留。'],
    verification: ['逐项比较代码分支和实际 diff，并核对两个索引中的 fe3c177；不能由源码推导执行成功。'],
    completed: ['previousHead 代码与 fe3c177 双重索引登记已进入版本树，三项变更均可直接观察。'],
    incomplete: ['本提交未落盘任何新增历史 SPEC/PLAN，也没有生成器运行日志或自动化验证记录。'],
  },
})
