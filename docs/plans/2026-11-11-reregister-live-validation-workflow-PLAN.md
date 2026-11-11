---
commit: 4dd93b75220926cefbe9d5d017224238bfd8e0f1
title: workflow 重命名的实施步骤
date: 2026-11-11
retrospective: true
---

# workflow 重命名的实施步骤

## 1. 纯移动文件

```bash
git mv .github/workflows/live-validation.yml .github/workflows/live-checks.yml
```

不编辑 YAML 内容。

## 2. 验收

```bash
git diff --summary
cmp .github/workflows/live-checks.yml .github/workflows/live-checks.yml
test ! -e .github/workflows/live-validation.yml
```

`git diff --summary` 应显示 100% rename；后续提交只修改 live-checks.yml。
