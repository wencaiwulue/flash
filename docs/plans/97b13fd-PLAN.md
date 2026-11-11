---
commit: 97b13fd5279b917c69462da929db00bba942de6a
title: "Move live validation gating into scripts"
date: 2026-11-11T09:33:58+08:00
status: partial
kind: component
---

# 实施计划：Move live validation gating into scripts

> 本文按实际代码依赖重建实施顺序，用于说明怎样完成该提交；不伪称是历史提交当时保存的计划。

## 目标与前置条件

受支持的 job 条件可在 runner 启动前结束任务，但父提交的 model/cloud 条件并不具备该可靠语义。此次把 model/cloud 的可用性判断下放到脚本，同时删除 desktop 的有效 vars gate；workflow 仍向 desktop 脚本固定传 1，不能把这个中间态写成三种门控都已完整迁移。

- 以含三个 job if、cloud 缺 token 抛错的父版本为起点。
- 先确认 desktop guard 已存在，避免把复用代码列成新增实现。

## 复用与兼容处理

### 复用现有实现

- 保留 model 成功标记和外层清理，以及 cloud 的 session、持久化、archive 与 finally 流程。

### 兼容、迁移与生命周期

- 已配置 model/cloud 的调用序列不变；未配置 job 现在仍会 checkout、安装依赖并进入脚本，脚本 skip 不等于原 job skip。
- desktop 独立调用仍可在变量非 1 时跳过，但此 workflow 显式传入 1。

## 文件级实施步骤

### 1. 加入 model 提前返回

在 main 首部检查 falsy ANTHROPIC_API_KEY，输出 MODEL_LIVE_SKIPPED 后返回。

涉及位置：`scripts/live-model-validation.ts`

### 2. 重组 cloud token 分支

将缺 token 异常替换为跳过日志，把组织解析、params 和 live try/finally 放入 else。

涉及位置：`scripts/live-cloud-validation.ts`

### 3. 移除 workflow job gate

核对 desktop 既有 guard 与字面量步骤环境后，只删除三个目标 if，不动 skillhub。

涉及位置：`.github/workflows/live-checks.yml`、`scripts/live-desktop-validation.ts`

## 风险与处理

- cloud 在 token 检查前已 mkdtemp，跳过分支不进入负责删除该目录的 live try/finally。
- desktop 失去仓库变量 job gate 后，被选中的 self-hosted runner 会继续 screenshot probe。
- cloud 有 token 但无 org UUID 仍会失败，不是所有缺省配置都跳过。

## 验证顺序

1. 检查补丁为 workflow 三行删除、model guard 新增和 cloud else 重组，且 desktop 文件无差异。
2. 后续运行配置/缺省矩阵时应分别捕获 skip 与 success 标记；此处不声明这些运行已经发生。

## 完成状态与剩余工作

- 状态：**partial**

### 已完成

- model/cloud 的脚本 guard 和三个 job if 的删除已落入 at-commit 内容；desktop 固定 live 的步骤环境与既有脚本 guard 未改。

### 未完成或后续工作

- desktop 的仓库变量门控未迁移到脚本，cloud 的无 token 临时目录清理也不完整；配置矩阵、外部服务响应及 runner 选择均无随提交记录。
