---
commit: e92caa6639daf982d3299a485dfc6c0b5ff7f1e7
title: "Implement local skill discovery"
date: 2026-11-10T19:47:22+08:00
status: implemented
---

# Implementation plan: Implement local skill discovery

## Objective

实现本地 skill 索引、Fuse 搜索、自然语言回退、去重及多信号 prefetch。

## Implementation steps

1. 复核目标、现有实现和复用模块。
2. 按提交范围修改实现并补充回归。
3. 执行验证、记录状态与未实现边界。

## Risks and mitigations

仅使用本地命令元数据，不调用未知远程协议。

## Verification sequence

排名、过滤、turn-zero/write-pivot/subagent prefetch 与缓存失效测试。

## Completion status and remaining work

- Status: **implemented**
- Remaining: 远程 canonical skill 后端当时仍未实现。
