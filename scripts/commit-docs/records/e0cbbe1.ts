import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: 'e0cbbe14182f93a59bd7e28a4dcd0776e05831f0',
  title: 'Finalize documentation for previous commit',
  kind: 'metadata-migration',
  status: 'implemented',
  beforeState: '父版本 a4edc60 已让 dc3f075 进入索引，Implemented 为 75；被补档的祖父提交 1fe1430 自身尚无 SPEC/PLAN 和 status 对象，self 仍保留原有 bootstrap 身份。',
  problem: '本提交需登记 1fe1430，而且其标题是 Finalize previous commit documentation，并非本提交的 Finalize documentation for previous commit。新 SPEC 的内层对象应是 c771f05，不能误用 dc3f075 的 5c5bc03。',
  goals: [
    '创建 1fe1430-SPEC.md 与 1fe1430-PLAN.md，frontmatter 使用 1fe14300c3b0a9eced6c5c3b3bf4615c7ca43361 及其自身标题。',
    '同步 INDEX/status，将 implemented 计数从 75 增到 76，并让 self 保持在所有历史项之后。',
  ],
  nonGoals: [
    '不改变 a4edc60 或更早文档的标题与范围，也不实现产品源码功能。',
    '不宣称文档列出的本地命令和 CI 检查有任何实际通过结果。',
  ],
  architecture: [
    'e0cbbe1 的当前标题与目标 1fe1430 的标题存在措辞差异，frontmatter 必须跟随目标；路径命名和索引身份则都使用 1fe1430。',
    '新 SPEC 表示 1fe1430 曾为 c771f05 建立双文档；当前提交另外建立 1fe1430 双文档，并只通过 INDEX/status 暴露这些新产物。',
  ],
  decisions: [
    'SPEC 采用 1fe1430 的 2026-11-11T11:16:02+08:00 时间和 Finalize previous commit documentation 标题，Actual scope 固定为 c771f05 四路径范围。',
    'INDEX 和 JSON 在 self 前新增一个对象，汇总达到 76/1/0；本提交自身的 Finalize documentation 标题不会覆盖目标文档标题。',
  ],
  alternatives: ['若直接拿当前提交标题填充 frontmatter，会与 1fe1430 metadata 不符；若复用上一规格的 5c5bc03 清单，则历史范围也错误，故需分别核对标题和 diff。'],
  security: ['四个变更路径均无可执行或认证逻辑，没有秘密泄漏和权限扩张；安全文字仅是文档内容。'],
  acceptance: [
    '两个 frontmatter 的 1fe1430 全 SHA、日期和 Finalize previous commit documentation 标题与目标提交完全一致。',
    '内层路径为 c771f05-SPEC/PLAN，INDEX 为 76/1/0，status 注册正确，self 未移动或改写。',
  ],
  evidence: [
    {
      kind: 'diff-observed',
      statement: '新 SPEC 使用 1fe1430 的提交身份和标题，范围清单明确出现 c771f05 的 PLAN。',
      source: { path: 'docs/specs/1fe1430-SPEC.md', role: 'evidence', revision: 'e0cbbe14182f93a59bd7e28a4dcd0776e05831f0', symbol: '# Finalize previous commit documentation', note: '标题证据区分当前提交与目标提交的措辞。' },
    },
    {
      kind: 'diff-observed',
      statement: '1fe1430-PLAN 的 frontmatter 同样锁定目标 full SHA，而非 e0cbbe1 自身 SHA。',
      source: { path: 'docs/plans/1fe1430-PLAN.md', role: 'evidence', revision: 'e0cbbe14182f93a59bd7e28a4dcd0776e05831f0', symbol: 'commit: 1fe14300c3b0a9eced6c5c3b3bf4615c7ca43361', note: '新计划属于被补档的祖父提交 1fe1430。' },
    },
    {
      kind: 'diff-observed',
      statement: 'INDEX patch 把 Implemented 改为 76，新增行标题也使用 1fe1430 的 Finalize previous 形式。',
      source: { path: 'docs/INDEX.md', role: 'evidence', revision: 'e0cbbe14182f93a59bd7e28a4dcd0776e05831f0', symbol: '| 1fe1430 | Finalize previous commit documentation | implemented |', note: '表格同时证明目标标题与链接。' },
    },
    {
      kind: 'diff-observed',
      statement: 'status patch 新增 1fe1430 完整对象并指向两个新文档，self 对象保持其后。',
      source: { path: 'docs/status/index.json', role: 'evidence', revision: 'e0cbbe14182f93a59bd7e28a4dcd0776e05831f0', symbol: '"fullSha": "1fe14300c3b0a9eced6c5c3b3bf4615c7ca43361"', note: 'at-commit 机器状态证据。' },
    },
    { kind: 'not-recorded', statement: '提交不含 bun 命令执行输出或 CI 回报，SPEC/PLAN 中的验证文字没有证明力。' },
  ],
  remaining: ['目标文档依旧只提供概括性步骤；本记录额外确认标题差异和嵌套范围，但不虚构测试或设计讨论。'],
  references: [
    { path: 'docs/INDEX.md', role: 'changed', note: '加入 1fe1430 的准确标题行，Implemented 达 76。' },
    { path: 'docs/plans/1fe1430-PLAN.md', role: 'changed', note: '新建 1fe1430 计划，标题不同于当前提交。' },
    { path: 'docs/specs/1fe1430-SPEC.md', role: 'changed', note: '新建规格并记录 c771f05 内层范围。' },
    { path: 'docs/status/index.json', role: 'changed', note: '在 self 前注册 1fe1430 完整状态。' },
  ],
  plan: {
    preconditions: ['确认 a4edc60 基线为 75，分别读取 e0cbbe1 与 1fe1430 的标题，并核对目标提交的 c771f05 范围。'],
    reuse: ['复用双 Markdown 与双索引格式，目标 frontmatter 采用 1fe1430 自身标题而不是当前提交标题。'],
    steps: [
      { title: '编写 1fe1430 规格', detail: '保留目标 Finalize previous 标题，同时把 c771f05 两个文档列入其历史范围。', paths: ['docs/specs/1fe1430-SPEC.md'] },
      { title: '编写 1fe1430 计划', detail: '用同一 frontmatter 和标题创建 PLAN，避免误用 e0cbbe1 的 Finalize documentation 措辞。', paths: ['docs/plans/1fe1430-PLAN.md'] },
      { title: '更新 76 项人工索引', detail: '将 1fe1430 行追加到 dc3f075 之后，链接两个新文件并调整 implemented 汇总。', paths: ['docs/INDEX.md'] },
      { title: '更新 1fe1430 机器状态', detail: '在 self 前插入目标 full SHA、准确标题、日期以及 spec/plan 文件字段。', paths: ['docs/status/index.json'] },
    ],
    compatibility: ['保留旧条目和 self 顺序，当前提交标题只用于 Git subject，不覆盖目标文档的元数据。'],
    risks: ['Finalize previous 与 Finalize documentation 两种近似标题最容易混写；内层 c771f05 与相邻 5c5bc03 也需分别核验。'],
    verification: ['检查 e0cbbe1 版本中两个 frontmatter、1fe1430 表格标题、c771f05 清单、76/1/0 和 self 末位。'],
    completed: ['1fe1430 的文档及索引入口均按目标自身标题创建，四路径无遗漏。'],
    incomplete: ['没有可复核的运行日志或 CI 状态，元数据之外的验证仍无记录。'],
  },
})
