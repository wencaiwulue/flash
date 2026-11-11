---
commit: 271cf757a24eb6cd7e46586fa18995759be32043
title: "Record final CI verification"
date: 2026-11-11T01:07:01+08:00
status: implemented
kind: evidence-update
---

# 实施计划：Record final CI verification

> 本文按实际代码依赖重建实施顺序，用于说明怎样完成该提交；不伪称是历史提交当时保存的计划。

## 目标与前置条件

离线验证数量与最终代码状态需要可追溯的提交/run 关联；缺这一行时，读者只能看到验证声明，无法从发布记录定位 e31ff8f 与 CI 42861258902。

- 确认目标验证段已经包含 152/645，且要记录的实现 SHA 是 e31ff8f 而非当前证据提交。

## 复用与兼容处理

### 复用现有实现

- 沿用 RELEASE 的 Verification/Commit 元数据格式，不另建状态表。

### 兼容、迁移与生命周期

- 原有段落顺序和验证数字保持不变，只增加可追溯元数据。

## 文件级实施步骤

### 1. 定位既有验证段

找到包含 152 tests、645 assertions 的段落，确认其功能范围与待关联提交一致。

涉及位置：`docs/RELEASE.md`

### 2. 追加提交和 CI 证据

在该段末尾写入 e31ff8f full SHA 与 42861258902 passed，不改动其他验证声明。

涉及位置：`docs/RELEASE.md`

## 风险与处理

- 把当前证据提交 SHA 错写成实现提交会断开归因，因此必须核对 e31ff8f。

## 验证顺序

1. 检查单文件单行 diff，并在 at-commit RELEASE 中搜索 run ID 与实现 SHA。

## 完成状态与剩余工作

- 状态：**implemented**

### 已完成

- 实现提交和 hosted CI 标识已进入同一发布验证段。

### 未完成或后续工作

- 未在此提交重新执行或抓取 CI 日志，记录本身不是新的运行环境。
