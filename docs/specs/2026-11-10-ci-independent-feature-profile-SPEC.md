---
commit: e2e0ff6e0897141823d361204e81aef79922f33b
title: 固定 feature-profile 测试环境
date: 2026-11-10
retrospective: true
---

# 固定 feature-profile 测试环境

## 问题

`enabledFeatures.test.ts` 通过构建后的 `feature-check.ts` 统计工具池，但子进程继承了开发机环境。`ANTHROPIC_BASE_URL` 和 `ENABLE_TOOL_SEARCH` 的差异会改变 ToolSearch 的注册结果，使同一提交在不同机器上出现 31/32 工具及缺失名称的不稳定断言。

## 设计

在测试子进程 env 中显式设置：

```ts
ANTHROPIC_API_KEY: 'offline-test-placeholder'
ANTHROPIC_BASE_URL: 'https://api.anthropic.com'
ENABLE_TOOL_SEARCH: 'true'
NODE_ENV: 'production'
```

保留其余 `process.env`，避免改动无关运行时配置，但对本测试的两个功能输入和占位认证使用固定值。预期工具数改为 32，并在 `toolNames` 的 arrayContaining 中断言 `ToolSearch`，同时保持 `nullCount===0` 和其他已有工具检查。

这使断言直接对应一个明确环境，而不是要求开发者机器与 CI 恰好一致。

## 验收标准

1. 父环境分别设置不同 `ANTHROPIC_BASE_URL` 和 `ENABLE_TOOL_SEARCH` 时，子进程仍使用测试指定值。
2. profile 包含 ToolSearch，工具数为 32，nullCount 为 0，Sleep 初始仍 disabled。
3. 测试只使用占位 API key，不读取真实凭据，也不发起模型请求。
4. `enabledFeatures.test.ts` 能在独立 Bun 子进程中重复执行，结果不受外层 shell 配置影响。
