---
commit: 4909c0fccbf24736f5c670ef936bae317e52dd4c
title: 日期加功能命名与验收-only 的迁移设计
date: 2026-11-11
retrospective: true
---

# 日期加功能命名与验收-only 的迁移设计

## 设计目标

该提交只新增 `docs/superpowers/specs/2026-11-11-date-based-commit-design-docs-design.md`，规定历史 SPEC/PLAN 从 SHA 文件名改为 `YYYY-MM-DD-feature-slug`，同时移除历史执行结果，只保留验收标准。未修改产品代码或生成器。

## 核心契约

- full SHA 继续作为记录与索引身份，日期+slug 只作为输出名称。
- slug 显式维护为小写 kebab-case，日期取 committer date 自然日。
- 同日同 slug 按历史顺序使用无后缀、-02、-03；残余冲突失败。
- SPEC 保留前置问题、目标、架构/数据流、引用、决策和验收；PLAN 保留前置条件、复用、文件级步骤、风险和验收顺序。
- 删除 evidence 字段与“验证证据”，`plan.verification` 改为 acceptanceSequence。
- self 路径固定，head/next 动态覆盖当前 HEAD，不能写死 94/190 数量。

## 迁移与错误处理

先固化当前 self 和已落地设计提交，再补 slug、清理结果表述、生成新路径、更新索引和政策，最后删除旧 SHA 文件。缺 slug、路径冲突、覆盖缺失、旧文件残留和重复生成差异均失败。

## 验收标准

1. 设计明确命名、冲突、数据契约、迁移顺序、错误处理和测试。
2. 动态 HEAD 清单覆盖设计评审提交，不把静态基线写成固定数量。
3. 文件/符号引用用于设计事实核对，不保存历史测试、CI 或 live 结果。
