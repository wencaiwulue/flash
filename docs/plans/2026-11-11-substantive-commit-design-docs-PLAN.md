---
commit: c69c271db2278642918bce5caf9641108e4f6cab
title: "Rebuild substantive commit design documentation"
date: 2026-11-11T14:04:41+08:00
status: implemented
kind: component
---

# 实施计划：Rebuild substantive commit design documentation

> 本文按实际代码依赖重建实施顺序，用于说明怎样完成该提交；不伪称是历史提交当时保存的计划。

## 目标与前置条件

这种结构只能证明文档存在且可由同一套模板复现，无法回答某个提交为什么采用特定架构、数据怎样流动、实施时先改哪个模块，也无法发现缺失记录被自动生成所掩盖。需要把技术正文变成强制、可核对的一等数据，并保留人工语义审查的位置。

- 完整 Git 历史可用，旧生成器和代表性 SPEC/PLAN 已确认只提供结构完整性而没有设计深度。
- 每项回填都能读取目标提交、父提交、测试以及对应 revision 的状态/发布记录。

## 复用与兼容处理

### 复用现有实现

- 复用现有 docs/specs、docs/plans、INDEX 和 status/index.json 的对外布局，避免破坏已有链接。
- 复用 Bun/TypeScript 测试与构建链，不引入新的运行时依赖或文档服务。
- 保留 self 解决 SHA 自引用的基本思想，但把清单计算统一到 head/next 两种模式。

### 兼容、迁移与生命周期

- 保留原有文档路径和 seven-character short SHA 链接，历史 full SHA 只在结构化记录中成为强制值。
- 后续工作将旧 self 迁移成刚落地 commit 的 SHA 记录，再创建新的 self，避免递归修改历史。
- PR 使用 head SHA 而不是 synthetic merge SHA，保证 CI 的 HEAD 与 self 清单含义一致。

## 文件级实施步骤

### 1. 建立不可兜底的数据契约

先定义完整记录、证据和文件引用，再让加载器在缺记录或 SHA 不匹配时立即失败，从入口消除通用正文。

涉及位置：`scripts/commit-docs/schema.ts`、`scripts/commit-docs/load.ts`

### 2. 实现 Git 对照和质量门禁

读取真实 diff 与 revision 内容，核对变更覆盖和引用，再对作者正文执行占位、证据、重复与敏感信息检查。

涉及位置：`scripts/commit-docs/git.ts`、`scripts/commit-docs/validate.ts`、`tests/commitDocs.test.ts`

### 3. 分离渲染、写入和只读检查

渲染器只转换已审核记录，writer 显式生成，checker 仅比较并报告孤儿文件；随后让 CI 只调用 checker。

涉及位置：`scripts/commit-docs/render.ts`、`scripts/document-commits.ts`、`scripts/check-commit-docs.ts`、`.github/workflows/ci.yml`

### 4. 以代表性提交校准内容标准

分别撰写大型恢复快照、Workflow、bridge/Cloud、CI 迁移、纯 rename 和元数据 finalization，审查通过后再批量回填。

涉及位置：`scripts/commit-docs/records/ea80851.ts`、`scripts/commit-docs/records/02bc3c2.ts`、`scripts/commit-docs/records/5c56455.ts`

### 5. 全量回填并逐提交审查

按时间顺序完成所有功能、修复、CI、证据和 finalization 记录，渲染后对照各自 diff 检查技术理由、步骤、时间和证据。

涉及位置：`scripts/commit-docs/records/`、`docs/specs/`、`docs/plans/`、`docs/INDEX.md`、`docs/status/index.json`

### 6. 执行全量验证和交付

先以 next 模式验证全部历史，再运行负向测试、typecheck、全量测试和 build；提交后用 head 模式及重复生成确认幂等，并把凭据文件 ignore 与状态修正纳入最终审查。

涉及位置：`docs/COMMIT_DOCS.md`、`docs/STATUS.md`、`docs/RELEASE.md`、`.gitignore`

## 风险与处理

- 历史回填可能把后来的理解误写成当时事实；通过 revision 证据和回溯说明控制。
- finalization 提交天然相似；重复门禁和逐提交计数/路径审查用于防止只替换 SHA 的伪独立文档。
- 路径存在不代表架构描述正确，因此最终报告必须保留人工语义审查结论和自动检查的边界。

## 验收顺序

1. tests/commitDocs.test.ts 覆盖各类无效记录的拒绝行为。
2. docs:generate -- --next 与 docs:check -- --next 能处理 93 个历史和 self 的完整清单。
3. typecheck、全量 bun test、build 和 git diff --check 能正常运行。
4. 提交后 docs:check 和两次 docs:generate + git diff --exit-code 能验证 head 清单和幂等性。

## 完成状态与剩余工作

- 状态：**implemented**

### 已完成

- 结构化 schema、显式加载、Git 对照、质量门禁、渲染和 head/next 入口已实现。
- CI 写后查问题已移除，维护政策和模板已改成方案设计与文件级实施要求。
- 93 个历史记录已全部回填，支持 188 份文档的 next 全量生成。
- tests/commitDocs.test.ts 负责命名、遗留字段、引用和渲染契约的回归。
- 93 个提交均完成独立语义复核，已修正多处证据、CI 门控、元数据谱系和实现边界误述，STATUS 已同步已知产品缺口。
- tests/commitDocs.test.ts 负责命名、遗留字段、引用和渲染契约的回归。

### 未完成或后续工作

- 提交后的 head 幂等检查和 hosted GitHub Actions 结果尚待验证。
