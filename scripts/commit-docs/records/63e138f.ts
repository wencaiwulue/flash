import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: '63e138f4eb8ea207a1aeb0806e060275ac55b4a3',
  title: 'Finalize previous commit self documentation',
  kind: 'metadata-migration',
  status: 'implemented',
  beforeState: '直接父提交 fe3c177c28b7581e93f7496c58b98bafa10dbb03 已为 f210ce9 建文档，INDEX 为 Implemented 45、Partial 1、Unimplemented 0；祖父提交 7740a1d28b70629f41d49116a8e6007eb46c72aa 尚无自己的文档和注册。',
  problem: '本次应为 7740a1d 建立四个元数据产物层面的闭合，SPEC 内部要描述它为 17c9196 新建文档；不能因统计同为 78/1 就与 fe3c177 的 f210ce9 记录混用。',
  goals: [
    '新建 7740a1d SPEC/PLAN，保存其 INDEX、status JSON 和 17c9196 文档对的四文件范围。',
    '将 7740a1d 插入两个索引的 self 前，Implemented 从 45 增至 46。',
  ],
  nonGoals: [
    '本提交不处理直接父 fe3c177，也不为 63e138f 自身创建文档。',
    '不修改生成器、checker、CI 或产品代码，不把计划中的命令当作执行日志。',
  ],
  architecture: [
    '新 SPEC 把 7740a1d 的 78 行新增拆成 17c9196 的 36 行 SPEC、31 行 PLAN，以及 INDEX/JSON 更新；被描述的 17c9196 自身则是 75 行新增，两个统计层级不可混淆。',
    'PLAN 与 SPEC 绑定 7740a1d 完整 SHA，INDEX 新行在 f210ce9 后，JSON 同步保存原日期、implemented 和同一对路径。',
  ],
  decisions: [
    'Actual scope 采用 7740a1d 的 4 files、78 insertions、1 deletion，并明确列出 17c9196-SPEC/PLAN。',
    '只新增一个索引对象，状态计数变为 46/1/0；fe3c177 和 63e138f 均不在此 diff 中注册。',
  ],
  alternatives: ['复制 fe3c177 的记录再替换 SHA 会留下 c4e19ce 路径错误；采用 17c9196 的 75 行统计又会把祖父范围误当成 7740a1d 自身范围。'],
  security: ['四个路径全是文档元数据，没有新增可执行逻辑、秘密或访问控制变化。'],
  acceptance: [
    'SPEC/PLAN frontmatter 均为 7740a1d 的完整 SHA、标题、日期和 implemented。',
    'SPEC 文件列表指向 17c9196 文档对，INDEX 与 JSON 的新增项均指向本次两个新文件。',
  ],
  evidence: [
    {
      kind: 'diff-observed',
      statement: '7740a1d SPEC 记录 78 insertions、1 deletion，并列出 17c9196 的 SPEC 路径。',
      source: { path: 'docs/specs/7740a1d-SPEC.md', role: 'evidence', revision: 'commit', symbol: 'docs/specs/17c9196-SPEC.md', note: '内部路径区分本记录与 fe3c177 的 c4e19ce 范围。' },
    },
    {
      kind: 'diff-observed',
      statement: '7740a1d PLAN 新建，包含生成计划的实现步骤小节。',
      source: { path: 'docs/plans/7740a1d-PLAN.md', role: 'evidence', revision: 'commit', symbol: '## Implementation steps', note: '计划文件与 7740a1d SPEC 同时新增。' },
    },
    {
      kind: 'diff-observed',
      statement: 'INDEX 只把 Implemented 增至 46，并添加 7740a1d 行。',
      source: { path: 'docs/INDEX.md', role: 'evidence', revision: 'commit', symbol: '- Implemented: 46', note: 'Partial 1 和 Unimplemented 0 不变。' },
    },
    {
      kind: 'diff-observed',
      statement: '机器索引在 self 前登记 7740a1d 完整 SHA 与文档路径。',
      source: { path: 'docs/status/index.json', role: 'evidence', revision: 'commit', symbol: '"fullSha": "7740a1d28b70629f41d49116a8e6007eb46c72aa"', note: '没有同时登记 fe3c177 或 63e138f。' },
    },
    { kind: 'not-recorded', statement: 'SPEC/PLAN 的验证文字没有对应命令输出、测试附件或 CI 结果。' },
  ],
  remaining: ['直接父 fe3c177 的文档和索引尚不闭合，当前 63e138f 自身也未在本提交登记。'],
  references: [
    { path: 'docs/INDEX.md', role: 'changed', note: 'Implemented 45 到 46，新增 7740a1d。' },
    { path: 'docs/plans/7740a1d-PLAN.md', role: 'changed', note: '新建 7740a1d 的 PLAN。' },
    { path: 'docs/specs/7740a1d-SPEC.md', role: 'changed', note: '记录 7740a1d 为 17c9196 补文档的四文件范围。' },
    { path: 'docs/status/index.json', role: 'changed', note: '新增 7740a1d 的机器索引对象。' },
  ],
  plan: {
    preconditions: ['确认父版本摘要为 45/1/0，并分别读取 7740a1d 的 78/1 diff 与其文档对象 17c9196。'],
    reuse: ['沿用已有 SPEC/PLAN 生成结构、INDEX 列和 status 对象，不改变 f210ce9 或 self 条目。'],
    steps: [
      { title: '编写 7740a1d SPEC', detail: '保存 78/1 统计及 17c9196 SPEC/PLAN、INDEX、JSON 四个路径。', paths: ['docs/specs/7740a1d-SPEC.md'] },
      { title: '编写 7740a1d PLAN', detail: '使用同一提交身份新增计划，保留验证仅为待执行说明的边界。', paths: ['docs/plans/7740a1d-PLAN.md'] },
      { title: '同步 INDEX', detail: '在 f210ce9 后加入 7740a1d，Implemented 单项递增到 46。', paths: ['docs/INDEX.md'] },
      { title: '同步 status JSON', detail: '在 self 前插入相同身份和文档路径，不登记其他提交。', paths: ['docs/status/index.json'] },
    ],
    compatibility: ['已有 f210ce9 及其之前条目不重排，新链接和 JSON 路径格式与相邻记录一致。'],
    risks: ['连续的 78/1 统计无法单独识别提交，必须核对 17c9196 路径与 7740a1d fullSha。'],
    verification: ['对比 7740a1d diff 与 SPEC 清单，检查 PLAN frontmatter，并核对两个索引仅有一个新增对象。'],
    completed: ['7740a1d 的 SPEC、PLAN、INDEX 行和 JSON 对象已同时落盘。'],
    incomplete: ['本提交没有可追溯的测试、构建或 CI 执行记录。'],
  },
})
