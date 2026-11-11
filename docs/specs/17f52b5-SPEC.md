---
commit: 17f52b5584441f3c937f3d927acad381852159b7
title: "Test live workflow without job conditions"
date: 2026-11-11T09:22:15+08:00
status: partial
kind: component
---

# Test live workflow without job conditions

> 本文是依据该提交的 diff、对应 revision 的实现与测试，以及有出处的状态记录所作的回溯性设计重建；不冒充历史提交当时已存在的原文。

## 前置状态与问题

父提交的 workflow 只剩 model 和 skillhub 两个 job：model 的 if 文本要求非 pull_request 且 API key 非空，但 secrets context 在 jobs.<job_id>.if 不受支持；skillhub 要求非 pull_request。Cloud 与 desktop job 已被移除但脚本仍在，model 脚本此时尚无缺少密钥时的 skip guard。

提交主题说明要测试没有 job conditions 的 workflow，补丁确实删除两个 if。删除后 model 对声明的触发器不再有 job 级凭据判断，也没有对应的脚本缺省分支，因此未配置时同样会安装依赖并进入 live 探针；Cloud/desktop 仍保持上一步的 absent 状态，不能用后来的脚本 guard 或最终 CI 结果解释当前设计。

## 目标与非目标

### 目标

- 删除 model 的非 pull_request/API key 复合条件和 skillhub 的非 pull_request 条件。
- 保持两个 job 的 runner、安装步骤、脚本调用、env 映射以及 workflow_dispatch/schedule 不变。

### 非目标

- 不恢复 Cloud 或 desktop job，也不把它们的 absent 状态写成 skipped 或 executed。
- 不新增 MODEL_LIVE_SKIPPED 或 CLOUD_LIVE_SKIPPED；这些属于后续 revision。
- 不重命名 live-validation.yml、不改变 name: live-validation，不宣称重新注册或 Actions 运行成功。
- 不修改模型、SkillHub、Cloud 或桌面脚本及其外部服务边界。

## 方案架构与数据流

当前 workflow 的两个 job 都没有 if，也没有 Environment 字段。对文件实际声明的 workflow_dispatch 与 schedule 而言，原非 pull_request 合取本就始终成立；删除它不改变这两类触发来源，但删除 model 的 secret 合取会实质扩大到无 API key 的运行。

model 在无密钥时也会 checkout、安装 Bun 和依赖，再调用原脚本。该脚本直接从 enableConfigs、getMainLoopModel 和 workflow probe 开始，没有 MODEL_LIVE_SKIPPED 分支，所以当前行为是尝试 live 验证并在后续配置或请求处暴露失败，而不是已定义的优雅 skip。

skillhub 同样无条件进入脚本，但其脚本在 URL 未配置时使用公共地址，token 可缺省，因此它和 model 的无条件运行语义不同。Cloud/desktop 依旧不出现在 YAML 中，即使脚本文件仍保留，也不会由该 workflow 调度。

### 文件、接口与证据关系

| 关系 | 位置 | 设计作用 |
|---|---|---|
| 变更 | `.github/workflows/live-validation.yml`，符号 `jobs:` | 删除 model 与 skillhub 的两个 if，保留二 job 及原触发器。 |
| 复用 | `scripts/live-model-validation.ts`，符号 `async function main()`，revision `commit` | 未改脚本尚无密钥 guard，无条件 job 会进入 live 流程。 |
| 复用 | `scripts/live-skillhub-validation.ts`，符号 `process.env.CLAUDE_SKILL_REGISTRY_URL \|\| 'https://skill.xfyun.cn'`，revision `commit` | 未改公共探针保留默认 URL 与可选 token。 |
| 复用 | `scripts/live-cloud-validation.ts`，符号 `CLOUD_LIVE_OK`，revision `commit` | 脚本仍在但无 Cloud job，本提交没有恢复或执行它。 |
| 复用 | `scripts/live-desktop-validation.ts`，符号 `DESKTOP_LIVE_SKIPPED`，revision `commit` | 脚本仍在但无 desktop job，不能把该标记归给当前 workflow。 |
| 复用 | `docs/RELEASE.md`，符号 `with separate model, SkillHub, Cloud, and desktop`，revision `commit` | 遗留四 job 描述未随中间态更新。 |

## 关键决策与工程取舍

- 以最小两行删除落实无 job conditions 的中间试验，不同时引入脚本 guard 或恢复其他 job。
- 保留公共 SkillHub 的默认 URL 和可选 token，使该 job 的无条件运行仍有公共探针路径；model 没有等价公共无凭据路径，这是本 revision 的实际缺陷。
- 保持文档不变意味着 RELEASE 的四 job 描述继续滞后；本记录因此采用 partial，而不把试验性两行删除包装成完整 live 方案。

### 备选方案与回溯分析

- 保留 model 的凭据 gate，或先给 model 增加无密钥提前返回，都能避免未配置 runner 进入 live probe；两者都不是本提交内容。
- 只删除非 pull_request 判断而保留 secret 判断可减少行为扩张，但不符合实际删除整行 if 的补丁。

## 安全与协议边界

- workflow 仍只有 contents: read，secret 值没有写入补丁或日志；无条件运行不等于凭据可被公开。
- 未配置 model 现在会启动 hosted runner 并尝试外部探针，可能产生失败和非必要资源消耗；不能把它说成安全跳过。
- self-hosted desktop 不在当前 workflow 中，此次删除条件不会意外启动桌面 runner。

## 验收标准

- diff 仅删除 model 与 skillhub 各一行 if，两个 job 的其他字段保持父提交内容。
- 当前 model 脚本没有缺密钥 sentinel 或提前返回，无条件 job 与无条件脚本 skip 必须明确区分。
- SkillHub 默认公共地址仍可用，Cloud/desktop job 仍 absent，workflow 路径与内部名称均未改变。
- 不从此补丁推断平台已接受 workflow 或任何 live probe 已通过。

## 验证证据

| 类型 | 证据陈述 | 来源 |
|---|---|---|
| diff-observed | at-commit workflow 的 model 与 skillhub 均直接从 runs-on 开始，不再有任何 job if；触发器和 env 映射保留。 | `.github/workflows/live-validation.yml`，符号 `jobs:`，revision `commit` |
| diff-observed | 该 revision 的 model main 先 enableConfigs、getMainLoopModel 并启动 workflow，没有 MODEL_LIVE_SKIPPED 或密钥存在性检查。 | `scripts/live-model-validation.ts`，符号 `async function main()`，revision `commit` |
| diff-observed | SkillHub 脚本仍以公共地址作为环境变量缺省值，并将 token 作为可选配置，因此不能与 model 的缺凭据行为混同。 | `scripts/live-skillhub-validation.ts`，符号 `process.env.CLAUDE_SKILL_REGISTRY_URL \|\| 'https://skill.xfyun.cn'`，revision `commit` |
| diff-observed | RELEASE 仍写四个独立 job，未反映 Cloud/desktop 在上一提交已移除以及本提交的二 job 无条件状态。 | `docs/RELEASE.md`，符号 `with separate model, SkillHub, Cloud, and desktop`，revision `commit` |
| not-recorded | 提交没有 workflow dispatch、schedule、解析或 sentinel 运行记录，尤其没有无密钥 model 行为或 Cloud/desktop 的实际结果。 | 未随提交记录执行证据 |

## 实现状态与剩余范围

- 状态：**partial**
- model 缺少与无条件 job 配套的无密钥 guard，未配置运行不会按后来的固定 sentinel 优雅跳过。
- Cloud/desktop CI 入口仍缺失，RELEASE 四 job 描述仍过时。
- 该试验是否改善 workflow 注册或执行没有平台侧证据。
