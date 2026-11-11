---
commit: b160aef6c60e6ef3ef0d4bfdf7f97dae7532e02b
title: 显式门控表达式的实施步骤
date: 2026-11-11
retrospective: true
---

# 显式门控表达式的实施步骤

## 1. 包装两个条件

**文件：** `.github/workflows/live-checks.yml`。

model 改为 `if: ${{ env.ANTHROPIC_API_KEY != '' }}`；cloud 的三个条件整体放入 `${{ ... }}`，不改变 `&&` 关系。

## 2. 验收

```bash
rg -n '^    if: \$\{\{' .github/workflows/live-checks.yml
actionlint .github/workflows/live-checks.yml
git diff -- .github/workflows/live-checks.yml
```

确认 diff 只有两处 if 包装。
