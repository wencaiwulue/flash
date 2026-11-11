---
commit: 4c04383cd5a2ee8953031948453d99da6d080946
title: env 门控的实施步骤
date: 2026-11-11
retrospective: true
---

# env 门控的实施步骤

## 1. 先映射 secret 再修改 if

**文件：** `.github/workflows/live-checks.yml`。

model 添加 ANTHROPIC_API_KEY/BASE_URL 的 job env；cloud 添加 OAUTH_TOKEN/ORG_UUID/BASE_URL 的 job env。随后把 if 从 secrets.* 改为 env.*，保持三个 cloud 条件的 `&&`。

## 2. 验收

```bash
! rg -n '^    if:.*secrets\.' .github/workflows/live-checks.yml
rg -n '^    (if|env):' .github/workflows/live-checks.yml
actionlint .github/workflows/live-checks.yml
```

检查 secret 映射与步骤 env 均保留，日志中没有打印 token。
