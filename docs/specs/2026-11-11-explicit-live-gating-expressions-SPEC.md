---
commit: b160aef6c60e6ef3ef0d4bfdf7f97dae7532e02b
title: "Use explicit expressions for live gating"
date: 2026-11-11T09:31:11+08:00
status: partial
kind: component
---

# Use explicit expressions for live gating

> 本文是依据该提交的 diff、对应 revision 的实现与测试，以及有出处的状态记录所作的回溯性设计重建；不冒充历史提交当时已存在的原文。

## 前置状态与问题

父版本已经建立 model/cloud job env，并把对应 if 改成未包裹的 env context 表达式；desktop 仍是 vars 条件。脚本状态也尚未变化：model 无密钥 guard、cloud 缺 token 抛错、desktop 由字面量步骤 env 进入 live 分支。

需要明确表达式定界，但 jobs.<job_id>.if 本身已隐式求值，添加 ${{ ... }} 不会改变可用上下文。父版本 env context 不受支持的问题因此仍然存在。

## 目标与非目标

### 目标

- 把 model 的单个 env 比较包进一对显式表达式定界符。
- 把 cloud 含 && 的三项比较包进同一对定界符，其他字符保持不变。
- 不调整 job env、desktop/skillhub、runner 或验证脚本。

### 非目标

- 不创建或修改环境变量，不替换 env context，也不新增 GitHub Environment。
- 不把语法改动写成 CI 运行、脚本跳过或原生 desktop probe 运行。

## 方案架构与数据流

这是 workflow 表达式语法层修改：job env 仍由父提交提供，if 只求值既有 env 名称；没有新的运行时组件或脚本控制流。

### 文件、接口与证据关系

| 关系 | 位置 | 设计作用 |
|---|---|---|
| 变更 | `.github/workflows/live-checks.yml` | 仅给 model/cloud 的 env if 增加显式定界符。 |
| 复用 | `scripts/live-model-validation.ts`，符号 `async function main()` | 没有新增 model 缺省配置 guard。 |
| 复用 | `scripts/live-cloud-validation.ts`，符号 `Claude OAuth is required for cloud validation` | cloud 仍在缺 token 时抛错。 |
| 复用 | `scripts/live-desktop-validation.ts`，符号 `DESKTOP_LIVE_SKIPPED` | 既有 guard 未改，workflow 运行步骤时传入 1。 |
| 复用 | `scripts/live-skillhub-validation.ts`，符号 `SKILLHUB_LIVE_OK` | skillhub 及其 job 均不参与语法修改。 |
| 复用 | `docs/RELEASE.md`，符号 `## CI live validation` | 既有发布段不能充当这次表达式修改的执行证据。 |
| 复用 | `docs/STATUS.md`，符号 `Live validation gaps` | 当时仍列有授权环境与原生桌面缺口。 |

## 关键决策与工程取舍

- cloud 整段布尔表达式只使用一对 opening/closing 定界符，而非分别包裹三个比较。
- desktop 的隐式 vars 表达式不在 diff 中，self-hosted runner 与 CLAUDE_DESKTOP_LIVE=1 步骤环境均原样保留。

### 备选方案与回溯分析

- 保留隐式 if 也能表达同样布尔式；若改为受支持的变量来源则属于语义修复，不是本次纯定界符编辑。

## 安全与协议边界

- 补丁只增加表达式符号，不改变 secrets 映射、权限、输出或凭据生命周期，记录不含任何配置值。

## 验收标准

- diff 只有 model/cloud 两行替换，新增与删除各 2 行。
- job env 和步骤 env 数量不变，model/cloud/desktop 脚本 guard 行为与父提交一致。

## 实现状态与剩余范围

- 状态：**partial**
- 显式表达式仍未解决 job if 的 env context 限制，实际 workflow 是否被接受需要平台证据。
