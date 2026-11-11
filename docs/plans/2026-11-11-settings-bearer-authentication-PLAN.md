---
commit: beee034523510ac0425461bb4ffce3250514d693
title: Settings/Bearer 认证的实施步骤
date: 2026-11-11
retrospective: true
---

# Settings/Bearer 认证的实施步骤

## 1. 修正 CI/test 缺少凭据判断

**文件：** `src/utils/auth.ts`。

在 `!apiKeyEnv` 的抛错条件中加入 `!process.env.ANTHROPIC_AUTH_TOKEN`。只有 Bearer 时继续后续认证链，不在 getAnthropicApiKeyWithSource 中返回伪造 API key。

## 2. 实现探针互斥 guard

**文件：** `scripts/live-model-validation.ts`。

在 enableConfigs 前依次检查：两种 token 同时存在则抛错；两者均不存在则 MODEL_LIVE_SKIPPED 并 return；随后才加载配置。

## 3. 更新 workflow 输入

**文件：** `.github/workflows/live-checks.yml`。

model 的 job env 与 step env 将 ANTHROPIC_API_KEY 改为 ANTHROPIC_AUTH_TOKEN，其他变量不变。

## 4. 验收

覆盖只有 API key、只有 AUTH_TOKEN、两者同时、两者均无四种输入。检查 workflow 不再传 API key，settings 能进入现有 Bearer 请求链，且日志不输出 token。
