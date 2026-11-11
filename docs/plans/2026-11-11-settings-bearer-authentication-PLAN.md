---
commit: beee034523510ac0425461bb4ffce3250514d693
title: "Support settings-based bearer authentication"
date: 2026-11-11T10:06:54+08:00
status: partial
kind: component
---

# 实施计划：Support settings-based bearer authentication

> 本文按实际代码依赖重建实施顺序，用于说明怎样完成该提交；不伪称是历史提交当时保存的计划。

## 目标与前置条件

需要让 live validation 复用既有 Bearer 通道完成模型验证，同时防止 API key 与 AUTH_TOKEN 同时存在时由调用顺序决定身份。提交文档把执行描述为 settings-based，但 standalone 脚本只检查启动时已有的 process.env，并未实现 settings.env 注入。Bearer 既不是 x-api-key，也不是 Claude OAuth，不能用变量改名混淆三种凭据语义。

- 本提交只识别 live 脚本开始执行 main() 时已经存在于 process.env 的 ANTHROPIC_AUTH_TOKEN。脚本在 enableConfigs() 前执行互斥和 skip guard，且未调用 applySafeConfigEnvironmentVariables() 或 applyConfigEnvironmentVariables()；enableConfigs() 本身不注入 settings.env。因此，token 仅写在 ~/.claude/settings.json、但未预先进入进程环境的 standalone 路径，不由本 diff 实现或验证。

## 复用与兼容处理

### 复用现有实现

- 复用 getAuthTokenSource() 对 ANTHROPIC_AUTH_TOKEN 的 hasToken/source 识别，以及 configureApiKeyHeaders() 的 Authorization: Bearer 注入；getAnthropicApiKeyWithSource() 仍不返回 AUTH_TOKEN source，在仅有 AUTH_TOKEN 时返回 key:null/source:none。同时复用既有三个 model-backed probes、本地 proactive Sleep 检查、runCleanupFunctions 和 CI 隔离目录。

### 兼容、迁移与生命周期

- 直接运行 live 脚本时，预先进入 process.env 的仅 API-key 或仅 AUTH_TOKEN 配置仍被 guard 接受；两者并存仅在该脚本中变成显式错误。CI model job 改为只映射 ANTHROPIC_AUTH_TOKEN secret，因此旧有仅配置 ANTHROPIC_API_KEY secret 的 workflow 不再继承该 API key，并会在无其他凭据时 skip。

## 文件级实施步骤

### 1. 修正核心 CI/test 凭据存在性检查

在 CI/test 缺少 API key 的判断中加入 AUTH_TOKEN 不存在条件，使该分支能沿用既有 Bearer source/provider 路径；--bare 与其他 resolver 分支不变。

涉及位置：`src/utils/auth.ts`

### 2. 定义 live 脚本认证矩阵

先拒绝 API key 与 AUTH_TOKEN 并存，再在双缺失时 skip，其余情况进入原四个 probes。

涉及位置：`scripts/live-model-validation.ts`

### 3. 对齐 CI 环境变量

把 job env 和模型 run step 的 secret 引用同时改为 ANTHROPIC_AUTH_TOKEN，保留 base URL 与隔离目录。

涉及位置：`.github/workflows/live-checks.yml`

### 4. 记录实际验证与边界

在 STATUS 更新四个 sentinel 的认证来源，在 RELEASE 说明互斥、Bearer/OAuth 区别及仍需独立环境的范围。

涉及位置：`docs/STATUS.md`、`docs/RELEASE.md`

## 风险与处理

- 若只改脚本不改核心，后续 API-key 检查仍会失败；若允许双凭据并存，则请求身份依赖不可见优先级。

## 验收顺序

1. 按仅 API key、仅 AUTH_TOKEN、两者并存、两者缺失四种矩阵检查分支，再依据 STATUS/RELEASE 记录核对四个 live-script sentinel，其中三个对应 model-backed 路径，PROACTIVE_LIVE_OK 仅证明本地 proactive Sleep 检查；本记录不新增在线执行声明。

## 完成状态与剩余工作

- 状态：**partial**

### 已完成

- 核心 CI/test 分支、live 脚本和 CI 已接受同一 process.env Bearer 输入契约，文档记录了 settings-based 四个 live-script sentinel；该记录没有本次命令、时间、环境或原始输出，不能独立重建凭据来源。

### 未完成或后续工作

- standalone 脚本未实现认证 guard 前的 settings.env 注入，仅凭 settings.json 的路径会 skip；未新增 auth 单元测试，也未完成独立 Claude OAuth 或桌面授权验证。
