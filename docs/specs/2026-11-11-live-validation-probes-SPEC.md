---
commit: 9cd4c63193ded6eb916bf734f65a427da193faf0
title: Live 验证探针与 SkillHub 响应兼容设计
date: 2026-11-11
status: partial
retrospective: true
---

# Live 验证探针与 SkillHub 响应兼容设计

## 背景与目标

该提交同时处理两类问题：

1. 模型工作流、proactive/Sleep、context collapse、reactive compaction、SkillHub、Cloud bridge/Files 和桌面 screenshot 分别依赖不同运行环境，不能用单一本地脚本统一表达。
2. SkillHub 返回记录的实际字段与客户端已有映射不完全一致：namespace 可能缺省，`latestVersion` 可能是对象，显示名和摘要可能使用 `displayName`、`summary`。

目标是把外部能力拆成四条可独立运行的探针，并在不改变现有 SkillHub 请求、下载和缓存接口的前提下扩展响应归一化。

## 总体结构

```text
workflow_dispatch / 每日 schedule
              │
              ▼
    .github/workflows/live-validation.yml
       ┌────────┼─────────┬──────────┐
       ▼        ▼         ▼          ▼
     model   skillhub    cloud     desktop
       │        │         │          │
       ▼        ▼         ▼          ▼
  四个串行   搜索→下载→  bridge恢复→  screenshot
  模型探针   版本缓存    Files→archive
```

每个 job 安装依赖后直接调用对应 Bun 脚本。job 只负责环境和依赖，业务断言放在脚本内；成功标记必须在断言之后输出，失败通过非零退出来终止当前探针。

## 模块设计

| 文件 | 责任 | 关键输入与输出 |
|---|---|---|
| `scripts/live-model-validation.ts` | 串行执行 workflow、Sleep、context collapse、reactive compaction | 模型配置；四个固定成功标记；任何断言失败即抛错 |
| `scripts/live-skillhub-validation.ts` | 搜索一个技能、构造下载地址、验证版本缓存命中 | registry URL/token；临时 cacheDir；第二次 `cacheHit=true` |
| `scripts/live-cloud-validation.ts` | 创建并恢复 perpetual bridge，持久化文件，最后归档 | OAuth token、orgUUID、baseUrl；恢复前后 session ID 必须一致 |
| `scripts/live-desktop-validation.ts` | 在显式开关下调用 screenshot 并关闭客户端 | `CLAUDE_DESKTOP_LIVE=1`；skip 与 success 使用不同标记 |
| `src/services/skillSearch/skillhubClient.ts` | 将不同 registry 记录归一化为 `SkillHubSearchItem` | 不改变 `search()`、`resolve()`、`download()` 的公共签名 |
| `.github/workflows/live-validation.yml` | 为四类环境提供独立 job、触发器和环境变量 | 手动触发与 `17 6 * * *`；`contents: read` |
| `docs/STATUS.md`、`docs/RELEASE.md` | 同步能力边界和后续环境要求 | 不参与探针控制流 |

## 关键流程

### 1. SkillHub 字段归一化

`search()` 仍依次完成请求、响应解包和列表提取，只改变单条记录的映射：

- namespace：显式非空值优先，否则为 `global`。
- version：`version` → `latestVersion.version` → 字符串 `latestVersion`。
- name：`displayName` → `name` → `slug`。
- description：`summary` → `description` → 空字符串。
- 缺少有效 slug 的记录继续被过滤；`shortId` 仍从 `id` 或 `shortId` 派生。

归一化集中在客户端内部，使 live 脚本和其他调用者共享同一兼容规则。

### 2. 模型探针

模型脚本按固定顺序执行，前一项失败会阻止后一项：

1. `startWorkflowTask()` 运行只有 `respond` 一步的 workflow，要求最终状态为 `completed`。
2. `activateProactive('command')` 后检查 `SleepTool.isEnabled()`，再调用 10ms Sleep 并拒绝 interrupted 结果。
3. 将 context window 固定为 100，构造六条长消息，要求一次 collapse 后 `collapsedSpans===1` 且消息数变为五。
4. 使用 user/assistant/user 三条消息调用 `reactiveCompactOnPromptTooLong()`，要求 `reactive.ok`。

`finally` 中统一执行 `runCleanupFunctions()`，避免前面的断言失败跳过清理。

### 3. SkillHub 探针

脚本创建独立临时 cacheDir，搜索 `code` 并取首项；namespace 和 slug 分别经 `encodeURIComponent` 后放入下载 URL。相同 slug、URL、cacheDir 连续调用两次 `loadRemoteSkill()`：第一次检查内容非空且包含 `name` 或 `#`，第二次必须命中版本缓存。临时目录在 `finally` 中递归删除。

### 4. Cloud 与桌面探针

Cloud 使用相同 cwd 和 perpetual 参数创建两个 bridge：第一个写入一条 user message 后 teardown，第二个必须恢复相同 `bridgeSessionId`。随后设置 Cloud Files 环境，写入 `nested/live.txt`，要求 persistence 至少返回一个文件，最后调用 `archive()`。

桌面只在变量等于 `1` 时取得 computer-use client 并调用 screenshot；无论 screenshot 是否抛错，都进入客户端关闭逻辑。

## 工程取舍

- **四 job 隔离，而非单脚本顺序跑全部能力**：模型、公共 registry、OAuth Cloud 和交互桌面的失败面不同，隔离可以让调度与资源配置分别演进；代价是 workflow 有重复的 checkout/install 步骤。
- **复用生产入口，而非伪造传输结果**：探针直接调用 workflow、bridge、loader 和 compaction 入口，能够覆盖真实控制流；代价是运行依赖外部服务与授权环境。
- **客户端集中兼容，而非 live 脚本特判**：字段优先级对所有 SkillHub 调用者一致；代价是必须用确定性响应测试约束每个回退分支。

## 安全与资源边界

- workflow 只声明 `contents: read`；token 通过环境变量进入对应脚本，不作为成功标记或错误文本输出。
- namespace、slug 在 URL 路径段中分别编码，不能直接拼接未编码输入。
- SkillHub 临时缓存和 Cloud 临时 cwd 都有清理路径；模型与 Cloud 复用各自 cleanup registry。
- desktop 使用 self-hosted runner 和固定配置目录，运行环境必须保证不同 job 之间不会复用受污染的配置。

## 验收标准

### 确定性适配

1. 缺省 namespace 映射为 `global`，显式 namespace 不被覆盖。
2. version、name、description 严格按上述优先级回退；对象和字符串两种 `latestVersion` 均可处理。
3. 缺少 slug 的记录被过滤，现有 `resolve()`、`download()` 请求格式不变。

### 探针行为

4. 模型脚本只有在 workflow completed、Sleep 未中断、collapse 统计正确、reactive 返回 ok 时才继续并输出对应标记。
5. SkillHub 第二次加载未命中缓存、首项不存在或下载内容不符合检查时，脚本必须失败并删除临时目录。
6. Cloud 恢复后的 session ID 不同、持久化为空或 archive 失败时，脚本必须失败并进入清理。
7. desktop 开关非 `1` 时只走 skip；启用时 screenshot 错误不能被吞掉，客户端必须关闭。

### CI 与生命周期

8. workflow 包含四个独立 job、手动和每日触发器、只读权限及各 job 对应的环境变量。
9. `model` 和 `cloud` 的缺配置跳过逻辑必须放在 GitHub Actions 支持的上下文中；不能把 `jobs.<job_id>.if` 直接使用 `secrets` 当成有效实现。
10. Cloud 必须先完成配置初始化再读取 OAuth token，且 self-hosted desktop 的配置目录必须在运行前隔离。

## 本提交的已知设计缺口

- `model`、`cloud` 在 `jobs.<job_id>.if` 中直接引用 `secrets`，不满足第 9 条验收标准。
- Cloud 脚本在 `enableConfigs()` 之前读取 OAuth token，不满足第 10 条中的初始化顺序。
- SkillHub 探针依赖查询首项和外部 registry 内容，内容检查较宽松；它不能替代字段映射的确定性测试。
- 固定 `/tmp/flash-*-{home,config}` 路径不会自动保证 self-hosted runner 的目录隔离。
