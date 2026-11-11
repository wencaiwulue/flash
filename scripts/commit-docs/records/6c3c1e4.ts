import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: '6c3c1e4d3cdd8b1b8279c023575fb7a37e94a14c',
  title: 'Finalize documentation for previous commit',
  kind: 'metadata-migration',
  status: 'implemented',
  beforeState: '直接父 612cc40e519f48121614051611d16b054823c24c 已补 2a4aa6c，INDEX 为 Implemented 65、Partial 1、Unimplemented 0，JSON 含 self 共 67 项。实际待补目标是祖父 0dabf466a5db43caa9890f5e0a031d00505a0008。',
  problem: '0dabf46 缺少自己的文档与入口，而其原始工作是为 be5c03e 建档；本提交若误选 612cc40，会把目标的 be5c03e 范围错写为 2a4aa6c。',
  goals: [
    '新建 0dabf46 SPEC/PLAN，准确保留 Complete previous commit documentation、2026-11-11T11:10:16+08:00 和 implemented。',
    '记录 be5c03e 文档对、两个索引及 78 行新增、1 行删除，并把 0dabf46 加入两个索引。',
  ],
  nonGoals: [
    '不补直接父 612cc40 或当前 6c3c1e4，不改动 2a4aa6c 的既有文档注册。',
    '不修改生成器，不把模板中的验证步骤或 CI 检查写成实际通过。',
  ],
  architecture: [
    '本 diff 由 0dabf46 的历史 SPEC/PLAN 和人类/机器两个索引补丁组成，未触及产品或生成代码。',
    '0dabf46 接在 2a4aa6c 后，self 保持末端占位；self 对象不代表 6c3c1e4，也没有被替换 fullSha。',
  ],
  decisions: [
    'SPEC 以 be5c03e-SPEC/PLAN 为 Actual scope，保留四文件 78/1 统计，而非复制 2a4aa6c 的 1329f79 范围。',
    'INDEX Implemented 65→66，其他状态仍为 1/0；JSON 67→68，含 self 的 implemented 66→67。',
    '0dabf46 是 JSON 第 67 项，self 顺移为第 68 项；本提交新增的四个路径正好闭合这一对象。',
  ],
  alternatives: ['选择 612cc40 会跳过 0dabf46 并提前处理下一层；仅写索引会让 be5c03e 范围说明没有对应 Markdown 产物。'],
  security: ['只有文档元数据变化，没有凭据、私有协议、权限绕过、依赖或运行逻辑调整。'],
  acceptance: [
    '0dabf46 两份 frontmatter 使用相同完整 SHA、标题和时间，范围路径指向 be5c03e。',
    'INDEX 与 JSON 均新增一个 implemented 项，2a4aa6c 保持前一项，self 仍在最后。',
  ],
  evidence: [
    { kind: 'diff-observed', statement: '0dabf46 SPEC 固定完整身份，Actual scope 包含 be5c03e 的两个文档。', source: { path: 'docs/specs/0dabf46-SPEC.md', role: 'evidence', revision: 'commit', symbol: 'docs/specs/be5c03e-SPEC.md', note: '该范围对应 0dabf46 的原始四文件 diff。' } },
    { kind: 'diff-observed', statement: '0dabf46 PLAN 以目标完整 SHA 新建，并包含实施与完成状态小节。', source: { path: 'docs/plans/0dabf46-PLAN.md', role: 'evidence', revision: 'commit', symbol: 'commit: 0dabf466a5db43caa9890f5e0a031d00505a0008', note: 'frontmatter 未使用直接父 612cc40。' } },
    { kind: 'diff-observed', statement: 'INDEX 新增 0dabf46 行，Implemented 计数为 66。', source: { path: 'docs/INDEX.md', role: 'evidence', revision: 'commit', symbol: '| 0dabf46 | Complete previous commit documentation | implemented |', note: '链接指向本提交新增的 SPEC/PLAN。' } },
    { kind: 'diff-observed', statement: '机器索引在 2a4aa6c 和 self 之间登记 0dabf46。', source: { path: 'docs/status/index.json', role: 'evidence', revision: 'commit', symbol: '"fullSha": "0dabf466a5db43caa9890f5e0a031d00505a0008"', note: '对象保留目标日期、标题、状态和路径。' } },
    { kind: 'not-recorded', statement: 'diff 不含生成、测试、构建或 CI 输出，PLAN 中的验证命令只是文档内容。' },
  ],
  remaining: ['612cc40 与当前 6c3c1e4 在此快照仍未建档；0dabf46 的计划没有实际验证记录。'],
  references: [
    { path: 'docs/INDEX.md', role: 'changed', note: 'Implemented 65→66，新增 0dabf46。' },
    { path: 'docs/plans/0dabf46-PLAN.md', role: 'changed', note: '新建 0dabf46 计划文档。' },
    { path: 'docs/specs/0dabf46-SPEC.md', role: 'changed', note: '记录 0dabf46 及 be5c03e 范围。' },
    { path: 'docs/status/index.json', role: 'changed', note: 'JSON 67→68，self 前加入 0dabf46。' },
  ],
  plan: {
    preconditions: ['确认祖父 0dabf46 是目标，并核对其原始 be5c03e 文档对及 78/1 统计。'],
    reuse: ['复用 2a4aa6c 后的顺序、既有生成模板和 JSON 七字段，保留 self 占位内容。'],
    steps: [
      { title: '建立 0dabf46 SPEC', detail: '写入完整目标身份、be5c03e 文档组和四文件统计。', paths: ['docs/specs/0dabf46-SPEC.md'] },
      { title: '建立 0dabf46 PLAN', detail: '用相同元数据保存计划步骤、风险、验证建议和完成声明。', paths: ['docs/plans/0dabf46-PLAN.md'] },
      { title: '追加 INDEX 行', detail: '在 2a4aa6c 后加入 0dabf46，只把 Implemented 增至 66。', paths: ['docs/INDEX.md'] },
      { title: '追加 JSON 对象', detail: '将 0dabf46 作为第 67 项写入，保留 self 为第 68 项。', paths: ['docs/status/index.json'] },
    ],
    compatibility: ['2a4aa6c 与更早历史链接不变，self 不改字段；生成器及索引格式没有版本差异。'],
    risks: ['相同标题在 0dabf46 与更早提交反复出现，必须靠 fullSha 和 be5c03e 路径避免对象混淆。'],
    verification: ['对照 0dabf46 原始提交与 SPEC，核对 PLAN frontmatter、两个计数和 self 最终位置。'],
    completed: ['0dabf46 的两个新文档和双索引对象已在四路径 diff 中闭合。'],
    incomplete: ['没有实际测试或 CI 证据，implemented 不代表模板验证序列已经执行。'],
  },
})
