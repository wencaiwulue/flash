---
commit: 4c04383cd5a2ee8953031948453d99da6d080946
title: "Use env context for live job gating"
date: 2026-11-11T09:29:51+08:00
status: partial
kind: component
---

# 实施计划：Use env context for live job gating

> 本文按实际代码依赖重建实施顺序，用于说明怎样完成该提交；不伪称是历史提交当时保存的计划。

## 目标与前置条件

此次尝试先把 secrets 映射为 job env，再从 if 读取 env，但 jobs.<job_id>.if 同样不支持 env context。创建环境变量并不会扩大该位置的上下文集合，缺陷不能记成已修复。

- 从 secrets job if 的父版本开始，保留 desktop vars 条件与四个脚本的既有行为。

## 复用与兼容处理

### 复用现有实现

- 复用现有 secret 名称、Bun 安装步骤、隔离目录以及所有验证函数，不新增脚本模块。

### 兼容、迁移与生命周期

- job/step env 的值来源与脚本命令不变，但 job 是否可启动仍受不受支持的 env if 影响，不能承诺与原执行兼容。

## 文件级实施步骤

### 1. 建立 model job env

在 model 增加两项 job env，再把 if 的 secret 读取改为 env 读取，保留步骤级同名映射。

涉及位置：`.github/workflows/live-checks.yml`

### 2. 建立 cloud job env

依次加入 token、org UUID、base URL 三项 job env，并同步替换复合 if 的三个操作数。

涉及位置：`.github/workflows/live-checks.yml`

### 3. 检查未触达文件

对照 desktop、skillhub 与脚本，确认本步没有补表达式括号、脚本 guard 或 runner 探测。

涉及位置：`.github/workflows/live-checks.yml`、`scripts/live-desktop-validation.ts`、`scripts/live-model-validation.ts`、`scripts/live-cloud-validation.ts`、`scripts/live-skillhub-validation.ts`

## 风险与处理

- jobs.<job_id>.if 不支持 env context，新增 job env 不能形成可靠的缺省配置跳过。
- desktop 变量只提供 opt-in；变量开启时仍要求 self-hosted runner，未开启时没有 DESKTOP_LIVE_SKIPPED 脚本日志。
- 同名 job/step env 重复增加维护面，却没有改变脚本内的凭据读取。

## 验收顺序

1. 逐行检查 9+/2- patch，并比较当前与父脚本；平台行为需要单独保存的 workflow 日志，不能从 YAML 推断成功。

## 完成状态与剩余工作

- 状态：**partial**

### 已完成

- model/cloud 的 job env 创建与 env context 改写已完成，desktop 和脚本中间态均保留。

### 未完成或后续工作

- job-if 可用性缺陷尚未解决，CI 跳过矩阵和原生桌面执行均无记录。
