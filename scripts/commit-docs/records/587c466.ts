import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: '587c466f7e28e4cb59b0c4522857a7110e7b152a',
  slug: 'commit-specs-and-plans',
  kind: 'component',
  status: 'partial',
  beforeState: '父提交只有全局 ARCHITECTURE/STATUS/RELEASE，没有逐提交 SPEC、PLAN、机器索引或文档 CI。当时的 41 个祖先需要集中补齐，当前文档工作又无法在自己的树内写入不会改变自身 SHA 的最终文件名。',
  problem: '该提交建立生成器、self 约定和 checker 来解决覆盖与 SHA 自引用，但内容层主要仍是 DETAILS 的四类短句、通用 fallback 和固定三步 PLAN；生命周期层又在生成时枚举包含当前 HEAD 的全部 commits，同时额外加入 self，导致提交前后预期清单不一致。',
  goals: [
    '建立从 Git metadata 到 SPEC/PLAN、INDEX、status JSON 的统一生成与只读比较入口。',
    '用 self/changeId 表达当前工作，并在基础 CI 获取完整历史、执行文档检查。',
    '保留每个提交的状态、变更文件、约束、验证和剩余范围，同时识别实际生成物尚未达到真正方案设计/实施文档标准。',
  ],
  nonGoals: [
    '不把 diffstat 和文件名列表当成架构，不把通用三步当成文件级实施计划。',
    '不改变产品功能或 OAuth/Cloud/desktop 的验证状态，也不借文档状态宣称 live 成功。',
    '本提交没有解决当前 HEAD 与 self 同时存在的确定性问题，后续提交仍需修正。',
  ],
  architecture: [
    '生成器用 git log --reverse 取得 full/short SHA、日期和 subject，statusFor 只把根提交标为 partial，其余一律 implemented。specFor 将 detailsFor 的四段说明与完整文件名/shortstat 拼接，planFor 在没有手工 plan 时使用相同三步；DETAILS 仅覆盖部分功能提交，fallback 为其余提交生成同义泛化文字。',
    'self 文案由 COMMIT_DOC_ID/COMMIT_DOC_SUBJECT 环境变量或默认值决定。buildCommitDocuments 在生成时遍历 git log 默认选出的 HEAD 可达历史（并非仓库所有 refs），再额外加入 self-SPEC/PLAN、INDEX 行和 JSON self 对象。预先提交时 HEAD 是 beee034，落地为 587c466 后再次运行会多出一个 587c466 SHA pair，因此已提交索引与新期望不同。',
    'checker 调同一个 buildCommitDocuments 并逐字比较工作树，能发现相对当前算法的缺失/过期文件，却不能评价设计理由或实施深度。CI 增加 fetch-depth: 0 与 checker step，package.json 提供 docs:generate/docs:check，COMMIT_DOCS 规定后续维护方式。',
  ],
  decisions: [
    '把生成逻辑集中于一个脚本，初期便于批量建立 86 个生成物（41 个历史 SHA pairs、self pair 和两个索引）；本提交总计 95 个变更文件，但脚本、静态模板、政策/状态文档及 CI/package 变更并非生成器输出。大型 DETAILS、模板和 Git 查询耦合也放大了后续修订成本。',
    '选择 self 是为避免 SHA 自引用，这一方向合理；错误在于没有从 SHA 历史清单排除当前 HEAD，形成双份当前提交语义。',
    '以精确文本比较作为首个 CI 门禁只能保证可重复生成，本记录据此把提交定为 partial，而不是继续沿用其自我评价。',
  ],
  alternatives: ['回溯来看，head 模式只处理祖先并由 self 表示 HEAD、next 模式再包含 HEAD，可以消除递归补丁；直接手写所有 Markdown 虽避免生成器状态问题，却无法提供路径和索引一致性校验。'],
  security: ['生成内容来自公开 Git 和人工说明，不应包含凭据；但“其余提交一律 implemented”和通用验证句会产生无依据状态，结构完整不等于证据真实。'],
  acceptance: [
    'diff 应包含生成器、checker、两个模板、政策/索引/状态文件、CI 与 package scripts，以及 43 个 SPEC 和 43 个 PLAN 路径。',
    '生成器能输出真实 SHA/title/date，以及按硬编码 statusFor 规则填入的 status 和索引，checker 能报告缺失或文本漂移。',
    '质量验收必须同时报告 fallback、固定 PLAN 和 HEAD/self 双份问题，不能只引用 41 pairs 的数量。',
  ],  remaining: [
    '通用 fallback 和固定三步使多数文档不具备独立架构与实施价值，需要按真实 diff 全面重写。',
    'HEAD 与 self 的清单语义需要拆分为明确的祖先/下一提交模式，不能依靠预提交时 HEAD 恰好是上一节点。',
    'checker 只检查生成集合中的路径是否存在及正文是否逐字一致；它不校验 SPEC 内列出的变更路径或 Markdown 链接目标，不发现额外/孤儿文档，也不检查证据真实性、重复正文或敏感信息，静态模板和政策文件更不在其比较集合中，因此 CI 成功不能代表内容合格。',
  ],
  references: [
    { path: 'scripts/document-commits.ts', role: 'changed', symbol: 'buildCommitDocuments', note: '实现 Git 枚举、DETAILS/fallback、SPEC/PLAN、self 与索引生成，也是两处核心缺陷所在。' },
    { path: 'scripts/check-commit-docs.ts', role: 'changed', symbol: 'buildCommitDocuments', note: '以同一生成结果逐字比较文档，只提供结构一致性检查。' },
    { path: '.github/workflows/ci.yml', role: 'changed', symbol: 'fetch-depth: 0', note: '加入全历史 checkout 和文档检查 step。' },
    { path: 'package.json', role: 'changed', symbol: 'docs:generate', note: '暴露生成与检查两个维护命令。' },
    { path: 'docs/COMMIT_DOCS.md', role: 'changed', symbol: '## The `self` record', note: '记录 self、状态和后续生成流程的政策约定。' },
    { path: 'docs/INDEX.md', role: 'changed', symbol: '- Implemented: 40', note: '提供人类可读链接与状态计数，反映预提交的 41 个祖先视角。' },
    { path: 'docs/status/index.json', role: 'changed', symbol: '"commits"', note: '保存 fullSha、日期、状态和文档路径的机器索引。' },
    { path: 'docs/STATUS.md', role: 'changed', symbol: '| Commit documentation |', note: '记录当时的 41 pairs 与 checker 通过声明。' },
    { path: 'docs/RELEASE.md', role: 'changed', symbol: '## Commit documentation policy', note: '把全历史文档和 self 约定纳入发布说明。' },
  ],
  changeGroups: [
    { prefix: 'docs/specs/', count: 43, note: '41 个祖先提交 SHA SPEC、self-SPEC 与 SPEC 模板；根/恢复 SPEC 还包含大段原始文件清单。' },
    { prefix: 'docs/plans/', count: 43, note: '41 个祖先提交 SHA PLAN、self-PLAN 与 PLAN 模板；多数 PLAN 使用同一组三步。' },
  ],
  plan: {
    preconditions: ['确认当时有 41 个祖先和一项未提交文档工作，并理解当前 commit 无法在自己的树内预先知道最终 SHA。'],
    reuse: ['复用 git metadata、现有 docs/STATUS/RELEASE、Bun 脚本和基础 CI，不引入新的文档服务。'],
    steps: [
      { title: '实现提交元数据与内容模型', detail: '在 document-commits.ts 定义 Commit/Details、Git 查询、DETAILS、statusFor 和 self 环境输入，先形成可批量读取的历史清单。', paths: ['scripts/document-commits.ts'] },
      { title: '生成 SPEC、PLAN 与索引', detail: '实现 specFor/planFor 及 INDEX/status JSON 投影，同时加入 fallback 和默认 PLAN；批量产出 41 个历史 SHA pairs、self pair 与两个索引；两个 template.md 则作为静态文件单独加入，不在 buildCommitDocuments 的输出集合中。', paths: ['scripts/document-commits.ts', 'docs/specs/', 'docs/plans/', 'docs/INDEX.md', 'docs/status/index.json'] },
      { title: '加入只读 checker 和命令入口', detail: '让 checker 复用生成器比较实际文件，在 package.json 注册 docs:generate/docs:check。', paths: ['scripts/check-commit-docs.ts', 'package.json'] },
      { title: '接入全历史 CI', detail: '把 checkout 改为 fetch-depth: 0，并在 typecheck 后运行 checker，确保历史记录可被完整枚举。', paths: ['.github/workflows/ci.yml'] },
      { title: '写政策与验证声明', detail: '在 COMMIT_DOCS 记录 self 和维护步骤，在 STATUS/RELEASE 写入 41 pairs 与检查声明；此处还应发现 HEAD/self 和正文深度问题，但原提交未完成。', paths: ['docs/COMMIT_DOCS.md', 'docs/STATUS.md', 'docs/RELEASE.md'] },
    ],
    compatibility: ['self 保持当前工作的稳定链接，旧全局 STATUS/RELEASE 继续存在；但动态 HEAD 清单使已提交生成结果不能稳定复现。'],
    risks: ['生成器与 checker 共用同一内容来源会掩盖泛化正文；预提交生成又把上一 HEAD 的视角固化进当前 commit。'],
    acceptanceSequence: ['核对 95 文件和目录计数，运行生成/比较检查，并单独测试提交后 HEAD 新增时是否出现额外 SHA pair；正文还需逐提交语义审查。'],
    completed: ['初版生成器、checker、索引、模板、政策和 CI 接线已经建立，历史文档文件得到批量覆盖。'],
    incomplete: ['未完成真正的逐提交设计/实施内容，未解决 HEAD/self 确定性，也没有内容质量负向测试。'],
  },
})
