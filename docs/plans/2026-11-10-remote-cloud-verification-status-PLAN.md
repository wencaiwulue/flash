---
commit: 2ff078cf60517f6aafe5e8fd542e2369334c17e3
title: Remote/Cloud 发布元数据的实施步骤
date: 2026-11-10
retrospective: true
---

# Remote/Cloud 发布元数据的实施步骤

## 1. 核对实现范围

```bash
git show --stat 02bc3c2
```

确认 remote-control、Cloud Files 和对应离线测试属于该提交。

## 2. 追加发布元数据

在 RELEASE 原“下一提交补充”文本后写入完整 SHA、CI 与离线验证元数据，保留真实授权环境作为独立边界，不修改实现文件。

## 3. 验收

检查完整 SHA、追加位置和单文件 diff；确保没有将 fake transport 描述为真实 Cloud 或 remote bridge 往返。
