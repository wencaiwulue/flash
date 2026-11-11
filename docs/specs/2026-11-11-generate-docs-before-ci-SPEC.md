---
commit: 9525612e328486ceb996e3ce3327c0119129bf29
title: 在 CI 文档检查前先生成提交文档
date: 2026-11-11
retrospective: true
---

# 在 CI 文档检查前先生成提交文档

## 设计

该提交把 CI 的 Check commit documentation 从仅运行 checker 改为依次运行 `document-commits.ts` 和 `check-commit-docs.ts`，使生成物在检查前刷新。其余 typecheck/test/build 顺序不变。

关键工程后果是 checker 不再只读：缺失或过期文件可能在检查前被 writer 补齐，从而掩盖“提交时未包含最新文档”的问题。这一行为必须作为设计边界记录，不能等同于独立只读验收。

## 验收标准

1. CI 在同一 step 中先 writer 后 checker，顺序与 diff 一致。
2. 其他 CI step 不变，文档生成所需的完整 Git 历史必须可用。
3. 文档明确 writer 可掩盖缺失/过期提交物；若要求只读门控，应移除 writer 并预先提交生成结果。
