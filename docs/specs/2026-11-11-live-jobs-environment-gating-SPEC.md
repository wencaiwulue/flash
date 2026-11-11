---
commit: 6ef3352651472a951a3779f7b9f906fbc5ca86ca
title: 移除 live job 的预建 Environment 绑定
date: 2026-11-11
retrospective: true
---

# 移除 live job 的预建 Environment 绑定

## 设计

该提交只从 model、cloud、desktop 三个 job 删除 `environment: live-validation`，使 runner 选择不再依赖预先创建的 GitHub Environment。四个 job、脚本、凭据映射和 job-level if 均未改变。

这消除了 Environment protection/审批这一外部依赖，但不会修复 model/cloud 在 `jobs.*.if` 中直接引用 secrets 的上下文问题，也不会自动授予 OAuth 或桌面环境。

## 验收标准

1. 三个 job 不再声明 environment，其余 YAML 与父提交一致。
2. model/cloud/desktop 的 runner、脚本和 env 映射不变。
3. 文档不得把删除 Environment 绑定解释为凭据门控或 live 可用性已经成立。
