---
commit: dab8405a36c2cb18c22b58235c8124265666b162
title: 剩余实现边界文档的实施步骤
date: 2026-11-10
retrospective: true
---

# 剩余实现边界文档的实施步骤

## 1. 核对各能力当前状态

检查 HISTORY_SNIP/REVIEW_ARTIFACT stub、remote loader、Monitor local-shell 路径、外部 backends，以及 changed-file/cron/LSP 测试目录。

## 2. 新增边界清单

在 STATUS 增加 Remaining implementation boundaries，逐项写清当前状态和不可用路径；明确 Monitor 使用 local-shell，不创建 monitor_mcp。

## 3. 重排实施顺序

先实现 Snip/ReviewArtifact，再补生命周期测试，随后模型与 Cloud/bridge 验证；pure env-less perpetual 仅在产品要求移除 Environments API 时进行。

## 4. 验收

确认 diff 只有 STATUS，所有边界都能由对应 revision 的源码或测试目录支持。
