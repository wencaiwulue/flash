---
commit: 85028f74ed5ec110dcfd0a0933f615f88cc4600e
title: 缩减 live job 解析面的实施步骤
date: 2026-11-11
retrospective: true
---

# 缩减 live job 解析面的实施步骤

## 1. 删除完整 job 定义

**文件：** `.github/workflows/live-validation.yml`。

从 `cloud:` 到文件末尾的 desktop 定义整体删除，保留 model、skillhub 及其全部配置。

## 2. 验收

```bash
rg -n '^  (model|skillhub):' .github/workflows/live-validation.yml
! rg -n '^  (cloud|desktop):' .github/workflows/live-validation.yml
git diff --stat
```

确认只修改 workflow，两个脚本仍存在且未被调用方意外改写。
