---
commit: 9b2a35201244ca84adeaa6844bf799e5a18aff6d
title: CLI 与 Agent SDK 构建恢复的实施顺序
date: 2026-11-10
retrospective: true
---

# CLI 与 Agent SDK 构建恢复的实施顺序

## 前置约束

- 父树没有 `package.json`、lockfile、`tsconfig.json` 和常规测试体系。
- 本任务是大范围源码恢复，按依赖组实施，不为 789 个文件编造独立设计步骤。
- 公共 SDK 未实现的协议必须显式失败；不能为了通过导出检查而返回空对象。

## 1. 建立依赖与脚本契约

创建 `package.json`、`bun.lock`、`bunfig.toml`、`tsconfig.json` 和 `.gitignore`。`package.json` 至少保持以下入口一致：

```json
{
  "type": "module",
  "main": "dist/main.js",
  "bin": { "claude-code": "dist/main.js" },
  "exports": {
    ".": {
      "types": "./dist/types/entrypoints/agentSdkTypes.d.ts",
      "import": "./dist/sdk.mjs"
    },
    "./cli": "./dist/main.js"
  },
  "scripts": {
    "build": "bun scripts/build.ts && bun run build:types",
    "build:types": "tsc --emitDeclarationOnly --noEmit false --outDir dist/types",
    "generate:sdk-types": "bun scripts/generate-sdk-types.ts",
    "typecheck": "tsc --noEmit",
    "test": "bun test"
  }
}
```

依赖版本以 `9b2a352:package.json` 和对应 lockfile 为准，不使用当前最新版本替换历史依赖。安装验收：

```bash
bun install --frozen-lockfile
```

## 2. 实现 schema 到类型的生成器

创建 `scripts/generate-sdk-types.ts`，定义两个 `GenerationTarget`：coreSchemas → coreTypes.generated，controlSchemas → controlTypes。

实现要求：

1. 读取 schema 源文件；
2. 用 `/^export const (\w+Schema)\s*=/gm` 收集名称；
3. 没有匹配项时抛错；
4. 去掉名称末尾的 `Schema`，生成对应 `z.infer` 类型；
5. controlTypes 文件保留 `export * from './coreTypes.js'` prelude；
6. 文件头标记“Generated ... Do not edit directly”。

验收：

```bash
bun run generate:sdk-types
rg -n 'export type .* = z.infer' src/entrypoints/sdk/coreTypes.generated.ts src/entrypoints/sdk/controlTypes.ts
```

临时移除一个测试副本中的全部 schema 导出，必须触发 `No exported schemas found`，不能生成空类型文件。

## 3. 实现双入口构建

创建 `scripts/build.ts`。先调用 `generateSdkTypes()`，再建立两个 build 配置：

```ts
const builds = [
  {
    entrypoints: ['src/entrypoints/cli.tsx'],
    naming: { entry: 'main.[ext]' },
    banner: '#!/usr/bin/env bun',
  },
  {
    entrypoints: ['src/entrypoints/agentSdkTypes.ts'],
    naming: { entry: 'sdk.mjs' },
  },
] as const
```

两个 `Bun.build()` 都使用 `target:'bun'`、`format:'esm'`、`features: []`，define 至少包含版本、包 URL、`process.env.USER_TYPE='external'` 和 `process.env.CLAUDE_CODE_VERIFY_PLAN='false'`。任一 `result.success` 为假时打印 logs 并退出 1。全部完成后：

```ts
await chmod(`${outdir}/main.js`, 0o755)
```

验收：

```bash
bun run build
test -x dist/main.js
bun dist/main.js --version
bun dist/main.js --help
bun -e "const sdk=await import('./dist/sdk.mjs'); if(typeof sdk.query!=='function'||typeof sdk.createSdkMcpServer!=='function') throw new Error('Invalid SDK exports')"
```

## 4. 按公共 API 恢复 SDK 实现

按依赖顺序恢复以下实现组，而不是从入口开始堆 stub：

| 顺序 | 实现组 | 公共出口 |
|---|---|---|
| 1 | `src/utils/sdkQuery.ts` 及查询/MCP 生命周期 | `query()`、`tool()`、`createSdkMcpServer()` |
| 2 | `src/utils/sdkSessionConversation.ts` | V2 create/resume/prompt |
| 3 | `src/utils/sdkSessions.ts` 与 JSONL 工具 | list/getInfo/getMessages/rename/tag/fork |
| 4 | `src/utils/cronScheduler.ts`、`cronNotification.ts` | watchScheduledTasks、buildMissedTaskNotification |
| 5 | `src/entrypoints/agentSdkTypes.ts` | 公共导出、类型和显式不可用边界 |

`watchScheduledTasks()` 的 events generator 必须先消费 pending queue，在 abort 时停止 scheduler、唤醒等待者并移除 listener；不能在 abort 后遗留文件 watcher。

`connectRemoteControl()` 在该恢复阶段保持：

```ts
export async function connectRemoteControl(): Promise<RemoteControlHandle | null> {
  throw new Error('connectRemoteControl is unavailable in this build')
}
```

逐组执行：

```bash
bun test tests/sdkMcp.test.ts
bun test tests/sdkSessions.test.ts
bun test tests/sdkCron.test.ts
```

测试必须覆盖 async query 输入输出、MCP teardown、session parentUuid 链、fork UUID 重写、cron missed/fire event 和 abort 清理。

## 5. 恢复 CLI 与运行时依赖

以 `src/entrypoints/cli.tsx` 为入口，恢复 `QueryEngine`、query loop、工具池、权限、MCP client、session/state 和终端 UI 的缺失依赖。内部功能仍由 external define 和空 feature 集约束，不能为了让 import 通过而开放未恢复模块。

工具池和 LSP 分层验收：

```bash
bun test tests/toolPool.test.ts
bun test tests/lsp.test.ts
bun run typecheck
bun test
```

typecheck 若指向缺失模块，应恢复真实依赖或保留明确 unsupported stub；不要创建只有空实现的同名文件来消除错误。

## 6. 固定 CI 顺序

创建 `.github/workflows/ci.yml`，依次执行：

```bash
bun install --frozen-lockfile
bun run generate:sdk-types
bun run typecheck
bun test
bun run build
bun dist/main.js --version
bun dist/main.js --help
bun -e "const sdk=await import('./dist/sdk.mjs'); if(typeof sdk.query!=='function'||typeof sdk.createSdkMcpServer!=='function') throw new Error('Invalid SDK exports')"
```

CLI 与 SDK smoke 必须读取打包产物，不能只测试 src 入口。构建声明文件后，再检查 `dist/types/entrypoints/agentSdkTypes.d.ts` 与 package exports 的路径一致。

## 回滚顺序

先回滚 CI，再按公共 API 回滚 SDK/CLI 入口，随后回滚 build/typegen，最后才移除依赖元数据。若某组测试失败，保留已通过的上游依赖并修复当前组，不通过降低断言或隐藏 unavailable 错误来推进下一组。
