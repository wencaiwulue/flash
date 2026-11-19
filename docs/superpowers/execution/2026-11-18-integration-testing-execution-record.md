---
id: integration-testing-execution-record
title: 集成测试体系执行记录（子项目 0+1 与 2）
date: 2026-11-18
status: final
---

# 集成测试体系执行记录：做了什么、如何做、决策与未做项

本文是 `integration-testing-cli-e2e` 分支（PR #18）两个子项目交付的执行记录：范围覆盖总体架构 spec 的子项目 0+1（公共支撑设施 + CLI 端到端）与子项目 2（配置对齐验收套件）。执行过程细节在 `.superpowers/sdd/progress.md` 台账（git 忽略），本文是持久化摘要。

## 1. 做了什么

### 1.1 子项目 0+1：支撑设施 + CLI e2e（已终审 Ready to merge = Yes）

| 交付物 | 内容 |
|---|---|
| Runner | `scripts/test-integration.ts`：`--suite` 过滤、`--live`/`--no-build`、dist 新鲜度自动构建；`scripts/test.ts` 排除 `tests/integration/` |
| mock-anthropic | 剧本化 mock Anthropic API（非流式/SSE/count_tokens、请求录制、`setRouter` 按 model 路由） |
| pty-driver + ptyrun.c | forkpty 真 PTY 驱动，测试时编译缓存（macOS/Linux 通用） |
| sandbox | 隔离 HOME/项目（onboarding/信任/API key 预置、剥离 ANTHROPIC_*/CLAUDE_* 泄漏、离线开关） |
| dist-fixture / ansi | dist 新鲜度检查构建；strip-ansi 复用封装 |
| CLI e2e 七组 | 启动退出、print 模式+错误浮出、工具执行链（含 is_error）、REPL 交互、--resume 历史回放、权限流、窄终端/流式渲染 |
| CI/文档 | ci.yml Integration tests 门禁步骤；README 双语命令行 |

### 1.2 子项目 2：config-acceptance 验收套件（已终审 Ready to merge = Yes）

| 交付物 | 内容 |
|---|---|
| hook 矩阵 | `fixtures/hooks.yaml` 33 事件全量：10 个真实运行断言 + 23 个显式 skip（全部带证据注释与原因行） |
| 来源优先级 | `sources.yaml` 8 组 dist 形态组合，经请求录制验证 user < project < local < flag < managed |
| 解析容错 | 2 条当前行为验证（`model: 42` 整来源失效、未知键 passthrough）+ 3 条 B0 目标断言编码（待 B0 落地改 status 点亮） |
| env/迁移键 | MAX_THINKING_TOKENS 真实生效验证（thinking budget 经请求体观察）；8 迁移键离线不可观察诚实标记 |
| 引擎 | `entries.ts`（YAML 加载校验）+ 场景构造器（tool_call/permission/print_turn/repl_compact/repl_config_change）+ 引擎单测 + 33 计数门 |
| 执行模型 | runner `--form` 透传；双形态 launcher（源码形态见 §4 降级） |

最终状态：`bun run test:integration` 20 文件全绿，28 pass / 48 skip（每个 skip 有 `SKIP [<原因>] <条目>` 行），typecheck 干净，无 src/ 改动。

## 2. 如何做的

- **流程**：superpowers 全链路 —— brainstorming（分层提问 + 决策表 spec）→ writing-plans（任务级 TDD 计划）→ subagent-driven development（每任务独立子代理实现 + 独立评审 + 修复循环）→ 终审（全分支 diff，逐项 triage Minor）。台账 `.superpowers/sdd/progress.md` 防压缩丢失。
- **探针驱动**：所有不确定行为先跑一次性探针脚本（不提交）取证，再定断言；证据写入测试注释/报告。
- **质量门实践**：评审抓获并纠正了伪造事件名（6 个 B1 新事件名单被编造 5 个）、语义错误的 batch 标记（既有事件误标 B1）、空断言造假、红灯报 DONE、两次越界产品源码修改（autoUpdater.ts，均回滚）。产品行为变更一律退回并要求独立 spec。

## 3. 关键决策（含证据）

| 决策 | 机制 | 为什么 / 备选不采用 |
|---|---|---|
| 独立 runner + 构建产物 | `test:integration` 平行于 `test` | PTY 需真实二进制、SDK 需 dist 形态；不混入单测 runner |
| Mock API 为主 | 进程内 Bun.serve 剧本化 | 离线可重复可断言请求；录制回放需先录制、真实 API 不稳定不能做 PR 门禁 |
| 与 smoke 共存 | 集成层做 PR 门禁，smoke 保留发布验收 | 职责不同；smoke 真实环境依赖无法离线化 |
| forkpty C helper（ptyrun.c） | 测试时编译缓存 | v1 的 `script` 包装被证伪：macOS BSD script 对 Bun socketpair stdin `tcgetattr` 失败 exit 1（`Operation not supported on socket`） |
| `setRouter` 按 model 路由 | mock 层 | haiku 辅助请求是否发生不确定，队列顺序技巧无法确定化 |
| 复用 strip-ansi | re-export 既有依赖 | 自写正则 ECMA-48 覆盖不全 |
| 目标断言 + skip 标记 | fixture `status: active \| blocked-by-batch:X \| blocked-by-prereq:<reason>` | 测试即批次验收门；skip 行显式输出禁静默缩覆盖 |
| hook 矩阵全量 33 | 表驱动数据而非代码 | 与 B0 机器可读矩阵理念对齐 |
| 源码形态降级 | `blocked-by-prereq:source-form-missing-ant-modules` | 见 §4；用户裁决 |
| 全程在 feature 分支 → PR #18 | 非 main 直提 | subagent-driven 流程要求 |

## 4. 没做什么 / 为什么

| 未做项 | 原因 |
|---|---|
| 子项目 3（Agent SDK 集成套件） | 排序在 0→1→2→3 之末；需独立 spec→plan→执行（query 循环、hook 接线、mock MCP、dist 形态导入、token-count fixtures 迁移） |
| managed 注入与 fail-closed 验收 | **源码形态在本仓库不可运行**：`USER_TYPE=ant` 使 `src/tools.ts:16-22` require ant 专属私有模块（REPLTool.js、SuggestBackgroundPRTool.js），快照中不存在（dist 由构建期 feature 门控替换）。用户裁决降级为 `blocked-by-prereq:source-form-missing-ant-modules`；spec §1.2 已修订。待私有模块可用（或私有仓库）后点亮 |
| B0 三类 hook 局部容错运行时 | 属 B0 批次（`2026-11-16-upstream-config-b0-baseline`），本轮只编码验收（`blocked-by-batch:B0`）；运行时仍是 `src/schemas/hooks.ts:212` partialRecord |
| B1 六个新事件运行时协议 | UserPromptExpansion/PostToolBatch/MessageDisplay/DirectoryAdded/PreModelSwitch/PostModelSwitch 属 B1（正确名单经纠正——曾有实现者伪造其中 5 个名字） |
| 8 个迁移键运行时断言 | print 模式下 theme/editorMode/verbose 等仅影响交互 UI，离线不可观察（`blocked-by-prereq:migration-*-observability`）；probe 确认各键无请求体路径 |
| Notification/PermissionDenied/StopFailure/Setup/FileChanged/CwdChanged/PostToolUseFailure 运行断言 | 探针证明离线场景不触发（如 Notification 不随权限提示、Setup 需 --init、PostToolUseFailure 在 print 模式不触发），`blocked-by-prereq:*-observability` 各带证据 |
| SubagentStart/Stop、TaskCreated/Completed、TeammateIdle、Elicitation/ElicitationResult、WorktreeCreate/Remove | 前置缺失：子代理场景框架、任务工具可观察路径、teammate 模式、MCP elicitation 服务端（子项目 3 落地 mock MCP 后可点亮 Elicitation 两条）、worktree 命令场景 |
| live 层用例 | 无登记（`--live` 目前 no-op，输出提示行）；真实凭据类验收不进 CI 门禁 |
| helper 去重重构 | approvedKeyConfig/routeHaikuAux/runPrint 在多测试文件间复制——终审判定为 post-merge 重构项（非正确性问题） |
| spec 双语成对 | specs/plans 按仓库既有惯例单语中文（双语规则适用于 README 与用户向 docs） |

## 5. 执行中的重要行为发现（已固化到测试注释与台账）

1. bundled dist 将 `process.env.NODE_ENV === 'test'` 构建期折叠为 false；GrowthBook 硬编码 `api.anthropic.com`；`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` 是唯一运行时生效的离线开关（否则 min-version 门禁 1.0.24 > 0.0.3 会杀进程）。
2. REPL：`❯` 会误匹配对话框选择器（ready 信号用状态栏 `/effort`）；ApproveApiKey 对话框可用 `customApiKeyResponses.approved: [apiKey.slice(-20)]` 预置消除；单次 Ctrl+C 清空输入、双次退出；Ctrl+D 不退出；权限对话框/interrupt 态下 `/exit` 与 SIGINT 均无效（用 `session.kill()` 收尾）。
3. 权限流：echo 等安全命令经 bash 分类器自动放行；写命令提示 "Do you want to proceed?"（1/2/3）；**拒绝后显示 "Interrupted · What should Claude do instead?" 且不向模型发新请求**（与上游 is_error 假设不同，快照行为）；PreToolUse hook exit 2 则会回传 is_error tool_result。
4. 首个用户提示可能附带 haiku 辅助请求（是否发生不确定 → setRouter 根治）。
5. 源码形态不可运行（§4 首行）；源码启动即使加 `EXTERNAL_FEATURES --feature` 参数也不够。

## 6. 后续入口

- 子项目 3 spec：新会话直接引用本文件 + 总体架构 spec + 台账即可续。
- B0/B1 批次落地时：改 fixtures 的 `status` 字段点亮对应验收（无需改测试逻辑）。
- PR #18 现状：CLI e2e 与 config-acceptance 两次终审均 Ready to merge = Yes；合并决策待用户。
