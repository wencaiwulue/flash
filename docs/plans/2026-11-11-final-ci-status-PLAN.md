---
commit: 271cf757a24eb6cd7e46586fa18995759be32043
title: 发布验证引用的实施步骤
date: 2026-11-11
retrospective: true
---

# 发布验证引用的实施步骤

## 1. 核对目标修复

```bash
git show --stat e31ff8f
```

确认发布引用指向 cron stop/restart 修复。

## 2. 追加 RELEASE 行

在验证段末尾追加完整 SHA 与对应 CI 元数据，不修改其他发布内容或源码。

## 3. 验收

检查完整 SHA、单行 diff 和追加位置，避免把该行误加到前一个功能提交段。
