---
commit: 97b13fd5279b917c69462da929db00bba942de6a
title: "Move live validation gating into scripts"
date: 2026-11-11T09:33:58+08:00
status: partial
kind: component
---

# Move live validation gating into scripts

> 本文是依据该提交的 diff、对应 revision 的实现与测试，以及有出处的状态记录所作的回溯性设计重建；不冒充历史提交当时已存在的原文。

## 前置状态与问题

父提交的 live-checks.yml 在 model/cloud 的 job if 使用不受支持的 env context，desktop 则使用 vars.CLAUDE_DESKTOP_LIVE。model 脚本缺少密钥时仍进入 main，cloud 脚本缺少 token 会直接抛错；desktop 脚本已有 CLAUDE_DESKTOP_LIVE !== '1' 的跳过分支。

受支持的 job 条件可在 runner 启动前结束任务，但父提交的 model/cloud 条件并不具备该可靠语义。此次把 model/cloud 的可用性判断下放到脚本，同时删除 desktop 的有效 vars gate；workflow 仍向 desktop 脚本固定传 1，不能把这个中间态写成三种门控都已完整迁移。

## 目标与非目标

### 目标

- 让 model 在缺少 ANTHROPIC_API_KEY 时输出 MODEL_LIVE_SKIPPED，并在 enableConfigs 前返回。
- 让 cloud 在缺少 OAuth token 时输出 CLOUD_LIVE_SKIPPED，同时保留有 token 时的 bridge、持久化和归档验证。
- 删除 workflow 中三个 job 的 if，不改变 skillhub 和各成功路径的验证步骤。

### 非目标

- live-desktop-validation.ts 不在 diff 中；workflow 仍给验证步骤设置 CLAUDE_DESKTOP_LIVE: '1'，因此该调用不会因原先仓库变量缺省而跳过。
- 本提交没有附带外部服务或 GitHub Actions 运行结果，不把静态改动解释为 live 验证通过。

## 方案架构与数据流

workflow 只保留 job 编排，model 与 cloud 的缺省配置处理进入各自 Bun 脚本；desktop 复用已有脚本 guard，但其字面量步骤环境使该 guard 在此 workflow 中进入 live 分支。

### 文件、接口与证据关系

| 关系 | 位置 | 设计作用 |
|---|---|---|
| 变更 | `.github/workflows/live-checks.yml` | 删除 model、cloud、desktop 的 job 级可用性条件。 |
| 变更 | `scripts/live-cloud-validation.ts` | 新增无 token 跳过并保留有 token 的 cloud 验证。 |
| 变更 | `scripts/live-model-validation.ts` | 新增无密钥提前返回。 |
| 复用 | `scripts/live-desktop-validation.ts`，符号 `process.env.CLAUDE_DESKTOP_LIVE !== '1'`，revision `commit` | 既有 desktop guard，未在本提交修改。 |

## 关键决策与工程取舍

- model guard 放在 main 开头，提前返回后仍由外层 finally 执行 runCleanupFunctions。
- cloud 仅对无 token 跳过；org UUID 获取失败仍是错误，base URL 继续使用 getOauthConfig().BASE_API_URL 默认值。
- workflow 只删三行条件，runner、secret 映射、安装步骤及验证命令均保持原样。

### 备选方案与回溯分析

- 事后看，保留 job if 能避免无配置 job 占用 runner，却不能产生脚本跳过日志；抽象共享 guard 也可能统一策略，但本 diff 没有引入新模块。

## 安全与协议边界

- guard 只检查配置是否存在并输出固定标记，不打印密钥、token、org UUID 或 base URL；成功路径仍沿用原有凭据来源。

## 验收标准

- 无密钥 model 不进入配置初始化和 live probes；无 token cloud 不进入组织解析及 bridge 流程。
- 有配置的成功序列保持完整，cloud 的有 token 分支仍包含 session resume、文件持久化、archive 和 finally 清理。
- 三个目标 job 不再有条件行，desktop 脚本无 diff 且其 workflow 步骤仍显式启用 live 模式。

## 实现状态与剩余范围

- 状态：**partial**
- desktop CI 已失去仓库变量门控；需要另行恢复 job gate 或调整步骤环境，当前字面量设置会让获得 runner 的 job 进入 screenshot。
- cloud 在 mkdtemp 后才检查 token，skip 分支不进入清理临时目录的 finally，该退出路径仍有资源清理缺口。
