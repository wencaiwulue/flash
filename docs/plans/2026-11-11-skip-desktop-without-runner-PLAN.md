---
commit: e90042354c2cb902b033cf9e06b39d9c67c1b111
title: Desktop runner 门控的实施步骤
date: 2026-11-11
retrospective: true
---

# Desktop runner 门控的实施步骤

## 1. 恢复 vars 条件

**文件：** `.github/workflows/live-checks.yml`。

在 desktop job 添加 `if: vars.CLAUDE_DESKTOP_LIVE == '1'`，保留 self-hosted、environment、steps 和 env。

## 2. 验收

分别检查变量未设置、空字符串、0 和 1 时的 job 条件求值：只有 1 允许调度。diff 必须只有这一行新增，不能顺带改变 model/cloud skip 或 desktop 脚本。
