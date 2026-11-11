---
commit: 4dd93b75220926cefbe9d5d017224238bfd8e0f1
title: 重命名 live workflow 文件以重新注册
date: 2026-11-11
retrospective: true
---

# 重命名 live workflow 文件以重新注册

## 设计

该提交将 `.github/workflows/live-validation.yml` 纯重命名为 `live-checks.yml`，Git 相似度 100%。文件内容、job、触发器和脚本不变，设计动作仅是改变 Actions 注册路径，不能虚构产品架构变化。

## 验收标准

1. 新路径存在且与旧路径逐字节一致，旧路径不存在。
2. Git 显示 rename 而非 delete+add，工作流 name 与全部 job 不变。
3. 后续门控修改必须基于 live-checks.yml，避免继续编辑已不存在的旧文件。
