# Claude Code

[English](README.md) | **简体中文**

Claude Code 的教学/研究快照：使用 Bun、React 和 Ink 构建的智能体编程 CLI 与 TypeScript Agent SDK。

## 概述

本仓库提供两个可独立构建的产品：

- **CLI**：交互式及非交互式智能体终端应用。
- **Agent SDK**：用于查询、工具、会话和定时任务的可嵌入 TypeScript API。

CLI 与 SDK 共享内置工具、Model Context Protocol（MCP）集成、权限处理、异步查询和会话管理。SDK 还提供进程内 MCP 工具、多轮会话和定时任务辅助接口。

外部构建会排除或禁用内部及实验功能。禁用边界不代表该能力已经实现；当前验证结果和限制请参阅[实现状态](https://github.com/wencaiwulue/flash/blob/main/docs/STATUS.md)。

## 快速开始

要求：**Bun 1.3+**。以下命令从源码构建并运行。

```bash
bun install --frozen-lockfile
bun run build

bun dist/main.js --version
bun dist/main.js --help
```

构建会生成 CLI（`dist/main.js`）、Agent SDK（`dist/sdk.mjs`）和 TypeScript 声明（`dist/types/`）。启动交互式 CLI：

```bash
bun dist/main.js
```

模型驱动的 CLI 和 SDK 请求需要你自己的、已授权的模型服务配置。版本、帮助、构建和导入命令不会验证真实模型连接。

## 独立二进制

推送 `vX.Y.Z` 标签后，发布流水线会为以下平台生成独立二进制；运行它们不需要安装 Bun。只有创建发布标签后，产物才会出现在 [GitHub Releases](https://github.com/wencaiwulue/flash/releases)。

| 平台 | 架构 | 归档 |
|---|---|---|
| macOS | Apple Silicon | `darwin-arm64.tar.gz` |
| macOS | Intel | `darwin-x64.tar.gz` |
| Linux | x64 | `linux-x64.tar.gz` |
| Linux | ARM64 | `linux-arm64.tar.gz` |
| Windows | x64 | `win32-x64.zip` |
| Windows | ARM64 | `win32-arm64.zip` |

### 在 macOS 和 Linux 上安装

安装最新版本：

```bash
(
  set -e
  installer="$(mktemp)"
  trap 'rm -f "$installer"' EXIT
  curl -fsSL https://github.com/wencaiwulue/flash/releases/latest/download/install.sh -o "$installer"
  sh "$installer"
)
claude-code --version
```

安装程序会将最新版本安装到 `~/.local/bin`。安装前会强制使用 Release 提供的 `SHA256SUMS` 校验下载的归档，且安装程序不会使用 `sudo`。请确保 `~/.local/bin` 已包含在 `PATH` 中。

如需选择特定版本和安装目录：

```bash
(
  set -e
  installer="$(mktemp)"
  trap 'rm -f "$installer"' EXIT
  curl -fsSL https://github.com/wencaiwulue/flash/releases/latest/download/install.sh -o "$installer"
  VERSION=v1.0.1 INSTALL_DIR="$HOME/.local/bin" sh "$installer"
)
```

`VERSION` 必须采用严格的 `vX.Y.Z` 格式。`INSTALL_DIR` 为可选项，默认值为 `~/.local/bin`。

### 手动下载归档

归档完整名称为 `claude-code-vX.Y.Z-<平台>-<架构>.<扩展名>`。每个归档包含二进制、`README.md` 和 `README.zh-CN.md`。`install.sh` 安装脚本作为单独的 Release 资产发布，不包含在归档中。

macOS/Linux 示例：

```bash
tar -xzf claude-code-vX.Y.Z-darwin-arm64.tar.gz
./claude-code --version
./claude-code --help
```

Windows PowerShell 示例：

```powershell
tar -xf claude-code-vX.Y.Z-win32-x64.zip
.\claude-code.exe --version
.\claude-code.exe --help
```

每个 Release 还提供覆盖全部归档的 `SHA256SUMS`。下载对应归档和该文件后，可只校验所选产物：

```bash
# macOS
grep 'claude-code-vX.Y.Z-darwin-arm64.tar.gz$' SHA256SUMS | shasum -a 256 -c -

# Linux
grep 'claude-code-vX.Y.Z-linux-x64.tar.gz$' SHA256SUMS | sha256sum -c -

# Windows PowerShell：将此输出与 SHA256SUMS 对比
(Get-FileHash .\claude-code-vX.Y.Z-win32-x64.zip -Algorithm SHA256).Hash.ToLower()
```

发布门禁会在每个原生平台执行版本与帮助检查，并在解包后重复检查。这不等于模型连接或所有可选原生集成都已验证；当前产物也不包含签名、公证或从 GitHub Releases 自动更新的承诺。

维护者可在当前主机本地构建、运行、打包并复验一个独立二进制：

```bash
bun run build:binary
```

产物写入 `build/release/`。只能为当前 OS/架构构建，不能将未运行验证的交叉编译产物发布。详细流程见[发布指南](https://github.com/wencaiwulue/flash/blob/main/docs/RELEASING.md)。

## Agent SDK

构建后，导入本地 SDK 入口并流式读取查询消息：

```ts
import { query } from './dist/sdk.mjs'

for await (const message of query({
  prompt: 'Reply with a short greeting.',
  options: { tools: [] },
})) {
  console.log(message)
}
```

SDK 支持：

- `tool()` 和 `createSdkMcpServer()`：进程内 MCP 工具。
- `query()`：异步消息、中止、权限、模型和 MCP 控制。
- V2 会话：`unstable_v2_createSession()`、`unstable_v2_resumeSession()` 和 `unstable_v2_prompt()`。
- 会话存储、文件检查点回退、上下文用量和定时任务。

SDK 组合方式见[架构文档](https://github.com/wencaiwulue/flash/blob/main/docs/ARCHITECTURE.md)，各能力验证范围见[实现状态](https://github.com/wencaiwulue/flash/blob/main/docs/STATUS.md)。

## 开发

| 命令 | 用途 |
|---|---|
| `bun run dev` | 从源码热重载运行 CLI。 |
| `bun run start` | 从源码运行 CLI。 |
| `bun run generate:sdk-types` | 从当前 schema 生成可序列化 SDK 类型。 |
| `bun run typecheck` | 执行 TypeScript 检查，不生成文件。 |
| `bun run test` | 使用仓库的逐文件隔离运行器执行测试。 |
| `bun run build` | 生成 SDK 类型、构建 CLI/SDK 并生成声明。 |
| `bun run build:binary` | 为当前主机编译、验证并打包独立二进制。 |

## 仓库结构

```text
src/
├── entrypoints/       # CLI 与 Agent SDK 入口
├── tools/             # 内置智能体工具
├── commands/          # 斜杠命令实现
├── components/        # React/Ink 终端组件
├── services/          # API、MCP、认证及其他集成
├── utils/             # 查询、会话、权限及共享工具
└── ...                # 其他 UI 与运行时子系统
scripts/               # 构建、测试、SDK 类型、发布及实机验证脚本
tests/                 # 测试套件
fixtures/              # 测试夹具
docs/                  # 用户、维护者、设计及验证文档
```

CLI 与 SDK 在暴露不同入口的同时，共享查询引擎、工具池、权限系统和应用状态。完整查询及状态流见[架构文档](https://github.com/wencaiwulue/flash/blob/main/docs/ARCHITECTURE.md)。

## 文档

从[文档索引](https://github.com/wencaiwulue/flash/blob/main/docs/README.md)开始，或直接查看：

- [架构](https://github.com/wencaiwulue/flash/blob/main/docs/ARCHITECTURE.md) — 入口、构建产物、查询流、SDK 组合、安全与功能边界。
- [实现状态](https://github.com/wencaiwulue/flash/blob/main/docs/STATUS.md) — 当前能力、验证证据和剩余工作。
- [发布指南](https://github.com/wencaiwulue/flash/blob/main/docs/RELEASING.md) — 可重复的中英文发布流程。
- [发布记录](https://github.com/wencaiwulue/flash/blob/main/docs/RELEASE.md) — 历史发布说明。
- [功能文档规范](https://github.com/wencaiwulue/flash/blob/main/docs/COMMIT_DOCS.md) — 功能设计规格和实施计划的维护规则。
