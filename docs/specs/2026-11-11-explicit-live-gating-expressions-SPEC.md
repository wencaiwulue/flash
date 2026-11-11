---
commit: b160aef6c60e6ef3ef0d4bfdf7f97dae7532e02b
title: 将 live 门控改为显式表达式
date: 2026-11-11
retrospective: true
---

# 将 live 门控改为显式表达式

## 设计

该提交只把 model/cloud 的 `if: env...` 改为 `if: ${{ env... }}`，不改变条件变量、逻辑或 job 配置。显式 `${{ }}` 用于消除条件表达式解析歧义，cloud 的三个条件仍在同一表达式内。

## 验收标准

1. model/cloud 的 if 使用显式 `${{ }}`，条件文本与父提交相同。
2. 没有修改 secrets 映射、desktop vars、脚本或其他 YAML。
3. 文档不得把语法变化描述为新的凭据功能。
