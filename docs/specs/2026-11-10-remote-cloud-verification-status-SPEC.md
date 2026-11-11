---
commit: 2ff078cf60517f6aafe5e8fd542e2369334c17e3
title: 追加 remote-control 与 Cloud 的发布验证元数据
date: 2026-11-10
retrospective: true
---

# 追加 remote-control 与 Cloud 的发布验证元数据

## 设计

该提交在 `docs/RELEASE.md` 的“下一提交补充验证信息”占位之后追加 `02bc3c2` 的完整 SHA、CI 与离线验证元数据，使发布说明与该实现提交关联。没有新增协议或运行时改动，真实 Cloud 授权环境仍与离线 fake transport/API 验收分开。

## 验收标准

1. RELEASE 指向完整 `02bc3c2` SHA，追加位置位于原占位之后。
2. 验证元数据只描述该提交的离线实现范围，不扩大为真实 Cloud 往返。
3. diff 只有 RELEASE 追加内容，没有修改 bridge、Files 或 SDK 代码。
