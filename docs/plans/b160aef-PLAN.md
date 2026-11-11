---
commit: b160aef6c60e6ef3ef0d4bfdf7f97dae7532e02b
title: "Use explicit expressions for live gating"
date: 2026-11-11T09:31:11+08:00
status: partial
kind: component
---

# 实施计划：Use explicit expressions for live gating

> 本文按实际代码依赖重建实施顺序，用于说明怎样完成该提交；不伪称是历史提交当时保存的计划。

## 目标与前置条件

需要明确表达式定界，但 jobs.<job_id>.if 本身已隐式求值，添加 ${{ ... }} 不会改变可用上下文。父版本 env context 不受支持的问题因此仍然存在。

- 以含 job env、未包裹 env if 的父 workflow 为起点，不把后续脚本 guard 当作已有实现。

## 复用与兼容处理

### 复用现有实现

- 复用全部变量定义、布尔操作数、runner 与 live 脚本，只编辑条件文本。

### 兼容、迁移与生命周期

- 表达式的布尔结构、变量映射和脚本接口均不变；runner 后果继承父版本，不能因括号更明确而推定 job 会正常跳过。

## 文件级实施步骤

### 1. 定界 model 表达式

在 model if 的完整比较两侧加入显式表达式符号，不触碰相邻 env 块。

涉及位置：`.github/workflows/live-checks.yml`

### 2. 定界 cloud 表达式

将 cloud 的三比较复合式整体包裹，保留操作数顺序与 &&。

涉及位置：`.github/workflows/live-checks.yml`

### 3. 复核行为未迁移

比较 desktop/skillhub 和四个脚本，确认没有同时改成脚本 guard、runner 检测或 vars gate。

涉及位置：`.github/workflows/live-checks.yml`、`scripts/live-model-validation.ts`、`scripts/live-cloud-validation.ts`、`scripts/live-desktop-validation.ts`、`scripts/live-skillhub-validation.ts`

## 风险与处理

- job if 仍读取不受支持的 env context，语法显式化不修复平台求值问题。
- desktop 为变量开启时仍选择 self-hosted；变量未开启时在脚本前跳过，两种路径都不是 runner 自动探测。
- 若 cloud 进入脚本且没有 token，依旧抛错，本提交没有 CLOUD_LIVE_SKIPPED。

## 验证顺序

1. 用 word diff 确认仅增加两对定界符，再核对脚本和文档无差异；执行结论必须另有 Actions 记录。

## 完成状态与剩余工作

- 状态：**partial**

### 已完成

- 两个目标条件的显式表达式写法已精确落入 workflow，其他中间行为未改。

### 未完成或后续工作

- 有效 job gate、workflow 运行、脚本 skip/success 矩阵及原生桌面验证仍未证明。
