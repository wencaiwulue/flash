# Local Template Jobs v1 契约

日期：2026-11-11
状态：前瞻设计，尚未实现；协议名称为 `local-template-jobs-v1`。

本文中的“必须/不得”是实现与验收要求，不表示当前 external build 已支持这些命令。当前 `src/cli/handlers/templateJobs.ts` 和 `src/jobs/classifier.ts` 都是显式占位。

## 1. 范围与现有接线

目标是提供完全本地的模板发现、任务创建、查询、追问、transcript 和状态持久化。任务仍通过同一个 Claude CLI/query 核心执行；不复制代理循环，也不实现远端任务服务。

现有约束：

- `src/entrypoints/cli.tsx` 仅在 `TEMPLATES` 下把顶层 `new`、`list`、`reply` 分派给 `templatesMain(args)`；成功后直接 `process.exit(0)`，所以错误必须抛出并非零退出，不能打印错误后正常返回。
- `src/query/stopHooks.ts` 在主线程每轮结束且存在 `CLAUDE_JOB_DIR` 时调用 `classifyAndWriteState(jobDirectory, turnAssistantMessages)`，等待分类与落盘，竞速上限为 60 秒；异常只记录日志。后台 fork、subagent 不得改写主任务状态。
- `src/utils/permissions/filesystem.ts` 只允许任务向位于配置目录 `jobs/` 内的当前 `CLAUDE_JOB_DIR` 写入，并检查词法路径和符号链接；实现不得用任务目录外的状态文件绕过该边界。
- `src/utils/markdownConfigLoader.ts` 已在 `TEMPLATES` 下支持 `templates` 目录。发现、设置来源和去重必须复用 `loadMarkdownFilesForSubdir()`，不能另建搜索顺序。
- `src/utils/sideQuery.ts` 提供带认证的独立结构化模型调用。分类器必须使用 JSON Schema/强制结构化结果并再次做运行时校验，禁止关键词分类、正则猜测“完成”或直接信任自由文本 JSON。

非目标：定时调度、云端同步、多用户服务、并行执行同一任务的多个 turn、危险权限自动放行，以及与任何私有任务协议兼容。

## 2. 公开命令

```text
claude new <template> [initial-prompt...] [--json] [--request-id <uuid>]
claude list [--json]
claude list <job-id> [--json]
claude list <job-id> --state
claude list <job-id> --transcript
claude reply <job-id> <prompt...> [--json] [--reply-id <uuid>]
```

规则：

1. `new` 创建任务并返回 `job_id`、`session_id`、`state` 和任务目录；`--request-id` 用于调用方安全重试。缺省 request ID 只生成一次，调用方若需去重重试必须保存并复用它。
2. `list` 无参数时按 `updated_at` 降序列出所有任务；带 ID 时显示权威状态、最近分类、错误、时间和文件路径。`--state` 原样输出经 schema 校验的 `state.json`，`--transcript` 流式输出任务线协议 JSONL，不把整个大文件读入内存。
3. `reply` 使用任务创建时冻结的模板和同一个 Claude transcript session，不接受另一个模板。它返回 `reply_id`、`job_id` 和接受时的状态；`--reply-id` 是幂等键。
4. `--json` 与 `--state`/`--transcript` 互斥；人类可读输出只走 stdout/stderr 的约定通道，JSON 模式 stdout 必须只有一条 JSON。
5. ID 必须是完整 UUID 或无歧义前缀；前缀命中多个任务时报 `JOB_ID_AMBIGUOUS`。禁止把 ID 拼入 shell 命令或未经校验拼入路径。
6. `new`/`reply` 只表示任务已被持久化并成功启动 supervisor，不表示模型已完成。调用方用 `list <job-id>` 观察后续状态。

建议稳定错误码：`TEMPLATE_NOT_FOUND`、`TEMPLATE_INVALID`、`JOB_NOT_FOUND`、`JOB_ID_AMBIGUOUS`、`JOB_BUSY`、`JOB_STATE_CONFLICT`、`JOB_CORRUPT`、`IDEMPOTENCY_CONFLICT`、`SPAWN_FAILED`、`CLASSIFIER_UNAVAILABLE`。退出码统一非零；机器错误写 stderr 的 `{error:{code,message,details?}}`。

## 3. 模板格式与发现

模板为 Markdown：

```markdown
---
name: code-review
description: Review the current change
model: inherit
permission-mode: default
allowed-tools: Read, Grep, Glob
cwd: .
---
检查当前变更并给出问题。用户补充要求：{{args}}
```

| 字段 | 必需 | v1 语义 |
|---|---|---|
| `name` | 否 | 缺省为文件名去 `.md`；匹配 `^[a-z0-9][a-z0-9-]{0,63}$`。 |
| `description` | 否 | 经 `coerceDescriptionToString()` 处理；列表/对象无效。 |
| `model` | 否 | `inherit` 或当前 CLI 接受的模型名；原样作为 argv 值传递。 |
| `permission-mode` | 否 | 仅 `default`、`acceptEdits`、`plan`，缺省 `default`；v1 不接受 bypass。 |
| `allowed-tools` | 否 | 复用 `parseAgentToolsFromFrontmatter()`：缺省继承 CLI 工具，空值无工具，`*` 全部工具。 |
| `cwd` | 否 | 缺省为调用 `new` 时的 cwd；若给出，必须是该 cwd 下的相对路径，禁止绝对路径、`..` 逃逸和符号链接逃逸。 |

正文是初始指令，不执行 frontmatter 中的任何命令。`{{args}}` 只进行文本替换；没有占位符时，非空用户 prompt 以两个换行追加。重复占位符全部进行相同文本替换。不得进行 shell eval、环境变量展开或把 prompt 拼入命令字符串。

发现顺序沿用 loader：managed/policy、user、project，project 内由近到远；同名取首个，物理文件按 inode 去重。选中模板的 frontmatter 或正文无效必须明确失败，不能静默换成另一个同名模板。创建任务时把正文、解析后配置、来源路径和 SHA-256 快照进 `job.json`，后续 `reply` 不重读模板。

## 4. 本地文件与 schema

任务根目录为 `${CLAUDE_CONFIG_DIR:-~/.claude}/jobs/<job_uuid>/`，目录 `0700`、文件 `0600`。写入时拒绝根目录或任务目录符号链接逃逸。

```text
job.json          不可变身份、模板快照、创建参数、幂等记录索引
state.json        当前权威快照，临时文件 + fsync + 原子 rename
transcript.jsonl  任务 supervisor 的追加式线协议日志
child.json        当前/最近子进程身份和退出信息
stderr.log        有界轮转的诊断日志，不写认证材料
lock/             proper-lockfile 锁及回复幂等记录
replies/          每个 reply ID 的 accepted/completed/failed 记录
```

`job.json` 至少包含：

```json
{
  "version": "local-template-jobs-v1",
  "job_id": "uuid",
  "session_id": "uuid",
  "request_id": "uuid",
  "created_at": "RFC3339",
  "cwd": "/canonical/project",
  "template": {"name": "code-review", "source_path": "/path/template.md", "sha256": "hex", "body": "...", "config": {}},
  "transcript_path": "/canonical/session/transcript.jsonl"
}
```

`transcript.jsonl` 是 supervisor 日志，不是 Claude 原生 session transcript 的替代品。每行 schema 为：

```json
{
  "version": "local-template-jobs-v1",
  "seq": 1,
  "timestamp": "RFC3339",
  "job_id": "uuid",
  "direction": "outbound|inbound|supervisor",
  "kind": "user|sdk|process|classifier|error",
  "payload": {}
}
```

`seq` 从 1 严格递增；追加前写一行、必要时 fsync。`outbound/user` 保存实际 prompt，`inbound/sdk` 保存 CLI 的完整 SDK message，`supervisor/process` 保存 spawn/exit，`classifier` 保存结构化分类或错误。原生恢复仍使用 `session_id` 和 `transcript_path` 指向的 Claude JSONL；读取它时复用 `sessionStorage` 的路径发现和 `loadTranscriptFile()`，不得把 supervisor 日志误传给该 loader。

## 5. 状态机与进程模型

`state.json` 顶层字段：

```json
{
  "version": "local-template-jobs-v1",
  "job_id": "uuid",
  "status": "queued",
  "generation": 1,
  "active_reply_id": null,
  "pid": null,
  "started_at": "RFC3339",
  "updated_at": "RFC3339",
  "ended_at": null,
  "exit_code": null,
  "classification": null,
  "last_error": null
}
```

权威状态只有：`queued → running ↔ waiting_for_input → running`，以及 `running → blocked|completed|failed|cancelled`。`waiting_for_input` 和 `blocked` 允许 `reply`；`completed` 也允许继续追问并重新进入 `running`，但 `failed/cancelled` 只能显式创建新任务，防止意外重放副作用。

1. `new` 在锁内写 `job.json`、`state.json` 和隐藏 supervisor 的启动记录，然后启动 detached supervisor；写盘或 spawn 失败不得留下看似 running 的孤儿。
2. supervisor 对每个 turn 使用 argv 启动真实 CLI：首轮带 `--print --output-format stream-json --session-id <session_id>`；后续带 `--print --output-format stream-json --resume <session_id>`。模型、工具和权限配置作为独立 argv 值，prompt 不经过 shell。
3. 同一任务串行，运行中 `reply` 返回 `JOB_BUSY`。每个 supervisor 必须验证 `CLAUDE_JOB_DIR` 位于任务根内，并在整个 turn 持有任务锁。
4. `child.json` 记录 PID、进程启动令牌（Linux `/proc/<pid>/stat` starttime；其他平台使用等效启动时间）、session ID、reply ID 和 argv 的脱敏摘要。等待退出的 supervisor 原子写退出码；`list` 发现 supervisor 已消失时必须做身份校验后 reconcile，不能永久显示 running。
5. 重启 CLI 不自动重新发送 prompt。若崩溃发生在 stdin 已写而回执未落盘的窗口，状态标为 `failed`/`recovery_uncertain`，由用户决定是否创建新任务；不承诺模型与工具副作用 exactly-once。不得复用 `DaemonSupervisor` 的自动重启策略重放任务。

## 6. 结构化分类与状态合并

分类输入是当前主线程完整 turn 的 `AssistantMessage[]`，只提取有界文本、工具名称/状态和 UUID，最大 64 KiB；不得发送密钥、完整文件或无关历史。分类 JSON Schema：

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["category", "summary", "confidence", "question", "evidence"],
  "properties": {
    "category": {"enum": ["in_progress", "needs_input", "completed", "blocked", "failed"]},
    "summary": {"type": "string"},
    "confidence": {"type": "number"},
    "question": {"type": ["string", "null"]},
    "evidence": {
      "type": "object",
      "additionalProperties": false,
      "required": ["assistant_message_uuids", "tool_use_ids"],
      "properties": {
        "assistant_message_uuids": {"type": "array", "items": {"type": "string"}},
        "tool_use_ids": {"type": "array", "items": {"type": "string"}}
      }
    }
  }
}
```

运行时要求 `0 <= confidence <= 1`，summary/question 有长度上限，证据 UUID/tool ID 必须来自本轮输入。`state.json.classification` 额外保存 `classified_at`、`generation`、`model`、`status: ok|stale|unavailable` 和可选 `error_code`。

合并优先级不可被模型覆盖：

- 子进程非零退出、spawn 失败或恢复不确定 ⇒ `failed`；
- 有活跃子进程 ⇒ `running`，即使模型声称 completed；
- 正常退出且分类为 `needs_input` ⇒ `waiting_for_input`；
- 正常退出且为 `blocked` ⇒ `blocked`；为 `completed` ⇒ `completed`；为 `failed` ⇒ `failed`；
- 分类缺失、非法、超时或低置信（小于 0.7）时，仅依据进程结果落到 `waiting_for_input`，分类标为 `stale|unavailable`，绝不能凭猜测标为 completed。

每轮分类必须携带递增 `generation`；旧 turn 的异步结果不得覆盖新 turn。60 秒竞速到期后，迟到的分类结果也只有在 generation 未变化且任务锁可重新获取时才可写入。写 `state.json` 必须原子完成，读者看到部分 JSON 时报告 `JOB_CORRUPT`，不能当作空任务。

## 7. 幂等、锁与恢复

- `new.request_id` 全任务根唯一；同 ID 且 job/template/prompt/cwd 的规范哈希相同则返回原任务，不同则 `IDEMPOTENCY_CONFLICT`。
- `reply_id` 在单任务内唯一；同 ID 同 prompt 返回已有回复记录，不同 prompt 冲突。accepted 记录必须先于 spawn 落盘。
- 锁使用现有 `proper-lockfile` 依赖，stale 只用于锁文件异常恢复，不用于证明业务进程死亡。杀进程前必须重新验证 PID、启动令牌、job ID 和 supervisor 身份。
- `list` 是只读加安全 reconcile；它不能因 PID 不可探测就删除其他用户的记录。EPERM、WSL 跨宿主和身份不明一律显示 `unknown` 并保留记录。
- 原生命名 session 的恢复继续复用 `sessionStorage` 的 parent UUID、compact 和 metadata 规则；supervisor 的 seq 只用于本任务日志去重，不能冒充原生 parent UUID。

## 8. 关键文件复用与新增边界

必须复用：

- `/Users/fengcaiwen/GolandProjects/claude-code/src/entrypoints/cli.tsx`：三个公开命令唯一入口。
- `/Users/fengcaiwen/GolandProjects/claude-code/src/cli/handlers/templateJobs.ts`：参数校验和命令实现。
- `/Users/fengcaiwen/GolandProjects/claude-code/src/jobs/classifier.ts`：结构化分类与原子状态写入。
- `/Users/fengcaiwen/GolandProjects/claude-code/src/query/stopHooks.ts`：主线程分类调用点，不改变其 fork/subagent 隔离。
- `/Users/fengcaiwen/GolandProjects/claude-code/src/utils/markdownConfigLoader.ts`、`frontmatterParser.ts`、`sideQuery.ts`、`sessionStorage.ts`、`concurrentSessions.ts`、`permissions/filesystem.ts`：发现、解析、模型、恢复、进程身份和目录边界。

实现可在 `src/jobs/` 新增 state/spawn/supervisor/schema 模块；不得把全部逻辑塞回 classifier，也不得新增第二条 query loop。`templatesMain` 的 `Promise<never>` 可通过成功后 `process.exit(0)` 或失败抛出保持类型一致。

## 9. 测试与 dist/live 验收

### 单元与集成

新增 `tests/templateJobs.test.ts` 和 `tests/jobClassifier.test.ts`，使用临时配置根和临时 git/cwd：

1. 模板发现优先级、同名冲突、frontmatter 各类型、空/全部工具、恶意 cwd/符号链接、模板快照不受后续编辑影响。
2. request/reply 幂等、冲突、busy、锁竞争、原子写入、损坏 state、乱序 generation 和迟到分类。
3. fake sideQuery 分别返回五种分类、非法 JSON、未知字段、伪造证据、低置信、超时和 API 错误；验证进程退出码始终优先，且无关键词分类。
4. fake child 覆盖 spawn 失败、正常/异常退出、stdin 写后崩溃、PID 复用、supervisor 重启恢复和 transcript 大文件流式读取。
5. 权限集成证明只能写当前 job 目录，符号链接指向 `~/.ssh` 等位置仍被拒绝。

### dist

在 `TEMPLATES` 加入实现所在 feature profile 后执行 `bun run typecheck`、`bun test tests/templateJobs.test.ts tests/jobClassifier.test.ts`、`bun run build`。用 `dist/main.js` 在隔离 `CLAUDE_CONFIG_DIR` 和 loopback fake model API 下完成 `new → list --state → reply → list --transcript`，验证 NDJSON、状态合并、session resume、进程清理和第二次构建后的 `.d.ts`；再运行 `tests/enabledFeatures.test.ts` 的 dist/profile 检查。构建成功或 help 出现命令本身不算通过。

### live

仅在已授权模型账户和一次性临时项目中执行一次真实模板任务，等待 `needs_input`，再 `reply` 到 `completed`；核对原生 transcript、 supervisor transcript 和分类证据一致。另测一次模型不可用，确认不自动完成、不丢旧状态。真实 Cloud/API 不可用则记录 skipped；不得把 fake sideQuery、fake child 或 dist 结果写成 live。

验收期间清理所有 supervisor/子进程和临时目录，保留既有无关工作树改动；契约本身不授权修改生产代码。
