---
commit: 17f52b5584441f3c937f3d927acad381852159b7
title: 移除 model 与 SkillHub job 条件的实施步骤
date: 2026-11-11
retrospective: true
---

# 移除 model 与 SkillHub job 条件的实施步骤

## 1. 删除两行条件

**文件：** `.github/workflows/live-validation.yml`。

仅删除 model 的 API key if 和 skillhub 的 event if，保留 runs-on、steps 与 env。

## 2. 验收

```bash
! rg -n '^    if:' .github/workflows/live-validation.yml
```

检查 model 在空 API key 时的实际入口：本提交没有脚本 guard，因此必须记录为未配置也会执行探针，不能写成自动跳过。
