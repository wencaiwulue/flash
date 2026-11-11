---
commit: 6ef3352651472a951a3779f7b9f906fbc5ca86ca
title: 移除 Environment 绑定的实施步骤
date: 2026-11-11
retrospective: true
---

# 移除 Environment 绑定的实施步骤

## 1. 精确修改三个 job

**文件：** `.github/workflows/live-validation.yml`。

仅删除 model、cloud、desktop 的 `environment: live-validation`，保留所有 if、runs-on、steps 和 env。

## 2. 静态验收

```bash
! rg -n '^    environment:' .github/workflows/live-validation.yml
git diff -- .github/workflows/live-validation.yml
```

确认 diff 恰好三行删除，没有顺带修改 secrets job-if、desktop vars 或脚本。
