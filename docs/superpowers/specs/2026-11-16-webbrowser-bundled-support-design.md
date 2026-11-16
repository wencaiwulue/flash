---
id: webbrowser-bundled-support
batch: 5
title: bundled 构建进程内支持 WebBrowser（playwright-core 数据读取编译期内联）
date: 2026-11-16
status: draft
---

# bundled 构建进程内支持 WebBrowser

## 1. 问题与约束

v0.0.1 bundled 二进制中模型调用 WebBrowser 工具即崩溃：
`ResolveMessage: Cannot find module '<编译机>/node_modules/playwright-core/package.json' from '/$bunfs/root/cli.js'`。

崩溃链：playwright-core `lib/coreBundle.js` 内 `require(path.join(packageRoot, "package.json"))` 与
`require(path.join(packageRoot, "browsers.json"))` 是动态路径 require，Bun 编译不内联，
`__dirname`/`packageRoot` 被烘焙为编译机绝对路径，运行时必然 ResolveMessage。

用户决策（2026-11-16）：**实现该 feature 而非绕开**——bundled 下 WebBrowser 必须真正可用。
经两条路线实验（见 §7）后用户选定路线 A：进程内 playwright。

约束：
- 与上游 Claude Code 有意偏离：上游 external 构建编译期裁掉该工具（v2.1.212 二进制 strings 实证），
  本仓库作为教学/研究快照选择实现它。偏离须在契约文档中显式声明。
- 功能子系统：登记 `docs/architecture/coverage/manifest.yaml` 并通过 `bun scripts/check-design-docs.ts`。
- 不修改 `node_modules` 内文件；一切转换在构建插件内完成。

## 2. 设计理由与备选方案

| 决策 | 实际机制 | 为什么采用 | 备选方案及不采用原因 | 代价 | 证据 |
|---|---|---|---|---|---|
| 路线 A：进程内 playwright | 构建插件把 playwright-core 两处动态数据读取内联为编译期常量；现有 stub 进程内代码原样工作 | 端到端实验通过（launch→goto→evaluate→screenshot）；用户机器只需装 Chrome，无 node 依赖；零新增协议层 | 路线 B：node 目标 sidecar bundle 嵌入释放（也验证可行，但需用户装 node ≥18、新增协议层/清理/僵死防御，+6.65MB）；移除 flag（上游同款，用户明确否决） | 二进制 +7.0MB | `/tmp/exp-inbin/`（A）、`/tmp/exp-sidecar/`（B）实验报告，2026-11-16 |
| 插件不碰 node_modules | `onLoad` 匹配 `playwright-core/lib/{coreBundle,package,serverRegistry}.js`，在源码文本上正则替换后返回 | 改 node_modules 会被重装冲掉且污染环境 | 直接 patch node_modules（不可持久） | 插件需随 playwright 升级重审 | 实验 Round 2-3 验证插件方案 |
| 插件挂到全部 Bun.build | `createBuildOptions()` 增加 `plugins` 字段，dist 构建（build.ts）与 compile 构建（build-binary.ts）同时获得 | dist/main.js 同样是单文件 bundle，playwright-core 烘焙问题相同，不修则 `bun dist/main.js` 下 WebBrowser 一样崩 | 仅 compile 构建（dist 形态留坑） | 无 | `scripts/build.ts:53` 与 `scripts/build-binary.ts:272` 均走 `Bun.build` API |
| 升级绊线测试 | 回归测试 grep 真实 `node_modules/playwright-core/lib/coreBundle.js` 必须包含插件所处理的两个模式，并验证插件转换输出可解析 | playwright 升级若改写这两处，插件静默失灵 → bundled 崩溃回归；测试在升级时立刻失败 | 无测试（失败只能靠用户报告） | 无 | 插件正则与 coreBundle.js 实测内容匹配 |
| Chrome 缺失沿用现有错误传播 | `chromium.launch({channel:'chrome'})` 失败 → stub 现有 catch → MCP 错误结果 | 不特判可保持 stub 语义单一；错误信息已含失败原因 | bundled 下预检 Chrome 是否安装（多余分支，YAGNI） | 无 | `src/external-stubs/claude-for-chrome-mcp.ts` getOpenBrowserClient 错误路径 |

## 3. 目标与非目标

### 目标
- bundled（compile）与 dist（bun build）两种产物形态下，WebBrowser 工具端到端可用（launch → navigate → evaluate → screenshot）。
- 产物脱离编译机路径：编译源目录删除后二进制仍正常。
- playwright 升级导致插件失配时，测试套件立即失败（绊线）。
- **自动化交互测试门禁**（用户要求，防"只能人工发现"的 bundled 运行时回归）：
  - release 构建冒烟在真实二进制内端到端调用 WebBrowser（见 §4.5）；
  - 测试套件含 pty 交互启动冒烟（见 §4.6）。
- 契约文档 `docs/external-stubs/contracts/open-chrome.md` 修订：声明 bundled isolated 路径已支持。

### 非目标
- chrome-cdp 真实 Chrome 路径的 bundled 支持：ws 握手限制（Bun node:http upgrade 模拟无法完成 Playwright ws CDP 握手，
  stub 注释 `src/external-stubs/claude-for-chrome-mcp.ts:211-213` 实证），需 sidecar 架构，留待独立 feature。
- `webp_codec.wasm`（截图 diff/图像比对 toHaveScreenshot 类）：懒加载路径，MCP 截图捕获不经过它，本期不做。
- playwright `install`/CLI/trace-viewer 等 CLI 向功能（烘焙路径仍存在，CLI 运行时不用）。
- 发布新版本（合并后用户另行决定）。

## 4. 设计明细

### 4.1 构建插件 `scripts/playwrightInlinePlugin.ts`

- 导出 `createPlaywrightInlinePlugin(): BunPlugin`，供 `createBuildOptions()` 与测试共用。
- `setup()` 中 `onLoad({ filter: /playwright-core[\\/](lib[\\/])?(coreBundle|package|serverRegistry)\.js$/ })`。
- 构建期从被解析的 playwright-core 真实路径读 `package.json` 与 `lib/browsers.json`（browsers.json 不存在时按空 registry 内联，只发警告）。
- 文本替换（命中才替换，未命中原文返回）：
  - `require(<X>.join(packageRoot, "package.json"))` → `JSON.parse(<内联字面量>)` 等价形态（直接内联对象字面量）
  - `require(<X>.join(packageRoot, "browsers.json"))` → 同上
  - 实验验证的正则模式以 `/tmp/exp-inbin/build.ts` 插件为基准移植。
- 返回 `{ contents, loader: 'js' }`。

### 4.2 接入点

- `scripts/build.ts` `createBuildOptions()` 返回值增加 `plugins: [createPlaywrightInlinePlugin()]`（类型放宽为 Bun.BuildConfig 兼容）。
- `scripts/build-binary.ts` 经 `...createBuildOptions()` 自动获得。
- `tests/fixtures/verify-enabled-features.ts` 不需要（产物在 bun 运行时执行，node_modules 可解析，无烘焙问题）。

### 4.3 回归测试 `tests/playwrightInlinePlugin.test.ts`

1. 真实 node_modules 绊线：读 `node_modules/playwright-core/lib/coreBundle.js` 文本，断言包含插件处理的 `package.json` 与 `browsers.json` 两个 require 模式（升级失配即失败）。
2. 插件单元：以最小合成文本（两种模式各一）跑插件 onLoad 转换，断言 require 已被内联且内联内容 `JSON.parse` 成功、字段 `name === 'playwright-core'`。
3. 未命中透传：不含模式的文本原样返回。

### 4.4 验收验证（人工/pty）

- 本机 `bun run build:binary` → 产物 `strings` 检查：不含编译机绝对 node_modules 路径；含 `playwright-core` 正常。
- pty 启动 bundled 二进制 → 交互会话让模型调用 WebBrowser 打开 `data:text/html` 页面并读 title → 成功返回。
- `bun run build` → `bun dist/main.js` 形态同样验证 WebBrowser 可用。
- 源码形态回归：`bun run test` 全绿；`bun run dev` 下 WebBrowser 行为不回归。

### 4.5 release 冒烟：真实二进制内端到端工具调用

背景：`scripts/build-binary.ts:235-245` 的 `smokeTestStandaloneBinary` 已通过临时重命名 node_modules
强制"真独立"环境跑 `--version` 冒烟；v0.0.1 崩溃恰属该冒烟覆盖不到的运行时调用路径。
本次把它升级为**崩溃类回归的硬门禁**：

1. **测试通道**：`src/main.tsx` 入口最早期（UI 初始化之前）检查 `FLASH_SMOKE_TOOL` 环境变量：
   - `FLASH_SMOKE_TOOL=WebBrowser`、`FLASH_SMOKE_INPUT=<tool input JSON>` 时：
     加载工具注册表 → 取 `WebBrowserTool` → `tool.call(JSON.parse(input))` → stdout 打印一行
     JSON 结果（含 `ok`/`error` 字段）→ `process.exit(0)`（成功）或 `exit(1)`（抛错）。
   - 不走模型、不开 Ink UI、不写配置；变量未设时行为与现状完全一致。
   - 命名用 `FLASH_` 前缀（本仓库自有测试通道，先例：`OVERFLOW_TEST_TOOL` 测试工具、
     `flash-binary-home-` 临时目录前缀）。
2. **冒烟步骤**（追加进 `smokeTestStandaloneBinary`，node_modules 隐藏态下执行）：
   spawn 二进制，env 注入 `FLASH_SMOKE_TOOL=WebBrowser` + input
   `{"action":"browser_navigate","arguments":{"url":"data:text/html,<title>smoke-ok</title>"}}`
   → 读 stdout JSON → `ok === true` 且结果含 `smoke-ok` 即通过。
3. **失败语义**：
   - 崩溃类（ResolveMessage、MODULE_NOT_FOUND、非 Chrome 缺失的工具错误）→ 冒烟失败 → **构建失败**。
   - Chrome 缺失（launch 报 executable/channel 找不到类错误）→ **警告跳过**（CI 机器可能没装 Chrome），
     构建继续，stderr 打印 `Smoke skip: Chrome not available on this machine`。
   - 区分依据：错误文本匹配 playwright 的 browser-not-found 模式（`Executable doesn't exist`、
     `channel.*not.*found`、`No such file or directory.*chrome` 等合集，实现时以实际报错为准并记入测试断言）。

### 4.6 测试套件 pty 交互启动冒烟

`tests/interactiveStartup.test.ts`（unix-only，`process.platform === 'win32'` 时 skip）：
- pty（`script -q /dev/null`）拉起 `bun dist/main.js`（dist 形态最接近 bundled 的单文件 bundle），
  HOME 指向 mkdtemp 隔离目录。
- 断言 15s 内输出包含欢迎框特征字符串（`Welcome back` 或版本框）且进程未以崩溃堆栈退出；
  超时 kill 后按输出判定。
- 目的：捕获交互启动类回归（如启动即崩、欢迎 UI 崩溃）；不依赖模型 API。
- 前置：需要 `dist/main.js` 存在；缺失时 skip 并提示先 `bun run build`（避免 `bun run test` 强制全量构建）。
 

## 5. 失败语义与风险

| 风险 | 场景 | 缓解 |
|---|---|---|
| playwright 升级改写命中点 | 插件正则失配，内联不发生，bundled 崩溃回归 | §4.3 绊线测试 grep 真实文件；升级 PR 会红 |
| 内联数据过期 | browsers.json 与 playwright 运行时逻辑不一致 | 内联内容来自同一构建所解析的 playwright-core 真实文件，天然一致 |
| Chrome 未安装 | `chromium.launch` 抛错 | 现有错误传播路径给出可读报错；文档注明需系统 Chrome |
| webp_codec.wasm 缺失 | 截图 diff 类调用在用户机失败 | 非目标，契约文档记录已知限制 |
| 烘焙 CLI 路径残留 | `playwright install` 等在用户机指向无效路径 | CLI 向功能非目标；绊线测试只覆盖 launch 路径 |

## 6. 现状验收标准

1. `scripts/playwrightInlinePlugin.ts` 存在并挂入全部 Bun.build 路径。
2. `tests/playwrightInlinePlugin.test.ts` 三类断言全过；`tests/interactiveStartup.test.ts` 过（无 dist 时 skip）；`bun run test` 全绿。
3. 本机 bundled 产物：`FLASH_SMOKE_TOOL` 冒烟端到端成功（node_modules 隐藏态）；编译源目录删除后仍成功。
4. dist 产物 `bun dist/main.js` 下 WebBrowser 端到端成功；pty 启动冒烟通过。
5. `docs/external-stubs/contracts/open-chrome.md` 修订完成（bundled isolated 支持 + 已知限制清单）。
6. manifest 登记 + `bun scripts/check-design-docs.ts` 0 errors。
7. release 构建冒烟失败语义验证：模拟崩溃（移除插件编译一次）→ 构建失败；模拟无 Chrome → 警告跳过。

## 7. 代码与测试证据

- 崩溃复现与机制：v0.0.1 用户实测（2026-11-16）+ 实验 Round 1 精确复现 ResolveMessage。
- 路线 A 实验：`/tmp/exp-inbin/`（build.ts 插件脚本、launch-full/launch-dyn、隔离编译源目录后的 e2e 通过、体积 63,446,114 → 70,447,202 字节）。
- 路线 B 实验：`/tmp/exp-sidecar/`（sidecar.node.js 6.91MB、host 端到端 OK、`--define` 占位 + stub 目录便携化、ENOENT 降级）。
- 构建接线点：`scripts/build.ts:13,53`、`scripts/build-binary.ts:272-276`。
- 现有进程内代码路径：`src/external-stubs/claude-for-chrome-mcp.ts:478-560`（getOpenBrowserClient）、`:242`（动态 import('@playwright/mcp')）。
- ws 限制注释：`src/external-stubs/claude-for-chrome-mcp.ts:211-213`。
- 上游裁剪证据：v2.1.212 二进制 `WEB_BROWSER_TOOL` 0 处、`expected-absent` 分类器（调查报告 2026-11-16）。

### 未覆盖测试
- bundled 端到端属人工/pty 验收，无法进自动化套件（测试进程非 compile 形态）。
- webp/trace-viewer 等 CLI 向功能未验证（非目标）。
