---
commit: e90042354c2cb902b033cf9e06b39d9c67c1b111
title: "Skip desktop validation without self-hosted runner"
date: 2026-11-11T09:40:42+08:00
status: implemented
kind: component
---

# 实施计划：Skip desktop validation without self-hosted runner

> 本文按实际代码依赖重建实施顺序，用于说明怎样完成该提交；不伪称是历史提交当时保存的计划。

## 目标与前置条件

需要让未配置 desktop live 的仓库在 runner 分配前略过 self-hosted job。实际实现是恢复 vars.CLAUDE_DESKTOP_LIVE == 1 的 opt-in 条件，并非查询 runner 库存；变量开启但无 runner 时不能声称会自动跳过。

- 以三个 job if 已删除、model/cloud 脚本 guard 已存在的父版本为基准。
- 确认 desktop 步骤 env 的字面量 1 与脚本 guard 的先后关系。

## 复用与兼容处理

### 复用现有实现

- 复用 vars 配置、self-hosted 标签、现有安装步骤及四个 live 脚本，不添加 runner 管理组件。

### 兼容、迁移与生命周期

- desktop 变量非 1 时，新行为是在 runner 前跳过且没有 DESKTOP_LIVE_SKIPPED 日志；变量为 1 时后续步骤与父版本相同。
- model/cloud 仍在 ubuntu 上启动脚本后处理缺省配置，skillhub 仍无 job if。

## 文件级实施步骤

### 1. 添加 desktop job gate

在 live-checks.yml 的 desktop 下、runs-on 前插入 vars 等值 if，不修改 model/cloud 条件。

涉及位置：`.github/workflows/live-checks.yml`

### 2. 核对 desktop 两阶段行为

对照脚本确认变量非 1 时不会进入 runner/脚本，变量为 1 时步骤字面量 env 选择 screenshot 分支。

涉及位置：`.github/workflows/live-checks.yml`、`scripts/live-desktop-validation.ts`

### 3. 确认其他脚本保持复用

逐文件比较 model、cloud、skillhub，保留已有 skip/success 路径，不混入新的 job gate。

涉及位置：`scripts/live-model-validation.ts`、`scripts/live-cloud-validation.ts`、`scripts/live-skillhub-validation.ts`

## 风险与处理

- 该条件不会探测 self-hosted runner；变量误设为 1 时，无 runner 的 job 仍可能等待或失败，而不是自动 skipped。
- job 级 skip 不含脚本输出，若运营流程依赖 DESKTOP_LIVE_SKIPPED 标记需另行区分。
- 获得 runner 不等于具有授权交互桌面，screenshot 的成功与失败均无随提交记录。

## 验收顺序

1. 检查一行 patch 和脚本零差异，并读取 at-commit STATUS 的原生桌面限制；执行结论需另附具体 Actions 运行来源。

## 完成状态与剩余工作

- 状态：**implemented**

### 已完成

- desktop 的变量 opt-in job gate 已加入，model/cloud 脚本门控与 desktop 成功路径保持不变。

### 未完成或后续工作

- runner 自动发现、变量真假运行矩阵以及真实 native desktop screenshot 验证均未实现或未记录。
