---
commit: b183b9a76948750cf396dd36c62ad06a62221b60
title: "Gate live validation jobs on available environments"
date: 2026-11-11T09:28:02+08:00
status: partial
kind: component
---

# Gate live validation jobs on available environments

> 本文是依据该提交的 diff、对应 revision 的实现与测试，以及有出处的状态记录所作的回溯性设计重建；不冒充历史提交当时已存在的原文。

## 前置状态与问题

父提交的 live-checks.yml 只有 model 与 skillhub 两个 ubuntu job，二者均无 job if。model 脚本没有缺密钥跳过；cloud 脚本缺 token 会抛错；desktop 脚本虽有 CLAUDE_DESKTOP_LIVE guard，但尚未接入 workflow。

需要把 model 可用性门控并补入 cloud、desktop 编排，但实现直接在 jobs.<job_id>.if 使用 secrets；该位置不支持 secrets context，不能把新增条件描述为已验证的空值跳过。

## 目标与非目标

### 目标

- 给 model 增加 ANTHROPIC_API_KEY 非空条件，保留原步骤级 secret 映射。
- 新增带三项 secret 条件的 cloud job，以及带 CLAUDE_DESKTOP_LIVE 变量条件的 self-hosted desktop job。
- 保持 skillhub、触发器、权限和四个验证脚本不变。

### 非目标

- 没有创建 GitHub Environment，也没有 environment: 配置；这里的环境可用性仅指变量和 runner 选择。
- 不新增脚本内 model/cloud 跳过，不记录 workflow 运行、外部服务成功或原生桌面验证。

## 方案架构与数据流

job if 位于 runner 分配和 checkout 之前，step env 只在步骤进程中生效；二者阶段不同。desktop 的 vars 条件控制 job，字面量步骤环境再控制既有脚本 guard。

### 文件、接口与证据关系

| 关系 | 位置 | 设计作用 |
|---|---|---|
| 变更 | `.github/workflows/live-checks.yml` | 加入 model gate，并新增 cloud、desktop job。 |
| 复用 | `scripts/live-model-validation.ts`，符号 `async function main()` | 父版本脚本无密钥跳过 guard，本提交未修改。 |
| 复用 | `scripts/live-cloud-validation.ts`，符号 `Claude OAuth is required for cloud validation` | 复用缺 token 抛错的 cloud 验证。 |
| 复用 | `scripts/live-desktop-validation.ts`，符号 `DESKTOP_LIVE_SKIPPED` | 复用既有 desktop guard；workflow 步骤会显式传入 1。 |
| 复用 | `scripts/live-skillhub-validation.ts`，符号 `SKILLHUB_LIVE_OK` | skillhub 脚本及其无条件 job 保持原样。 |
| 复用 | `docs/RELEASE.md`，符号 `## CI live validation` | 当时发布说明未给此次门控提供独立运行证据。 |
| 复用 | `docs/STATUS.md`，符号 `Live validation gaps` | 当时状态仍保留 Cloud 与原生桌面的授权环境边界。 |

## 关键决策与工程取舍

- model 与 cloud 采用未包裹的 secrets 表达式，desktop 采用未包裹的 vars 等值表达式；本提交尚未引入 job 级 env。
- cloud 要求 token、org UUID、base URL 三项均非空，尽管脚本自身对后两项另有回退；desktop 运行后强制向脚本传入 CLAUDE_DESKTOP_LIVE=1。

### 备选方案与回溯分析

- 事后看，脚本内 guard 能输出跳过标记，job if 则能避免 runner 占用；本提交没有把二者统一，也没有实现 runner 自动探测。

## 安全与协议边界

- 记录只包含变量名，不含凭据值；workflow 沿用 secrets/vars 引用与 contents: read，没有新增权限或回显步骤。

## 验收标准

- diff 仅向 live-checks.yml 增加 33 行：一个 model if 和完整 cloud、desktop jobs。
- model/cloud 脚本仍分别是无缺省 guard、缺 token 抛错；desktop job 若进入步骤，其字面量 env 会走 screenshot 分支。

## 验证证据

| 类型 | 证据陈述 | 来源 |
|---|---|---|
| diff-observed | at-commit workflow 可直接看到 model 的 secrets 条件、cloud 的三项 secrets 条件和两个新增 job。 | `.github/workflows/live-checks.yml`，符号 `if: secrets.ANTHROPIC_API_KEY != ''`，revision `b183b9a76948750cf396dd36c62ad06a62221b60` |
| diff-observed | desktop 使用 vars.CLAUDE_DESKTOP_LIVE 等值条件与 self-hosted runner，步骤环境仍固定为 1。 | `.github/workflows/live-checks.yml`，符号 `if: vars.CLAUDE_DESKTOP_LIVE == '1'`，revision `b183b9a76948750cf396dd36c62ad06a62221b60` |
| diff-observed | 父脚本表明 cloud 在没有 OAuth token 时抛出错误，本提交未改变这一脚本行为。 | `scripts/live-cloud-validation.ts`，符号 `Claude OAuth is required for cloud validation`，revision `4dd93b75220926cefbe9d5d017224238bfd8e0f1` |
| diff-observed | desktop 的 DESKTOP_LIVE_SKIPPED 分支是复用代码，并非本提交新增。 | `scripts/live-desktop-validation.ts`，符号 `process.env.CLAUDE_DESKTOP_LIVE !== '1'`，revision `4dd93b75220926cefbe9d5d017224238bfd8e0f1` |
| diff-observed | at-commit STATUS 仍要求另行准备授权的交互桌面，未提供原生桌面已通过依据。 | `docs/STATUS.md`，符号 `Native Computer Use desktop control`，revision `b183b9a76948750cf396dd36c62ad06a62221b60` |
| not-recorded | 没有随提交保存 workflow 解析、job 跳过、runner 分配或 live probe 日志。 | 未随提交记录执行证据 |

## 实现状态与剩余范围

- 状态：**partial**
- model/cloud 的 job-if 上下文需要另行修正；desktop 变量与真实 runner 库存也未建立自动关联。
