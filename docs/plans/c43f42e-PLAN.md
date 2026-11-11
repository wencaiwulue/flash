---
commit: c43f42e4eba9ae16c7d7a78dfbcfcb4bfb177d0c
title: "Isolate CI lifecycle test timing and cwd"
date: 2026-11-11T00:44:19+08:00
status: implemented
kind: component
---

# 实施计划：Isolate CI lifecycle test timing and cwd

> 本文按实际代码依赖重建实施顺序，用于说明怎样完成该提交；不伪称是历史提交当时保存的计划。

## 目标与前置条件

需要减少 CI 中由共享 cwd 和偏紧计时窗口造成的测试不稳定，同时不改变 ReviewArtifact 或 cron 产品实现。这里的修复只建立异步上下文隔离并放宽接管等待，不解决 first 必获锁的假设，也不注入锁探测间隔。

- 确认 cwd.ts 已提供 AsyncLocalStorage override，ReviewArtifact 通过 getCwd 解析相对路径，无需新增测试专用生产接口。
- 确认 cron 回归使用真实计时器和既有 5000 毫秒锁探测，本步只调整等待预算。

## 复用与兼容处理

### 复用现有实现

- 复用 mkdtemp/rm 临时目录、fake review runner、虚拟 now、waitFor 和现有锁生命周期。
- 复用 runWithCwdOverride，让被测异步调用及其后代看到同一目录，而不是模拟 ReviewArtifact 内部路径解析。

### 兼容、迁移与生命周期

- 生产 API、feature flag、cron 文件格式和 ReviewArtifact 路径契约均不变。
- 测试仍使用相对 artifact 路径，因此继续覆盖异步 cwd override 对 getCwd 的影响。

## 文件级实施步骤

### 1. 隔离 artifact 测试的异步 cwd

在 reviewArtifact.test.ts 移除 getCwdState/setCwdState 导入及保存/恢复语句，把写入后的相对路径读取包进 runWithCwdOverride。保留同一临时目录、fake runner、summary 断言和 finally 删除，使文件解析仍走真实 getCwd 路径。

涉及位置：`tests/reviewArtifact.test.ts`

### 2. 放宽 cron 锁接管等待窗口

在 cronLifecycle.test.ts 将 secondFired 的 waitFor 超时改为 30 秒，并将该测试的总超时改为 40 秒；不改 first owner 前提、虚拟时间推进或调度器常量。

涉及位置：`tests/cronLifecycle.test.ts`

## 风险与处理

- 真实计时器在慢速 CI 上仍可能波动；30/40 秒只是更宽窗口，并不使 owner 选择或锁探测确定化。
- AsyncLocalStorage 只覆盖当前异步调用链，不能把其他未包裹测试的全局 cwd 写入变得安全。

## 验证顺序

1. 定向运行 ReviewArtifact 文件读取测试，并在并行测试环境下确认相对路径读取不依赖全局 cwd 恢复。
2. 重复运行 cron takeover 测试，核对 30 秒接管等待和 40 秒总预算；执行结果须另有命令或 CI 来源。

## 完成状态与剩余工作

- 状态：**implemented**

### 已完成

- ReviewArtifact 测试已切换到异步本地 cwd，cron 接管等待已放宽，且没有产品源码变更。

### 未完成或后续工作

- 固定 first owner、固定探测周期和 stop/restart 状态问题仍未在该 revision 处理。
- 本提交没有独立定向或全量执行记录；at-commit STATUS 的 152/645 是 adaa8ff 留下的先前基线，真实模型和多进程运行也仍无证据。
