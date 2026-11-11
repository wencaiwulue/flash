import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: '17c91967ada4424f164da8e2699e3ee90d587036',
  slug: 'commit-docs-finalization',
  title: 'Finalize self record for previous commit',
  kind: 'metadata-migration',
  status: 'implemented',
  beforeState: '直接父提交 c4e19cee451ce0a5a43e78475d40f2e079b350df 已为 587c466 建立 95 文件清单文档，INDEX 为 Implemented 41、Partial 1、Unimplemented 0；祖父提交 8117aaa81ba58bb7ddae1256712797880a6cdebd 的 HEAD 排除代码尚无对应 SPEC/PLAN。',
  problem: '本提交要把 8117aaa 的单行生成器变更记录为文档并注册，而不是继续描述直接父 c4e19ce；其范围只有 scripts/document-commits.ts 的 1 行新增和 1 行删除。',
  goals: [
    '新建 8117aaa SPEC/PLAN，frontmatter 绑定其完整 SHA，Actual scope 只列生成器脚本。',
    '在 INDEX 与 status JSON 中加入 8117aaa，将 Implemented 从 41 更新为 42。',
  ],
  nonGoals: [
    '不修改 HEAD 排除实现，也不为直接父 c4e19ce 或当前 17c9196 建文档。',
    '不把 SPEC/PLAN 的测试、typecheck、build 和 CI 文字视为实际运行记录。',
  ],
  architecture: [
    '被记录的生成器按 git log --reverse 得到正序历史，commits().slice(0, -1) 总是排除当时最新 HEAD；在 c4e19ce 为 HEAD 的位置会纳入 8117aaa，但并非永久排除固定 c4e19ce。',
    '当前提交的四个路径则是纯元数据：8117aaa 的 SPEC 与 PLAN，加上 587c466 后、self 前的 INDEX 行和 JSON 对象；没有生成器源码变化。',
  ],
  decisions: [
    'SPEC 保存 1 file changed、1 insertion、1 deletion，脚本路径唯一；不能用 c4e19ce 的 169 行新增或 587c466 的 95 文件统计替代。',
    '两个索引仅登记 8117aaa，三类计数成为 42/1/0；self 仍最后，既有 587c466 条目不重复插入。',
  ],
  alternatives: ['把 HEAD 排除写成固定过滤某个 SHA 会误解动态数组边界；把本提交对象设为直接父 c4e19ce 又会重复父提交已经完成的文档工作。'],
  security: ['本提交不改可执行逻辑，只说明已有的历史遍历边界并添加元数据；没有权限、凭据或网络行为变化。'],
  acceptance: [
    '8117aaa SPEC/PLAN 的身份、日期和 implemented 状态一致，SPEC 只列 scripts/document-commits.ts。',
    'INDEX 与 JSON 均新增 8117aaa，spec/plan 字段指向实际新文件，计数为 42/1/0。',
  ],  remaining: ['直接父 c4e19ce 的文档留待后续提交；新 PLAN 仍使用概括性模板，未记录 HEAD 排除行为的实测输出。'],
  references: [
    { path: 'docs/INDEX.md', role: 'changed', note: 'Implemented 41 到 42，加入 8117aaa。' },
    { path: 'docs/plans/8117aaa-PLAN.md', role: 'changed', note: '新建 HEAD 排除提交的计划文档。' },
    { path: 'docs/specs/8117aaa-SPEC.md', role: 'changed', note: '记录 8117aaa 单文件单行生成器变更。' },
    { path: 'docs/status/index.json', role: 'changed', note: '新增 8117aaa 的机器可读条目。' },
  ],
  plan: {
    preconditions: ['确认直接父 c4e19ce 已完成 587c466 文档，并读取 8117aaa 的唯一脚本 diff 与动态 HEAD 位置。'],
    reuse: ['沿用 8117aaa 引入的 HEAD 排除生成规则及既有文档/索引格式，self 保持独立。'],
    steps: [
      { title: '记录 HEAD 排除 SPEC', detail: '以 8117aaa 身份新建 SPEC，只列生成器和 1/1 diff 统计。', paths: ['docs/specs/8117aaa-SPEC.md'] },
      { title: '记录 HEAD 排除 PLAN', detail: '新增同身份 PLAN，不将模板步骤改写为已发生验证。', paths: ['docs/plans/8117aaa-PLAN.md'] },
      { title: '注册表格入口', detail: '在 587c466 后、self 前添加 8117aaa，Implemented 增至 42。', paths: ['docs/INDEX.md'] },
      { title: '注册机器入口', detail: '在 self 前保存相同 fullSha、状态和 SPEC/PLAN 路径。', paths: ['docs/status/index.json'] },
    ],
    compatibility: ['HEAD 排除代码保持原样，已有历史顺序与 self 身份不变；新增内容只有文档元数据。'],
    risks: ['动态 HEAD 容易被写成固定提交过滤，且祖父文档对象容易被误替换为直接父。'],
    acceptanceSequence: ['核对 8117aaa 源码与 SPEC 的单文件统计，并检查两个索引的新行、完整 SHA 和链接。'],
    completed: ['8117aaa 的文档对及双重索引注册已落盘，本提交没有额外代码差异。'],
    incomplete: ['没有保存生成器、测试、构建或 CI 的运行结果。'],
  },
})
