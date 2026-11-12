import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: 'c69c271db2278642918bce5caf9641108e4f6cab',
  changeId: 'substantive-commit-docs',
  title: 'Rebuild substantive per-commit design and implementation documentation',
  kind: 'component',
  status: 'implemented',
  beforeState: '既有文档系统把提交标题、变更文件数量和少量一句话说明填入固定模板；大多数历史提交共用 fallback，PLAN 则共用三个没有文件和依赖关系的步骤。CI 还会先运行 writer，再检查刚刚被它重写的文件。',
  problem: '这种结构只能证明文档存在且可由同一套模板复现，无法回答某个提交为什么采用特定架构、数据怎样流动、实施时先改哪个模块，也无法发现缺失记录被自动生成所掩盖。需要把技术正文变成强制、可核对的一等数据，并保留人工语义审查的位置。',
  goals: [
    '为全部 93 个历史提交建立独立、结构化的方案设计与实施记录，并生成对应 SPEC/PLAN。',
    '让缺失记录、空泛占位、错误文件引用、无来源执行证据和复制正文在本地及 CI 中失败。',
    '明确区分当提交证据、后续证据、实现状态和仍需授权环境的验证边界。',
    '统一 self 与下一提交的准备模式，CI 只读校验已提交文档。',
  ],
  nonGoals: [
    '不改写历史 commit、commit message 或产品实现，也不借文档整改重新解释未发生的 live 验证。',
    '不把重复度、路径存在性或 schema 通过宣称为计算机已经证明设计语义正确。',
    '不处理 OAuth、Cloud、remote-control 和原生桌面环境本身的验收。',
  ],
  architecture: [
    '记录层以每提交一个 TypeScript 模块保存 beforeState、architecture、decisions、evidence 和有序 plan.steps。加载器只接受显式记录；Git 层负责真实历史、rename 和 revision 内容，渲染层不再创作技术正文。',
    '校验层先把提交 diff 与 changed references 对齐，再检查 reused/test/evidence 在指定 revision 是否存在，最后对作者正文做占位、敏感信息和跨记录重复检查。证据对象带 kind 与 source，使“新增测试”和“执行通过”在数据模型中就不能混为一谈。',
    '渲染器把同一份审核记录分别投影为 SPEC 与 PLAN，同时重建 INDEX 和 JSON 状态。head 模式要求祖先 SHA 加当前 self，next 模式把当前 HEAD 也纳入 SHA 清单，从而消除额外复制 previous HEAD 文档的补丁。',
  ],
  decisions: [
    '采用结构化记录而不是直接维护散落的 Markdown，是为了让文件覆盖、证据类型和 revision 成为机器可校验字段；Markdown 仍作为人类阅读的最终产物。',
    '将功能、纯证据更新和元数据迁移区分为不同 kind，避免给 rename 或 finalization commit 虚构产品架构。',
    '把重复检查限制在作者撰写的实质段落，排除 frontmatter、索引和机械统计，避免正常元数据格式造成无意义冲突。',
    'CI 不调用 writer；生成与检查分离后，工作树里缺失或过期的文档会原样暴露，而不是在检查前被修复。',
  ],
  alternatives: [
    '继续扩充单个 DETAILS 表会让长正文、证据和步骤挤在一个脚本里，也无法按提交并行审查，因此拆成独立记录。',
    '根据标题和 diffstat 自动推断理由仍然会产生用户已经否定的泛化文档，故只自动提取机械事实，不自动生成设计 prose。',
    '把所有提交硬套成产品组件设计会迫使纯文档提交编造数据流；采用 kind 和具体的“不适用”理由更诚实。',
  ],
  security: [
    '记录和生成物只引用公开源码、测试与已有状态文档；敏感模式检查失败时不回显疑似凭据。',
    '证据模型不允许用后续 live 结果冒充当提交结果，OAuth/Cloud/desktop 边界继续按真实环境记录。',
    '校验器对 Git 只执行读取操作；CI 不再获得通过 writer 修改待检查内容的隐式路径。',
  ],
  acceptance: [
    '93 个历史提交均有 full-SHA 对应的独立记录，且每个普通变更文件能在设计或实施记录中定位。',
    '缺失记录、旧 fallback、空章节、错误路径、复制段落和证据缺源均有确定失败测试。',
    'next 与 head 两种模式生成结果一致地衔接，重复生成不产生 diff，CI 不再先写后查。',
    '代表性 Workflow、bridge、CI、rename 和 finalization 文档能独立说明架构、取舍与文件级顺序。',
  ],
  evidence: [
    {
      kind: 'test-added',
      statement: 'tests/commitDocs.test.ts 覆盖完整记录、空章节、旧模板、敏感值、缺失 SHA、错误 diff 路径、变更文件 symbol、证据缺源、证据文件缺失、复制正文和模式解析。',
      source: { path: 'tests/commitDocs.test.ts', role: 'test', note: '新增文档质量门禁的负向与结构回归。' },
    },
    {
      kind: 'diff-observed',
      statement: 'CI diff 将 checkout 固定到 PR head 或 push SHA，并把文档步骤缩减为只读 docs:check。',
    },
    {
      kind: 'recorded-command-pass',
      statement: '本地实际执行 docs:generate -- --next 并在语义审查后重新生成，随后 docs:check -- --next 验证 188 份历史/self 设计与实施文档及索引全部通过。',
      source: { path: 'scripts/document-commits.ts', role: 'evidence', note: '本次全量 next 生成命令的实际入口与输出计数。' },
    },
    {
      kind: 'recorded-command-pass',
      statement: '本地实际执行 tests/commitDocs.test.ts，16 个测试、27 个断言全部通过；全量 bun test 随后完成 168 个测试、672 个断言，零失败。',
      source: { path: 'tests/commitDocs.test.ts', role: 'test', note: '定向门禁测试及其纳入全量套件后的实际结果。' },
    },
    {
      kind: 'recorded-command-pass',
      statement: '本地 bun run typecheck 零错误，bun run build 成功生成 CLI、SDK 和 declarations，git diff --check 通过。',
      source: { path: 'package.json', role: 'evidence', note: '本次完整验证实际执行的 typecheck、build 与 build:types 脚本。' },
    },
  ],
  remaining: [
    '93 个历史记录、独立语义审查、审查后重生成和本地全量验证均已完成；仅剩提交后的 head 幂等检查与 hosted CI 验证，自动门禁不替代已经执行的语义审查。',
    '审计发现的 standalone settings、ReviewArtifact、context-collapse、Workflow、Snip、SkillHub/cache 和 Browser 实现缺口已写入 STATUS，本次不修改产品实现。',
    '既有 OAuth、Cloud、remote-control 与原生桌面 live 边界不受本次文档工作影响。',
  ],
  references: [
    { path: 'scripts/commit-docs/schema.ts', role: 'changed', note: '定义设计记录、证据、引用、变更分组和实施步骤的数据契约。' },
    { path: 'scripts/commit-docs/git.ts', role: 'changed', note: '提供确定顺序历史、rename-aware diff 和 revision 文件读取。' },
    { path: 'scripts/commit-docs/load.ts', role: 'changed', note: '只加载显式逐提交记录，并拒绝文件名与 SHA 不一致。' },
    { path: 'scripts/commit-docs/validate.ts', role: 'changed', note: '执行覆盖、引用、证据、占位、重复和敏感信息检查。' },
    { path: 'scripts/commit-docs/render.ts', role: 'changed', note: '把审核记录投影为 SPEC、PLAN 和两种索引。' },
    { path: 'scripts/document-commits.ts', role: 'changed', note: '提供唯一写入口和 head/next 清单语义。' },
    { path: 'scripts/check-commit-docs.ts', role: 'changed', note: '只读比较生成结果并发现孤儿 SPEC/PLAN。' },
    { path: 'tests/commitDocs.test.ts', role: 'changed', note: '验证结构与负向质量门禁。' },
    { path: '.github/workflows/ci.yml', role: 'changed', note: '固定实际 head revision，并禁止 CI 检查前写文档。' },
    { path: '.gitignore', role: 'changed', note: '把 plainTextStorage 使用的 .credentials.json 纳入防误提交范围。' },
    { path: 'docs/COMMIT_DOCS.md', role: 'changed', note: '规定设计正文、证据和人工审查责任。' },
    { path: 'docs/STATUS.md', role: 'changed', note: '修正 Cloud skip、settings 加载、ReviewArtifact 与 context-collapse 的当前状态和剩余边界。' },
    { path: 'docs/RELEASE.md', role: 'changed', note: '以 93 个实质设计记录和只读 CI 政策替换过时的 41-commit 结构检查说明。' },
    { path: 'docs/INDEX.md', role: 'changed', note: '重建全部历史与 self 的人类可读文档索引。' },
    { path: 'docs/status/index.json', role: 'changed', note: '重建全部历史与 self 的机器可读状态和文档路径。' },
    { path: 'package.json', role: 'reused', note: '提供文档检查、typecheck、test 与 build 的既有命令入口。' },
  ],
  changeGroups: [
    { prefix: 'docs/specs/', count: 95, note: '93 个历史提交 SPEC、self SPEC 与模板全部由结构化记录重渲染。' },
    { prefix: 'docs/plans/', count: 95, note: '93 个历史提交 PLAN、self PLAN 与模板全部由结构化记录重渲染。' },
    { prefix: 'scripts/commit-docs/records/', count: 94, note: '93 个历史提交各一份独立 TypeScript 设计记录，另含当前 self。' },
  ],
  plan: {
    preconditions: [
      '完整 Git 历史可用，旧生成器和代表性 SPEC/PLAN 已确认只提供结构完整性而没有设计深度。',
      '每项回填都能读取目标提交、父提交、测试以及对应 revision 的状态/发布记录。',
    ],
    reuse: [
      '复用现有 docs/specs、docs/plans、INDEX 和 status/index.json 的对外布局，避免破坏已有链接。',
      '复用 Bun/TypeScript 测试与构建链，不引入新的运行时依赖或文档服务。',
      '保留 self 解决 SHA 自引用的基本思想，但把清单计算统一到 head/next 两种模式。',
    ],
    steps: [
      {
        title: '建立不可兜底的数据契约',
        detail: '先定义完整记录、证据和文件引用，再让加载器在缺记录或 SHA 不匹配时立即失败，从入口消除通用正文。',
        paths: ['scripts/commit-docs/schema.ts', 'scripts/commit-docs/load.ts'],
      },
      {
        title: '实现 Git 对照和质量门禁',
        detail: '读取真实 diff 与 revision 内容，核对变更覆盖和引用，再对作者正文执行占位、证据、重复与敏感信息检查。',
        paths: ['scripts/commit-docs/git.ts', 'scripts/commit-docs/validate.ts', 'tests/commitDocs.test.ts'],
      },
      {
        title: '分离渲染、写入和只读检查',
        detail: '渲染器只转换已审核记录，writer 显式生成，checker 仅比较并报告孤儿文件；随后让 CI 只调用 checker。',
        paths: ['scripts/commit-docs/render.ts', 'scripts/document-commits.ts', 'scripts/check-commit-docs.ts', '.github/workflows/ci.yml'],
      },
      {
        title: '以代表性提交校准内容标准',
        detail: '分别撰写大型恢复快照、Workflow、bridge/Cloud、CI 迁移、纯 rename 和元数据 finalization，审查通过后再批量回填。',
        paths: ['scripts/commit-docs/records/ea80851.ts', 'scripts/commit-docs/records/02bc3c2.ts', 'scripts/commit-docs/records/5c56455.ts'],
      },
      {
        title: '全量回填并逐提交审查',
        detail: '按时间顺序完成所有功能、修复、CI、证据和 finalization 记录，渲染后对照各自 diff 检查技术理由、步骤、时间和证据。',
        paths: ['scripts/commit-docs/records/', 'docs/specs/', 'docs/plans/', 'docs/INDEX.md', 'docs/status/index.json'],
      },
      {
        title: '执行全量验证和交付',
        detail: '先以 next 模式验证全部历史，再运行负向测试、typecheck、全量测试和 build；提交后用 head 模式及重复生成确认幂等，并把凭据文件 ignore 与状态修正纳入最终审查。',
        paths: ['package.json', 'docs/COMMIT_DOCS.md', 'docs/STATUS.md', 'docs/RELEASE.md', '.gitignore'],
      },
    ],
    compatibility: [
      '保留原有文档路径和 seven-character short SHA 链接，历史 full SHA 只在结构化记录中成为强制值。',
      '后续工作将旧 self 迁移成刚落地 commit 的 SHA 记录，再创建新的 self，避免递归修改历史。',
      'PR 使用 head SHA 而不是 synthetic merge SHA，保证 CI 的 HEAD 与 self 清单含义一致。',
    ],
    risks: [
      '历史回填可能把后来的理解误写成当时事实；通过 revision 证据、later-evidence 类型和回溯说明控制。',
      'finalization 提交天然相似；重复门禁和逐提交计数/路径审查用于防止只替换 SHA 的伪独立文档。',
      '路径存在不代表架构描述正确，因此最终报告必须保留人工语义审查结论和自动检查的边界。',
    ],
    verification: [
      '运行 tests/commitDocs.test.ts，先确认各类无效记录确实被拒绝。',
      '运行 docs:generate -- --next 与 docs:check -- --next，核对 93 个历史和 self 的完整清单。',
      '运行 typecheck、全量 bun test、build 和 git diff --check，排除工具改动造成的工程回归。',
      '提交后运行普通 docs:check 和两次 docs:generate + git diff --exit-code，验证 head 清单和幂等性。',
      '观察真实 GitHub Actions，只记录实际完成的结果。',
    ],
    completed: [
      '结构化 schema、显式加载、Git 对照、质量门禁、渲染和 head/next 入口已实现。',
      'CI 写后查问题已移除，维护政策和模板已改成方案设计与文件级实施要求。',
      '93 个历史记录已全部回填，并成功执行过一次 188 份文档的 next 全量生成。',
      '十六个结构、证据、revision 与负向测试已在本地执行通过。',
      '93 个提交均完成独立语义复核，已修正多处证据、CI 门控、元数据谱系和实现边界误述，STATUS 已同步已知产品缺口。',
      '审查后 next 全量生成与检查、168/672 全量测试、typecheck、build 和 diff whitespace 检查均已通过。',
    ],
    incomplete: [
      '提交后的 head 幂等检查和 hosted GitHub Actions 结果尚待验证。',
    ],
  },
})
