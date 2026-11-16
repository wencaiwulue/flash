---
id: chrome-bundled-wiring
batch: 4
title: Chrome 集成 bundled 构建前置分流设计
date: 2026-11-15
status: draft
---

# Chrome 集成 bundled 构建前置分流设计

## 1. 问题与约束

独立（bundled）二进制下，配置 `claudeInChromeDefaultEnabled: true`（与真实 Claude Code 共享的 `~/.claude.json`）会让交互式启动必然崩溃：

1. Bun 的 ws 模拟无法完成 Playwright 的 CDP 握手，外部构建 stub（`src/external-stubs/claude-for-chrome-mcp.ts:212-216`）在 Bun 环境必须 spawn Node sidecar；
2. bundled 二进制里 sidecar 的 `cwd` 为 `/$bunfs/...`（Bun 虚拟文件系统），`posix_spawn` 因 cwd 不存在而失败（已最小化复现：`spawn('node', cwd:'/$bunfs/root')` → `ENOENT`）；即使 cwd 有效，独立安装无 node_modules，node 也无法解析 `@playwright/mcp`；
3. 异常落入 `src/main.tsx:2370` 的 catch → `process.exit(1)`，整个 CLI 无法启动。

约束：
- **对齐上游 Claude Code 的可观察行为**。上游二进制 v2.1.212 反编译证据显示其 chrome 接线段为三级结构：已知必败条件在 setup **之前**分流（默认路径静默 debug 日志、显式路径 stderr 警告），setup catch 的硬退出保留给真正意外失败——上游 setup 只组装配置不 spawn 子进程，catch 在受支持环境几乎不可达。
- 本快照的偏差是**缺少前置分流层**，而非硬退出本身；因此不删 catch、不改 `shouldEnableInChrome` 的布尔判定。
- sidecar 在 bundled 下不可修复（需随二进制分发 Node + node_modules），属未来工作（`docs/external-stubs/contracts/open-chrome.md` 契约文档范围）。

## 2. 设计理由与备选方案

| 决策 | 实际机制 | 为什么采用 | 备选方案及不采用原因 | 代价 | 证据 |
|---|---|---|---|---|---|
| 前置分流而非降级 catch | bundled 时在接线段提前跳过 setup，mirror 上游 `Ee/Te` 分支 | 与上游三级结构逐层对应；catch 保持"意外失败"语义 | 删除 `process.exit(1)` 全部降级（会让真正的意外失败静默吞掉，偏离上游）；修 sidecar（需分发 node_modules，YAGNI） | main.tsx 增加一个分支 | 上游二进制字符串 `Skipping chrome wiring: blocked by enterprise MCP config...` / `ps("Error: Failed to run with Claude in Chrome.")` |
| 显式与默认路径区分告警 | 显式 `--chrome`/env → stderr 警告一次；配置默认 → 静默 debug | 对齐上游策略阻止分支的双档处理（`vq` 警告 vs `C` debug）；显式意图必须被回应，常设偏好在功能不可用平台上静默关闭 | 全部静默（显式要求被无视，体验差）；全部警告（每次启动刷屏） | 无 | 上游 `else if (Wr && In) if (_t) C(...) else vq(...)` |
| 守卫决策抽为纯函数 `chromeWiringBundledAction` | `setup.ts` 导出 `(enable, bundled, explicit) → 'warn'\|'skip'\|'none'` | main.tsx 六千行无法单测；这是唯一新增逻辑，8 组合矩阵可全覆盖 | 内联在 main.tsx（不可测）；三态决策函数替代布尔判定（用户已选上游形状，布尔+面板） | 一个小导出 | `src/utils/bundledMode.ts` `spawnScriptArgs` 的可注入参数先例 |
| `shouldEnableClaudeInChrome` 零改动 | 守卫做在接线段而非判定函数 | 上游判定就是布尔；接线段分流后置 `enableClaudeInChrome = false`，下游（onboarding 门控 `main.tsx:3253`、setup 分支）自动继承 | 在判定函数加 bundled 参数（会让通知 hook 与显式路径语义纠缠） | 无 | `src/main.tsx:2338` 单点消费者结构 |
| `/chrome` 面板按原因展示 | 仿 `isWSL` 先例加 bundled 错误行并隐藏菜单 | 面板已存在（状态/endpoint/profile/Reconnect/默认启用齐全），上游形状即"面板报原因" | 新建状态 UI（重复建设） | 两处 JSX | `src/commands/chrome/chrome.tsx:100-104` isWSL 行 |

## 3. 目标与非目标

### 目标
- bundled 二进制在任何 chrome 配置下都能正常启动到交互提示符。
- 显式 `--chrome`/`CLAUDE_CODE_ENABLE_CFC=1` 在 bundled 下：一次 stderr 警告 + 正常启动。
- 配置默认启用在 bundled 下：静默跳过（仅 debug 日志）。
- `/chrome` 面板在 bundled 下显示不可用原因，隐藏操作菜单。
- 守卫决策逻辑有单元测试覆盖。
- 非 bundled（源码 `bun` 方式）行为与现状完全一致。

### 非目标
- 不修 sidecar/stub：bundled 下支持 open-CDP chrome 仍是未来工作（契约文档既有范围）。
- 不删 `main.tsx:2370` 的 `process.exit(1)`（上游同款，语义为"意外失败"）。
- 不改 `shouldEnableClaudeInChrome` 签名与逻辑。
- 不动 `~/.claude.json` 配置。
- 不新建 `/chrome` 之外的状态 UI。

## 4. 设计明细

### 4.1 决策纯函数（`src/utils/claudeInChrome/setup.ts`）

```ts
export type ChromeWiringAction = 'warn' | 'skip' | 'none'

export function chromeWiringBundledAction(
  enable: boolean,
  bundled: boolean,
  explicit: boolean,
): ChromeWiringAction {
  if (!enable || !bundled) return 'none'
  return explicit ? 'warn' : 'skip'
}
```

`explicit` 的定义：`chromeFlag === true` 或 `isEnvTruthy(process.env.CLAUDE_CODE_ENABLE_CFC)`（镜像上游 `Fr.chrome !== !0 && Z.CLAUDE_CODE_ENABLE_CFC !== !0` 的显式性判断）。

### 4.2 接线段（`src/main.tsx:2338` 附近）

```ts
let enableClaudeInChrome = shouldEnableClaudeInChrome(chromeOpts.chrome)
const chromeWiringAction = chromeWiringBundledAction(
  enableClaudeInChrome,
  isInBundledMode(),
  chromeOpts.chrome === true || isEnvTruthy(process.env.CLAUDE_CODE_ENABLE_CFC),
)
if (chromeWiringAction === 'warn') {
  process.stderr.write(
    'Warning: Open Chrome CDP is not available in standalone builds; ' +
    'continuing without browser tools. Run from source to use it.\n',
  )
} else if (chromeWiringAction === 'skip') {
  logForDebugging(
    '[Claude in Chrome] Skipping chrome wiring: not available in standalone builds',
  )
}
if (chromeWiringAction !== 'none') enableClaudeInChrome = false
```

下游继承：`enableClaudeInChrome` 为 false → setup 分支不进入（catch 不可达）→ `showSetupScreens`（`:3253`）onboarding 不弹。auto-enable 分支现状恒 false，不受影响。

### 4.3 通知 hook（`src/hooks/useChromeExtensionNotification.tsx:13`）

`useStartupNotification` 回调开头加 `if (isInBundledMode()) return null`——hook 自行重算 `shouldEnableClaudeInChrome` 不经过接线段变量，需独立守卫，否则 bundled + 显式 `--chrome` 会显示误导性的"已启用"提示。

### 4.4 `/chrome` 面板（`src/commands/chrome/chrome.tsx`）

- 新增 `const isBundled = isInBundledMode()`（import 自 `../../utils/bundledMode.js`）。
- 仿 `isWSL` 错误行（`:100-104`）加：`{isBundled && <Text color="error">Open Chrome CDP is not available in standalone builds.</Text>}`。
- Select 菜单渲染条件 `!isWSL` 改为 `!isWSL && !isBundled`。

### 4.5 测试

- 新增 `tests/claudeInChromeWiring.test.ts`：`chromeWiringBundledAction` 8 组合矩阵（enable × bundled × explicit），TDD 先红后绿。
- 集成验证（pty，复用调试期复现手法）：本地 `bun run build:binary` 产出 bundled 二进制后验证三场景——配置默认启用正常启动无警告；`--chrome` 一行警告后正常启动；`/chrome` 显示 unsupported 行且无菜单。
- 回归：`bun run test` 全绿；源码方式（`bun run`，非 bundled）行为不变。

## 5. 失败语义与风险

| 场景 | 行为 | 依据 |
|---|---|---|
| bundled + 配置默认启用 | 静默跳过，无浏览器工具 | 上游"功能在平台上不可用即静默" |
| bundled + 显式 `--chrome`/env | 一次 stderr 警告 + 正常启动 | 上游显式被策略阻止 → stderr 警告 |
| 非 bundled + setup 意外失败 | 保持 `process.exit(1)` | 上游 catch 同款；意外失败不应静默 |
| 非 bundled + CDP 不可达 | 现状不变（preflight 报错路径） | 本次不触碰 stub 连接逻辑 |

风险：`bun run build:binary` 本地产物验证耗时（可接受，一次性）；警告文案与上游措辞不一致（上游无对应文案，措辞自拟但语义对齐）。

## 6. 现状验收标准

1. `tests/claudeInChromeWiring.test.ts` 全绿。
2. `bun run test` 全绿（无回归）。
3. pty 验证三场景（4.5）全部通过；bundled 启动不再出现 `Error: Failed to run with Claude in Chrome.`
4. 非 bundled：`bun run build && bun dist/main.js --version` 正常；`--chrome` 行为与现状一致。
5. `/chrome` 面板 bundled 下显示原因行、无菜单；非 bundled 面板内容不变。

## 7. 代码与测试证据

- 崩溃链与最小复现：`src/main.tsx:2370`（catch + exit）；`src/external-stubs/claude-for-chrome-mcp.ts:212-216`（Node sidecar spawn，cwd 为 `import.meta.url` 目录）；实测 `spawn('node', {cwd:'/$bunfs/root'})` → `ENOENT posix_spawn 'node'`；`~/.claude.json` 含 `"claudeInChromeDefaultEnabled": true`。
- 上游行为证据：v2.1.212 二进制字符串 `Skipping chrome wiring: blocked by enterprise MCP config or managed deniedMcpServers policy`（前置分流）、`Warning: MCP server blocked by enterprise policy`（显式警告档）、`return ... ps("Error: Failed to run with Claude in Chrome.")`（catch 硬退出，仅意外失败）。
- 官方文档证据：`--chrome` + API key → "keeps Chrome integration off"；WSL 不支持；策略场景经 `/chrome` 面板报告原因。
- 既有 UI 基础：`src/commands/chrome/chrome.tsx`（完整状态面板）、`src/components/ClaudeInChromeOnboarding.tsx` + `src/interactiveHelpers.tsx:392-401`（一次性 onboarding，已接线）。
- 测试空白：现有测试无 `shouldEnableClaudeInChrome`/接线守卫覆盖；`tests/openBackends.test.ts` 仅覆盖 stub 后端生命周期。

### 未覆盖测试
- pty 集成场景为人工验证（bundled 二进制行为无法在 `bun test` 内复现——测试进程 `Bun.main` 是真实路径，恒为非 bundled）。
- 非 bundled 显式 `--chrome` 的完整连接成功路径依赖真实 Chrome CDP 实例，不在 CI 范围。
