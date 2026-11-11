---
commit: 3948f914500e3982fb160607250d6a2e22f0578d
title: Cron 锁接管的确定性测试设计
date: 2026-11-11
retrospective: true
---

# Cron 锁接管的确定性测试设计

## 设计

`createCronScheduler` 新增 `lockProbeIntervalMs`，默认仍是 5000ms，测试可将 second scheduler 的 probe 间隔设为 50ms，避免把验证耗时绑定到生产默认值。

接管测试不再假设 first 一定获得锁：等待任一 scheduler 的 nextFireTime 出现后推进时间，再等待 firstFired+secondFired 至少一次。实际触发者作为 owner，另一个作为 other；断言 other 未触发，owner.stop 后等待 otherFired。

## 验收标准

1. 未传 lockProbeIntervalMs 时生产默认仍为 5000ms，测试注入只影响目标实例。
2. 两个实例无论谁先获锁，测试都按实际触发者选择 owner/other。
3. owner 停止前 other 不重复触发，停止后 other 在条件等待内接管。
4. 测试不依赖固定 owner 名称或默认 probe 周期，同时保留超时上限。
