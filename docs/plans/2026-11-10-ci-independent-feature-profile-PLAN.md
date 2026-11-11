---
commit: e2e0ff6e0897141823d361204e81aef79922f33b
title: feature-profile 环境固定实施步骤
date: 2026-11-10
retrospective: true
---

# feature-profile 环境固定实施步骤

## 1. 固定子进程输入

**修改：** `tests/enabledFeatures.test.ts` 中运行构建 fixture 的 `Bun.spawnSync({env})`。

在 `...process.env` 之后添加：

```ts
ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
ENABLE_TOOL_SEARCH: 'true',
```

保留 `ANTHROPIC_API_KEY:'offline-test-placeholder'` 和 `NODE_ENV:'production'`。顺序必须确保外层环境不能覆盖这些测试值。

## 2. 让断言对应 ToolSearch 的注册结果

把 `profile.toolCount` 的期望改为 32，并在 `profile.toolNames` 的 `expect.arrayContaining([...])` 中加入 `ToolSearch`。保留 `nullCount===0`、其他工具名称和 `sleepInitiallyEnabled===false`，避免用单一计数掩盖错误注册。

## 3. 用对立外层环境验收

分别运行：

```bash
ANTHROPIC_BASE_URL=https://example.invalid ENABLE_TOOL_SEARCH=false bun test tests/enabledFeatures.test.ts
ANTHROPIC_BASE_URL=https://api.anthropic.com ENABLE_TOOL_SEARCH=true bun test tests/enabledFeatures.test.ts
```

两次 profile 都应为 32 个工具、包含 ToolSearch、没有 null entry。若测试仍读取外层变量，检查 env 展开顺序，而不是提高或降低计数。

再执行：

```bash
bun test tests/enabledFeatures.test.ts
bun run typecheck
```

不需要真实 API key；如出现网络访问，说明测试入口已经偏离离线 fixture，应先停止并修正入口。
