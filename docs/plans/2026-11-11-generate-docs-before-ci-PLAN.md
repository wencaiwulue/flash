---
commit: 9525612e328486ceb996e3ce3327c0119129bf29
title: CI 文档生成前置的实施步骤
date: 2026-11-11
retrospective: true
---

# CI 文档生成前置的实施步骤

## 1. 修改 CI step

**文件：** `.github/workflows/ci.yml`。

将 Check commit documentation 的 run 改为：

```yaml
run: |
  bun scripts/document-commits.ts
  bun scripts/check-commit-docs.ts
```

不修改 typecheck/test/build。

## 2. 验收

先确认 checkout 提供完整历史，再执行同一顺序。额外做一个负向检查：删除一份生成文档后，writer 会在 checker 前补回；该现象说明此门控不是只读提交物检查，必须在文档中保留这一限制。
