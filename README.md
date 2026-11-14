# flash

**English** | [简体中文](README.zh-CN.md)

Educational/research snapshot of Claude Code: an agentic coding CLI and TypeScript Agent SDK built with Bun, React, and Ink.

## Overview

This repository provides two independently buildable products:

- **CLI**: An interactive and headless agent terminal application.
- **Agent SDK**: An embeddable TypeScript API for queries, tools, sessions, and scheduled tasks.

The CLI and SDK share built-in tools, Model Context Protocol (MCP) integrations, permission handling, asynchronous queries, and session management. The SDK also exposes in-process MCP tools, multi-turn sessions, and scheduled-task helpers.

The external build excludes or disables internal and experimental features. A disabled boundary is not an implemented capability; see [Implementation Status](https://github.com/wencaiwulue/flash/blob/main/docs/STATUS.md) for current verification results and remaining limitations.

## Quick Start

Requirements: **Bun 1.3+**. These commands build and run from source.

```bash
bun install --frozen-lockfile
bun run build

bun dist/main.js --version
bun dist/main.js --help
```

The build produces the CLI (`dist/main.js`), Agent SDK (`dist/sdk.mjs`), and TypeScript declarations (`dist/types/`). Start the interactive CLI with:

```bash
bun dist/main.js
```

Model-driven CLI and SDK requests require your own authorized model-provider configuration. The version, help, build, and import commands do not validate a live model connection.

## Standalone Binaries

Pushing a `vX.Y.Z` tag builds standalone binaries for the following platforms; they do not require Bun at runtime. Assets appear on [GitHub Releases](https://github.com/wencaiwulue/flash/releases) only after a release tag is created.

| Platform | Architecture | Archive |
|---|---|---|
| macOS | Apple Silicon | `darwin-arm64.tar.gz` |
| macOS | Intel | `darwin-x64.tar.gz` |
| Linux | x64 | `linux-x64.tar.gz` |
| Linux | ARM64 | `linux-arm64.tar.gz` |
| Windows | x64 | `win32-x64.zip` |
| Windows | ARM64 | `win32-arm64.zip` |

### Install on macOS and Linux

Install the latest release:

```bash
(
  set -e
  installer="$(mktemp)"
  trap 'rm -f "$installer"' EXIT
  curl -fsSL https://github.com/wencaiwulue/flash/releases/latest/download/install.sh -o "$installer"
  sh "$installer"
)
flash --version
```

The installer installs the latest release into `~/.local/bin`. It verifies the downloaded archive against the Release's `SHA256SUMS` before installation and does not use `sudo`. Ensure `~/.local/bin` is included in your `PATH`.

To select a specific version and installation directory:

```bash
(
  set -e
  installer="$(mktemp)"
  trap 'rm -f "$installer"' EXIT
  curl -fsSL https://github.com/wencaiwulue/flash/releases/latest/download/install.sh -o "$installer"
  VERSION=v1.0.1 INSTALL_DIR="$HOME/.local/bin" sh "$installer"
)
```

`VERSION` must use strict `vX.Y.Z` format. `INSTALL_DIR` is optional and defaults to `~/.local/bin`.

### Manual Archives

Full archive names follow `flash-vX.Y.Z-<platform>-<arch>.<extension>`. Each archive contains the binary, `README.md`, and `README.zh-CN.md`. The `install.sh` installer is published as a separate Release asset and is not included in the archives.

Example for macOS/Linux:

```bash
tar -xzf flash-vX.Y.Z-darwin-arm64.tar.gz
./flash --version
./flash --help
```

Windows PowerShell example:

```powershell
tar -xf flash-vX.Y.Z-win32-x64.zip
.\flash.exe --version
.\flash.exe --help
```

Each Release includes `SHA256SUMS` covering every archive. After downloading your archive and this file, verify only the selected asset:

```bash
# macOS
grep 'flash-vX.Y.Z-darwin-arm64.tar.gz$' SHA256SUMS | shasum -a 256 -c -

# Linux
grep 'flash-vX.Y.Z-linux-x64.tar.gz$' SHA256SUMS | sha256sum -c -

# Windows PowerShell: compare this output with SHA256SUMS
(Get-FileHash .\flash-vX.Y.Z-win32-x64.zip -Algorithm SHA256).Hash.ToLower()
```

The release gate runs version and help checks on each native platform and repeats them after extraction. This does not validate model connections or every optional native integration; the assets are not signed/notarized, and GitHub Releases-based automatic updates are not provided.

Maintainers can compile, execute, package, and re-verify a standalone binary for the current host:

```bash
bun run build:binary
```

Artifacts are written to `build/release/`. Only the current OS/architecture can be built; unexecuted cross-compiled artifacts cannot be published. See the [Release Guide](https://github.com/wencaiwulue/flash/blob/main/docs/RELEASING.md) for the complete process.

## Agent SDK

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

The SDK supports:

- `tool()` and `createSdkMcpServer()`: In-process MCP tools.
- `query()`: Asynchronous messages, aborts, permissions, models, and MCP controls.
- V2 sessions through `unstable_v2_createSession()`, `unstable_v2_resumeSession()`, and `unstable_v2_prompt()`.
- Session storage, file-checkpoint rewind, context usage, and scheduled tasks.

See [Architecture](https://github.com/wencaiwulue/flash/blob/main/docs/ARCHITECTURE.md) for SDK composition and [Implementation Status](https://github.com/wencaiwulue/flash/blob/main/docs/STATUS.md) for capability-specific verification.

## Development

| Command | Purpose |
|---|---|
| `bun run dev` | Run the CLI from source with hot reloading. |
| `bun run start` | Run the CLI from source. |
| `bun run generate:sdk-types` | Generate serializable SDK types from the current schemas. |
| `bun run typecheck` | Run TypeScript checks without emitting files. |
| `bun run test` | Run tests with the isolated per-file test runner. |
| `bun run build` | Generate SDK types, build the CLI and SDK, and emit declarations. |
| `bun run build:binary` | Compile, verify, and package a standalone binary for the current host. |

## Repository Layout

```text
src/
├── entrypoints/       # CLI and Agent SDK entrypoints
├── tools/             # Built-in agent tools
├── commands/          # Slash command implementations
├── components/        # React/Ink terminal UI components
├── services/          # API, MCP, authentication, and integrations
├── utils/             # Query, session, permission, and shared utilities
└── ...                # Additional UI and runtime subsystems
scripts/               # Build, test, SDK, release, and live-validation scripts
tests/                 # Test suite
fixtures/              # Test fixtures
docs/                  # User, maintainer, design, and verification documents
```

The CLI and SDK share the query engine, tool pool, permission system, and application state while exposing different entrypoints. See [Architecture](https://github.com/wencaiwulue/flash/blob/main/docs/ARCHITECTURE.md) for the complete query and state flow.

## Documentation

Start with the [Documentation Index](https://github.com/wencaiwulue/flash/blob/main/docs/README.md), or go directly to:

- [Architecture](https://github.com/wencaiwulue/flash/blob/main/docs/ARCHITECTURE.md) — Entrypoints, artifacts, query flow, SDK composition, security, and feature boundaries.
- [Implementation Status](https://github.com/wencaiwulue/flash/blob/main/docs/STATUS.md) — Current capabilities, verification evidence, and remaining work.
- [Release Guide](https://github.com/wencaiwulue/flash/blob/main/docs/RELEASING.md) — Repeatable bilingual release process.
- [Release Record](https://github.com/wencaiwulue/flash/blob/main/docs/RELEASE.md) — Historical release notes.
- [Feature Documentation Policy](https://github.com/wencaiwulue/flash/blob/main/docs/COMMIT_DOCS.md) — Maintainer rules for feature design specs and implementation plans.
