---
commit: c69c271db2278642918bce5caf9641108e4f6cab
title: 将提交文档改为显式结构化设计记录
date: 2026-11-11
retrospective: true
---

# 将提交文档改为显式结构化设计记录

## 设计动因

此前 SPEC/PLAN 主要由提交标题、diffstat 和通用 fallback 拼接，PLAN 共用“复核—修改—验证”三步。该提交把正文改为每 commit 一个 TypeScript 记录，试图让设计内容成为可校验数据，而不是渲染时自动创作。

## 组件边界

- `schema.ts`：定义 beforeState/problem/goals/architecture/decisions/evidence/references/plan.steps 等字段。
- `git.ts`：读取 topo 顺序历史、rename-aware diff 和 revision 文件。
- `load.ts`：按 short SHA 动态加载显式 records，拒绝文件名与 full SHA 不符。
- `validate.ts`：检查覆盖、revision/symbol、rename、证据、占位、重复和敏感信息。
- `render.ts`：把记录投影为 SPEC/PLAN 与两个索引，head 模式覆盖祖先+self，next 模式额外覆盖当前 HEAD。
- `document-commits.ts`：唯一写入口；`check-commit-docs.ts` 只读比较并发现孤儿文件。

CI 不再先 writer 后 checker，避免生成器掩盖缺失提交物。

## 实际边界

记录包含执行证据模型，渲染器保留“验证证据”和“验证顺序”，与当前“只写验收标准”的新要求不同。大量历史正文仍需逐提交语义审查；结构、路径和重复检查不能证明设计理由正确。

## 验收标准

1. 每个历史 SHA 都有显式记录，缺失或文件名不匹配直接失败。
2. 变更文件可由 changed reference/changeGroup 覆盖，引用与符号在指定 revision 存在。
3. head/next 清单一致衔接，CI 只读检查且能发现孤儿文件。
4. 通用 fallback、复制正文和敏感信息被拒绝；语义审查仍是独立要求。
