---
commit: c43f42e4eba9ae16c7d7a78dfbcfcb4bfb177d0c
title: "Isolate CI lifecycle test timing and cwd"
date: 2026-11-11T00:44:19+08:00
status: implemented
kind: component
---

# Isolate CI lifecycle test timing and cwd

> 本文是依据该提交的 diff、对应 revision 的实现与测试，以及有出处的状态记录所作的回溯性设计重建；不冒充历史提交当时已存在的原文。

## 前置状态与问题

父提交的 ReviewArtifact 文件读取测试虽然使用 mkdtemp 隔离目录，却通过 getCwdState/setCwdState 改写进程级 cwd，并在 finally 恢复；并发异步测试可能观察到这份临时全局状态。cron takeover 回归固定等待 first 获锁和触发，second 接管等待为 12 秒、整个测试上限为 15 秒，而非 owner 的锁探测常量仍为 5000 毫秒。

需要减少 CI 中由共享 cwd 和偏紧计时窗口造成的测试不稳定，同时不改变 ReviewArtifact 或 cron 产品实现。这里的修复只建立异步上下文隔离并放宽接管等待，不解决 first 必获锁的假设，也不注入锁探测间隔。

## 目标与非目标

### 目标

- 用 runWithCwdOverride 将 ReviewArtifact 的临时目录限制在当前异步调用链，移除测试对全局 cwd 的写入和恢复。
- 把 second 接管等待从 12 秒放宽到 30 秒，并把整个 cron takeover 测试上限从 15 秒调整为 40 秒。

### 非目标

- 不修改 cronScheduler、cronTasksLock、ReviewArtifactTool 或生产 cwd 解析逻辑。
- 不让测试接受 second 先获锁，不改变 5000 毫秒生产探测周期，也不添加 stop/start 重启回归。
- 不把临时目录与 fake review runner 测试描述为真实模型 artifact review 或多进程 cron 验证。

## 方案架构与数据流

ReviewArtifact 测试继续在同一临时目录写 artifact.txt，但调用改为 runWithCwdOverride(dir, () => reviewArtifact(...))。既有 cwd.ts 用 AsyncLocalStorage<string> 保存 override，pwd/getCwd 在当前异步上下文及其后代读取它，未设置时才回退 getCwdState；因此测试 finally 只需删除目录，不再恢复全局状态。

cron 测试的调度器、虚拟 now、锁实现和 first/second 断言均保持原样，唯一时序变化是 waitFor 的 secondFired 上限扩为 30_000，test 总预算扩为 40_000。真实 setInterval 仍按 1000 毫秒 check、5000 毫秒 lock probe 运行，放宽的是等待窗口而非虚拟时钟。

### 文件、接口与证据关系

| 关系 | 位置 | 设计作用 |
|---|---|---|
| 变更 | `tests/cronLifecycle.test.ts`，符号 `secondFired.length >= 1, 30_000` | 只放宽 second 接管与整个测试的实时等待上限。 |
| 变更 | `tests/reviewArtifact.test.ts`，符号 `runWithCwdOverride(dir` | 用异步本地 cwd 包住 artifact 读取，移除全局 cwd 写入/恢复。 |
| 复用 | `src/utils/cwd.ts`，符号 `new AsyncLocalStorage<string>()` | 复用父提交已有的异步上下文 cwd override，pwd/getCwd 的回退逻辑不变。 |
| 复用 | `src/tools/ReviewArtifactTool/ReviewArtifactTool.ts`，符号 `resolve(getCwd(), input.artifact_path!)` | 被测实现继续通过 getCwd 解析相对 artifact 路径，本提交不改产品代码。 |

## 关键决策与工程取舍

- 复用已经存在的 AsyncLocalStorage cwd 入口，而不是在测试中另建 mock 或继续 setCwdState；这样被测 reviewArtifact 仍经正常 getCwd/resolve 路径读取文件。
- 本提交仅放大接管时间预算，保留固定 owner 断言；owner-neutral 选择和可注入 probe interval 不属于该 diff。

### 备选方案与回溯分析

- 回溯性比较：可以继续依赖 try/finally 恢复全局 cwd，但那不能隔离恢复前的并发读取；也可以直接改用绝对路径，但本提交实际先验证 AsyncLocalStorage override，绝对路径简化不在此范围。
- 回溯性比较：可以把锁探测改成更短的生产常量来加速测试，但那会改变所有调用方；本提交只延长测试等待，保持调度器行为不变。

## 安全与协议边界

- AsyncLocalStorage override 限定测试读取临时 artifact 的 cwd，不新增文件权限或扩大 ReviewArtifact 的输入契约。
- 两个变更文件都是测试，没有新增网络访问、凭据处理或生产权限分支。

## 验收标准

- ReviewArtifact 测试在 override 异步上下文中读取相对 artifact.txt，源码不再导入或调用 getCwdState/setCwdState，并始终清理临时目录。
- cron takeover 的 second 等待上限为 30 秒、测试上限为 40 秒，原有单 owner 触发断言不变。
- 产品源码零变更，cwd override 与锁探测的既有生产默认值不被测试调整改写。

## 实现状态与剩余范围

- 状态：**implemented**
- 该 revision 的 takeover 测试仍假设 first 是 owner，锁探测间隔也固定为 5000 毫秒；异步获锁先后与测试速度尚未解耦。
- stop/start 的调度状态重置不在本提交覆盖内，真实多进程锁竞争和真实模型 review 仍无新增证据。
