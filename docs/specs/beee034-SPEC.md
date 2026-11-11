---
commit: beee034523510ac0425461bb4ffce3250514d693
title: "Support settings-based bearer authentication"
date: 2026-11-11T10:06:54+08:00
status: partial
kind: component
---

# Support settings-based bearer authentication

> 本文是依据该提交的 diff、对应 revision 的实现与测试，以及有出处的状态记录所作的回溯性设计重建；不冒充历史提交当时已存在的原文。

## 前置状态与问题

父提交的 live model 脚本只接受 ANTHROPIC_API_KEY；只有 Bearer settings 的环境会输出 MODEL_LIVE_SKIPPED。核心 getAnthropicApiKeyWithSource 在缺少 API key 时，即使已有 ANTHROPIC_AUTH_TOKEN，也仍可能进入“缺少 API key 或 Claude OAuth”的错误分支。CI model job 同样只映射 API-key secret。

需要让 live validation 复用既有 Bearer 通道完成模型验证，同时防止 API key 与 AUTH_TOKEN 同时存在时由调用顺序决定身份。提交文档把执行描述为 settings-based，但 standalone 脚本只检查启动时已有的 process.env，并未实现 settings.env 注入。Bearer 既不是 x-api-key，也不是 Claude OAuth，不能用变量改名混淆三种凭据语义。

## 目标与非目标

### 目标

- 让核心 CI/test API-key 检查承认既有 ANTHROPIC_AUTH_TOKEN，避免该分支错误要求额外 API key/OAuth。
- 让 live 脚本接受任一已注入进程环境的模型凭据、拒绝两种凭据并存，并在两者都缺失时保留 skip。
- 让 CI model job 与 step 传递同名 AUTH_TOKEN secret，并保留 settings-based 四个 live-script sentinel 的历史记录及其证据边界。

### 非目标

- 不把 ANTHROPIC_AUTH_TOKEN 映射为 CLAUDE_CODE_OAUTH_TOKEN，也不将其作为 x-api-key 发送。
- 不因此完成 Cloud Files、Remote Control、perpetual 服务端或原生桌面的 OAuth/授权环境验收。
- 不新增独立认证协议或输出 settings/token 内容。

## 方案架构与数据流

正常 CLI 初始化可由 managedEnv 将 settings.env 注入 process.env，但本提交修改的 standalone live 脚本没有调用 applySafeConfigEnvironmentVariables() 或 applyConfigEnvironmentVariables()；它在 enableConfigs() 前检查环境，而 enableConfigs() 本身只开放/读取配置，不做该注入。因此 token 仅存在于 ~/.claude/settings.json 时，这个脚本会走 MODEL_LIVE_SKIPPED。

src/utils/auth.ts 只在 CI=true 或 NODE_ENV=test 的“没有可用凭据”判定中增加 AUTH_TOKEN；getAnthropicApiKeyWithSource() 仍不返回 Bearer source，仅有 AUTH_TOKEN 时返回 key:null/source:none。Bearer 识别属于 getAuthTokenSource()，实际 Authorization: Bearer header 由 configureApiKeyHeaders() 注入；API key 与 Claude OAuth 仍是不同来源和协议路径。

live-model-validation.ts 在 enableConfigs 前先做互斥检查，再做双缺失 skip；任一凭据存在才进入 Workflow、proactive、context-collapse 和 reactive-compaction 四个检查。其中 Workflow、context-collapse、reactive-compaction 是 model-backed probes，PROACTIVE_LIVE_OK 只检查 proactive 激活和本地 SleepTool 计时，不发起模型请求。workflow 的 job/step 环境与进程环境输入契约对齐，STATUS/RELEASE 记录 sentinel 和认证类型。

### 文件、接口与证据关系

| 关系 | 位置 | 设计作用 |
|---|---|---|
| 变更 | `src/utils/auth.ts`，符号 `!process.env.ANTHROPIC_AUTH_TOKEN` | 避免 CI/test 分支已有 Bearer 时仍进入缺少 API key/OAuth 的错误。 |
| 变更 | `scripts/live-model-validation.ts`，符号 `mutually exclusive` | 实现双认证互斥、双缺失 skip 和单凭据进入 probes。 |
| 变更 | `.github/workflows/live-checks.yml`，符号 `secrets.ANTHROPIC_AUTH_TOKEN` | 在 job 与 step 两层传递匹配的 Bearer secret。 |
| 变更 | `docs/STATUS.md`，符号 `Settings-based auth returned` | 把三个 model-backed 能力和本地 proactive Sleep 对应表行的证据来源改为 settings-based auth。 |
| 变更 | `docs/RELEASE.md`，符号 `## Settings-based authentication` | 记录认证互斥、CI guard 和本地四个 sentinel，并区分 Bearer 与 OAuth；其中 model sentinels 的概括比实现证据更宽。 |

## 关键决策与工程取舍

- live 脚本中双凭据并存直接抛错，而不是让 AUTH_TOKEN 静默覆盖 API key；这样该脚本的配置歧义在发起模型请求前暴露，但核心 resolver 和普通 CLI 未新增全局互斥。
- 保留 MODEL_LIVE_SKIPPED 仅用于两者都缺失，避免把“认证方式不受支持”误报成“未配置”。
- 核心只增加一个存在性条件，复用现有 Bearer source、provider 和模型调用，不复制认证实现。

### 备选方案与回溯分析

- 回溯来看，把 Bearer 塞进 ANTHROPIC_API_KEY 虽能减少脚本分支，却会改变 header 与凭据类型；只做 CI secret 改名而不修核心存在性检查，则仍会在后续认证路径失败。

## 安全与协议边界

- 在 live-model-validation.ts 中，非空的 ANTHROPIC_API_KEY 与 ANTHROPIC_AUTH_TOKEN 同时存在时，会在 enableConfigs() 前抛出互斥错误；核心 resolver 和普通 CLI 未新增全局互斥，其他认证组合也未由本提交统一拒绝。
- 新增认证 guard 不显式打印 token；双缺失认证分支打印 MODEL_LIVE_SKIPPED 后返回，四个成功点打印固定 sentinel。脚本仍可能输出异常、依赖或 cleanup 日志，因此不概括为“日志只输出固定 sentinel”；本 diff 未新增 settings/token 内容输出，CI secret 名与 Bearer 类型一致。
- Claude OAuth 继续是独立身份来源，本次模型 Bearer 结果不能替代 Cloud/remote-control 授权。

## 验收标准

- 在 CI=true 或 NODE_ENV=test、没有 API key/FD key 且存在非空 ANTHROPIC_AUTH_TOKEN 时，getAnthropicApiKeyWithSource() 不再抛出缺少 API key/Claude OAuth 的错误，并返回 key:null/source:none；--bare 和其他 resolver 分支未因此变成通用 Bearer API-key source。
- 仅凭据通过 guard 后，脚本进入 Workflow、context-collapse、reactive-compaction 三个 model-backed probes，以及不发起模型请求的 proactive SleepTool 本地计时检查。
- live 脚本中两种变量同时设置时在配置初始化前抛出明确互斥错误；都未设置时，该认证分支只打印 MODEL_LIVE_SKIPPED 后返回。
- workflow 的 job 与 run step 都引用 ANTHROPIC_AUTH_TOKEN secret，不再把该 secret 交给 API-key 变量。

## 验证证据

| 类型 | 证据陈述 | 来源 |
|---|---|---|
| diff-observed | 核心 CI/test 缺少凭据条件新增 !process.env.ANTHROPIC_AUTH_TOKEN，live 脚本新增互斥与双缺失两个独立分支。 | `src/utils/auth.ts`，符号 `!process.env.ANTHROPIC_AUTH_TOKEN`，revision `commit` |
| recorded-command-pass | at-commit RELEASE 的 Settings-based authentication 小节声称本地 settings-based validation 返回全部四个 model sentinels；STATUS 将 WORKFLOW_LIVE_OK、PROACTIVE_LIVE_OK、CONTEXT_COLLAPSE_LIVE_OK 和 REACTIVE_COMPACTION_LIVE_OK 四个具名结果归因于 settings-based auth。按实现，其中 PROACTIVE_LIVE_OK 仅是本地 Sleep 检查，不构成 Bearer 或 OAuth 验证。 | `docs/STATUS.md`，符号 `Settings-based auth returned`，revision `commit` |
| not-recorded | 本提交没有新增 Claude OAuth、Cloud/remote-control 或原生桌面 round trip，也没有独立 auth 单元测试文件。 | 未随提交记录执行证据 |

## 实现状态与剩余范围

- 状态：**partial**
- standalone live 脚本尚未把仅存在于 settings.json 的 token 注入 process.env；该路径会在 guard 处 skip，且历史输出无法证明 token 仅来自 settings 文件。
- 真实 Claude OAuth 与原生桌面仍需各自授权环境；本次仅有 at-commit 文档记录支持三个 model-backed Bearer 路径，PROACTIVE_LIVE_OK 是本地 Sleep 结果，不构成 Bearer 或 OAuth 验证。
