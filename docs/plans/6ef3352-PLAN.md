---
commit: 6ef3352651472a951a3779f7b9f906fbc5ca86ca
title: "Allow live jobs without precreated environment"
date: 2026-11-11T09:18:52+08:00
status: partial
kind: component
---

# 实施计划：Allow live jobs without precreated environment

> 本文按实际代码依赖重建实施顺序，用于说明怎样完成该提交；不伪称是历史提交当时保存的计划。

## 目标与前置条件

提交主题要求允许 job 在没有预建 Environment 时运行，实际补丁只删除三个 Environment 绑定。这样可以改变平台对 named Environment 的依赖，但不会修改任何凭据或桌面开关条件，也不修复 model/cloud 在 job if 使用 secrets 的上下文错误；提交没有平台错误、运行结果或文档同步。

- 以 9cd4c63193ded6eb916bf734f65a427da193faf0 的四 job workflow 为基线，逐行确认只有三个 job 带 Environment。

## 复用与兼容处理

### 复用现有实现

- 复用现有触发器、只读权限、四个脚本入口及所有 secret/vars 映射，不新增 CI 抽象。

### 兼容、迁移与生命周期

- workflow_dispatch、cron、四 job 名称和脚本调用不变。
- desktop 变量非 1 仍是 job-level skip，不是脚本输出 skip；model/cloud 没有脚本 guard，且 secrets job-if 不受支持，不能承诺无凭据时有效跳过。
- 依赖 live-validation Environment 保护或 Environment secrets 的部署语义不再由该 workflow 提供。

## 文件级实施步骤

### 1. 核对 Environment 与 gate 的差别

先区分 named Environment 绑定、model/Cloud 凭据条件和 desktop 变量条件，避免把三种控制混为一个开关。

涉及位置：`.github/workflows/live-validation.yml`、`scripts/live-desktop-validation.ts`

### 2. 删除三个 Environment 绑定

依次从 model、cloud、desktop 删除 environment: live-validation，保持相邻 runs-on、if 和 steps 原样，skillhub 不作补齐。

涉及位置：`.github/workflows/live-validation.yml`

### 3. 检查遗留文档与证据缺口

对照 RELEASE 的 protected environment 表述并标记不一致；平台运行未记录时，仅确认 YAML diff，不补写 CI 成功。

涉及位置：`.github/workflows/live-validation.yml`、`docs/RELEASE.md`

## 风险与处理

- 把 Environment 删除误解为凭据条件删除会高估变更范围；model/cloud 虽未删除 if，但 secrets context 不受支持，条件文本存在不等于门控有效。
- 失去 named Environment 保护是实际安全边界变化，且旧 RELEASE 会误导后续审查。

## 验证顺序

1. 用父提交与当前提交的 workflow diff 确认恰好三行删除，再读取当前文件核对四个 if 全部保留。
2. 若后续取得平台证据，应分别报告 job skipped 与脚本 executed；本提交自身不声明这类结果。

## 完成状态与剩余工作

- 状态：**partial**

### 已完成

- model、cloud、desktop 的 named Environment 绑定已删除，其他 job 编排保持不变。

### 未完成或后续工作

- 文档与新的 Environment 语义未同步，model/cloud 的 secrets job-if 仍无效，workflow 注册和 live job 行为未留下运行证据。
