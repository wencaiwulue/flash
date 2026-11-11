---
commit: b183b9a76948750cf396dd36c62ad06a62221b60
title: 恢复 live job 与门控的实施步骤
date: 2026-11-11
retrospective: true
---

# 恢复 live job 与门控的实施步骤

## 1. 添加 model 条件并恢复两个 job

**文件：** `.github/workflows/live-checks.yml`。

model 添加 API key if；cloud 恢复 OAuth 三条件及 hosted 配置，desktop 恢复 vars 开关与 self-hosted 配置。所有脚本路径沿用已有 scripts/live-*。

## 2. 验收

```bash
rg -n '^  (model|skillhub|cloud|desktop):|^    if:' .github/workflows/live-checks.yml
actionlint .github/workflows/live-checks.yml
```

四个 job 必须存在。静态检查若指出 secrets context，应保留为未达标项，而不是仅确认 YAML 可解析就结束。
