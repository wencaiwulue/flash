---
id: flash-coding-skill
batch: 4
title: flash-coding 工程 skill 与根 CLAUDE.md 总纲设计
date: 2026-11-15
status: draft
---

# flash-coding 工程 skill 与根 CLAUDE.md 总纲设计

## 1. 问题与约束

仓库当前没有任何面向 agent 的工程指导：无根 `CLAUDE.md`、无 `.claude/skills/`。每个会话都要重新踩坑——本次会话积累的可沉淀知识包括：flash 改名的命名排除清单、测试运行器逐文件执行的语义、bundled 与源码两种运行形态的陷阱（`$bunfs` cwd、Bun ws 限制）、external-stubs 契约、发布命名单点、以及"先对齐上游 Claude Code 行为再设计"的方法论。

约束：
- 载体：根 `CLAUDE.md` 自动加载但应极短（硬规则 + 指路）；详细内容放 `.claude/skills/flash-coding/SKILL.md` 按需调用（用户已确认此组合）。
- 内容范围（用户确认）：产品命名规则、构建测试与陷阱、架构约束与 stubs、文档与发布流程、上游对齐工作流。
- 结构：单一 skill（用户已确认方案 A），五板块一文件。
- 事实准确性是硬约束：skill 中每条命令/路径/行为必须经仓库实测或 grep 验证，不得凭记忆书写。

## 2. 设计理由与备选方案

| 决策 | 实际机制 | 为什么采用 | 备选方案及不采用原因 | 代价 | 证据 |
|---|---|---|---|---|---|
| CLAUDE.md + skill 配合 | 硬规则自动加载；详注按需调用 | 关键不变量（命名排除清单）不能依赖 agent 记得调用 skill；同时避免 200-300 行常驻上下文 | 仅 CLAUDE.md（常驻开销大）、仅 skill（硬规则可能被漏调） | 维护两个文件的一致性 | 本次会话中命名规则若不在会话上下文就会误改 claudeCodeGuideAgent |
| 单一 skill 五板块 | 一个 `SKILL.md`，description 声明触发场景 | 板块间交叉引用密集（命名规则与所有板块交叉）；单入口好维护 | 五个小 skill（维护成本高、易漏调）、两层 references 惰性加载（对几百行内容过度设计） | 调用时全量载入 | 板块内容清单见第 4 节 |
| 每条规则带证据锚点 | file:line、命令实测输出、上游证据 | 本会话教训：凭文档误判上游行为（chrome 硬退出），后经二进制证据修正 | 无锚点的经验陈述（不可验证、会腐烂） | 定稿前核对工时 | `docs/superpowers/specs/2026-11-15-chrome-bundled-wiring-design.md` 第 2 节 |
| 两者提交进 git | `CLAUDE.md` 与 `.claude/skills/` 入库 | 团队/CI/未来会话共享同一套指导；`.claude/` 当前不存在，全新创建无迁移 | 本地不入库（指导漂移） | 无 | `.gitignore` 未排除 `.claude/` |

## 3. 目标与非目标

### 目标
- 根 `CLAUDE.md`：约 15 行，7 条硬规则 + skill 指路。
- `.claude/skills/flash-coding/SKILL.md`：五板块，每条规则带证据锚点，200-300 行。
- 两者提交进 git。
- 定稿前完成事实核对（每条命令/路径实测）与触发验证。

### 非目标
- 不迁移现有 `src/skills/`（那是产品运行时的 skill 系统，与 agent 工程 skill 无关）。
- 不生成 `AGENTS.md`/`GEMINI.md` 等其他工具的指导文件（YAGNI，需要时再从 skill 派生）。
- 不做 skill 的自动化测试（内容是文档，验收靠事实核对与触发实测）。

## 4. 设计明细

### 4.1 根 `CLAUDE.md`（全文草案）

```markdown
# CLAUDE.md

flash：Claude Code 的教学/研究快照（Bun + React/Ink 的 agentic CLI 与 Agent SDK）。

## 硬性规则

1. 产品名是 flash。源码/文档中 `Claude Code`、`claude-code` 字样按命名排除清单处理
   （claudeCodeGuideAgent、generated/**、github-app.ts、oauth.ts、CLAUDECODE 协议、
   小写外部标识符不改；README 归属句保留）→ 详见 flash-coding skill。
2. 测试：`bun run test`（scripts/test.ts 逐文件顺序执行，以退出码判断，勿只看 tail）。
   构建：`bun run build`；类型：`bun run typecheck`。
3. 行为或设计变更前，先用三层证据对齐上游 Claude Code（官方文档 → 本机上游二进制
   strings → 本仓库 external-stubs 契约），证据写入 spec 决策表 → 方法见 flash-coding skill。
4. 功能子系统的设计文档需登记 `docs/architecture/coverage/manifest.yaml` 并通过
   `bun scripts/check-design-docs.ts`；工程改造类不需要。
5. 设计文档：`docs/superpowers/specs|plans/YYYY-MM-DD-<topic>.md`，中文 + 决策表带证据。
6. README 与 docs 改动必须双语成对提交。
7. 提交信息以 `Co-Authored-By: Claude <noreply@anthropic.com>` 结尾。

其余工程惯例（bundled 形态、stubs 契约、发布命名单点、环境陷阱）：
调用 flash-coding skill。
```

### 4.2 `SKILL.md` frontmatter

```yaml
---
name: flash-coding
description: 在 flash 仓库（Claude Code 教学快照）写代码、写测试、改文档或发版前使用。涵盖产品命名排除清单、构建/测试命令与 bun 环境陷阱、bundled 与 external-stubs 架构约束、文档与发布流程、上游 Claude Code 行为对齐工作流。
---
```

### 4.3 SKILL.md 五板块内容要点

**板块 1：产品命名（flash vs Claude Code）**
- 三条替换规则（产品指称→flash；二进制/归档/命令名→flash 仅限产物链与文档；`claude_code` 等标识符默认保留）。
- 排除清单逐条：`src/tools/AgentTool/built-in/claudeCodeGuideAgent.ts`、`src/types/generated/**`、`src/constants/github-app.ts`、`src/constants/oauth.ts`、`CLAUDECODE=1`/`claude-code-hint` 协议、小写外部标识符全集（`com.anthropic.claude-code-url-handler`、`claude-code-keybindings.json` 等）、`docs/RELEASE.md:33` legacy URL。
- 归属句保护：`README.md:5` "built on Claude Code"、`README.zh-CN.md:5` "基于 Claude Code"。
- 完成标准：全仓 grep 残留逐条归入排除清单。权威依据：`docs/superpowers/specs/2026-11-14-flash-rename-design.md` 第 4 节。

**板块 2：构建测试与环境陷阱**
- 命令：`bun install --frozen-lockfile`；`bun run build`（= `scripts/build.ts` + `build:types`）；`bun run typecheck`；`bun run test`。
- 测试运行器语义：`scripts/test.ts` 对每个测试文件起独立 bun 进程顺序执行；输出中 "N pass" 只是最后一个文件的统计；判定标准 = 退出码 0 且无 "Failed test files" 输出。
- 陷阱：沙箱下 `tests/openBackends.test.ts` 进程组 kill 报 EPERM（环境性，非代码缺陷）；无 TTY 时 CLI 走非交互分支，交互行为验证用 `script -q /dev/null <cmd>`；bun spawn 的 cwd 指向 `/$bunfs/...` 会 ENOENT；Bun 的 ws 模拟无法完成 Playwright CDP 握手；macOS `sed -i ''`；`CLAUDE_CODE_DEBUG_LOGS_DIR` 期望文件路径而非目录。

**板块 3：架构约束与 external-stubs**
- 双运行形态：`isInBundledMode()`（`Bun.main` 以 `/$bunfs/` 开头）vs 源码 `bun`；新代码须考虑两形态行为分叉（先例：chrome 接线前置分流）。
- external-stubs 替换私有 `@ant/*` 包；改 stub 前必读 `docs/external-stubs/contracts/*.md`；不得声称与私有扩展协议（native messaging、bridge、配对）兼容。
- 功能子系统的 spec 登记 `docs/architecture/coverage/manifest.yaml` 并跑 `bun scripts/check-design-docs.ts`；工程改造类（改名、skill 等）不登记。

**板块 4：文档与发布流程**
- spec/plan 约定：路径、中文、frontmatter（id/batch/title/date/status）、决策表带证据列、章节 1-9 结构（参照既有文件）。
- 双语成对：`README.md`/`README.zh-CN.md` 与 docs 内双语文件同步修改。
- 发布命名单点：`scripts/build-binary.ts` 的 `getBinaryName`/`getArchiveName`；联动 `scripts/install.sh` 的 `BINARY_NAME` 与 `tests/releasePackaging.test.ts` 断言；命名变更必须同一提交同步全部引用。
- 发布流程：打 `vX.Y.Z` tag → `.github/workflows/release.yml`；流程权威 `docs/RELEASING.md`。

**板块 5：上游对齐工作流**
- 设计行为变更前的三层证据：① 官方文档 `code.claude.com/docs`（入口 `llms.txt` 索引）；② 上游二进制实测（本机已装时用 `which claude` 定位，macOS Homebrew 路径形如 `/opt/homebrew/Caskroom/claude-code/<version>/claude`；`strings` 提取关键路径逻辑）；③ 本仓库契约文档。
- 证据写入 spec 决策表"证据"列；上游语义优先于本仓库现状，除非契约文档明确声明偏离。
- 文档与二进制冲突时以二进制为准。反例警示：chrome 修复中曾凭文档误判"上游不硬退出"。

### 4.4 验收方式

1. **事实核对**：定稿前逐条验证——命令实测（`bun run test` tail 语义）、路径 grep（coverage manifest、契约文档、上游二进制路径存在性）、行为锚点抽查（file:line 仍然准确）。
2. **触发验证**：新会话中输入与本仓库相关的编码任务，确认 description 命中自动触发。
3. **提交**：`CLAUDE.md` + `.claude/skills/flash-coding/SKILL.md` 一次提交入库。

## 5. 失败语义与风险

| 风险 | 场景 | 缓解 |
|---|---|---|
| 规则腐烂 | 代码演进后锚点失效（file:line 漂移） | 锚点尽量指向稳定标识（导出名、路径、命令）而非行号；行号仅作辅助 |
| 触发失灵 | description 太窄导致该调不调 | description 覆盖"写代码/测试/文档/发版"四场景；定稿后实测一次 |
| 与未来改名/重构冲突 | skill 内容与仓库演进脱节 | 上游对齐工作流本身就是仓库纪律；skill 修订走普通 PR |

## 6. 现状验收标准

1. `CLAUDE.md` 存在且 ≤20 行，含 7 条硬规则。
2. `.claude/skills/flash-coding/SKILL.md` 存在，五板块齐全，每板块至少 3 条带证据锚点的规则。
3. 事实核对清单（4.4 第 1 条）全部通过并有记录。
4. 触发验证通过（4.4 第 2 条）。
5. 两者已提交入库。

## 7. 代码与测试证据

- 无 CLAUDE.md / `.claude/skills/`：`ls` 确认（2026-11-15）。
- 测试运行器语义：`scripts/test.ts:14-46`（逐文件 Bun.spawn 顺序执行、失败汇总输出）。
- coverage manifest 校验：`scripts/check-design-docs.ts:5-7`（ROOTS/MANIFEST_PATH）。
- 发布命名单点：`scripts/build-binary.ts:70-82`。
- 上游对齐方法论案例：`docs/superpowers/specs/2026-11-15-chrome-bundled-wiring-design.md` 第 2、7 节。
- 命名规则权威：`docs/superpowers/specs/2026-11-14-flash-rename-design.md` 第 4 节。

### 未覆盖测试
- skill 内容无自动化测试；腐烂防护依赖锚点稳定性与人工修订。
- 触发验证依赖 Claude Code 运行时行为，无法在本仓库测试框架内自动化。
