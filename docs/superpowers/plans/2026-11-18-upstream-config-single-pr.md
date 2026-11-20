# Upstream Configuration Single-PR Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在同一个 wencaiwulue/flash#17 中完成 B0–B5 和最终跨批次审查，使最终固定 stable 的全部在范围内的 settings、hooks、env 具备可审计的行为兼容证据。

**Architecture:** 保留不可变的版本化上游证据包，以稳定 ID 迁移兼容矩阵；漂移、批次完成和最终严格完成使用不同门禁。每个功能批次仍有独立 spec、计划、提交区间和评审，但统一在一个 Draft PR 交付。

**Tech Stack:** Bun、TypeScript、Zod、React/Ink、YAML/JSON fixtures、上游 Claude Code stable 二进制黑盒 probes、GitHub CLI。

## Global Constraints

- 只使用 worktree `upstream-config-b0`、分支 `worktree-upstream-config-b0` 和 PR #17，不创建替代 PR，不提前合并 B0。
- 每批按官方文档 → 同版本上游二进制 → external-stubs/既有 spec 的顺序收集证据，写入中文具体 spec 的决策表。
- 每个 active 条目必须验证 path、type、default、source、precedence、runtime；schema、枚举或环境注入本身不是完成。
- `CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION` 自 2.1.224 起 removed/no-op，不重新实现其旧上限。
- Managed、permissions、sandbox 不得因容错或无效高优先级配置降级为较宽松策略。
- 协议 fake 不等于真实 claude.ai/Desktop/Cloud/企业服务验证；缺少必要实测时保持 partial/blocked 和 Draft。
- 常规 CI 使用脱敏 fixtures，不访问网络、真实账号、私有上游二进制或用户凭据。
- 全量测试以 `bun run test` 退出码和无 `Failed test files` 为准；功能 spec 必须登记 coverage manifest。
- 提交以 `Co-Authored-By: Claude <noreply@anthropic.com>` 结尾。

---

### Task 1: 统一路线与 PR 交付边界

**Files:**
- Modify: `docs/superpowers/specs/2026-11-16-upstream-configuration-alignment-design.md`
- Create: `docs/superpowers/plans/2026-11-18-upstream-config-single-pr.md`
- External: `wencaiwulue/flash#17`

**Interfaces:**
- Produces: 单一 PR、分批实施/评审、最终严格门禁的共同约束，供 Task 2–8 引用。

- [x] 同步 `origin/main`，保留已有 B0 提交和未跟踪 token-count fixtures。
- [x] 用 `gh pr ready 17 --undo` 将 PR 转为 Draft。
- [x] 在路线中记录单 PR 决策，修正 removed subagent 环境变量目标。
- [ ] 将 PR 标题改为 `Align flash with upstream configuration across B0-B5`，正文维护 B0、基线门禁、B1–B5、最终审查和验证清单。
- [ ] 运行 `bun scripts/check-design-docs.ts`，预期退出码 0、无新增 error。
- [ ] 提交路线和计划：`git commit -m "Unify upstream alignment in one draft PR"`。

### Task 2: 多基线迁移与完整性门禁

**Files:**
- Modify: `scripts/upstreamConfigInventory.ts`
- Modify: `scripts/checkUpstreamConfigCompatibility.ts`
- Modify: `tests/upstreamConfigInventory.test.ts`
- Modify: `tests/upstreamConfigCompatibility.test.ts`
- Create: 活动基线指针及后续 `fixtures/upstream-config/<exact-version>/` 快照

**Interfaces:**
- Consumes: 既有 `CompatibilityInventory`、`CompatibilityMatrix`、`checkCompatibility()` 和 `createInitialMatrix()`。
- Produces: 显式 fixture 目录选择、非破坏性矩阵迁移、owner/spec/version 证据、漂移/批次/最终三种检查模式；B1–B5 只能经这些接口推进状态。

- [ ] 先写失败测试：非 2.1.311 快照可独立检查，旧 2.1.311 快照保持有效，initializer 不覆盖现有人工矩阵。
- [ ] 运行 `bun test ./tests/upstreamConfigInventory.test.ts ./tests/upstreamConfigCompatibility.test.ts`，确认新增用例因硬编码基线/缺少迁移接口而失败。
- [ ] 将版本和 fixture 路径参数化，增加受版本控制的活动基线指针；历史证据只读，新证据写新目录。
- [ ] 写迁移测试：新增、消失、类型/default/scope/precedence/lifecycle 变化均进入 diff；受影响 aligned 降级，未变化项必须记录 carry-forward 审核。
- [ ] 实现按稳定 ID 的非破坏性迁移，现有 matrix 存在时拒绝覆盖。
- [ ] 写所有权和证据测试：每个 active 条目具有 ownerBatch、spec、verifiedVersion/current-baseline review，aligned 的 repo 路径和测试引用真实存在。
- [ ] 实现批次与最终严格模式；增加 `ignored-by-design`，removed/no-op 仅在有证据时允许 `excluded`，deprecated-effective 不允许排除。
- [ ] 增加显式 env consumer registry 检查，证明环境变量不是以源码字符串或注入冒充消费者。
- [ ] 运行定向测试、历史/活动基线检查和 `bun run typecheck`，预期全部退出码 0；最终严格模式对当前 0 aligned 矩阵必须失败。
- [ ] 更新具体 spec、coverage 和 PR 检查清单，提交：`git commit -m "Add versioned upstream compatibility gates"`。
- [ ] 对该提交区间进行独立规格符合性与代码质量评审，修正功能问题后再解锁 B1。

### Task 3: B1 Hooks 与进程/subagent 环境

**Files:**
- Create: `docs/superpowers/specs/2026-11-18-upstream-config-b1-hooks-design.md`
- Create: `docs/superpowers/plans/2026-11-18-upstream-config-b1-hooks.md`
- Modify: `src/entrypoints/sdk/coreTypes.ts`
- Modify: `src/schemas/hooks.ts`
- Modify: `src/utils/hooks.ts` 及 probes 证明的真实触发点
- Modify: 活动基线 fixtures、相关 tests 和 coverage

**Interfaces:**
- Consumes: Task 2 的版本化证据、所有权和批次门禁。
- Produces: 全部 33 个 hook 的协议结论；6 个新事件的 schema、SDK 类型和真实运行时分发；B1 env 的真实消费者。

- [ ] 固定 B1 最新 stable 精确版本，生成新 inventory/evidence/diff，不覆盖 2.1.311。
- [ ] 为六个新事件分别记录触发、payload、matcher、stdout/exit、blocking/async、timeout、错误证据；先写具体 spec 和详细 TDD 计划。
- [ ] 先写事件协议失败测试，再复用 `getMatchingHooks()`/`executeHooks()` 接入真实触发点；测试事件顺序、abort、headless/SDK 和未知事件兄弟配置保留。
- [ ] 复核其余 27 个事件，并对 managed/remote/inline 非法 hook 做隔离 probes，不无证扩大容错。
- [ ] 验证 removed 总场次变量 no-op；分别实现/验证 active 并发与深度变量的默认、非法/边界和真实限制。
- [ ] 完成 B1 所有 env，运行批次门禁、全量测试、build、typecheck、design 检查。
- [ ] 更新矩阵/coverage/PR，提交 B1  contiguous 提交区间并完成独立评审。

### Task 4: B2 本地核心、UI 与配置来源

**Files:**
- Create: B2 具体 spec 和详细计划
- Modify: `src/tools/ConfigTool/supportedSettings.ts`
- Modify: `src/utils/settings/types.ts`
- Modify: `src/utils/settings/settings.ts`
- Modify: B2 所属 model/compact/UI/terminal/env 消费者、测试、fixtures 和 coverage

**Interfaces:**
- Consumes: Task 2 门禁与 B1 后的活动矩阵。
- Produces: 来源可追踪的 settings/global-config 解析及 B2 真实运行时消费者。

- [ ] 固定 B2 stable 并写具体决策表，覆盖 B2 全部所有权条目。
- [ ] 先写来源冲突、default、merge/replace 和运行时失败测试，再统一 settings 与 `~/.claude.json` 读取；不自动迁移或双写。
- [ ] 验证九个既有 global-only 示例及全部 B2 model/thinking/compact/output/status/terminal/notification 项。
- [ ] 解决 B2 schema exclusions 和 env，运行批次及全部发布门禁。
- [ ] 更新矩阵/coverage/PR，提交并完成 B2 提交区间评审。

### Task 5: B3 安全与文件系统

**Files:**
- Create: B3 具体 spec 和详细计划
- Modify: B3 所属 permissions/attribution/worktree/sandbox/env 实现、测试、fixtures 和 coverage

**Interfaces:**
- Consumes: 统一来源模型和 B2 后矩阵。
- Produces: 与 B4 共享的安全来源语义及 fail-closed 行为证据。

- [ ] 固定 B3 stable，逐字段记录非法值、部分有效对象和来源失败行为。
- [ ] 先写高优先级无效策略、merge bypass、canonicalization、symlink/路径逃逸失败测试，再实现最小安全语义。
- [ ] 验证真实权限裁决、attribution、worktree 生命周期和 sandbox 进程边界。
- [ ] 运行批次及全部发布门禁，更新矩阵/coverage/PR并完成 B3 提交区间评审。

### Task 6: B4 集成与托管

**Files:**
- Create: B4 具体 spec 和详细计划
- Modify: `src/services/mcp/claudeai.ts`
- Modify: `src/services/remoteManagedSettings/index.ts`
- Modify: `src/bridge/bridgeEnabled.ts`
- Modify: `src/bridge/crossSessionMessages.ts`
- Modify: `src/bridge/peerSessions.ts`
- Modify: B4 所属 auth/gateway/plugin/network/env 实现、测试、fixtures 和 coverage

**Interfaces:**
- Consumes: B3 的统一安全来源与优先级。
- Produces: MCP、remote managed、Remote Control、cross-session 及 B4 集成的真实消费者和降级证据。

- [ ] 固定 B4 stable，将每项分类为已有未接线、功能缺失、外部专属或 removed/deprecated。
- [ ] 用协议 fake 先写成功、禁用、ineligible、畸形响应、服务失败和超时测试，再接入真实消费者。
- [ ] 保留 OAuth、订阅、服务端 gate 和企业策略，不绕过外部限制。
- [ ] 可行时执行脱敏 live 验证；不可用时保留 partial/blocked，不解除 Draft。
- [ ] 运行批次及全部发布门禁，更新矩阵/coverage/PR并完成 B4 提交区间评审。

### Task 7: B5 独立功能子项目

**Files:**
- Create: 每个子项目独立 spec、详细计划、实现、测试、fixtures 和 coverage
- Modify: 活动矩阵和 PR #17 清单

**Interfaces:**
- Consumes: B1–B4 的所有权分类和协议边界。
- Produces: Artifact 发布、插件/技能同步、mods、feedback drafts、用量重置后继续及其他完全缺失功能的真实实现。

- [ ] 每个子项目分别固定证据、写 spec/计划、先写协议与行为失败测试，再实现功能。
- [ ] Artifact 不使用 ReviewArtifactTool 或 SSH artifact 冒充；同步不以目录复制冒充；deprecated-effective 配置仍须对齐。
- [ ] fake 只证明本地协议；必要真实服务验证缺失时保持未完成。
- [ ] 每个子项目运行批次及全部发布门禁，形成独立提交区间和评审；全部计入同一 PR。

### Task 8: 最终 xxx 完整性审查与交付

**Files:**
- Modify: 最终活动基线、全部受影响实现/测试/spec/coverage
- External: `wencaiwulue/flash#17`

**Interfaces:**
- Consumes: B0–B5 全部提交区间和证据。
- Produces: 最终 stable 的严格完整性报告、端到端验证和可评审交付。

- [ ] 固定最终 stable，复核所有条目和旧 aligned carry-forward，不追逐后续 latest。
- [ ] 处理 8 个原 afterBaseline 项、7 个 Desktop-only 项、16 个泛化 schema exclusions 和全部生命周期终态。
- [ ] 运行历史/活动基线、最终严格模式及 `bun run test && bun run build && bun run typecheck && bun scripts/check-design-docs.ts`，要求每步退出码 0。
- [ ] 用构建产物复测原始未知 hook 和代表性 settings/source/env 端到端场景。
- [ ] 确认 PR CI、所有提交区间评审和必要 live 证据完成；仍有 active partial/missing/different/blocked 时保持 Draft。
- [ ] 严格门禁和评审全部通过后更新最终动态统计并解除 Draft；合并前另行取得用户确认。
