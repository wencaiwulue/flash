---
commit: b183b9a76948750cf396dd36c62ad06a62221b60
title: "Gate live validation jobs on available environments"
date: 2026-11-11T09:28:02+08:00
status: partial
kind: component
---

# 实施计划：Gate live validation jobs on available environments

> 本文按实际代码依赖重建实施顺序，用于说明怎样完成该提交；不伪称是历史提交当时保存的计划。

## 目标与前置条件

需要把 model 可用性门控并补入 cloud、desktop 编排，但实现直接在 jobs.<job_id>.if 使用 secrets；该位置不支持 secrets context，不能把新增条件描述为已验证的空值跳过。

- 以仅有 model、skillhub 的父 workflow 为基准，并确认 cloud/desktop 脚本已经存在。
- 区分 job-if 上下文、步骤 env 和 GitHub Environment，不能把三者混写。

## 复用与兼容处理

### 复用现有实现

- 复用四个 live 脚本、Bun 安装序列、隔离 HOME/CLAUDE_CONFIG_DIR 及 workflow_dispatch/schedule。

### 兼容、迁移与生命周期

- skillhub 编排不变；其余脚本主体也未改，但能否进入脚本取决于新增 job 条件，不能沿用父版本必然启动的结论。

## 文件级实施步骤

### 1. 门控既有 model job

在 workflow 的 model 下加入 secret 非空 if，保留原 steps 与 step env。

涉及位置：`.github/workflows/live-checks.yml`

### 2. 接入 cloud 文件

追加 ubuntu cloud job，设置三项条件、安装步骤、脚本命令和对应 secret 映射。

涉及位置：`.github/workflows/live-checks.yml`、`scripts/live-cloud-validation.ts`

### 3. 接入 desktop 文件

追加 self-hosted desktop job 和 vars opt-in，核对既有脚本 guard 会被步骤字面量 1 绕过。

涉及位置：`.github/workflows/live-checks.yml`、`scripts/live-desktop-validation.ts`

### 4. 核对未改边界

确认 model、skillhub 脚本和 STATUS/RELEASE 无 diff，不把既有说明当成本次运行结果。

涉及位置：`scripts/live-model-validation.ts`、`scripts/live-skillhub-validation.ts`、`docs/STATUS.md`、`docs/RELEASE.md`

## 风险与处理

- jobs.<job_id>.if 不支持 secrets context，model/cloud 不能据此宣称可靠跳过或 CI 可运行。
- desktop 变量为 1 但没有 self-hosted runner 时不会由该表达式自动跳过；为假时虽可免占 runner，却没有脚本 skip 日志。
- cloud job 若实际进入且缺 token，复用脚本会失败而不是输出 CLOUD_LIVE_SKIPPED。

## 验收顺序

1. 静态比较父/当前 workflow 与四个脚本，确认 33 行新增和脚本零差异。
2. 后续应分别留存 workflow 解析、条件真假、runner 选择与脚本输出；本记录不宣称这些执行已发生。

## 完成状态与剩余工作

- 状态：**partial**

### 已完成

- 初始 model 条件及 cloud、desktop 编排已落入 at-commit workflow，复用脚本和文档边界已核对。

### 未完成或后续工作

- 有效的 model/cloud job gate、runner 可用性检测以及所有 CI/live 执行结果均未随提交证明。
