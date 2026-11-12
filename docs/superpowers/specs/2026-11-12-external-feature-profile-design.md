---
title: External Feature Profile 构建与验收设计
date: 2026-11-12
status: approved
---

# External Feature Profile 构建与验收设计

## 1. 背景与问题

CLI 与 Agent SDK 共享 TypeScript 源码、查询、工具、权限和 session 实现，但交付形式不同：CLI 需要可直接执行的入口，SDK 需要可导入模块和类型声明。仅恢复源码或让 `Bun.build()` 返回成功，不能证明依赖、公共类型、功能注册和最终 bundle 能组成可用产品。

External feature profile 的目标是建立可复现的双产品交付链，并用真实 bundle 验证 external 功能边界。该功能只处理构建、类型、注册和离线行为，不验证真实模型、Cloud OAuth、桌面控制或远端 registry。

## 2. 为什么采用这套设计与实施顺序

设计首先解决的是“交付结果不可信”，而不是“缺少一个构建脚本”。以下选择都直接对应这个根因。

### 2.1 为什么共享源码与双入口构建

CLI 与 SDK 的查询、工具、权限和 session 行为必须一致，分别实现会产生永久维护成本和语义漂移。共享源码并在入口层处理可执行 CLI 与可导入 SDK 的差异，可以把“行为一致”变成结构性约束。代价是两个入口必须一起评审生命周期和导出边界，不能只改其中一端。

### 2.2 为什么从 schema 生成公共类型

手写 declarations 会让公共 API 与真实校验规则逐渐不一致。以 `coreSchemas.ts` 和 `controlSchemas.ts` 为唯一事实来源，可以让调用方看到的类型与运行时接受的输入保持同源。当前生成器采用行首正则换取最小实现复杂度，因此必须显式接受 `export const ...Schema` 的命名约束；没有匹配项时失败，而不是生成一个看似完整的空文件。

### 2.3 为什么生产与验收必须共享 feature 列表

Bun feature flag 会参与 dead-code elimination。生产与验收各维护一份列表时，可能出现“测试验证了生产并不包含的代码”或“生产新增功能却没有验收”的假阳性。`externalFeatureProfile.ts` 是两类构建的唯一功能清单，新增功能必须同时通过实现、注册和 dist 验收。选择单一列表不是减少几行重复，而是让验收对象可信。

### 2.4 为什么验收真实 bundle，而不是只测源码

源码中的 `isEnabled()` 或 import 存在，不能证明代码最终进入 dist。验收构建再次编译 `feature-check.ts` 并在独立 Bun 子进程中加载，才能发现 feature 未启用、注册遗漏、空实现和打包后的模块初始化问题。独立子进程还避免 Bun test runner 对模块导入的拦截改变生产行为。

### 2.5 为什么固定离线环境，并把在线验证分开

外部服务和本机环境会让构建验收变慢且不确定。固定 `ANTHROPIC_BASE_URL`、`ENABLE_TOOL_SEARCH` 和占位凭据，是为了让失败只能来自构建或注册，而不是开发机差异。真实模型、Cloud OAuth、桌面和远端 registry 属于不同故障域，不能用它们阻塞基础交付，也不能用离线 profile 冒充这些能力已在线可用。

### 2.6 为什么按这个顺序实施

1. **先固定依赖与 exports**：后续产物才有稳定输入和可检查的消费路径。
2. **再生成类型**：先得到 SDK 编译所需声明，错误不会被后续 bundle 掩盖。
3. **再构建 CLI/SDK**：此时可以验证外部入口、权限和 dead-code elimination 的真实结果。
4. **最后验证注册与状态**：工具、命令、worker、Sleep 和 skills 只有在 bundle 可加载后才有验收意义。
5. **最后改变外层环境复验**：确认结果由构建配置决定，而不是被本机配置污染。

这个顺序让每一步都有可验证产物和明确故障边界，不是形式上的“先代码后测试”。

### 2.7 不采用哪些替代方案，以及为什么

| 备选做法 | 不采用的原因 |
|---|---|
| CLI 与 SDK 各自实现 | 查询、工具与权限语义会重复并漂移 |
| 手写 SDK declarations | 类型容易与 Zod 校验规则脱节 |
| 生产与测试各维护 feature 列表 | 验收可能与实际交付配置不一致 |
| 只做源码单元测试 | 无法发现 dead-code elimination 和打包初始化问题 |
| 以真实外部服务作为基础构建验收 | 引入凭据、网络和平台差异，模糊故障边界 |
| 固定工具数量作为唯一目标 | 数量只是当前快照，正确集合、无空实现和状态一致性才是目的 |

当前 `main` 的 profile 是 43 个工具，但这个数字不是设计目标本身。新增功能时，数量应随 EXTERNAL_FEATURES 与真实注册共同变化；不能用改大或改小数字代替原因分析。

## 3. 目标与非目标

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

## 4. 总体架构

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

## 5. 组件契约

### 5.1 依赖与公共导出

`package.json`、`bun.lock`、`bunfig.toml` 和 `tsconfig.json` 固定工具链。CLI 通过 `bin` 与 `./cli` 指向 `dist/main.js`；SDK import 指向 `dist/sdk.mjs`，SDK types 指向 `dist/types/entrypoints/agentSdkTypes.d.ts`。

主要脚本职责：

- `generate:sdk-types`：生成公共类型；
- `typecheck`：静态检查；
- `test`：运行 Bun test；
- `build`：先打包，再生成 declarations；
- `dev`/`start`：进入 CLI 源码入口。

### 5.2 SDK 类型生成

`generate-sdk-types.ts` 处理两个目标：

| Schema | 输出 |
|---|---|
| `src/entrypoints/sdk/coreSchemas.ts` | `coreTypes.generated.ts` |
| `src/entrypoints/sdk/controlSchemas.ts` | `controlTypes.ts` |

生成器通过行首正则收集 `export const <name>Schema`，生成对应的 `z.infer<ReturnType<typeof schemas.<name>Schema>>`。controlTypes 额外导出 coreTypes。没有匹配项时必须失败，不能生成空声明并继续交付。

该实现依赖命名约定，新增 schema 必须遵循 `export const ...Schema` 形式。

### 5.3 双入口打包

`scripts/build.ts` 在打包前调用类型生成，再构建：

1. `src/entrypoints/cli.tsx` → `dist/main.js`，添加 Bun shebang，最终 chmod 为可执行文件；
2. `src/entrypoints/agentSdkTypes.ts` → `dist/sdk.mjs`。

两者使用 Bun target、ESM format，并注入版本、包 URL、`USER_TYPE=external` 和 `CLAUDE_CODE_VERIFY_PLAN=false`。`features` 显式列出 external 功能，不能用默认全量内部实现替代。任一 `result.success` 为假时打印构建日志并非零退出。

### 5.4 功能注册与运行时边界

工具是否进入 bundle、命令是否注册、命令 availability 和运行时 `isEnabled` 是不同层次：

- feature 集决定代码是否保留；
- registry 决定工具或命令是否暴露；
- availability 决定宿主环境是否支持；
- 运行时状态决定当前是否可调用，例如 Sleep 只有在 proactive 激活后启用。

`ultraplan` 等命令可以同时具有 external 注册与 `claude-ai` availability，不能用 internal-only 列表或 `USER_TYPE==='ant'` 重复限制。

### 5.5 Feature-profile 验收

`tests/fixtures/feature-check.ts` 导出 `getAllBaseTools`、`builtInCommandNames`、`getCoordinatorAgents`、`isReactiveCompactEnabled` 和 bundled skills/proactive 控制函数。

`verify-enabled-features.ts` 使用同一 feature 集构建 fixture，并在独立 Bun 子进程中检查：

- 工具总数当前为 43，且没有 null entry；
- 指定工具、命令和 skills 均存在；
- Sleep 初始 disabled，proactive 激活后 enabled；
- worker 是后台 worker，具有 Bash 但不具有 Agent；
- reactive compaction、hunter、proactive、peers、remote-control-server、workflows、Buddy、Fork、force-snip、assistant、ultraplan、voice 和 brief 均按设计注册。

测试子进程固定 `ANTHROPIC_API_KEY=offline-test-placeholder`、`ANTHROPIC_BASE_URL=https://api.anthropic.com`、`ENABLE_TOOL_SEARCH=true` 和 `NODE_ENV=production`，避免外层环境改变 ToolSearch 注册结果。

## 6. 失败语义

| 失败 | 处理 |
|---|---|
| Schema 无匹配导出 | 终止类型生成，不继续构建 |
| CLI 或 SDK bundle 失败 | 打印构建日志并非零退出 |
| 声明路径与 exports 不一致 | 停止交付，不保留“可导入”假象 |
| null tool、缺失工具或错误命令注册 | profile 测试失败并输出具体差异 |
| Sleep/proactive 状态错误或 worker 可递归 Agent | profile 测试失败 |
| 外层环境覆盖测试输入 | 在子进程 env 中显式覆盖测试值，禁止 profile 漂移 |
| 外部服务未授权 | 不属于本功能；不得用 offline profile 冒充在线可用 |

## 7. 实施顺序

1. 固定依赖、tsconfig、lockfile、入口和 exports。
2. 实现 schema 类型生成及无匹配失败测试。
3. 完成双入口构建、external define、CLI 权限和 declarations。
4. 按层接入工具、命令、availability、运行时状态和 bundled skills。
5. 实现 feature-profile fixture，覆盖正常注册、空实现、状态转换和递归限制。
6. 在对立外层环境下重复验收，再执行全量工程检查。

## 8. 验收标准

### 构建与导出

- 类型生成能从两个 schema 文件生成对应声明，无匹配时明确失败。
- typecheck、全量测试和双入口 build 可按规定顺序执行。
- `dist/main.js` 具有 shebang 和可执行权限，`dist/sdk.mjs` 可导入，declarations 与 package exports 对应。
- 任一打包失败都非零退出，不能只凭文件存在判断成功。

### Feature profile

- 当前 profile 包含 43 个工具且 `nullCount===0`，指定工具和命令均存在。
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
