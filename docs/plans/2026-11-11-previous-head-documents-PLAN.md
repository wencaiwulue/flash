---
commit: 80e6defe99a3ce09a3d2b4229458fed0fbde5dbc
title: previous HEAD 补写的实施步骤
date: 2026-11-11
retrospective: true
---

# previous HEAD 补写的实施步骤

## 1. 在历史循环后添加补充分支

**文件：** `scripts/document-commits.ts`。

在主循环后、self 文件前加入：

```ts
const previousHead = commits().at(-2)
if (previousHead) {
  documents.set(`docs/specs/${previousHead.short}-SPEC.md`, specFor(previousHead))
  documents.set(`docs/plans/${previousHead.short}-PLAN.md`, planFor(previousHead))
}
```

## 2. 验收

用两个 commit 的临时仓库检查 previousHead 文件存在、当前 HEAD SHA 文件不存在、self 存在；单 commit 时无补写。

另外读取 INDEX/JSON，确认该分支没有注册 previousHead 条目，避免把文件存在误认为索引完整。
