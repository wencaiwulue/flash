import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: '0dabf466a5db43caa9890f5e0a031d00505a0008',
  slug: 'commit-docs-finalization',
  title: 'Complete previous commit documentation',
  kind: 'metadata-migration',
  status: 'implemented',
  beforeState: '直接父 2a4aa6c36263b3b17c6c5f188b03cc9a6a7e3cff 已登记 1329f79，INDEX 为 63/1/0，JSON 含 self 共 65 项。当前实际补档对象是祖父 be5c03e17428c3a7f85f7c0459b49432e61ccbf4，父树尚无其文档。',
  problem: '需要为 be5c03e 补身份与发现入口，并把它的范围追溯到 1bc02bf 文档对；不能因为直接父是 2a4aa6c 就复用其 1329f79 文档范围。',
  goals: [
    '新建 be5c03e SPEC/PLAN，写入 Complete previous commit documentation、2026-11-11T11:09:24+08:00、完整 SHA 和 implemented。',
    '保存 1bc02bf 文档对、两个索引及 78 行新增、1 行删除范围，并只增加 be5c03e 的一组索引项。',
  ],
  nonGoals: [
    '不处理直接父 2a4aa6c 或当前 0dabf46 的文档，不重复登记 1329f79。',
    '不调整生成器，不把计划中的验证命令、宽泛完成文字或 CI 名称视为实际结果。',
  ],
  architecture: [
    'be5c03e SPEC/PLAN 是历史内容层，INDEX 表格和 commits 数组是注册层；四者之外没有代码变化。',
    '新项接在 1329f79 后，self 继续位于末尾且字段不变；当前 0dabf46 不获得自我 SHA 条目。',
  ],
  decisions: [
    'SPEC 选择 1bc02bf-SPEC/PLAN 作为目标范围，统计为四文件 78/1，与 be5c03e 原 diff 对应。',
    '为 be5c03e 新增一行后，INDEX 三项依次为 64、1、0；机器数组由 65 扩至 66，其中 implemented 含 self 从 64 变为 65。',
    'be5c03e 是第 65 个 JSON 对象，self 移至第 66 项；新增历史对象和 Markdown 路径一一对应。',
  ],
  alternatives: ['若补 2a4aa6c 会漏掉 be5c03e 并错用 1329f79 范围；若只加 be5c03e 索引而不建两个文件，则会制造新的断链。'],
  security: ['仅提交元数据和文档链接落盘，无执行权限、敏感值、外部协议或产品安全行为变化。'],
  acceptance: [
    '两份 frontmatter 完整匹配 be5c03e，Actual scope 的 1bc02bf 路径和统计与原 diff 一致。',
    'INDEX 与 JSON 各增加一个 be5c03e implemented 项，1329f79 保持前一项，self 最后。',
  ],  remaining: ['2a4aa6c 与 0dabf46 在此版本仍未建档；be5c03e 的模板计划也未留下实际验证轨迹。'],
  references: [
    { path: 'docs/INDEX.md', role: 'changed', note: 'Implemented 63→64，新增 be5c03e 行。' },
    { path: 'docs/plans/be5c03e-PLAN.md', role: 'changed', note: 'be5c03e 的新建计划。' },
    { path: 'docs/specs/be5c03e-SPEC.md', role: 'changed', note: '记录 be5c03e 及 1bc02bf 范围。' },
    { path: 'docs/status/index.json', role: 'changed', note: 'JSON 65→66，self 前插入 be5c03e。' },
  ],
  plan: {
    preconditions: ['识别祖父 be5c03e 为文档目标，核对其 1bc02bf 产物和四文件统计。'],
    reuse: ['沿用 1329f79 后的顺序、JSON 七字段、self 占位及现有生成文档模板。'],
    steps: [
      { title: '编写 be5c03e SPEC', detail: '记录完整目标身份和 1bc02bf 文档组及 78/1 行统计。', paths: ['docs/specs/be5c03e-SPEC.md'] },
      { title: '编写 be5c03e PLAN', detail: '使用同一标题、时间和状态保存计划模板各小节。', paths: ['docs/plans/be5c03e-PLAN.md'] },
      { title: '更新 INDEX', detail: '在 1329f79 后追加 be5c03e，仅将 Implemented 增至 64。', paths: ['docs/INDEX.md'] },
      { title: '更新 JSON', detail: '将 be5c03e 写为第 65 项，保持 self 为第 66 项。', paths: ['docs/status/index.json'] },
    ],
    compatibility: ['1329f79 及既有 self 内容不改，新增项沿用原字段和链接格式，生成器无差异。'],
    risks: ['本提交与目标标题相同，容易只看标题而忽略 SHA，进而把 1bc02bf 范围写到错误的文档身份下。'],
    acceptanceSequence: ['按 fullSha 核对 be5c03e 原 diff 和 frontmatter，并检查索引只增加该项且 self 未变。'],
    completed: ['be5c03e 的文档对、INDEX 行和 JSON 对象已完整加入。'],
    incomplete: ['未保存任何命令或 CI 执行证据，本记录只确认元数据闭合。'],
  },
})
