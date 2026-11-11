---
commit: a8c8b90fd2e7b5fa14ebb2bc6beff3f5c2904346
title: LSP 与 cron 生命周期竞态修复
date: 2026-11-11
retrospective: true
---

# LSP 与 cron 生命周期竞态修复

## LSP 关闭与错误状态

`LSPClient` 新增 connectionClosed，在 process exit 和 connection.onClose 时置位，新的 start 重置。stop 只在连接尚未关闭时发送 shutdown request 和 exit notification，避免进程已崩溃时等待永远不会到来的响应；force-kill timer 仍作为超时兜底。

`LSPServerInstance` 在普通 crash recovery 超限和显式 maxRestarts 超限两条路径都设置 `lastError` 与 `state:'error'`，避免抛出错误后实例仍显示 running。

## Cron 时间与一次性任务提交点

`createCronScheduler` 新增 `now()` 注入，initial missed-task 计算和每次 check 共用，生命周期测试可以确定性推进时间。

一次性任务删除不再只等待磁盘 removeCronTasks：磁盘删除成功后，立即从内存 tasks 过滤该 ID。这样磁盘删除与 chokidar 异步 reload 之间，旧任务不会因内存仍保留而再次触发。

## 新增回归范围

- `changedFiles.test.ts`：offset/limit 读取只报告该范围变化，范围外编辑不产生附件；删除文件同时清缓存。
- `cronLifecycle.test.ts`：one-shot 只触发一次并清 nextFireTime，recurring 重新排期，maxAgeMs=0 与 permanent 语义，以及 owner stop 后的锁接管。
- `lspLifecycle.test.ts` 与 `fake-lsp-server.ts`：真实 JSON-RPC 初始化/echo/crash、重启、超限 error、优雅停止超时后的 force kill。

## 验收标准

1. 已关闭连接不发送 shutdown/exit，仍存活连接保留优雅停止与超时 force kill。
2. 两种 maxRestarts 超限都设置 lastError 和 error 状态。
3. one-shot 在磁盘与 watcher 之间不会重复触发；recurring、permanent、maxAgeMs=0 和锁接管行为正确。
4. changed-file 范围、删除缓存和 fake LSP 全生命周期测试均通过对应测试文件验证。
