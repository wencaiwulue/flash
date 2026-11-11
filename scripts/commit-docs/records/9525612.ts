import { defineCommitRecord } from '../schema.ts'

export const record = defineCommitRecord({
  commit: '9525612e328486ceb996e3ce3327c0119129bf29',
  slug: 'generate-docs-before-ci',
  kind: 'component',
  status: 'implemented',
  beforeState: '父提交的 CI 已用 fetch-depth: 0 取得完整历史，但文档步骤只运行 check-commit-docs.ts。生成器负责把上一 self 落实成 SHA 文件，若提交者漏跑生成，checker 会把这些文件报告为缺失。',
  problem: '该提交选择在 checker 前执行 document-commits.ts，让 CI 能自行生成上一提交文档。这解决了漏生成导致的失败，却同时让 checker 验证刚刚由同一生成器写出的内容，无法证明仓库原本提交的文档完整或未过期。',
  goals: ['在 CI 的文档检查步骤中先运行生成器，再运行现有 checker，保持其他构建与测试步骤不变。'],
  nonGoals: ['不改变 self/SHA 算法、SPEC/PLAN 内容或测试套件，也不把这次流程修补描述为设计正文质量校验。'],
  architecture: ['数据流由 committed tree → generator 写工作树 → checker 读取同一工作树 组成。生成与检查共享记录和 Git 元数据，因此 checker 能验证确定性，却失去了检测 committed artifact 缺失的独立起点。'],
  decisions: ['直接扩展现有 step 为两行命令，而不是新增 job 或修改 checker；实现最小，但写操作和验证仍耦合在同一 workspace。'],
  alternatives: ['回溯工程上，CI 只运行 checker 并在失败时要求作者提交生成结果，才能保留缺失/过期文档证据；先 generate 再 check 则更宽松，这是本提交实际选择及其代价。'],
  security: ['没有新增凭据或网络写入；主要风险是质量门禁被同进程生成结果满足，而不是产品权限边界变化。'],
  acceptance: ['at-commit workflow 在 check-commit-docs.ts 前执行 document-commits.ts，且 fetch-depth、typecheck、test、build 和 smoke 顺序保持原样。'],  remaining: ['writer 会在 checker 前掩盖 missing/stale committed documents；后续需要把生成保留为本地写操作，CI 改为只读检查。'],
  references: [
    { path: '.github/workflows/ci.yml', role: 'changed', symbol: 'bun scripts/document-commits.ts', note: '将生成器插入现有文档 checker 之前。' },
  ],
  plan: {
    preconditions: ['确认上一 self 的 SHA 文档由生成器负责，且当前 CI 已 checkout 全历史。'],
    reuse: ['复用既有两个 Bun 脚本及其共享 buildCommitDocuments，不引入新的文档格式。'],
    steps: [
      { title: '展开文档 CI 步骤', detail: '把单行 run 改为多行 block，在第一行调用生成器，让上一 self 的 SHA 文件先落到工作树。', paths: ['.github/workflows/ci.yml'] },
      { title: '保留 checker 与后续验证', detail: '第二行继续调用原 checker，typecheck/test/build/smoke 不变；同时记录这种写后查无法检测提交遗漏的限制。', paths: ['.github/workflows/ci.yml'] },
    ],
    compatibility: ['本地生成命令和文档路径不变，CI 对漏提交生成结果变得更宽容。'],
    risks: ['同一输入既生成又验证会产生自证，缺失文档可能在 CI 中被临时补齐而不再失败。'],
    acceptanceSequence: ['检查 patch 的命令顺序，并用后续 run 只证明 workflow 可执行；另行审查 committed tree 才能发现其独立性缺口。'],
    completed: ['生成器已进入文档检查步骤，后续有 run 通过的记录。'],
    incomplete: ['没有实现只读 CI 校验，也没有增加针对 stale/missing committed artifact 的回归。'],
  },
})
