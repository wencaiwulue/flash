---
commit: 9b2a35201244ca84adeaa6844bf799e5a18aff6d
title: 恢复 CLI 与 Agent SDK 的可构建交付链
date: 2026-11-10
status: partial
retrospective: true
---

# 恢复 CLI 与 Agent SDK 的可构建交付链

## 问题

父提交只有源码快照，没有依赖清单、锁文件、TypeScript 配置、构建脚本和测试体系，并存在缺失模块与 SDK stub。该提交的核心不是增加一个新产品功能，而是把源码整理为两个可构建入口：CLI 与 Agent SDK，同时给尚未实现的协议保留明确边界。

## 交付结构

```text
Zod schemas
   │ scripts/generate-sdk-types.ts
   ▼
coreTypes.generated.ts + controlTypes.ts
   │
   ├─ src/entrypoints/cli.tsx ────────→ dist/main.js
   └─ src/entrypoints/agentSdkTypes.ts → dist/sdk.mjs
                                             │
                                  tsc declarations
                                             ▼
                                      dist/types/
```

`package.json` 将 CLI 暴露为 `bin` 和 `./cli`，将 SDK 的 import 指向 `dist/sdk.mjs`，类型指向 `dist/types/entrypoints/agentSdkTypes.d.ts`。

## 构建设计

### 依赖与脚本

新增 `package.json`、`bun.lock`、`bunfig.toml`、`tsconfig.json` 和 `.gitignore`，恢复 Bun/TypeScript 工具链。主要脚本职责为：

- `generate:sdk-types`：从 schema 源码生成 TypeScript 类型；
- `typecheck`：执行 `tsc --noEmit`；
- `test`：运行 Bun test；
- `build`：先打包，再生成 declarations；
- `dev`/`start`：直接进入 CLI 源码入口。

### 类型生成

`generate-sdk-types.ts` 只处理两个目标：

| schema | 输出 |
|---|---|
| `src/entrypoints/sdk/coreSchemas.ts` | `coreTypes.generated.ts` |
| `src/entrypoints/sdk/controlSchemas.ts` | `controlTypes.ts` |

生成器用行首正则找出 `export const <name>Schema`，再生成对应的 `z.infer<ReturnType<typeof schemas.<name>Schema>>`。如果某个文件没有匹配项，必须报错。它不是通用 AST 转换器，新增 schema 必须遵循这一命名与导出形式。

### 双入口打包

`scripts/build.ts` 在打包前调用类型生成，然后依次构建：

1. `src/entrypoints/cli.tsx` → `dist/main.js`，添加 Bun shebang，最终 chmod 为可执行文件；
2. `src/entrypoints/agentSdkTypes.ts` → `dist/sdk.mjs`。

两个 bundle 都是 Bun target、ESM format，并注入版本、包 URL 和 `process.env.USER_TYPE='external'`。`features` 在该提交明确是空数组，不能描述为启用了后续提交的完整功能旗标集合。构建失败时打印日志并非零退出，不能静默留下“成功”产物。

## SDK 能力边界

`agentSdkTypes.ts` 将公共 API 接到具体实现：

- `query()` → `createSdkQuery()`；
- V2 create/resume/prompt → SDK session conversation 实现；
- list/getInfo/getMessages/rename/tag/fork → JSONL session 工具；
- `watchScheduledTasks()` → 文件型 cron scheduler，通过 pending queue 和 abort 停止；
- `tool()`、`createSdkMcpServer()` → 进程内 MCP 组合。

`connectRemoteControl()` 在该 revision 明确抛出 `connectRemoteControl is unavailable in this build`。因此类型中定义 `RemoteControlHandle` 并不代表远程控制协议已接通。

## 源码恢复与测试分层

该提交还恢复大量 CLI、SDK、查询、工具、服务和 UI 文件，属于 789 个文件的大范围源码恢复，而不是可逐文件虚构设计讨论的新功能开发。验收按依赖分层：

- `tests/toolPool.test.ts`：内建工具池与外部裁剪；
- `tests/sdkMcp.test.ts`：进程内 MCP 与 query 生命周期；
- `tests/sdkSessions.test.ts`：JSONL session 操作；
- `tests/sdkCron.test.ts`：scheduler watch、missed event 和 abort；
- `tests/lsp.test.ts`：LSP 生命周期基础。

`.github/workflows/ci.yml` 把验收顺序固定为安装、类型生成、typecheck、test、build、CLI version/help、SDK import smoke。

## 工程取舍

- **双入口共享一份源码**：CLI 与 SDK 复用查询、工具、权限和 session 模块，避免两套代理循环；代价是入口必须严格管理 UI 与进程生命周期差异。
- **schema 驱动公共类型**：公共序列化类型有单一来源，但生成器的正则契约要求额外命名约束。
- **显式 unavailable，而非伪造实现**：remote-control 等未接通能力保留清晰失败，避免类型存在造成错误可用性预期。
- **external 构建**：通过 define 固定外部身份，并保留空 feature 集，后续功能需要逐项启用，不能倒写为该提交已经开放。

## 验收标准

1. 冻结锁文件安装后，类型生成能从两个 schema 文件生成对应声明；无匹配 schema 时生成器失败。
2. typecheck、五个测试文件和双入口 build 可按 CI 顺序执行。
3. `dist/main.js` 具有 shebang 和可执行权限，`dist/sdk.mjs` 可导入，declarations 与 package exports 对应。
4. SDK query、V2、session、cron 和 MCP 公共函数分别连接到上述实现；`connectRemoteControl()` 保持明确 unavailable。
5. 构建 define 保持 `USER_TYPE=external` 和 `features: []`，没有把后续功能旗标倒写进本提交。
6. 任一打包失败都非零退出，CLI/SDK 不能只凭文件存在就判定端到端可用。
