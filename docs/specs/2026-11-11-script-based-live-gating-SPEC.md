---
commit: 97b13fd5279b917c69462da929db00bba942de6a
title: 将 model/Cloud 缺配置判断移入脚本
date: 2026-11-11
retrospective: true
---

# 将 model/Cloud 缺配置判断移入脚本

## 设计

该提交删除 model、cloud、desktop 的 job-level if。model 在 `main()` 开头检查 API key，缺失时输出 MODEL_LIVE_SKIPPED 并 return；Cloud 在无 OAuth token 时输出 CLOUD_LIVE_SKIPPED，只有存在 token 才解析 orgUUID/baseUrl 并进入 bridge 流程。

desktop 暂时没有 job-level 开关，self-hosted job 仍会被调度，需要后续独立处理。

## 验收标准

1. model/cloud 缺配置输出独立 skip 标记，不创建模型或 Cloud 资源。
2. Cloud 有 token 时的 bridge、Files、archive 和清理逻辑不变。
3. 三个 job-level if 被移除，desktop 无 runner 时的调度边界必须另行处理。
