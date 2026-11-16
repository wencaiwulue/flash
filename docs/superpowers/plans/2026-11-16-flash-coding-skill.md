# flash-coding 工程 skill 与 CLAUDE.md 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 创建根 `CLAUDE.md`（7 条硬规则总纲）与 `.claude/skills/flash-coding/SKILL.md`（五板块工程注意事项），事实核对后入库。

**Architecture:** 文档型任务，无运行时代码。顺序：事实核对（每条将写入 skill 的命令/路径/行为实测或 grep）→ 写 CLAUDE.md → 写 SKILL.md → 入库与触发验证说明。内容以 spec §4.1/§4.3 为准，本计划给出逐字全文。

**Tech Stack:** Markdown、bash 实测核对、git。

## Global Constraints

来自已批准规格 `docs/superpowers/specs/2026-11-15-flash-coding-skill-design.md`：

- CLAUDE.md ≤20 行，内容逐字用 Task 2 的草案（spec §4.1）。
- SKILL.md frontmatter 的 name/description 逐字用 Task 3 的草案（spec §4.2）。
- SKILL.md 每条规则须有证据锚点（导出名/路径/命令/spec 引用；行号仅辅助）。
- 事实核对未通过的条目必须修正或删除，不得带错误事实入库。
- 文件新建：`.claude/skills/flash-coding/` 当前不存在。
- 提交信息以 `Co-Authored-By: Claude <noreply@anthropic.com>` 结尾。
- 工作分支：`flash-coding-skill`（从 main 新建）。
- 不修改 `src/skills/**`（产品运行时 skill 系统）与任何源码。

## 实施理由与步骤依据

顺序依据：先事实核对（Task 1）——skill 的价值在于事实准确，核对未通过的条目需要在动笔前修正措辞（如路径漂移、行为变化）；然后写 CLAUDE.md（Task 2，短、独立）；再写 SKILL.md（Task 3，Task 1 的核对结果决定个别措辞）；最后入库（Task 4）。触发验证依赖新会话的 Claude Code 运行时行为，无法在本任务链内自动化，作为入库后的人工验收步骤记录在 Task 4。

## File Structure

- Create: `CLAUDE.md`（根）——硬规则总纲
- Create: `.claude/skills/flash-coding/SKILL.md`——五板块详注
- 事实核对记录：写入 `.superpowers/sdd/flash-skill-facts.md`（git-ignored 草稿，不入库）

---

### Task 1: 事实核对

**Files:**
- Create: `.superpowers/sdd/flash-skill-facts.md`（草稿，不入库）

**Interfaces:**
- Consumes: 无。
- Produces: 每条核对项的实测结果记录；Task 2/3 依据它修正措辞。

- [ ] **Step 1: 逐条核对并记录**

执行以下命令，将每条结果（通过/偏差及实际值）写入 `.superpowers/sdd/flash-skill-facts.md`：

```bash
# 1. 命令集（package.json scripts）
grep -n '"build"\|"typecheck"\|"test"\|"build:binary"' package.json
# 2. 测试运行器逐文件语义
sed -n '14,46p' scripts/test.ts
# 3. 测试输出末尾只是最后一个文件统计（运行一个小文件验证 tail 行为）
bun test tests/claudeInChromeWiring.test.ts 2>&1 | tail -3
# 4. coverage manifest 校验脚本与路径
grep -n "MANIFEST_PATH\|ROOTS" scripts/check-design-docs.ts | head -3
# 5. 发布命名单点
sed -n '70,82p' scripts/build-binary.ts
# 6. install.sh BINARY_NAME 联动
grep -n "BINARY_NAME" scripts/install.sh | head -2
# 7. 命名排除清单文件存在性
ls src/tools/AgentTool/built-in/claudeCodeGuideAgent.ts src/constants/github-app.ts src/constants/oauth.ts
ls src/types/generated/events_mono/claude_code/ | head -2
# 8. 归属句
sed -n '5p' README.md; sed -n '5p' README.zh-CN.md
# 9. 双语文件对
ls docs/RELEASING.md; grep -c "flash" README.zh-CN.md
# 10. external-stubs 契约文档
ls docs/external-stubs/contracts/
# 11. 上游二进制定位方式
which claude; ls /opt/homebrew/Caskroom/claude-code/ 2>/dev/null | tail -1
# 12. isInBundledMode 判定逻辑
sed -n '17,30p' src/utils/bundledMode.ts
# 13. 权威 spec 存在
ls docs/superpowers/specs/2026-11-14-flash-rename-design.md docs/superpowers/specs/2026-11-15-chrome-bundled-wiring-design.md
```

Expected: 全部命中预期值。任何偏差（文件移动、行为变化、版本差异）记入事实记录并据此修正 Task 2/3 措辞。

- [ ] **Step 2: 汇总结论**

在事实记录末尾写一段"措辞修正清单"（无修正则写"无偏差"）。Task 3 的 SKILL.md 内容以下列基准为准：偏差条目用实测值替换本计划中的对应文本。

---

### Task 2: 创建根 CLAUDE.md

**Files:**
- Create: `CLAUDE.md`

**Interfaces:**
- Consumes: Task 1 的事实核对结论。
- Produces: 根 `CLAUDE.md`，内容与 spec §4.1 逐字一致（除非 Task 1 发现偏差）。

- [ ] **Step 1: 写入文件**

创建 `CLAUDE.md`，内容逐字如下：

````markdown
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
````

- [ ] **Step 2: 核对行数**

Run: `wc -l CLAUDE.md`
Expected: ≤20 行。

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "Add root CLAUDE.md with hard rules for flash engineering

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: 创建 flash-coding SKILL.md

**Files:**
- Create: `.claude/skills/flash-coding/SKILL.md`

**Interfaces:**
- Consumes: Task 1 事实核对结论（措辞修正基准）。
- Produces: 五板块工程 skill；Task 4 的触发验证依赖其 frontmatter description。

- [ ] **Step 1: 写入文件**

创建 `.claude/skills/flash-coding/SKILL.md`（`mkdir -p .claude/skills/flash-coding`），内容逐字如下（Task 1 有偏差时按实测修正对应行）：

````markdown
---
name: flash-coding
description: 在 flash 仓库（Claude Code 教学快照）写代码、写测试、改文档或发版前使用。涵盖产品命名排除清单、构建/测试命令与 bun 环境陷阱、bundled 与 external-stubs 架构约束、文档与发布流程、上游 Claude Code 行为对齐工作流。
---

# flash 工程注意事项

给在本仓库工作的 agent 的工程惯例。每条规则带证据锚点；行号是辅助定位，以导出名/路径/命令为准。

## 1. 产品命名（flash vs Claude Code）

本仓库产品名是 **flash**（小写），是 Claude Code 的教学/研究快照。命名遵循
`docs/superpowers/specs/2026-11-14-flash-rename-design.md` 第 4 节，要点：

- 替换规则：产品指称 `Claude Code` → `flash`；二进制/归档/命令名 `claude-code` → `flash`
  （仅限产物命名链与文档示例）；`claude_code`/`ClaudeCode`/`claudeCode` 标识符默认保留。
- **绝不替换**（排除清单）：
  - `src/tools/AgentTool/built-in/claudeCodeGuideAgent.ts`（讲解真实 Claude Code 的 agent）
  - `src/types/generated/**`（生成的上游 schema）
  - `src/constants/github-app.ts`（引用真实 anthropics/claude-code-action 的工作流模板）
  - `src/constants/oauth.ts`（协议常量）
  - `CLAUDECODE=1` / `<claude-code-hint />` 协议字面量与注释
  - 小写外部标识符：`com.anthropic.claude-code-url-handler`、`claude-code-keybindings.json`、
    `claude-code-github-action`、`anthropics/claude-code`、`claude-code-action`、
    `claude-code-plugins`、`#claude-code-feedback`、`platform.claude.com/…app=claude-code`
  - `docs/RELEASE.md` 中的 legacy 仓库 URL
- 归属句保护：`README.md:5` "Educational/research snapshot built on Claude Code: …" 与
  `README.zh-CN.md:5` "基于 Claude Code 的教学/研究快照：…" 中的 Claude Code 必须保留。
- 完成标准：全仓 `grep -rn "Claude Code\|claude-code" src scripts docs` 的残留必须能逐条
  归入排除清单或归属句。

## 2. 构建测试与环境陷阱

命令（`package.json` scripts）：

- `bun install --frozen-lockfile`
- `bun run build`（= `bun scripts/build.ts` + `build:types`）
- `bun run typecheck`
- `bun run test`
- `bun run build:binary`（独立二进制，默认输出 `build/release/`）

**测试运行器语义**（`scripts/test.ts`）：对每个测试文件起**独立 bun 进程顺序执行**。
输出里的 "N pass / 0 fail" 只是**最后一个文件**的统计——判定标准是**退出码 0 且无
"Failed test files" 输出**，不要只看 tail 的 pass 数。

环境陷阱：

- 沙箱内 `tests/openBackends.test.ts` 可能因进程组 `kill` 报 `EPERM`——环境性失败，非代码缺陷。
- 无 TTY 时 CLI 走非交互分支（"Input must be provided either through stdin…"）。验证交互行为
  用 `script -q /dev/null <命令>` 分配伪终端，后台跑 + sleep + 按 PID kill。
- bun `child_process.spawn` 的 `cwd` 指向 `/$bunfs/...` 会 `ENOENT posix_spawn`（虚拟文件系统
  对真实子进程不可见）；即使 cwd 有效，独立二进制也无法为子进程解析 node_modules。
- Bun 的 ws 模拟无法完成 Playwright 的 CDP 握手（`src/external-stubs/claude-for-chrome-mcp.ts`
  为此维护 Node sidecar）。
- macOS `sed -i ''`（BSD sed）。
- `CLAUDE_CODE_DEBUG_LOGS_DIR` 期望**文件路径**而非目录（传目录会 EISDIR 崩溃）。

## 3. 架构约束与 external-stubs

- **双运行形态**：`isInBundledMode()`（`src/utils/bundledMode.ts`：`Bun.main` 以 `/$bunfs/`
  开头或有 embeddedFiles）vs 源码 `bun` 运行。两形态行为可能分叉，新代码要考虑
  （先例：`main.tsx` chrome 接线段的前置分流 `chromeWiringBundledAction`）。
- **external-stubs**：外部构建用 `src/external-stubs/` 替换私有 `@ant/*` 包。改 stub 前
  必读 `docs/external-stubs/contracts/*.md` 契约；不得声称与私有协议（native messaging、
  bridge、扩展配对）兼容。
- **设计文档校验**：功能子系统的 spec 需登记 `docs/architecture/coverage/manifest.yaml`
  并通过 `bun scripts/check-design-docs.ts`；工程改造类（改名、工具链、本 skill 等）
  不登记不校验。

## 4. 文档与发布流程

- 设计文档：`docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md` 与
  `docs/superpowers/plans/YYYY-MM-DD-<topic>.md`；中文；frontmatter
  （id/batch/title/date/status）；决策表带"证据"列；参照既有文件的章节结构。
- **双语成对**：`README.md` ↔ `README.zh-CN.md`；docs 内双语文件（如 `RELEASING.md`）
  改一处必须同步另一处。
- **发布命名单点**：`scripts/build-binary.ts` 的 `getBinaryName`/`getArchiveName` 决定
  二进制与归档名（`flash` / `flash.exe` / `flash-vX.Y.Z-<platform>-<arch>.<ext>`）；
  `scripts/install.sh` 的 `BINARY_NAME` 与 `tests/releasePackaging.test.ts` 断言联动。
  改命名必须**同一提交**同步全部引用（先改测试为失败再改实现，TDD）。
- 发布流程：推送 `vX.Y.Z` tag → `.github/workflows/release.yml` 构建六平台产物并发布；
  流程权威是 `docs/RELEASING.md`（双语）。

## 5. 上游对齐工作流（先对齐，再设计）

对 Claude Code 上游行为做任何设计/修改前，按顺序收集三层证据：

1. **官方文档**：`https://code.claude.com/docs/`（抓取入口 `llms.txt` 索引找相关页）。
2. **上游二进制实测**：本机已装时 `which claude` 定位（macOS Homebrew 形如
   `/opt/homebrew/Caskroom/claude-code/<version>/claude`），用 `strings` 提取关键路径的
   逻辑片段。二进制证据优先于文档——文档可能滞后（反例：chrome 修复中文档暗示上游
   "keeps integration off"，二进制显示 setup 失败仍硬退出，真正的护栏是 setup 前的前置分流）。
3. **本仓库契约**：`docs/external-stubs/contracts/*.md` 与既有 spec。

要求：证据写入 spec 决策表的"证据"列；上游语义优先于本仓库现状（快照定位），
除非契约文档明确声明偏离。
````

- [ ] **Step 2: 核对结构**

Run: `wc -l .claude/skills/flash-coding/SKILL.md && grep -c "^## " .claude/skills/flash-coding/SKILL.md`
Expected: 200-300 行区间（±50）；`## ` 计数为 5（五个板块，标题是 h1 不计入）。

Run: `head -4 .claude/skills/flash-coding/SKILL.md`
Expected: frontmatter 完整（`---` 包裹，name: flash-coding）。

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/flash-coding/SKILL.md
git commit -m "Add flash-coding engineering skill

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: 入库确认与触发验收

**Files:**
- 无代码修改

**Interfaces:**
- Consumes: Task 2/3 的提交。
- Produces: 入库确认 + 人工验收说明。

- [ ] **Step 1: 确认两文件已入库**

Run: `git log --oneline -3 && git status --short | head -5`
Expected: 两个内容提交在列；工作区无 `CLAUDE.md`/`.claude/skills` 残留未跟踪项。

- [ ] **Step 2: 记录人工验收项**

触发验证（自动加载 CLAUDE.md、按 description 触发 skill）依赖新会话的 Claude Code
运行时，无法在本任务链内完成。在 `.superpowers/sdd/flash-skill-facts.md` 末尾追加：
"待人工验收：新会话输入编码任务，确认 CLAUDE.md 生效、flash-coding skill 被触发"。

Run: `cat .superpowers/sdd/flash-skill-facts.md | tail -3`
Expected: 含待验收记录。

- [ ] **Step 3: 无额外提交**

本任务不产生代码提交；若 Step 1 发现文件遗漏，回到 Task 2/3 补交。
