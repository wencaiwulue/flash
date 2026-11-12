# Claude Code

Educational/research snapshot of Claude Code: an agentic coding CLI and TypeScript Agent SDK built with Bun, React, and Ink.

## Overview

This repository provides two independently buildable products:

- **CLI**: an interactive and headless agent terminal application.
- **Agent SDK**: an embeddable TypeScript API for queries, tools, sessions, and scheduled tasks.

The CLI and SDK share built-in tools, Model Context Protocol (MCP) integrations, permission handling, asynchronous queries, and session management. The SDK also exposes in-process MCP tools, multi-turn sessions, and scheduled-task helpers.

The external build excludes or disables internal and experimental features. A disabled boundary is not an implemented capability; see [Implementation Status](docs/STATUS.md) for current verification results and remaining limitations.

## Quick Start

Requirements: **Bun 1.3+**.

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

- `tool()` and `createSdkMcpServer()` for in-process MCP tools.
- `query()` with asynchronous messages, aborts, permissions, models, and MCP controls.
- V2 sessions through `unstable_v2_createSession()`, `unstable_v2_resumeSession()`, and `unstable_v2_prompt()`.
- Session storage, file-checkpoint rewind, context usage, and scheduled tasks.

See [Architecture](docs/ARCHITECTURE.md) for SDK composition and [Implementation Status](docs/STATUS.md) for capability-specific verification.

## Development

| Command | Purpose |
|---|---|
| `bun run dev` | Run the CLI from source with hot reloading. |
| `bun run start` | Run the CLI from source. |
| `bun run generate:sdk-types` | Generate serializable SDK types from the current schemas. |
| `bun run typecheck` | Run TypeScript checks without emitting files. |
| `bun run test` | Run tests with the repository's isolated per-file test runner. |
| `bun run build` | Generate SDK types, build the CLI and SDK, and emit declarations. |

## Repository Layout

```text
src/
├── entrypoints/       # CLI and Agent SDK entrypoints
├── tools/             # Built-in agent tools
├── commands/          # Slash command implementations
├── components/        # React/Ink terminal UI components
├── services/          # API, MCP, authentication, and other integrations
├── utils/             # Query, session, permission, and shared utilities
└── ...                # Additional UI and runtime subsystems
scripts/               # Build, test, SDK type, and documentation tooling
tests/                 # Test suite
fixtures/              # Test fixtures
docs/                  # User, maintainer, design, and verification documents
```

The CLI and SDK share the query engine, tool pool, permission system, and application state while exposing different entrypoints. See [Architecture](docs/ARCHITECTURE.md) for the complete query and state flow.

## Documentation

Start with the [Documentation Index](docs/README.md), or go directly to:

- [Architecture](docs/ARCHITECTURE.md) — entrypoints, build artifacts, query flow, SDK composition, security, and feature boundaries.
- [Implementation Status](docs/STATUS.md) — current capabilities, verification evidence, and remaining work.
- [Release Record](docs/RELEASE.md) — historical release notes.
- [Feature Documentation Policy](docs/COMMIT_DOCS.md) — maintainer rules for feature design specs and implementation plans.
