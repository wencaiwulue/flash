---
commit: ab2d941c75f445320180c2559bc62e146238aacc
title: 提交文档 CI 元数据的实施步骤
date: 2026-11-11
retrospective: true
---

# 提交文档 CI 元数据的实施步骤

## 1. 核对现有政策段

确认 RELEASE 已包含历史 SPEC/PLAN、INDEX、JSON 和 self 约定，以及 CI 先 writer 后 checker 的流程。

## 2. 追加 CI 元数据

在 self 约定之后追加 full-history generation/validation 的 CI 元数据，不修改记录、索引、生成器或 workflow。

## 3. 验收

检查单文件追加与现有数量、self 语义一致；不要把该元数据描述为只读门控或功能运行结果。
