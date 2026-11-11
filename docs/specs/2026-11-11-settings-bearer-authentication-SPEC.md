---
commit: beee034523510ac0425461bb4ffce3250514d693
title: Settings/Bearer 认证与 API key 互斥设计
date: 2026-11-11
retrospective: true
---

# Settings/Bearer 认证与 API key 互斥设计

## 认证选择

`getAnthropicApiKeyWithSource()` 在 CI/test 的缺少凭据检查中同时识别 ANTHROPIC_AUTH_TOKEN：只有 Bearer token 时不再错误抛出“API key 或 OAuth 必须存在”。该函数仍只返回 API key，Bearer 由后续配置/请求链处理，不能混写成 x-api-key。

`live-model-validation.ts` 在 enableConfigs 前拒绝同时存在 API key 与 AUTH_TOKEN；两者都缺失才输出 MODEL_LIVE_SKIPPED。存在任一有效认证后，再加载 settings 并执行模型探针。

workflow 的 model job env 和 step env 都从 `ANTHROPIC_API_KEY` 改为 `ANTHROPIC_AUTH_TOKEN`，与 settings-based Bearer 输入一致，且不使用 Claude OAuth 代替它。

## 验收标准

1. 只有 AUTH_TOKEN 时 CI/test 认证检查不会误报缺少凭据，也不会把它返回为 API key。
2. 两种 token 同时存在立即失败，均不存在才 skip，存在其一时继续加载配置。
3. workflow 两处 env 均使用 AUTH_TOKEN，BASE_URL/HOME/config 保持不变。
4. 日志与错误文本不包含 token，API key、Bearer 和 OAuth 三条路径不混用。
