---
commit: 9525612e328486ceb996e3ce3327c0119129bf29
title: "Generate commit documentation before CI checks"
date: 2026-11-11T11:26:09+08:00
status: implemented
kind: component
---

# 实施计划：Generate commit documentation before CI checks

> 本文按实际代码依赖重建实施顺序，用于说明怎样完成该提交；不伪称是历史提交当时保存的计划。

## 目标与前置条件

该提交选择在 checker 前执行 document-commits.ts，让 CI 能自行生成上一提交文档。这解决了漏生成导致的失败，却同时让 checker 验证刚刚由同一生成器写出的内容，无法证明仓库原本提交的文档完整或未过期。

- 确认上一 self 的 SHA 文档由生成器负责，且当前 CI 已 checkout 全历史。

## 复用与兼容处理

### 复用现有实现

- 复用既有两个 Bun 脚本及其共享 buildCommitDocuments，不引入新的文档格式。

### 兼容、迁移与生命周期

- 本地生成命令和文档路径不变，CI 对漏提交生成结果变得更宽容。

## 文件级实施步骤

### 1. 展开文档 CI 步骤

把单行 run 改为多行 block，在第一行调用生成器，让上一 self 的 SHA 文件先落到工作树。

涉及位置：`.github/workflows/ci.yml`

### 2. 保留 checker 与后续验证

第二行继续调用原 checker，typecheck/test/build/smoke 不变；同时记录这种写后查无法检测提交遗漏的限制。

涉及位置：`.github/workflows/ci.yml`

## 风险与处理

- 同一输入既生成又验证会产生自证，缺失文档可能在 CI 中被临时补齐而不再失败。

## 验收顺序

1. 检查 patch 的命令顺序，并用后续 run 只证明 workflow 可执行；另行审查 committed tree 才能发现其独立性缺口。

## 完成状态与剩余工作

- 状态：**implemented**

### 已完成

- 生成器已进入文档检查步骤，后续有 run 通过的记录。

### 未完成或后续工作

- 没有实现只读 CI 校验，也没有增加针对 stale/missing committed artifact 的回归。
