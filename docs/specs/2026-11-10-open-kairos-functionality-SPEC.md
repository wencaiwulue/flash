---
commit: d5a675a4df66ff620d7577aaf167bb5749cc08a2
title: 开放 KAIROS assistant、通知、文件与 PR 订阅设计
date: 2026-11-10
retrospective: true
---

# 开放 KAIROS assistant、通知、文件与 PR 订阅设计

## Assistant 初始化

assistant 可由 settings、CLAUDE_CODE_ASSISTANT 或 forced 标记激活，并区分 forced/env/settings 来源。`initializeAssistantTeam()` 以 session 前缀生成 teamName，写入 lead 成员、leadSessionId/model/cwd，注册 cleanup，重置任务列表并设置 in-process teammate 模式。system addendum 只要求 lead 委托独立工作并汇总，不允许把未完成的队友工作或上传当成已完成。

session discovery 通过 OAuth 请求 `/v1/sessions?limit=50`，兼容 data 包装和 snake/camel 字段，按 lastActiveAt 降序。

## 外部动作边界

- PushNotification：优先 webhook，2xx 才算 delivered；否则使用 sendOSNotification；无 adapter 必须失败。
- SendUserFile：要求 active Remote Control bridge、FileRead 权限和普通文件，复用 uploadBriefAttachment；只有返回 fileId 才算上传成功。
- SubscribePR：repository 默认从 origin 解析，subscribe/unsubscribe/list 共用 PRSubscriptionManager；非 list 必须提供 pr_number。
- `/dream`：用 buildConsolidationPrompt 组合 auto-memory 路径、项目目录和用户参数，不另建记忆存储。

## PR 事件去重

PRSubscriptionManager 为每个 repository#number 保存独立 interval、seen 和 initialized。每轮先取 PR head SHA，再并行读取 issue comments、reviews 和 check-runs，事件 ID 分别加 comment/review/check 前缀。

首轮只建立 baseline，不发通知；后续仅发 seen 中不存在的 ID。interval 使用 unref，unsubscribe clearInterval，stopAll 停止全部订阅。

构建新增 `KAIROS` 和 `KAIROS_GITHUB_WEBHOOKS`，assistant 命令、team/session 初始化、通知、文件、订阅和 dream 分别接入。

## 验收标准

1. assistant 激活来源、team 文件、lead、任务目录和 cleanup 一致；session 字段解析与排序正确。
2. webhook 非 2xx、无通知 adapter、无 bridge、无 fileId 和非法 PR 参数都不能被报告为成功。
3. PR 首轮静默、后续按类型 ID 去重，重复 subscribe/unsubscribe 与 stopAll 正确。
4. `kairos.test.ts` 覆盖 team 初始化、通知适配、PR 去重和 dream prompt；feature-profile 覆盖两个 KAIROS feature。
