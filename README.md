# Claude Code

Claude Code 的教学/研究快照：使用 Bun、React 和 Ink 构建的智能体编程 CLI 与 TypeScript Agent SDK。

Educational/research snapshot of Claude Code: an agentic coding CLI and TypeScript Agent SDK built with Bun, React, and Ink.

## 概述 | Overview

本仓库提供两个可独立构建的产品：

This repository provides two independently buildable products:

- **CLI**：交互式及非交互式智能体终端应用。/ An interactive and headless agent terminal application.
- **Agent SDK**：用于查询、工具、会话和定时任务的可嵌入 TypeScript API。/ An embeddable TypeScript API for queries, tools, sessions, and scheduled tasks.

CLI 与 SDK 共享内置工具、Model Context Protocol（MCP）集成、权限处理、异步查询和会话管理。SDK 还提供进程内 MCP 工具、多轮会话和定时任务辅助接口。

The CLI and SDK share built-in tools, Model Context Protocol (MCP) integrations, permission handling, asynchronous queries, and session management. The SDK also exposes in-process MCP tools, multi-turn sessions, and scheduled-task helpers.

外部构建会排除或禁用内部及实验功能。禁用边界不代表该能力已经实现；当前验证结果和限制请参阅[实现状态](docs/STATUS.md)。

The external build excludes or disables internal and experimental features. A disabled boundary is not an implemented capability; see [Implementation Status](docs/STATUS.md) for current verification results and remaining limitations.

## 快速开始 | Quick Start

要求：**Bun 1.3+**。以下方式从源码构建并运行。

Requirements: **Bun 1.3+**. These commands build and run from source.

```bash
bun install --frozen-lockfile
bun run build

bun dist/main.js --version
bun dist/main.js --help
```

构建会生成 CLI（`dist/main.js`）、Agent SDK（`dist/sdk.mjs`）和 TypeScript 声明（`dist/types/`）。启动交互式 CLI：

The build produces the CLI (`dist/main.js`), Agent SDK (`dist/sdk.mjs`), and TypeScript declarations (`dist/types/`). Start the interactive CLI with:

```bash
bun dist/main.js
```

模型驱动的 CLI 和 SDK 请求需要你自己的、已授权的模型服务配置。版本、帮助、构建和导入命令不会验证真实模型连接。

Model-driven CLI and SDK requests require your own authorized model-provider configuration. The version, help, build, and import commands do not validate a live model connection.

## 独立二进制 | Standalone Binaries

推送 `vX.Y.Z` 标签后，发布流水线会为以下平台生成独立二进制；运行它们不需要安装 Bun。产物位于 [GitHub Releases](https://github.com/wencaiwulue/flash/releases)，在创建发布标签前不会存在。

Pushing a `vX.Y.Z` tag builds standalone binaries for the following platforms; they do not require Bun at runtime. Assets appear on [GitHub Releases](https://github.com/wencaiwulue/flash/releases) only after a release tag is created.

| 平台 / Platform | 架构 / Architecture | 归档 / Archive |
|---|---|---|
| macOS | Apple Silicon | `darwin-arm64.tar.gz` |
| macOS | Intel | `darwin-x64.tar.gz` |
| Linux | x64 | `linux-x64.tar.gz` |
| Linux | ARM64 | `linux-arm64.tar.gz` |
| Windows | x64 | `win32-x64.zip` |
| Windows | ARM64 | `win32-arm64.zip` |

归档完整名称为 `claude-code-vX.Y.Z-<平台>-<架构>.<扩展名>`，每个归档包含二进制和本 README。macOS/Linux 示例：

Full archive names follow `claude-code-vX.Y.Z-<platform>-<arch>.<extension>` and contain the binary plus this README. Example for macOS/Linux:

```bash
tar -xzf claude-code-vX.Y.Z-darwin-arm64.tar.gz
./claude-code --version
./claude-code --help
```

Windows 示例 / Windows example:

```powershell
tar -xf claude-code-vX.Y.Z-win32-x64.zip
.\claude-code.exe --version
.\claude-code.exe --help
```

每个 Release 还提供覆盖全部归档的 `SHA256SUMS`。下载对应归档和该文件后，可只校验所选产物：

Each Release includes `SHA256SUMS` covering every archive. After downloading your archive and this file, verify only the selected asset:

```bash
# macOS
grep 'claude-code-vX.Y.Z-darwin-arm64.tar.gz$' SHA256SUMS | shasum -a 256 -c -

# Linux
grep 'claude-code-vX.Y.Z-linux-x64.tar.gz$' SHA256SUMS | sha256sum -c -

# Windows PowerShell: compare this output with SHA256SUMS
(Get-FileHash .\claude-code-vX.Y.Z-win32-x64.zip -Algorithm SHA256).Hash.ToLower()
```

发布门禁会在每个原生平台执行版本与帮助检查，并在解包后重复检查。这不等于模型连接或所有可选原生集成都已验证；当前产物也不包含签名、公证或从 GitHub Releases 自动更新的承诺。

The release gate runs version and help checks on each native platform and repeats them after extraction. This does not validate model connections or every optional native integration; the assets are not signed/notarized, and GitHub Releases-based automatic updates are not provided.

维护者可在当前主机本地构建、运行、打包并复验一个独立二进制：

Maintainers can compile, execute, package, and re-verify a standalone binary for the current host:

```bash
bun run build:binary
```

产物写入 `build/release/`。只能为当前 OS/架构构建，不能将未运行验证的交叉编译产物发布。详细流程见[发布指南](docs/RELEASING.md)。

Artifacts are written to `build/release/`. Only the current OS/architecture can be built; unexecuted cross-compiled artifacts cannot be published. See the [Release Guide](docs/RELEASING.md) for the complete process.

## Agent SDK

构建后，导入本地 SDK 入口并流式读取查询消息：

After building, import the local SDK entrypoint and stream query messages:

```ts
import { query } from './dist/sdk.mjs'

for await (const message of query({
  prompt: 'Reply with a short greeting.',
  options: { tools: [] },
})) {
  console.log(message)
}
```

SDK 支持 / The SDK supports:

- `tool()` 和 `createSdkMcpServer()`：进程内 MCP 工具。/ In-process MCP tools.
- `query()`：异步消息、中止、权限、模型和 MCP 控制。/ Asynchronous messages, aborts, permissions, models, and MCP controls.
- V2 会话：`unstable_v2_createSession()`、`unstable_v2_resumeSession()` 和 `unstable_v2_prompt()`。/ V2 sessions through these APIs.
- 会话存储、文件检查点回退、上下文用量和定时任务。/ Session storage, file-checkpoint rewind, context usage, and scheduled tasks.

SDK 组合方式见[架构文档](docs/ARCHITECTURE.md)，各能力验证范围见[实现状态](docs/STATUS.md)。

See [Architecture](docs/ARCHITECTURE.md) for SDK composition and [Implementation Status](docs/STATUS.md) for capability-specific verification.

## 开发 | Development

| 命令 / Command | 用途 / Purpose |
|---|---|
| `bun run dev` | 从源码热重载运行 CLI。/ Run the CLI from source with hot reloading. |
| `bun run start` | 从源码运行 CLI。/ Run the CLI from source. |
| `bun run generate:sdk-types` | 从当前 schema 生成可序列化 SDK 类型。/ Generate serializable SDK types from the current schemas. |
| `bun run typecheck` | 执行 TypeScript 检查，不生成文件。/ Run TypeScript checks without emitting files. |
| `bun run test` | 使用仓库的逐文件隔离运行器执行测试。/ Run tests with the isolated per-file test runner. |
| `bun run build` | 生成 SDK 类型、构建 CLI/SDK 并生成声明。/ Generate SDK types, build the CLI and SDK, and emit declarations. |
| `bun run build:binary` | 为当前主机编译、验证并打包独立二进制。/ Compile, verify, and package a standalone binary for the current host. |

## 仓库结构 | Repository Layout

```text
src/
├── entrypoints/       # CLI 与 Agent SDK 入口 / CLI and Agent SDK entrypoints
├── tools/             # 内置智能体工具 / Built-in agent tools
├── commands/          # 斜杠命令实现 / Slash command implementations
├── components/        # React/Ink 终端组件 / React/Ink terminal UI components
├── services/          # API、MCP、认证及其他集成 / API, MCP, authentication, and integrations
├── utils/             # 查询、会话、权限及共享工具 / Query, session, permission, and shared utilities
└── ...                # 其他 UI 与运行时子系统 / Additional UI and runtime subsystems
scripts/               # 构建、测试、SDK 类型、发布及实机验证脚本 / Build, test, SDK, release, and live-validation scripts
tests/                 # 测试套件 / Test suite
fixtures/              # 测试夹具 / Test fixtures
docs/                  # 用户、维护者、设计及验证文档 / User, maintainer, design, and verification documents
```

CLI 与 SDK 在暴露不同入口的同时，共享查询引擎、工具池、权限系统和应用状态。完整查询及状态流见[架构文档](docs/ARCHITECTURE.md)。

The CLI and SDK share the query engine, tool pool, permission system, and application state while exposing different entrypoints. See [Architecture](docs/ARCHITECTURE.md) for the complete query and state flow.

## 文档 | Documentation

从[文档索引](docs/README.md)开始，或直接查看：

Start with the [Documentation Index](docs/README.md), or go directly to:

- [架构 / Architecture](docs/ARCHITECTURE.md) — 入口、构建产物、查询流、SDK 组合、安全与功能边界。/ Entrypoints, artifacts, query flow, SDK composition, security, and feature boundaries.
- [实现状态 / Implementation Status](docs/STATUS.md) — 当前能力、验证证据和剩余工作。/ Current capabilities, verification evidence, and remaining work.
- [发布指南 / Release Guide](docs/RELEASING.md) — 可重复的中英文发布流程。/ Repeatable bilingual release process.
- [发布记录 / Release Record](docs/RELEASE.md) — 历史发布说明。/ Historical release notes.
- [功能文档规范 / Feature Documentation Policy](docs/COMMIT_DOCS.md) — 功能设计规格和实施计划的维护规则。/ Maintainer rules for feature design specs and implementation plans.
