# Design Docs Completeness Audit

## 基线

- 仓库 commit：c546cf2cd86e263d59dfd13b9894868c3b00813d
- 上游 CLI：2.1.212 (Claude Code)
- 官方文档索引：https://code.claude.com/docs/llms.txt
- 矩阵生成时间：2026-11-16T06:23:54.850Z
- 范围：68 个注册子系统、全部 coverage groups、顶层文档、未注册工程 spec 与横向契约。
- 当前状态：矩阵已建立，子系统审查尚未完成；open 不表示无问题。

## 基线检查结果

```
Design docs: 0 errors, 71 warnings
```

## 总矩阵

| Spec ID | Batch | Coverage groups | 文档完整性 | 实现一致性 | 上游一致性 | 验证状态 | 发现 | 报告 |
|---|---:|---:|---|---|---|---|---:|---|
| documentation-system | 0 | 2/2 | 完整 | 一致 | N/A | 充分 (离线测试) | 1 | [batch-0.md#documentation-system](batch-0.md#documentation-system) |
| plugins | 0 | 14/14 | 完整 | 一致 | 部分一致 | 部分充分 (有测试，缺集成) | 2 | [batch-0.md#plugins](batch-0.md#plugins) |
| query-core | 0 | 3/3 | 完整 | 一致 | 部分一致 | 部分充分 (有测试，缺端到端) | 2 | [batch-0.md#query-core](batch-0.md#query-core) |
| sdk-query-sessions | 0 | 11/11 | 完整 | 一致 | 部分一致 | 充分 (核心模块覆盖) | 1 | [batch-0.md#sdk-query-sessions](batch-0.md#sdk-query-sessions) |
| sdk-type-generation | 0 | 3/3 | 完整 | 一致 | N/A | 充分 | 1 | [batch-0.md#sdk-type-generation](batch-0.md#sdk-type-generation) |
| cli-startup | 1 | 6/6 | 完整 | 一致 | 一致 | 部分充分 (无直接测试, spec 截断) | 1 | [batch-1.md#cli-startup](batch-1.md#cli-startup) |
| context-compaction | 1 | 8/8 | 完整 | 一致 | 一致 | 部分充分 (核心有测试, 其他模块缺) | 3 | [batch-1.md#context-compaction](batch-1.md#context-compaction) |
| model-api | 1 | 12/12 | 完整 | 一致 | 一致 | 部分充分 (测试覆盖有限) | 1 | [batch-1.md#model-api](batch-1.md#model-api) |
| attachments | 2 | 0/6 | open | open | open | unverified | 0 | 未生成 |
| bridge | 2 | 0/22 | open | open | open | unverified | 0 | 未生成 |
| buddy | 2 | 0/3 | open | open | open | unverified | 0 | 未生成 |
| computer-use | 2 | 0/3 | open | open | open | unverified | 0 | 未生成 |
| file-tools | 2 | 0/10 | open | open | open | unverified | 0 | 未生成 |
| lsp | 2 | 0/8 | open | open | open | unverified | 0 | 未生成 |
| mcp | 2 | 0/20 | open | open | open | unverified | 0 | 未生成 |
| onboarding-ui | 2 | 0/1 | open | open | open | unverified | 0 | 未生成 |
| permissions | 2 | 0/14 | open | open | open | unverified | 0 | 未生成 |
| session-persistence | 2 | 0/7 | open | open | open | unverified | 0 | 未生成 |
| shell-tools | 2 | 0/13 | open | open | open | unverified | 0 | 未生成 |
| tool-framework | 2 | 0/7 | open | open | open | unverified | 0 | 未生成 |
| auth | 3 | 0/20 | open | open | open | unverified | 0 | 未生成 |
| commit-attribution | 3 | 0/6 | open | open | open | unverified | 0 | 未生成 |
| git-integration | 3 | 0/9 | open | open | open | unverified | 0 | 未生成 |
| memory | 3 | 0/7 | open | open | open | unverified | 0 | 未生成 |
| notifications | 3 | 0/7 | open | open | open | unverified | 0 | 未生成 |
| session-search-recovery | 3 | 0/8 | open | open | open | unverified | 0 | 未生成 |
| sessions-share | 3 | 0/6 | open | open | open | unverified | 0 | 未生成 |
| settings | 3 | 0/21 | open | open | open | unverified | 0 | 未生成 |
| skills | 3 | 0/17 | open | open | open | unverified | 0 | 未生成 |
| app-state | 4 | 0/10 | open | open | open | unverified | 0 | 未生成 |
| assistant-ui | 4 | 0/2 | open | open | open | unverified | 0 | 未生成 |
| commands-framework | 4 | 0/3 | open | open | open | unverified | 0 | 未生成 |
| cost-tracking | 4 | 0/10 | open | open | open | unverified | 0 | 未生成 |
| ide-integration | 4 | 0/8 | open | open | open | unverified | 0 | 未生成 |
| ink-platform | 4 | 0/20 | open | open | open | unverified | 0 | 未生成 |
| repl-input | 4 | 0/9 | open | open | open | unverified | 0 | 未生成 |
| text-formatting | 4 | 0/12 | open | open | open | unverified | 0 | 未生成 |
| ui-rendering | 4 | 0/14 | open | open | open | unverified | 0 | 未生成 |
| voice-assistant | 4 | 0/10 | open | open | open | unverified | 0 | 未生成 |
| workspace-ui | 4 | 0/13 | open | open | open | unverified | 0 | 未生成 |
| agent-swarms | 5 | 0/20 | open | open | open | unverified | 0 | 未生成 |
| help-feedback | 5 | 0/2 | open | open | open | unverified | 0 | 未生成 |
| plan-worktree | 5 | 0/10 | open | open | open | unverified | 0 | 未生成 |
| review-analysis | 5 | 0/5 | open | open | open | unverified | 0 | 未生成 |
| scheduling | 5 | 0/22 | open | open | open | unverified | 0 | 未生成 |
| task-system | 5 | 0/21 | open | open | open | unverified | 0 | 未生成 |
| workflow | 5 | 0/7 | open | open | open | unverified | 0 | 未生成 |
| daemon-background | 6 | 0/10 | open | open | open | unverified | 0 | 未生成 |
| deep-link | 6 | 0/7 | open | open | open | unverified | 0 | 未生成 |
| open-runner | 6 | 0/7 | open | open | open | unverified | 0 | 未生成 |
| platform-integrations | 6 | 0/16 | open | open | open | unverified | 0 | 未生成 |
| remote-control | 6 | 0/7 | open | open | open | unverified | 0 | 未生成 |
| ssh | 6 | 0/9 | open | open | open | unverified | 0 | 未生成 |
| teleport | 6 | 0/3 | open | open | open | unverified | 0 | 未生成 |
| build-feature-profile | 7 | 0/7 | open | open | open | unverified | 0 | 未生成 |
| data-structures | 7 | 0/15 | open | open | open | unverified | 0 | 未生成 |
| diagnostics | 7 | 0/2 | open | open | open | unverified | 0 | 未生成 |
| experimental-features | 7 | 0/2 | open | open | open | unverified | 0 | 未生成 |
| external-stubs | 7 | 0/5 | open | open | open | unverified | 0 | 未生成 |
| hooks-system | 7 | 0/4 | open | open | open | unverified | 0 | 未生成 |
| magic-docs | 7 | 0/4 | open | open | open | unverified | 0 | 未生成 |
| messaging-primitives | 7 | 0/11 | open | open | open | unverified | 0 | 未生成 |
| native-installer | 7 | 0/7 | open | open | open | unverified | 0 | 未生成 |
| network-security | 7 | 0/7 | open | open | open | unverified | 0 | 未生成 |
| runtime-lifecycle | 7 | 0/11 | open | open | open | unverified | 0 | 未生成 |
| telemetry | 7 | 0/1 | open | open | open | unverified | 0 | 未生成 |
| test-validation | 7 | 0/11 | open | open | open | unverified | 0 | 未生成 |
| web-tools | 7 | 0/9 | open | open | open | unverified | 0 | 未生成 |

## 分类统计与整改顺序

### Batch 0 统计

| 项目 | 数量 |
|------|------|
| 审查子系统 | 5 |
| 完整文档 | 5 |
| 实现一致 | 5 |
| 发现总数 | 5 |
| P0 | 0 |
| P1 | 0 |
| P2 | 2 |
| P3 | 3 |

### Batch 1 统计

| 项目 | 数量 |
|------|------|
| 审查子系统 | 3 |
| 完整文档 | 3 |
| 实现一致 | 3 |
| 上游一致 | 3 |
| 发现总数 | 5 |
| P0 | 0 |
| P1 | 0 |
| P2 | 3 |
| P3 | 2 |

### 发现分类

| 类别 | 数量 |
|------|------|
| 测试缺口 | 4 |
| 证据不足 | 1 |

### 整改优先级

1. **P2（2项）**：添加 plugins/query-core 集成测试
2. **P3（3项）**：补齐 plugins 7.0 章节测试场景说明、为 sdkEventQueue 添加测试/完善 sdkHeapDumpMonitor、添加类型兼容性测试

其余批次尚未完成，暂不统计。

## 完成判定

batch 0：✅ 已完成审查，报告已生成并链接；其余批次待审查。
batch 1：✅ 已完成审查，报告已生成并链接；官方文档与 strings 已收集，真实模型/API 行为尚未验证。
