---
commit: e90042354c2cb902b033cf9e06b39d9c67c1b111
title: 无授权桌面 runner 时跳过 desktop job
date: 2026-11-11
retrospective: true
---

# 无授权桌面 runner 时跳过 desktop job

## 设计

该提交仅为 desktop 恢复 `if: vars.CLAUDE_DESKTOP_LIVE == '1'`。默认未开启时 job 不进入 self-hosted 队列；显式开启后才复用原 runner、脚本和独立 HOME/config。

model/cloud 的脚本内 skip guard 不变，desktop 的 job-level guard 与脚本内 DESKTOP_LIVE_SKIPPED 是两层不同机制。

## 验收标准

1. desktop 仅增加 vars if，其他 job 和脚本不变。
2. 变量非 1 时 job 不调度；为 1 时才进入 self-hosted 和 screenshot 探针。
3. 变量值不能被描述为 runner 自动发现，授权桌面环境仍需由配置方提供。
