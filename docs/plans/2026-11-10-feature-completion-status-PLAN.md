---
commit: e5c06bc3865ddeee428732aae46dab58c412a545
title: 功能完成发布元数据的实施步骤
date: 2026-11-10
retrospective: true
---

# 功能完成发布元数据的实施步骤

## 1. 核对目标提交

```bash
git show --stat 6b7bf48
git branch -r --contains 6b7bf48b0b4f0af740073eddbc5584f0c598c539
```

确认发布对象是 6b7bf48 及其功能范围，而不是初始构建恢复提交。

## 2. 更新 RELEASE

在 `docs/RELEASE.md` 末尾新增 Follow-up feature completion：完整 SHA、远端包含关系、功能集合和验证元数据；保留 Cloud xattr、daemon/bridge 的阻塞说明及 STATUS 链接。

## 3. 验收

检查 diff 只修改 RELEASE，且没有改动 `docs/STATUS.md` 或产品源码。核对 SHA、远端包含关系和阻塞项均可由 Git 与目标 revision 复核。
