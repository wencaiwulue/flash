---
commit: 4dbadb8a7616033419b9d4a614b62c11c1c3df52
title: "Record live validation workflow success"
date: 2026-11-11T09:42:27+08:00
status: partial
kind: evidence-update
---

# Record live validation workflow success

> 本文是依据该提交的 diff、对应 revision 的实现与测试，以及有出处的状态记录所作的回溯性设计重建；不冒充历史提交当时已存在的原文。

## 前置状态与问题

父提交已经记录本地 live 脚本的四项模型 sentinel 与 SKILLHUB_LIVE_OK，但 RELEASE 尚未关联 hosted live-validation run，STATUS 的 Verified evidence 表也没有该 workflow 行。

需要补录 GitHub Actions 结果，同时保留缺凭据跳过与真正执行的区别。实际补丁在 RELEASE 写明 model/Cloud 可跳过，却在 STATUS 写成 Model、SkillHub、Cloud jobs passed，两个公开状态来源因此对 Cloud 给出不一致含义。

## 目标与非目标

### 目标

- 把 live-validation run 42940722483 加入 RELEASE，并记录无凭据和无 self-hosted runner 时的跳过条件。
- 在 STATUS 增加 workflow 行，同时识别其 Cloud passed 表述与 RELEASE 的冲突，而不替历史补丁掩盖。

### 非目标

- 不把 workflow 整体成功解释成每个 live job 都执行成功，skip 不是 live round trip。
- 不新增模型、SkillHub、Cloud 或桌面探针，也不修改 secrets、runner 和脚本。

## 方案架构与数据流

证据沿两个文档面传播：RELEASE 保存 run ID 与跳过条件，STATUS 保存摘要表行。二者本应对同一运行给出一致结论；本提交的实际设计缺陷正是 STATUS 摘要丢失了 Cloud 的 skip 限定。

### 文件、接口与证据关系

| 关系 | 位置 | 设计作用 |
|---|---|---|
| 变更 | `docs/RELEASE.md`，符号 `42940722483` | 追加 hosted run 与 model/Cloud/desktop 的跳过条件。 |
| 变更 | `docs/STATUS.md`，符号 `\| `live-validation` workflow \|` | 新增摘要行，但其 Cloud passed 没有保留 RELEASE 的限定。 |

## 关键决策与工程取舍

- 回溯记录同时保留 run 通过和文档矛盾，而不是只引用较乐观的 STATUS 行，也不把后来的配置状态倒填到这次运行。

### 备选方案与回溯分析

- 更稳妥的实现应把 STATUS 写成 workflow passed，并列明 model/Cloud 按凭据跳过；直接删除 STATUS 行虽能消除冲突，却会丢失本次证据更新，这两种都不是实际 diff。

## 安全与协议边界

- 文档只记录公开 run 和 sentinel，不写入 secret 值；Cloud 与桌面是否具备授权环境必须由真实 job 行为证明。

## 验收标准

- RELEASE 包含 42940722483，并明确 model/Cloud 缺凭据跳过和 desktop 无 self-hosted runner 跳过。
- STATUS 的新增行被原样识别为过度概括，不能被本设计文档重新表述为 Cloud live verified。

## 验证证据

| 类型 | 证据陈述 | 来源 |
|---|---|---|
| recorded-ci-pass | RELEASE 记录 live-validation run 42940722483 passed，但同句限定 model/Cloud 可在缺凭据时 skipped，desktop 可在无 runner 时 skipped。 | `docs/RELEASE.md`，符号 `42940722483`，revision `commit` |
| diff-observed | STATUS 同时新增 Model、SkillHub、Cloud jobs passed，未保留 Cloud skip 限定，因此该证据提交自身存在未调和的状态冲突。 | `docs/STATUS.md`，符号 `\| `live-validation` workflow \|`，revision `commit` |
| not-recorded | 此提交没有附上 Cloud OAuth round trip 或桌面控制日志，不能用 workflow 结论补齐这些证据。 | 未随提交记录执行证据 |

## 实现状态与剩余范围

- 状态：**partial**
- STATUS 的 Cloud jobs passed 需要另行校正为带环境条件的 workflow 结果；在此之前，该证据提交只能记为 partial。
