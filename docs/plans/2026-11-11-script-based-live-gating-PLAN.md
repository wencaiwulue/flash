---
commit: 97b13fd5279b917c69462da929db00bba942de6a
title: 脚本门控的实施步骤
date: 2026-11-11
retrospective: true
---

# 脚本门控的实施步骤

## 1. 移除三个 job-level if

**文件：** `.github/workflows/live-checks.yml`。

仅删除 model、cloud、desktop 的 if，保留 job env 和步骤。

## 2. 添加 model guard

**文件：** `scripts/live-model-validation.ts`。

在 main() 第一行检查 `!process.env.ANTHROPIC_API_KEY`，输出 MODEL_LIVE_SKIPPED 并 return，放在 enableConfigs 之前。

## 3. 添加 Cloud guard

**文件：** `scripts/live-cloud-validation.ts`。

token 缺失时输出 CLOUD_LIVE_SKIPPED；orgUUID/baseUrl、params、bridge 和清理逻辑放入 else，确保无 token 不进入外部调用。

## 4. 验收

分别运行空 token 的 model/cloud 脚本，检查 skip 标记和资源未创建；有配置时再按原探针验收。desktop 无 self-hosted runner 的调度仍需后续 job-level vars guard。
