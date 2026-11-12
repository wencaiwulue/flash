---
title: External Feature Profile 构建与验收设计
date: 2026-11-12
status: approved
---

# External Feature Profile 构建与验收设计

## 1. 背景与问题

CLI 与 Agent SDK 共享 TypeScript 源码、查询、工具、权限和 session 实现，但交付形式不同：CLI 需要可直接执行的入口，SDK 需要可导入模块和类型声明。仅恢复源码或让 `Bun.build()` 返回成功，不能证明依赖、公共类型、功能注册和最终 bundle 能组成可用产品。

External feature profile 的目标是建立可复现的双产品交付链，并用真实 bundle 验证 external 功能边界。该功能只处理构建、类型、注册和离线行为，不验证真实模型、Cloud OAuth、桌面控制或远端 registry。

## 2. 目标与非目标

### 目标

- 固定依赖安装、SDK 类型生成、双入口打包和 declarations 的顺序。
- 明确 `USER_TYPE=external`、external feature 集和运行时可用性边界。
- 验证实际 bundle 中的工具池、命令、worker、proactive/Sleep 和 bundled skills。
- 固定离线测试环境，使 feature profile 不受开发机配置影响。
- 让类型生成、构建、注册和冒烟失败都有明确非零结果。

### 非目标

- 不启用 internal-only 功能，不建立第二套 CLI 或 SDK 实现。
- 不把源码存在、类型存在或构建成功等同于外部服务可用。
- 不在该功能中处理模型、Cloud、桌面或远端 registry 的在线验收。

## 3. 总体架构

```text
coreSchemas.ts / controlSchemas.ts
                │
                ▼
     scripts/generate-sdk-types.ts
                │
                ▼
coreTypes.generated.ts / controlTypes.ts
                │
        ┌───────┴────────┐
        ▼                ▼
src/entrypoints/cli.tsx  src/entrypoints/agentSdkTypes.ts
        │                │
        └──── Bun.build ─┘
                │
                ▼
 dist/main.js     dist/sdk.mjs
                │
                ▼
       tsc declarations → dist/types
```

生产构建和验收构建共享 feature 集与 external define。`tests/fixtures/feature-check.ts` 导出真实注册表，`tests/fixtures/verify-enabled-features.ts` 再构建并加载它，避免只验证源码而不验证交付配置。

## 4. 组件契约

### 4.1 依赖与公共导出

`package.json`、`bun.lock`、`bunfig.toml` 和 `tsconfig.json` 固定工具链。CLI 通过 `bin` 与 `./cli` 指向 `dist/main.js`；SDK import 指向 `dist/sdk.mjs`，SDK types 指向 `dist/types/entrypoints/agentSdkTypes.d.ts`。

主要脚本职责：

- `generate:sdk-types`：生成公共类型；
- `typecheck`：静态检查；
- `test`：运行 Bun test；
- `build`：先打包，再生成 declarations；
- `dev`/`start`：进入 CLI 源码入口。

### 4.2 SDK 类型生成

`generate-sdk-types.ts` 处理两个目标：

| Schema | 输出 |
|---|---|
| `src/entrypoints/sdk/coreSchemas.ts` | `coreTypes.generated.ts` |
| `src/entrypoints/sdk/controlSchemas.ts` | `controlTypes.ts` |

生成器通过行首正则收集 `export const <name>Schema`，生成对应的 `z.infer<ReturnType<typeof schemas.<name>Schema>>`。controlTypes 额外导出 coreTypes。没有匹配项时必须失败，不能生成空声明并继续交付。

该实现依赖命名约定，新增 schema 必须遵循 `export const ...Schema` 形式。

### 4.3 双入口打包

`scripts/build.ts` 在打包前调用类型生成，再构建：

1. `src/entrypoints/cli.tsx` → `dist/main.js`，添加 Bun shebang，最终 chmod 为可执行文件；
2. `src/entrypoints/agentSdkTypes.ts` → `dist/sdk.mjs`。

两者使用 Bun target、ESM format，并注入版本、包 URL、`USER_TYPE=external` 和 `CLAUDE_CODE_VERIFY_PLAN=false`。`features` 显式列出 external 功能，不能用默认全量内部实现替代。任一 `result.success` 为假时打印构建日志并非零退出。

### 4.4 功能注册与运行时边界

工具是否进入 bundle、命令是否注册、命令 availability 和运行时 `isEnabled` 是不同层次：

- feature 集决定代码是否保留；
- registry 决定工具或命令是否暴露；
- availability 决定宿主环境是否支持；
- 运行时状态决定当前是否可调用，例如 Sleep 只有在 proactive 激活后启用。

`ultraplan` 等命令可以同时具有 external 注册与 `claude-ai` availability，不能用 internal-only 列表或 `USER_TYPE==='ant'` 重复限制。

### 4.5 Feature-profile 验收

`tests/fixtures/feature-check.ts` 导出 `getAllBaseTools`、`builtInCommandNames`、`getCoordinatorAgents`、`isReactiveCompactEnabled` 和 bundled skills/proactive 控制函数。

`verify-enabled-features.ts` 使用同一 feature 集构建 fixture，并在独立 Bun 子进程中检查：

- 工具总数当前为 42，且没有 null entry；
- 指定工具、命令和 skills 均存在；
- Sleep 初始 disabled，proactive 激活后 enabled；
- worker 是后台 worker，具有 Bash 但不具有 Agent；
- reactive compaction、hunter、proactive、peers、remote-control-server、workflows、Buddy、Fork、force-snip、assistant、ultraplan、voice 和 brief 均按设计注册。

测试子进程固定 `ANTHROPIC_API_KEY=offline-test-placeholder`、`ANTHROPIC_BASE_URL=https://api.anthropic.com`、`ENABLE_TOOL_SEARCH=true` 和 `NODE_ENV=production`，避免外层环境改变 ToolSearch 注册结果。

## 5. 失败语义

| 失败 | 处理 |
|---|---|
| Schema 无匹配导出 | 终止类型生成，不继续构建 |
| CLI 或 SDK bundle 失败 | 打印构建日志并非零退出 |
| 声明路径与 exports 不一致 | 停止交付，不保留“可导入”假象 |
| null tool、缺失工具或错误命令注册 | profile 测试失败并输出具体差异 |
| Sleep/proactive 状态错误或 worker 可递归 Agent | profile 测试失败 |
| 外层环境覆盖测试输入 | 在子进程 env 中显式覆盖测试值，禁止 profile 漂移 |
| 外部服务未授权 | 不属于本功能；不得用 offline profile 冒充在线可用 |

## 6. 实施顺序

1. 固定依赖、tsconfig、lockfile、入口和 exports。
2. 实现 schema 类型生成及无匹配失败测试。
3. 完成双入口构建、external define、CLI 权限和 declarations。
4. 按层接入工具、命令、availability、运行时状态和 bundled skills。
5. 实现 feature-profile fixture，覆盖正常注册、空实现、状态转换和递归限制。
6. 在对立外层环境下重复验收，再执行全量工程检查。

## 7. 验收标准

### 构建与导出

- 类型生成能从两个 schema 文件生成对应声明，无匹配时明确失败。
- typecheck、全量测试和双入口 build 可按规定顺序执行。
- `dist/main.js` 具有 shebang 和可执行权限，`dist/sdk.mjs` 可导入，declarations 与 package exports 对应。
- 任一打包失败都非零退出，不能只凭文件存在判断成功。

### Feature profile

- 当前 profile 包含 42 个工具且 `nullCount===0`，指定工具和命令均存在。
- Sleep 初始 disabled，proactive 激活后 enabled；worker 为后台 worker 且不含 Agent。
- reactive compaction、hunter、assistant、ultraplan、voice、brief 等注册与 feature 集一致。
- 外层 `ANTHROPIC_BASE_URL` 和 `ENABLE_TOOL_SEARCH` 取不同值时，profile 结果不发生变化。

### 建议验收命令

```bash
bun install --frozen-lockfile
bun run generate:sdk-types
bun run typecheck
bun test tests/enabledFeatures.test.ts
bun test
bun run build
bun dist/main.js --version
bun dist/main.js --help
bun -e "const sdk=await import('./dist/sdk.mjs'); if(typeof sdk.query!=='function'||typeof sdk.createSdkMcpServer!=='function') throw new Error('Invalid SDK exports')"
```

这些命令定义交付验收，不表示历史提交当时保存或执行过相同计划。
