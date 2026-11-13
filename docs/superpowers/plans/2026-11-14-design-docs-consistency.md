# Design Docs Consistency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 68 份子系统设计文档的改进建议统一为可校验、可分级、可追溯的工作清单，回写已知缺陷，修复交叉引用，并以最新验证结果更新状态记录和 CI 门禁。

**Architecture:** 先按领域串行改写第 9 章，避免多个任务同时触碰同一文件；再集中处理跨领域缺陷与剩余建议分级。所有正文归一后，才为 `scripts/check-design-docs.ts` 增加结构性检查并接入 CI。最后运行真实验证，只把实际结果写入 `docs/STATUS.md`，不将执行结果写入回溯性设计 spec。

**Tech Stack:** Markdown、YAML、Bun 1.3.14、TypeScript strict、Bun test、Zod v4、GitHub Actions、现有 `scripts/check-design-docs.ts`。

## Global Constraints

- 不修改 `src/` 中的产品实现；本计划只修改文档、文档检查器及其测试、CI。
- 68 份注册 spec 全部保持 `draft`；本计划不代替用户批准，不批量改成 `approved`。
- 每份 spec 继续使用九章结构；第 9 章统一使用七列表格：优先级、触发场景与证据、建议方向、回归风险、验收方式、工作量、置信度。
- P0 只用于有直接证据的安全、数据丢失、核心正确性或协议边界问题；P1 不能只依赖设计推断；单纯测试缺口归为 P2；可选体验和新功能归为 P2/P3。
- 工作量只能使用 `S`、`M`、`L` 之一；置信度只能以 `已证实`、`待运行验证` 或 `设计推断` 开头，可在括号中补充证据边界。
- 每条建议必须包含源码路径或验证记录证据、回归风险、可观察验收方式和单一工作量；不得新增空泛重构愿望。
- `docs/STATUS.md` 是当前状态；`docs/RELEASE.md` 和 external-stubs 分波验证记录是历史记录，只追加或加历史说明，不改写旧结果。
- mock/offline/build 证据不得写成 live 验证。未重新执行的 live 能力保持原有证据边界。
- `src/entrypoints/sdk/settingsTypes.generated.ts` 是手写 re-export，必须继续由 `sdk-type-generation` 主拥有，不得加入生成文件排除。
- 不在 coverage YAML 中重复登记跨域文件；跨域问题通过 spec 链接和主职责说明表达。
- 每个任务独立提交并运行对应检查；最终运行全量 test、typecheck、build、普通文档检查和严格模式诊断分类。
- 最终严格模式仍应只有 68 个 `DRAFT_SPEC` 错误；不得将“draft 尚未批准”误报为其他结构问题。

## 实施理由与步骤依据

先改文档再改检查器，避免新增规则让中间提交必然失败。前四个任务处理 33 份非标准第 9 章，第五个任务处理其余 34 份领域 spec 的优先级和已知缺陷，第六个任务单独处理 `documentation-system`、检查器和 CI；七个任务合计覆盖全部 68 份 spec，且每份 spec 只有一个主要修改任务。

已知缺陷按真实 coverage 主归属回写：WebBrowser 属于 `tool-framework`，Snip 执行链涉及 `query-core` 与 `runtime-lifecycle`，ReviewArtifact 涉及 `review-analysis`、`file-tools` 和 `permissions`。这样不会把问题错误地放进 `web-tools` 或重复登记文件。

检查器采用表结构检查而非 Markdown 全量解析：项目模板本身要求固定七列，因此逐行解析足够且可预测。优先级证据规则只检查明显的契约违规，不试图用脚本判断架构语义。CI 先运行普通检查，因为所有 spec 仍为 draft；只有未来逐批批准后才能启用 `--require-approved`。

回滚以任务提交为单位：某一领域改写可单独 revert，不影响检查器和其他领域。最终验证若失败，必须先修复再更新 STATUS，不能把旧结果复制成新结果。

## File Structure

- Modify `docs/superpowers/specs/2026-11-12-*-design.md`、`2026-11-13-task-system-design.md`：只归一第 9 章、修正明确的交叉引用和已记录缺陷；不改变其他章节的架构范围。
- Modify `docs/superpowers/specs/2026-11-12-codebase-design-docs-design.md`：记录推荐表校验契约、诊断码、CI 边界，并修正手写 settings re-export 的旧描述。
- Modify `scripts/check-design-docs.ts`：验证第 9 章表头、行结构、工作量和 P0/P1 证据级别。
- Modify `tests/designDocs.test.ts`：提供合法推荐表 fixture，以及非标准表、模糊工作量、无依据高优先级的失败测试。
- Modify `.github/workflows/ci.yml`：显式运行普通设计文档检查。
- Modify `docs/COMMIT_DOCS.md`：将第 9 章和优先级规则设为评审门禁。
- Modify `docs/STATUS.md`：写入本轮实际验证结果和剩余边界。
- Modify `docs/status/external-stubs-audit.md`：明确其为历史审计基线。
- Create `docs/superpowers/plans/2026-11-14-design-docs-consistency.md`：本实施计划。

---

### Task 1: 归一核心执行链的第 9 章

**Files:**
- Modify `docs/superpowers/specs/2026-11-12-query-core-design.md`
- Modify `docs/superpowers/specs/2026-11-12-sdk-query-sessions-design.md`
- Modify `docs/superpowers/specs/2026-11-12-model-api-design.md`
- Test: `tests/designDocs.test.ts` 的真实仓库结构用例（本任务不修改测试）

**Interfaces:**
- Consumes: 三份 spec 的第 1–8 章、`docs/STATUS.md` 的 HISTORY_SNIP 边界、`docs/superpowers/specs/TEMPLATE.md` 第 9 章。
- Produces: 三份使用统一七列表格的第 9 章；`query-core` 新增模型 Snip 路径问题，其他建议不虚构新缺陷。

- [ ] **Step 1: 读取当前建议及其证据**

读取三份 spec 的第 2、4、5、7、8、9 章。保留已有且有证据的建议，将自定义 `P1/P2` 小节、编号列表和散文转换为以下唯一表头：

```markdown
| 优先级 | 触发场景与证据 | 建议方向 | 回归风险 | 验收方式 | 工作量 | 置信度 |
|---|---|---|---|---|---|---|
```

每个任务改写时遵守以下优先级判定，而不是保留旧标签：

```text
已确认安全、数据丢失或核心正确性问题 → P0 或 P1，必须有直接代码/验证证据
高影响可靠性、生命周期、并发或性能问题 → P1，不得仅以“设计推断”结尾
单纯缺少测试、局部可维护性或重复实现 → P2
可选体验、新功能和低收益优化 → P3
```

- [ ] **Step 2: 回写 HISTORY_SNIP 的真实执行链问题**

在 `query-core` 第 9 章加入下面这条建议；`runtime-lifecycle` 的投影职责由 Task 4 处理，不重复建立第二条独立 backlog：

```markdown
| P1 | `docs/STATUS.md` 记录真实 query 在 `snipCompactIfNeeded` 前过滤 `snip_marker`，直接数组和 `/force-snip` 测试不能证明模型触发路径 | 让模型产生的 marker 保留到 snip 执行，再按现有投影边界移除；主修复属于 query 执行链 | 高：可能改变压缩顺序、历史投影和工具配对；需要同时复核 `runtime-lifecycle` | 添加真实 query 路径回归，证明模型 marker 能触发 snip，且 UI scrollback、SDK replay 和磁盘历史语义不变 | M | 待运行验证（先用失败回归复现 STATUS 记录） |
```

将第 8 章的 ``compact``、``context-collapse`` 旧称呼改为带链接的 `context-compaction`：

```markdown
- `src/services/compact/`、`src/services/contextCollapse/` → 见 [Context Compaction](2026-11-12-context-compaction-design.md)；本文只描述 query 调用边界。
```

- [ ] **Step 3: 检查三份文档的表格和链接**

Run:

```bash
rg --files-without-match '^\| 优先级 \| 触发场景与证据 \| 建议方向 \| 回归风险 \| 验收方式 \| 工作量 \| 置信度 \|$' \
  docs/superpowers/specs/2026-11-12-query-core-design.md \
  docs/superpowers/specs/2026-11-12-sdk-query-sessions-design.md \
  docs/superpowers/specs/2026-11-12-model-api-design.md
rg -n 'compact` spec|context-collapse` spec' docs/superpowers/specs/2026-11-12-query-core-design.md || true
bun scripts/check-design-docs.ts
```

Expected: 第一条命令无输出；第二条无旧称呼；文档检查 0 errors，draft warnings 保持 68。

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-11-12-query-core-design.md docs/superpowers/specs/2026-11-12-sdk-query-sessions-design.md docs/superpowers/specs/2026-11-12-model-api-design.md
git commit -m "Normalize core spec recommendations"
```

---

### Task 2: 归一工具与状态子系统的第 9 章

**Files:**
- Modify `docs/superpowers/specs/2026-11-12-buddy-design.md`
- Modify `docs/superpowers/specs/2026-11-12-computer-use-design.md`
- Modify `docs/superpowers/specs/2026-11-12-lsp-design.md`
- Modify `docs/superpowers/specs/2026-11-12-mcp-design.md`
- Modify `docs/superpowers/specs/2026-11-12-tool-framework-design.md`
- Modify `docs/superpowers/specs/2026-11-12-commit-attribution-design.md`
- Modify `docs/superpowers/specs/2026-11-12-git-integration-design.md`
- Modify `docs/superpowers/specs/2026-11-12-session-search-recovery-design.md`
- Modify `docs/superpowers/specs/2026-11-12-sessions-share-design.md`
- Modify `docs/superpowers/specs/2026-11-12-skills-design.md`
- Test: `tests/designDocs.test.ts` 的真实仓库结构用例（本任务不修改测试）

**Interfaces:**
- Consumes: 十份 spec 的证据章节、`docs/STATUS.md` 的 SkillHub/local cache 与 Browser error 边界。
- Produces: 十份统一推荐表；Skills 和 WebBrowser 已知问题进入唯一主 spec。

- [ ] **Step 1: 转换十份第 9 章**

使用 Task 1 的七列表头和优先级规则逐份转换。删除“P0 高优先级/P1 中优先级”等与全局模板冲突的自定义定义。将“无直接测试”统一归入 P2，除非同一行另有直接安全或核心正确性证据。

- [ ] **Step 2: 回写 Skills 已知问题**

在 `skills` 第 9 章保留现有合理建议，并加入：

```markdown
| P1 | `docs/STATUS.md` 记录 canonical `skillPath=destination` 后续被 `dirname()` 误算，旧 load 清理可能删除同 cwd 的新 Promise，空 write-pivot 也可能重复触发 | 统一 canonical base directory，并以 Promise 身份保护缓存清理；空结果按输入信号去重 | 高：路径变化会影响技能加载、权限和遥测；缓存修改会影响并发发现 | 增加 canonical 加载集成、旧/新 load 交错完成、无附件 write-pivot 重复信号测试；三者均不得产生错误路径或重复工作 | M | 待运行验证（STATUS 已记录，先用集成回归复现） |
```

在 `tool-framework` 第 9 章加入：

```markdown
| P1 | `docs/STATUS.md` 记录 `src/tools/WebBrowserTool/WebBrowserTool.ts` 丢弃 MCP `result.isError`，成功导航测试不能证明后端错误可见 | 在 WebBrowser 结果适配层保留 `isError` 和结构化错误内容 | 中：需保持成功结果形状，并区分后端错误与本地异常 | 构造 MCP 成功、`isError=true` 和 transport 异常三种结果，验证工具调用方可见状态及内容均正确 | S | 待运行验证（先补失败适配测试） |
```

- [ ] **Step 3: 检查十份文档**

Run:

```bash
rg --files-without-match '^\| 优先级 \| 触发场景与证据 \| 建议方向 \| 回归风险 \| 验收方式 \| 工作量 \| 置信度 \|$' \
  docs/superpowers/specs/2026-11-12-{buddy,computer-use,lsp,mcp,tool-framework,commit-attribution,git-integration,session-search-recovery,sessions-share,skills}-design.md
bun scripts/check-design-docs.ts
```

Expected: 第一条无输出；检查器 0 errors、68 draft warnings。

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-11-12-{buddy,computer-use,lsp,mcp,tool-framework,commit-attribution,git-integration,session-search-recovery,sessions-share,skills}-design.md
git commit -m "Normalize tool and state spec recommendations"
```

---

### Task 3: 归一 UI 与 Agent 子系统的第 9 章

**Files:**
- Modify `docs/superpowers/specs/2026-11-12-assistant-ui-design.md`
- Modify `docs/superpowers/specs/2026-11-12-commands-framework-design.md`
- Modify `docs/superpowers/specs/2026-11-12-ink-platform-design.md`
- Modify `docs/superpowers/specs/2026-11-12-repl-input-design.md`
- Modify `docs/superpowers/specs/2026-11-12-ui-rendering-design.md`
- Modify `docs/superpowers/specs/2026-11-12-help-feedback-design.md`
- Modify `docs/superpowers/specs/2026-11-12-plan-worktree-design.md`
- Test: `tests/designDocs.test.ts` 的真实仓库结构用例（本任务不修改测试）

**Interfaces:**
- Consumes: 七份 spec 当前第 9 章及第 7 章证据边界。
- Produces: 七份统一推荐表，不引入新的 UI 功能承诺。

- [ ] **Step 1: 转换并重新分级**

逐条保留有代码或验证依据的建议，使用统一七列表格。UI 新功能、视觉改进和可选交互默认 P3；仅在已有直接证据表明核心输入、渲染或状态正确性受损时提升为 P1。测试缺口单独写为 P2，不与功能建议合并成一行。

每行必须能回答：

```text
什么输入或故障触发 → 哪个路径/符号证明 → 修改哪个契约 → 可能破坏什么 → 如何验收 → S/M/L → 证据级别
```

- [ ] **Step 2: 运行文档检查**

```bash
rg --files-without-match '^\| 优先级 \| 触发场景与证据 \| 建议方向 \| 回归风险 \| 验收方式 \| 工作量 \| 置信度 \|$' \
  docs/superpowers/specs/2026-11-12-{assistant-ui,commands-framework,ink-platform,repl-input,ui-rendering,help-feedback,plan-worktree}-design.md
bun scripts/check-design-docs.ts
```

Expected: 第一条无输出；检查器 0 errors。

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-11-12-{assistant-ui,commands-framework,ink-platform,repl-input,ui-rendering,help-feedback,plan-worktree}-design.md
git commit -m "Normalize UI and agent spec recommendations"
```

---

### Task 4: 归一远程与工程子系统的第 9 章

**Files:**
- Modify `docs/superpowers/specs/2026-11-12-daemon-background-design.md`
- Modify `docs/superpowers/specs/2026-11-12-open-runner-design.md`
- Modify `docs/superpowers/specs/2026-11-12-platform-integrations-design.md`
- Modify `docs/superpowers/specs/2026-11-12-teleport-design.md`
- Modify `docs/superpowers/specs/2026-11-12-build-feature-profile-design.md`
- Modify `docs/superpowers/specs/2026-11-12-diagnostics-design.md`
- Modify `docs/superpowers/specs/2026-11-12-external-stubs-design.md`
- Modify `docs/superpowers/specs/2026-11-12-hooks-system-design.md`
- Modify `docs/superpowers/specs/2026-11-12-magic-docs-design.md`
- Modify `docs/superpowers/specs/2026-11-12-messaging-primitives-design.md`
- Modify `docs/superpowers/specs/2026-11-12-network-security-design.md`
- Modify `docs/superpowers/specs/2026-11-12-runtime-lifecycle-design.md`
- Modify `docs/superpowers/specs/2026-11-12-test-validation-design.md`
- Test: `tests/designDocs.test.ts` 的真实仓库结构用例（本任务不修改测试）

**Interfaces:**
- Consumes: 十三份 spec、live-checks 证据边界、STATUS 的 Snip/settings 条目。
- Produces: 十三份统一推荐表；真实环境验证与代码缺陷分开描述。

- [ ] **Step 1: 转换十三份推荐章节**

使用统一七列表格。将“运行 Cloud/桌面/SSH/Open Runner”写成 `待运行验证` 的验收工作，不得写成产品代码必然有缺陷。将私有协议兼容和自托管 SkillHub 保持为可选 P3，不作为当前发布阻塞项。

- [ ] **Step 2: 明确 Snip 和 live-validation 边界**

在 `runtime-lifecycle` 第 9 章加入投影侧验收建议，但注明主修复由 `query-core` 跟踪：

```markdown
| P2 | `src/services/compact/snipProjection.ts` 与 query 执行链共享 marker 边界；STATUS 的模型 Snip 问题由 `query-core` 主跟踪 | 为投影层增加“marker 保留至执行后再投影”的跨层契约测试，不另建一套执行逻辑 | 中：需保护 tool-use/result 配对和幂等边界 | 与 query 回归共同验证 marker 不提前消失、不重复 snip、不切断工具对 | M | 待运行验证（依赖 query-core 主修复） |
```

在 `test-validation` 第 9 章加入：

```markdown
| P1 | `scripts/live-model-validation.ts` 在 `enableConfigs()` 前检查 `process.env.ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN`；STATUS 与 RELEASE 对 settings 直读的表述需要以实际运行统一 | 明确 standalone 脚本的 settings 初始化契约，并集中处理凭据互斥检查 | 中：改变初始化顺序可能改变真实认证来源；不得打印凭据 | 覆盖无凭据、仅 API key、仅 Bearer、两者同时存在四种分支，并分别记录 caller-injected 与 settings-only 的实际结果 | M | 待运行验证（需要隔离 HOME 的 live/matrix 运行） |
```

- [ ] **Step 3: 运行文档检查**

```bash
rg --files-without-match '^\| 优先级 \| 触发场景与证据 \| 建议方向 \| 回归风险 \| 验收方式 \| 工作量 \| 置信度 \|$' \
  docs/superpowers/specs/2026-11-12-{daemon-background,open-runner,platform-integrations,teleport,build-feature-profile,diagnostics,external-stubs,hooks-system,magic-docs,messaging-primitives,network-security,runtime-lifecycle,test-validation}-design.md
bun scripts/check-design-docs.ts
```

Expected: 第一条无输出；检查器 0 errors。

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-11-12-{daemon-background,open-runner,platform-integrations,teleport,build-feature-profile,diagnostics,external-stubs,hooks-system,magic-docs,messaging-primitives,network-security,runtime-lifecycle,test-validation}-design.md
git commit -m "Normalize platform and engineering recommendations"
```

---

### Task 5: 重审其余 34 份建议并回写跨领域缺陷

**Files:**
- Modify `docs/superpowers/specs/2026-11-12-plugins-design.md`
- Modify `docs/superpowers/specs/2026-11-12-sdk-type-generation-design.md`
- Modify `docs/superpowers/specs/2026-11-12-cli-startup-design.md`
- Modify `docs/superpowers/specs/2026-11-12-context-compaction-design.md`
- Modify `docs/superpowers/specs/2026-11-12-attachments-design.md`
- Modify `docs/superpowers/specs/2026-11-12-bridge-design.md`
- Modify `docs/superpowers/specs/2026-11-12-file-tools-design.md`
- Modify `docs/superpowers/specs/2026-11-12-onboarding-ui-design.md`
- Modify `docs/superpowers/specs/2026-11-12-permissions-design.md`
- Modify `docs/superpowers/specs/2026-11-12-session-persistence-design.md`
- Modify `docs/superpowers/specs/2026-11-12-shell-tools-design.md`
- Modify `docs/superpowers/specs/2026-11-12-auth-design.md`
- Modify `docs/superpowers/specs/2026-11-12-memory-design.md`
- Modify `docs/superpowers/specs/2026-11-12-notifications-design.md`
- Modify `docs/superpowers/specs/2026-11-12-settings-design.md`
- Modify `docs/superpowers/specs/2026-11-12-app-state-design.md`
- Modify `docs/superpowers/specs/2026-11-12-cost-tracking-design.md`
- Modify `docs/superpowers/specs/2026-11-12-ide-integration-design.md`
- Modify `docs/superpowers/specs/2026-11-12-text-formatting-design.md`
- Modify `docs/superpowers/specs/2026-11-12-voice-assistant-design.md`
- Modify `docs/superpowers/specs/2026-11-12-workspace-ui-design.md`
- Modify `docs/superpowers/specs/2026-11-12-agent-swarms-design.md`
- Modify `docs/superpowers/specs/2026-11-12-review-analysis-design.md`
- Modify `docs/superpowers/specs/2026-11-12-scheduling-design.md`
- Modify `docs/superpowers/specs/2026-11-13-task-system-design.md`
- Modify `docs/superpowers/specs/2026-11-12-workflow-design.md`
- Modify `docs/superpowers/specs/2026-11-12-deep-link-design.md`
- Modify `docs/superpowers/specs/2026-11-12-remote-control-design.md`
- Modify `docs/superpowers/specs/2026-11-12-ssh-design.md`
- Modify `docs/superpowers/specs/2026-11-12-data-structures-design.md`
- Modify `docs/superpowers/specs/2026-11-12-experimental-features-design.md`
- Modify `docs/superpowers/specs/2026-11-12-native-installer-design.md`
- Modify `docs/superpowers/specs/2026-11-12-telemetry-design.md`
- Modify `docs/superpowers/specs/2026-11-12-web-tools-design.md`
- Test: `tests/designDocs.test.ts` 的真实仓库结构用例（本任务不修改测试）

**Interfaces:**
- Consumes: 34 份已有推荐表、STATUS 的 Workflow/ReviewArtifact/context-collapse 边界、memory 的 symlink 证据。
- Produces: 34 份统一定级的推荐表和明确的跨 spec 主责任；不新增产品实现。

- [ ] **Step 1: 统一全部现有表的七列和优先级**

保留现有事实，但执行以下确定性修正：

```text
“无专门测试/测试缺口大”从 P0/P1 降为 P2，除非同行另有直接安全或核心正确性证据
仅“设计推断”的 P1 降为 P2；可选新功能降为 P3
P0 行必须以“已证实”结尾，并指出直接代码或验证证据
S/M、M/L 等模糊工作量选择实际主导工作量；无法判断时取较大值并缩小建议范围
四列或六列表头全部改为统一七列，不保留第二套“优先级说明”
```

- [ ] **Step 2: 回写 Workflow、ReviewArtifact 和 compaction 缺陷**

在 `workflow` 第 9 章加入：

```markdown
| P1 | `docs/STATUS.md` 记录反向声明依赖的 skip 传播可留下 pending，skip→retry 可接受旧 runner 的迟到结果 | 修复依赖状态传播，并用 execution generation 隔离 retry 前后的 runner 结果 | 高：DAG 顺序、通知和终态持久化均可能受影响 | 参数化不同步骤声明顺序，覆盖 skip 链、skip→retry、旧 runner 晚完成；最终不得有 pending，旧结果不得改变新执行状态 | M | 待运行验证（先加入对抗性 DAG 回归） |
```

在 `review-analysis` 第 9 章加入：

```markdown
| P1 | STATUS 记录 FileRead 自动允许时返回 FileRead 形状的 `updatedInput`，丢失 ReviewArtifact 的 `artifact_path/focus/context`；无路径 persistent allow 还可能覆盖无关读取 | 在权限委托边界恢复原始工具输入，并将持久规则绑定到规范化 artifact 路径 | 高：涉及工具输入契约和文件读取授权范围 | 覆盖 allow、ask、 persistent allow、工作区外路径；执行器必须收到原始字段，后续无关读取不得复用授权 | M | 待运行验证（先通过执行器权限回归复现） |
```

在 `file-tools` 与 `permissions` 第 9 章只增加一条 P2 跨层验收说明，指向 `review-analysis` 为主修复，不重复创建独立实现任务。

在 `context-compaction` 第 9 章加入：

```markdown
| P1 | STATUS 记录正常 `startSpawn` 未先写入 `collapseStore.staged`、默认 summarizer 重复提供 archive、reset-during-persistence 缺少回归；第 4/7 章已有对应状态边界 | 关闭正常执行的 staged 生命周期，去除重复 archive 输入，并定义持久化期间 reset 的完成条件 | 高：影响 prompt-too-long 恢复、摘要内容和跨会话状态 | 覆盖同次运行 overflow、恢复后 overflow、reset 与持久化交错；每类运行必须恰好使用一份 archive，且不能提交 reset 前状态 | M | 待运行验证（live sentinel 不覆盖这些顺序） |
```

保留已有多会话全局状态建议，但 P0 行必须有具体跨会话污染场景和直接源码证据；若当前只有结构风险而没有可复现场景，降为 P1 并以 `待运行验证` 标记。

- [ ] **Step 3: 回写 memory symlink 安全边界并修复交叉引用**

在 `memory` 第 9 章将 symlink 写入问题与“缺少测试”拆成两行。安全行使用 P0/P1 前必须核对 `isTeamMemPath` 与 `validateTeamMemWritePath` 的真实代码；若字符串前缀检查确实可让 symlink 目标逃出 team 根目录，使用：

```markdown
| P0 | `isTeamMemPath` 的字符串前缀检查与 `validateTeamMemWritePath` 的真实路径验证不一致，权限路径可能接受指向 team 根目录外的 symlink | 在权限裁决和实际写入前共享同一 realpath/边界验证，拒绝越界目标 | 中：已有合法 symlink 用法需保留，但不得信任不存在的最终目标路径 | 覆盖目录 symlink、文件 symlink、不存在目标、合法内部链接；所有越界写入均在权限和执行两层被拒绝 | M | 已证实（源码检查；仍需安全回归固定攻击路径） |
```

如果源码复核不支持该攻击路径，不得保留 P0；改写为 P2 的防御一致性建议并说明证据边界。

将 `context-compaction` 中的 `analytics spec` 改为 [Telemetry](2026-11-12-telemetry-design.md) 的调用边界；将 `prompt-cache-break-detection spec` 改为真实源码符号说明，不再引用不存在的 spec。将 `review-analysis` 的 `Agent spec` 改为 [Agent Swarms](2026-11-12-agent-swarms-design.md)，并注明 ReviewArtifact 主设计仍属于本文。

- [ ] **Step 4: 运行全量文档结构检查**

```bash
bun scripts/check-design-docs.ts
rg -n 'analytics spec|prompt-cache-break-detection spec|Agent spec|compact` spec|context-collapse` spec' docs/superpowers/specs/2026-11-1*-design.md || true
```

Expected: 检查器 0 errors；旧 spec 称呼无输出。

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs
git commit -m "Retriage recommendations and record known defects"
```

---

### Task 6: 校验推荐表契约并接入 CI

**Files:**
- Modify `scripts/check-design-docs.ts`
- Modify `tests/designDocs.test.ts`
- Modify `docs/superpowers/specs/2026-11-12-codebase-design-docs-design.md`
- Modify `docs/COMMIT_DOCS.md`
- Modify `.github/workflows/ci.yml`
- Test: `tests/designDocs.test.ts`
- Test: `tests/designDocsCli.test.ts`

**Interfaces:**
- Consumes: 已归一的 68 份第 9 章、现有 `checkSpecDocument()` 和 `Diagnostic`。
- Produces: `RECOMMENDATIONS_TABLE`、`RECOMMENDATION_ROW`、`RECOMMENDATION_EVIDENCE` 三类结构诊断；CI 普通文档检查。

- [ ] **Step 1: 将 fixture 改为合法推荐表并添加失败测试**

把 `specText()` 的第 9 章正文改为：

```markdown
| 优先级 | 触发场景与证据 | 建议方向 | 回归风险 | 验收方式 | 工作量 | 置信度 |
|---|---|---|---|---|---|---|
| P2 | `src/index.ts` 的当前测试边界 | 增加一个边界回归 | 低：仅新增测试 | 新场景通过且原场景不变 | S | 已证实 |
```

在 `tests/designDocs.test.ts` 添加：

```typescript
test('rejects a non-normalized recommendation section', async () => {
  createCompleteFixture()
  put(
    'docs/superpowers/specs/system-design.md',
    specText().replace(
      '| 优先级 | 触发场景与证据 | 建议方向 | 回归风险 | 验收方式 | 工作量 | 置信度 |',
      '| Priority | Evidence | Direction | Risk | Acceptance | Effort | Confidence |',
    ),
  )

  const result = await checkDesignDocs({ cwd, files })
  expect(result.errors.map(issue => issue.code)).toContain('RECOMMENDATIONS_TABLE')
})

test('rejects ambiguous effort and unsupported high-priority evidence', async () => {
  createCompleteFixture()
  put(
    'docs/superpowers/specs/system-design.md',
    specText().replace(
      '| P2 | `src/index.ts` 的当前测试边界 | 增加一个边界回归 | 低：仅新增测试 | 新场景通过且原场景不变 | S | 已证实 |',
      '| P0 | `src/index.ts` 的假设风险 | 改变核心路径 | 高 | 新场景通过 | S/M | 设计推断 |\n| P1 | `src/index.ts` 的推测性能问题 | 增加缓存 | 中 | 基准更快 | M | 设计推断 |',
    ),
  )

  const result = await checkDesignDocs({ cwd, files })
  const codes = result.errors.map(issue => issue.code)
  expect(codes).toContain('RECOMMENDATION_ROW')
  expect(codes.filter(code => code === 'RECOMMENDATION_EVIDENCE')).toHaveLength(2)
})
```

- [ ] **Step 2: 运行测试并确认新规则尚未实现**

```bash
bun test tests/designDocs.test.ts
```

Expected: 两个新测试失败，分别缺少 `RECOMMENDATIONS_TABLE`、`RECOMMENDATION_ROW` 和 `RECOMMENDATION_EVIDENCE`；已有合法 fixture 测试保持通过。

- [ ] **Step 3: 实现最小表结构校验**

在 `checkSpecDocument()` 中调用下面的辅助函数。该函数只解析第 9 章，不影响前八章，也不判断建议的技术价值：

```typescript
const RECOMMENDATION_HEADER =
  '| 优先级 | 触发场景与证据 | 建议方向 | 回归风险 | 验收方式 | 工作量 | 置信度 |'

function checkRecommendations(
  entry: SpecEntry,
  content: string,
  errors: Diagnostic[],
): void {
  const start = content.indexOf('## 9. 改进建议')
  if (start < 0) return
  const body = content.slice(start + '## 9. 改进建议'.length)
  const lines = body.split('\n').map(line => line.trim())
  const rows = lines.filter(line => /^\| P[0-3] \|/.test(line))
  if (!lines.includes(RECOMMENDATION_HEADER) || rows.length === 0) {
    errors.push({
      code: 'RECOMMENDATIONS_TABLE',
      message: `${entry.spec} section 9 requires the normalized seven-column table`,
    })
  }

  for (const row of rows) {
    const cells = row.split('|').slice(1, -1).map(cell => cell.trim())
    if (cells.length !== 7 || !/^[SML]$/.test(cells[5] ?? '')) {
      errors.push({
        code: 'RECOMMENDATION_ROW',
        message: `${entry.spec} has a malformed recommendation row: ${row}`,
      })
      continue
    }
    const [priority, , , , , , confidence] = cells
    const unsupported = priority === 'P0'
      ? !confidence.startsWith('已证实')
      : priority === 'P1'
        ? !/^(已证实|待运行验证)/.test(confidence)
        : false
    if (unsupported) {
      errors.push({
        code: 'RECOMMENDATION_EVIDENCE',
        message: `${entry.spec} has unsupported ${priority} evidence: ${confidence}`,
      })
    }
  }
}
```

在 `checkMarkdownLinks()` 前加入：

```typescript
checkRecommendations(entry, content, errors)
```

- [ ] **Step 4: 更新设计契约与 CI**

在 `documentation-system` spec 的诊断目录、验收和测试证据中记录三个新诊断。将其第 6.4 节旧句“`settingsTypes.generated.ts` 仍是未覆盖文件”改为：

```markdown
- 真实仓库测试要求结构错误为空，并明确断言手写 `settingsTypes.generated.ts` 由 `sdk-type-generation` 主拥有且未被排除。
- 第 9 章必须使用统一七列表；模糊工作量、P0 无已证实证据、P1 仅设计推断均为结构错误。
```

将 `documentation-system` 自身第 9 章也转换为统一七列表，并加入“自动表检查不能判断技术语义”的 P2 人工复审建议。

在 `docs/COMMIT_DOCS.md` 的回溯性档案规则中追加：P0 必须已证实，P1 不得仅有设计推断，工作量只取 S/M/L，实际运行结果仍只进入 STATUS。

在 `.github/workflows/ci.yml` 的 Generate SDK types 之后加入：

```yaml
      - name: Check design docs
        run: bun scripts/check-design-docs.ts
```

- [ ] **Step 5: 运行聚焦测试和真实仓库检查**

```bash
bun test tests/designDocs.test.ts tests/designDocsCli.test.ts
bun scripts/check-design-docs.ts
git diff --check
```

Expected: 聚焦测试全部通过；真实仓库 0 errors、68 draft warnings；无 whitespace 错误。

- [ ] **Step 6: Commit**

```bash
git add scripts/check-design-docs.ts tests/designDocs.test.ts docs/superpowers/specs/2026-11-12-codebase-design-docs-design.md docs/COMMIT_DOCS.md .github/workflows/ci.yml
git commit -m "Enforce normalized design recommendations"
```

---

### Task 7: 刷新当前状态并完成全量验证

**Files:**
- Modify `docs/STATUS.md`
- Modify `docs/status/external-stubs-audit.md`
- Test: `tests/designDocsModel.test.ts`
- Test: `tests/designDocsOwnership.test.ts`
- Test: `tests/designDocs.test.ts`
- Test: `tests/designDocsCli.test.ts`

**Interfaces:**
- Consumes: 前六个任务提交、当前工作树的实际命令输出、既有 live 证据边界。
- Produces: 当前 STATUS、明确的历史审计说明、可复核的最终验证记录。

- [ ] **Step 1: 运行聚焦文档测试和全量验证**

```bash
bun test tests/designDocsModel.test.ts tests/designDocsOwnership.test.ts tests/designDocs.test.ts tests/designDocsCli.test.ts
bun run typecheck
bun run build
bun run test
bun scripts/check-design-docs.ts
git diff --check
```

Expected: 所有命令退出 0；测试 0 failures；普通文档检查 0 errors、68 draft warnings。若任一命令失败，本任务不得标记完成，STATUS 不得写成 Passed。

- [ ] **Step 2: 验证严格模式只剩未批准状态**

```bash
bun -e 'import { checkDesignDocs } from "./scripts/check-design-docs.ts"; const result = await checkDesignDocs({ cwd: process.cwd(), requireApproved: true }); const other = result.errors.filter(issue => issue.code !== "DRAFT_SPEC"); const drafts = result.errors.filter(issue => issue.code === "DRAFT_SPEC"); console.log(JSON.stringify({ draftErrors: drafts.length, otherErrors: other }, null, 2)); if (drafts.length !== 68 || other.length !== 0) process.exit(1)'
```

Expected: `draftErrors: 68`、`otherErrors: []`，命令退出 0。不要直接执行严格 CLI 并将其预期退出 1 写成产品测试失败。

- [ ] **Step 3: 更新 STATUS 和历史边界**

将 `docs/STATUS.md` 的日期更新为实际执行日期，并把当前验证表中的本地基线更新为本任务真实结果。测试行使用以下不含伪造断言总数的格式：

```markdown
| `bun run test` | Passed: all 97 discovered test files completed with zero failures; offline/mock evidence does not promote live-only capabilities |
| `bun run typecheck` | Passed on the documentation-consistency branch with zero TypeScript errors |
| `bun run build` | Passed for CLI, SDK, and declaration artifacts |
| Design docs structural check | Passed with 0 errors; 68 specs remain draft and await human approval |
```

若测试发现数量在任务执行时已变化，以 `scripts/test.ts` 的实际发现数量替换 97，不保留旧数字。

重写 STATUS 的剩余工作顺序，使 Workflow、Snip、ReviewArtifact、compaction、Skills、WebBrowser、memory symlink 和 live-validation settings 均有明确条目。对 settings 只记录本轮源码可证实行为和实际运行范围：如果未执行 settings-only live matrix，必须保留 `Implemented, unverified`，不得照抄 RELEASE 的旧成功描述作为本轮证据。

在 `docs/status/external-stubs-audit.md` 标题下增加：

```markdown
> 历史审计基线：本文中的“当前行为”指 2026-11-11 审计时的源码状态；后续公开实现和验证结果以 `../external-stubs/verification.md` 及 `../STATUS.md` 为准，不将本表逐行视为当前实现清单。
```

`docs/RELEASE.md` 不重写历史；本任务没有实际发布，不新增发布成功声明。

- [ ] **Step 4: 复核最终 diff 和状态**

```bash
git diff --check
git diff --name-only origin/main..HEAD
git status --short --branch
```

Expected: 没有 `src/` 产品实现路径；变更仅包含计划允许的文件；提交后工作区干净。

- [ ] **Step 5: Commit**

```bash
git add docs/STATUS.md docs/status/external-stubs-audit.md
git commit -m "Refresh design documentation verification status"
```
