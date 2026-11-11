---
commit: dab8405a36c2cb18c22b58235c8124265666b162
title: 显式记录剩余实现边界与实施顺序
date: 2026-11-10
retrospective: true
---

# 显式记录剩余实现边界与实施顺序

## 设计

该提交在 `docs/STATUS.md` 新增 “Remaining implementation boundaries”，把 HISTORY_SNIP、REVIEW_ARTIFACT、remote canonical skills、MonitorMcpTask、KAIROS/Buddy/Fork/private backends，以及 changed-file/cron/LSP 测试缺口逐项列出。

随后重排 Next implementation order：先 HISTORY_SNIP 与 ReviewArtifact，再补 changed-file/cron/LSP 生命周期测试，之后是模型会话、Cloud/remote bridge 和可选 pure env-less perpetual。Monitor 的可用路径明确是 local-shell，不是 legacy monitor_mcp。

## 验收标准

1. 每个边界都对应当时 stub、未启用后端或缺失测试，不与现有 local-shell Monitor 混淆。
2. 实施顺序与新增边界一一对应，pure env-less perpetual 保持可选而非默认替换。
3. diff 只修改 STATUS，不把构建状态当成这些能力已完成。
