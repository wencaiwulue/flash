## Build and Verification

Requirements: Bun 1.3+.

```bash
bun install --frozen-lockfile
bun run generate:sdk-types
bun run typecheck
bun test
bun run build

bun dist/main.js --version
bun dist/main.js --help
```

The build produces both `dist/main.js` (CLI) and `dist/sdk.mjs` (Agent SDK).
Do not enable internal-only feature flags in the external build: modules guarded
by `USER_TYPE === 'ant'` or unavailable feature flags are intentionally disabled.

Project documents:

- [Architecture](docs/ARCHITECTURE.md)
- [Implementation status and verification evidence](docs/STATUS.md)
- [Release record](docs/RELEASE.md)

## Agent SDK

The local SDK entrypoint supports:

- `tool()` and `createSdkMcpServer()` for in-process MCP tools.
- `query()` with async messages, aborts, permissions, models, and MCP controls.
- V2 sessions: `unstable_v2_createSession()`, `unstable_v2_resumeSession()`,
  and `unstable_v2_prompt()`.
- Session storage: list, read, rename, tag, and fork.
- File checkpoint rewind with `enableFileCheckpointing`.
- Context usage, plugin reload, task stop, flag settings, and settings reads.
- Scheduled tasks: `watchScheduledTasks()` and
  `buildMissedTaskNotification()`.

```ts
import { query } from './dist/sdk.mjs'

for await (const message of query({
  prompt: 'Reply with a short greeting.',
  options: { tools: [] },
})) {
  console.log(message)
}
```

`connectRemoteControl()` remains unavailable. Remote control is not emulated
with placeholder success responses.

Linux credential storage uses `secret-tool` with plaintext fallback. npm
marketplace packages are downloaded with lifecycle scripts disabled and cached
using the existing marketplace schema and refresh flow.

---

## Directory Structure

```text
src/
├── main.tsx                 # Entrypoint orchestration (Commander.js-based CLI path)
├── commands.ts              # Command registry
├── tools.ts                 # Tool registry
├── Tool.ts                  # Tool type definitions
├── QueryEngine.ts           # LLM query engine
├── context.ts               # System/user context collection
├── cost-tracker.ts          # Token cost tracking
│
├── commands/                # Slash command implementations (~50)
├── tools/                   # Agent tool implementations (~40)
├── components/              # Ink UI components (~140)
├── hooks/                   # React hooks
├── services/                # External service integrations
├── screens/                 # Full-screen UIs (Doctor, REPL, Resume)
├── types/                   # TypeScript type definitions
├── utils/                   # Utility functions
│
├── bridge/                  # IDE and remote-control bridge
├── coordinator/             # Multi-agent coordinator
├── plugins/                 # Plugin system
├── skills/                  # Skill system
├── keybindings/             # Keybinding configuration
├── vim/                     # Vim mode
├── voice/                   # Voice input
├── remote/                  # Remote sessions
├── server/                  # Server mode
├── memdir/                  # Persistent memory directory
├── tasks/                   # Task management
├── state/                   # State management
├── migrations/              # Config migrations
├── schemas/                 # Config schemas (Zod)
├── entrypoints/             # Initialization logic
├── ink/                     # Ink renderer wrapper
├── buddy/                   # Companion sprite
├── native-ts/               # Native TypeScript utilities
├── outputStyles/            # Output styling
├── query/                   # Query pipeline
└── upstreamproxy/           # Proxy configuration
```

---

## Architecture Summary

### 1. Tool System (`src/tools/`)

Every tool cli can invoke is implemented as a self-contained module. Each tool defines its input schema, permission model, and execution logic. Built-in tools are registered in `src/tools.ts`; MCP tools are discovered at runtime by `src/services/mcp/client.ts` and merged into the same pool, so they do not require static imports in `src/tools.ts`.

| Tool | Description |
|---|---|
| `BashTool` | Shell command execution |
| `FileReadTool` | File reading (images, PDFs, notebooks) |
| `FileWriteTool` | File creation / overwrite |
| `FileEditTool` | Partial file modification (string replacement) |
| `GlobTool` | File pattern matching search |
| `GrepTool` | ripgrep-based content search |
| `WebFetchTool` | Fetch URL content |
| `WebSearchTool` | Web search |
| `AgentTool` | Sub-agent spawning |
| `SkillTool` | Skill execution |
| `MCPTool` | MCP server tool invocation |
| `LSPTool` | Language Server Protocol integration |
| `NotebookEditTool` | Jupyter notebook editing |
| `TaskCreateTool` / `TaskUpdateTool` | Task creation and management |
| `SendMessageTool` | Inter-agent messaging |
| `TeamCreateTool` / `TeamDeleteTool` | Team agent management |
| `EnterPlanModeTool` / `ExitPlanModeTool` | Plan mode toggle |
| `EnterWorktreeTool` / `ExitWorktreeTool` | Git worktree isolation |
| `ToolSearchTool` | Deferred tool discovery |
| `CronCreateTool` | Scheduled trigger creation |
| `RemoteTriggerTool` | Remote trigger |
| `SleepTool` | Proactive mode wait (`PROACTIVE`/`KAIROS` only; not included in the external build) |
| `SyntheticOutputTool` | Structured output generation |

### 2. Command System (`src/commands/`)

User-facing slash commands invoked with `/` prefix.

| Command | Description |
|---|---|
| `/commit` | Create a git commit |
| `/review` | Code review |
| `/compact` | Context compression |
| `/mcp` | MCP server management |
| `/config` | Settings management |
| `/doctor` | Environment diagnostics |
| `/login` / `/logout` | Authentication |
| `/memory` | Persistent memory management |
| `/skills` | Skill management |
| `/tasks` | Task management |
| `/vim` | Vim mode toggle |
| `/diff` | View changes |
| `/cost` | Check usage cost |
| `/theme` | Change theme |
| `/context` | Context visualization |
| `/pr_comments` | View PR comments |
| `/resume` | Restore previous session |
| `/share` | Share session (internal-only hidden stub; unavailable externally) |
| `/desktop` | Desktop app handoff |
| `/mobile` | Mobile app handoff |

### 3. Service Layer (`src/services/`)

| Service | Description |
|---|---|
| `api/` | Anthropic API client, file API, bootstrap |
| `mcp/` | Model Context Protocol server connection and management |
| `oauth/` | OAuth 2.0 authentication flow |
| `lsp/` | Language Server Protocol manager |
| `analytics/` | GrowthBook-based feature flags and analytics |
| `plugins/` | Plugin loader |
| `compact/` | Conversation context compression |
| `policyLimits/` | Organization policy limits |
| `remoteManagedSettings/` | Remote managed settings |
| `extractMemories/` | Automatic memory extraction |
| `tokenEstimation.ts` | Token count estimation |
| `teamMemorySync/` | Team memory synchronization |

### 4. Bridge System (`src/bridge/`)

A bidirectional communication layer connecting IDE extensions (VS Code, JetBrains) with the Claude Code CLI.

- `bridgeMain.ts` — Bridge main loop
- `bridgeMessaging.ts` — Message protocol
- `bridgePermissionCallbacks.ts` — Permission callbacks
- `replBridge.ts` — REPL session bridge
- `jwtUtils.ts` — JWT-based authentication
- `sessionRunner.ts` — Session execution management

### 5. Permission System (`src/hooks/toolPermission/`)

Checks permissions on every tool invocation. Either prompts the user for approval/denial or automatically resolves based on the configured permission mode (`default`, `plan`, `bypassPermissions`, `auto`, etc.).

### 6. Feature Flags

Dead code elimination via Bun's `bun:bundle` feature flags:

```typescript
import { feature } from 'bun:bundle'

// Inactive code is completely stripped at build time
const voiceCommand = feature('VOICE_MODE')
  ? require('./commands/voice/index.js').default
  : null
```

Notable flags: `PROACTIVE`, `KAIROS`, `BRIDGE_MODE`, `DAEMON`, `VOICE_MODE`, `AGENT_TRIGGERS`, `MONITOR_TOOL`

---

## Key Files in Detail

### `QueryEngine.ts` (~1.3K lines)

The core engine for LLM API calls. Handles streaming responses, tool-call loops, thinking mode, retry logic, and token counting.

### `Tool.ts` (~800 lines)

Defines base types and interfaces for all tools — input schemas, permission models, and progress state types.

### `commands.ts` (~750 lines)

Manages registration and execution of all slash commands. Uses conditional imports to load different command sets per environment.

### `main.tsx`

Commander.js-based CLI parser and React/Ink renderer initialization. At startup, it overlaps MDM settings, keychain prefetch, and GrowthBook initialization for faster boot.

---

## Tech Stack

| Category | Technology |
|---|---|
| Runtime | [Bun](https://bun.sh) |
| Language | TypeScript (strict) |
| Terminal UI | [React](https://react.dev) + [Ink](https://github.com/vadimdemedes/ink) |
| CLI Parsing | [Commander.js](https://github.com/tj/commander.js) (extra-typings) |
| Schema Validation | [Zod v4](https://zod.dev) |
| Code Search | [ripgrep](https://github.com/BurntSushi/ripgrep) |
| Protocols | [MCP SDK](https://modelcontextprotocol.io), LSP |
| API | [Anthropic SDK](https://docs.anthropic.com) |
| Telemetry | OpenTelemetry + gRPC |
| Feature Flags | GrowthBook |
| Auth | OAuth 2.0, JWT, macOS Keychain |

---

## Notable Design Patterns

### Parallel Prefetch

Startup time is optimized by prefetching MDM settings, keychain reads, and API preconnect in parallel before heavy module evaluation begins.

```typescript
// main.tsx — fired as side-effects before other imports
startMdmRawRead()
startKeychainPrefetch()
```

### Lazy Loading

Heavy modules (OpenTelemetry, gRPC, analytics, and some feature-gated subsystems) are deferred via dynamic `import()` until actually needed.

### Agent Swarms

Sub-agents are spawned via `AgentTool`, with `coordinator/` handling multi-agent orchestration. `TeamCreateTool` enables team-level parallel work.

### Skill System

Reusable workflows defined in `skills/` are executed through `SkillTool`. Users can add custom skills.

### Plugin Architecture

Built-in and third-party plugins are loaded through the `plugins/` subsystem.

---
