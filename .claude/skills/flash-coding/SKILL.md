---
name: flash-coding
description: 在 flash 仓库（Claude Code 教学快照）写代码、写测试、改文档或发版前使用。涵盖产品命名排除清单、构建/测试命令与 bun 环境陷阱、bundled 与 external-stubs 架构约束、文档与发布流程、上游 Claude Code 行为对齐工作流。
---

# flash 工程注意事项

给在本仓库工作的 agent 的工程惯例。每条规则带证据锚点；行号是辅助定位，以导出名/路径/命令为准。

## 1. 产品命名（flash vs Claude Code）

本仓库产品名是 **flash**（小写），是 Claude Code 的教学/研究快照。命名遵循
`docs/superpowers/specs/2026-11-14-flash-rename-design.md` 第 4 节，要点：

- 替换规则：产品指称 `Claude Code` → `flash`；二进制/归档/命令名 `claude-code` → `flash`
  （仅限产物命名链与文档示例）；`claude_code`/`ClaudeCode`/`claudeCode` 标识符默认保留。
- **绝不替换**（排除清单）：
  - `src/tools/AgentTool/built-in/claudeCodeGuideAgent.ts`（讲解真实 Claude Code 的 agent）
  - `src/types/generated/**`（生成的上游 schema）
  - `src/constants/github-app.ts`（引用真实 anthropics/claude-code-action 的工作流模板）
  - `src/constants/oauth.ts`（协议常量）
  - `CLAUDECODE=1` / `<claude-code-hint />` 协议字面量与注释
  - 小写外部标识符：`com.anthropic.claude-code-url-handler`、`claude-code-keybindings.json`、
    `claude-code-github-action`、`anthropics/claude-code`、`claude-code-action`、
    `claude-code-plugins`、`#claude-code-feedback`、`platform.claude.com/…app=claude-code`
  - `docs/RELEASE.md` 中的 legacy 仓库 URL
- 归属句保护：`README.md:5` "Educational/research snapshot built on Claude Code: …" 与
  `README.zh-CN.md:5` "基于 Claude Code 的教学/研究快照：…" 中的 Claude Code 必须保留。
- 完成标准：全仓 `grep -rn "Claude Code\|claude-code" src scripts docs` 的残留必须能逐条
  归入排除清单或归属句。

## 2. 构建测试与环境陷阱

命令（`package.json` scripts）：

- `bun install --frozen-lockfile`
- `bun run build`（= `bun scripts/build.ts` + `build:types`）
- `bun run typecheck`
- `bun run test`
- `bun run build:binary`（独立二进制，默认输出 `build/release/`）

**测试运行器语义**（`scripts/test.ts`）：对每个测试文件起**独立 bun 进程顺序执行**。
输出里的 "N pass / 0 fail" 只是**最后一个文件**的统计——判定标准是**退出码 0 且无
"Failed test files" 输出**，不要只看 tail 的 pass 数。

环境陷阱：

- 沙箱内 `tests/openBackends.test.ts` 可能因进程组 `kill` 报 `EPERM`——环境性失败，非代码缺陷。
- 无 TTY 时 CLI 走非交互分支（"Input must be provided either through stdin…"）。验证交互行为
  用 `script -q /dev/null <命令>` 分配伪终端，后台跑 + sleep + 按 PID kill。
- bun `child_process.spawn` 的 `cwd` 指向 `/$bunfs/...` 会 `ENOENT posix_spawn`（虚拟文件系统
  对真实子进程不可见）；即使 cwd 有效，独立二进制也无法为子进程解析 node_modules。
- Bun 的 ws 模拟无法完成 Playwright 的 CDP 握手（`src/external-stubs/claude-for-chrome-mcp.ts`
  为此维护 Node sidecar）。
- macOS `sed -i ''`（BSD sed）。
- `CLAUDE_CODE_DEBUG_LOGS_DIR` 期望**文件路径**而非目录（传目录会 EISDIR 崩溃）。

## 3. 架构约束与 external-stubs

- **双运行形态**：`isInBundledMode()`（`src/utils/bundledMode.ts`：`Bun.main` 以 `/$bunfs/`
  开头或有 embeddedFiles）vs 源码 `bun` 运行。两形态行为可能分叉，新代码要考虑
  （先例：`main.tsx` chrome 接线段的前置分流 `chromeWiringBundledAction`）。
- **external-stubs**：外部构建用 `src/external-stubs/` 替换私有 `@ant/*` 包。改 stub 前
  必读 `docs/external-stubs/contracts/*.md` 契约；不得声称与私有协议（native messaging、
  bridge、扩展配对）兼容。
- **设计文档校验**：功能子系统的 spec 需登记 `docs/architecture/coverage/manifest.yaml`
  并通过 `bun scripts/check-design-docs.ts`；工程改造类（改名、工具链、本 skill 等）
  不登记不校验。

## 4. 文档与发布流程

- 设计文档：`docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md` 与
  `docs/superpowers/plans/YYYY-MM-DD-<topic>.md`；中文；frontmatter
  （id/batch/title/date/status）；决策表带"证据"列；参照既有文件的章节结构。
- **双语成对**：`README.md` ↔ `README.zh-CN.md`；docs 内双语文件（如 `RELEASING.md`）
  改一处必须同步另一处。
- **发布命名单点**：`scripts/build-binary.ts` 的 `getBinaryName`/`getArchiveName` 决定
  二进制与归档名（`flash` / `flash.exe` / `flash-vX.Y.Z-<platform>-<arch>.<ext>`）；
  `scripts/install.sh` 的 `BINARY_NAME` 与 `tests/releasePackaging.test.ts` 断言联动。
  改命名必须**同一提交**同步全部引用（先改测试为失败再改实现，TDD）。
- 发布流程：推送 `vX.Y.Z` tag → `.github/workflows/release.yml` 构建六平台产物并发布；
  流程权威是 `docs/RELEASING.md`（双语）。

## 5. 上游对齐工作流（先对齐，再设计）

对 Claude Code 上游行为做任何设计/修改前，按顺序收集三层证据：

1. **官方文档**：`https://code.claude.com/docs/`（抓取入口 `llms.txt` 索引找相关页）。
2. **上游二进制实测**：本机已装时 `which claude` 定位（macOS Homebrew 形如
   `/opt/homebrew/Caskroom/claude-code/<version>/claude`），用 `strings` 提取关键路径的
   逻辑片段。二进制证据优先于文档——文档可能滞后（反例：chrome 修复中文档暗示上游
   "keeps integration off"，二进制显示 setup 失败仍硬退出，真正的护栏是 setup 前的前置分流）。
3. **本仓库契约**：`docs/external-stubs/contracts/*.md` 与既有 spec。

要求：证据写入 spec 决策表的"证据"列；上游语义优先于本仓库现状（快照定位），
除非契约文档明确声明偏离。
