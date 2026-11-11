---
commit: d5a675a4df66ff620d7577aaf167bb5749cc08a2
title: KAIROS 功能开放的实施顺序
date: 2026-11-10
retrospective: true
---

# KAIROS 功能开放的实施顺序

## 1. 初始化 assistant team 与 session discovery

**文件：** `src/assistant/index.ts`、`sessionDiscovery.ts`。

实现 forced/env/settings 三种激活路径。initializeAssistantTeam 先固定 teamName/leadAgentId，再写 team 文件、注册 cleanup、重置任务、设置 leader 和 in-process override。discovery 复用 prepareApiRequest/getOAuthHeaders，兼容两种列表与字段格式，按 lastActiveAt 排序。

**测试：** `tests/kairos.test.ts` 先验证隔离 team 文件和响应归一化。

## 2. 实现通知与文件上传

PushNotificationTool 先检查 webhook，axios 带 10 秒和 abort，非 2xx 抛错；无 webhook 时调用 sendOSNotification，无 adapter 抛错。

SendUserFileTool 先复用 FileRead 权限，再检查 isReplBridgeActive 和普通文件，调用 uploadBriefAttachment；只有 fileId 非空才返回 fileName/fileId。

分别覆盖 webhook 成功/失败、OS fallback、无 bridge 和上传失败。

## 3. 实现 PRSubscriptionManager 与工具

**文件：** `src/services/prSubscriptions.ts`、`SubscribePRTool.ts`、`commands/subscribe-pr.ts`。

每订阅保存 timer/seen/initialized。poll 先解析 head SHA，再并发获取 comments/reviews/checks，用类型前缀构造稳定 ID。initialized=false 时 fresh 为空；随后只通知未见 ID。timer unref，unsubscribe 清理。

SubscribePRTool 实现 list/subscribe/unsubscribe，非 list 必须有 pr_number，repository 缺省从 origin 解析。

**测试：** 注入 fetchJson，覆盖首轮 baseline、三类新事件、重复事件、重复 subscribe 和 stopAll。

## 4. 注册 dream 与 feature

`/dream` 使用 buildConsolidationPrompt(getAutoMemPath(), getProjectDir(getCwd()), args)。构建只添加 `KAIROS`、`KAIROS_GITHUB_WEBHOOKS`，同步 assistant 命令、通知、文件、订阅和技能注册。

```bash
bun test tests/kairos.test.ts tests/enabledFeatures.test.ts
bun run typecheck
bun test
```

回滚时先移除外部动作入口，再回滚 PR 订阅和 assistant team；不得把首次 PR 历史当新事件、把无 fileId 当上传成功，或复用全局 team 文件。
