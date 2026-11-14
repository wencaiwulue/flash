# flash 产品更名实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将对外产品名从 "Claude Code" 统一更名为 flash：README（双语）、CLI 用户可见字符串、Agent/工具提示词、二进制与归档产物名、安装脚本、发布文档。

**Architecture:** 纯文本替换型变更，无运行时抽象。按依赖顺序分四步：产物命名链（含 TDD 测试先行）→ 源码字符串与提示词（机械替换 + 人工改写）→ README 与发布文档 → 客观验收（全仓 grep 残留仅剩排除清单）。

**Tech Stack:** Bun 1.3+、TypeScript、`bun test`（`bun run test` → `scripts/test.ts`）、POSIX sh（install.sh）、GitHub Actions（无需改动）。

## Global Constraints

以下约束来自已批准的设计规格 `docs/superpowers/specs/2026-11-14-flash-rename-design.md`，每个任务隐式继承：

- 产品名统一为 **flash**（小写 f），标题 `# flash`。
- 归属表述保留：README 首行为 "Educational/research snapshot built on Claude Code: …"（中文：`基于 Claude Code 的教学/研究快照：…`）。
- 归档命名：`flash-vX.Y.Z-<platform>-<arch>.<ext>`；二进制名：`flash` / `flash.exe`。
- `package.json`：`"name": "flash"`，`"bin": { "flash": "dist/main.js" }`。
- **绝不替换**（排除清单，全文有效）：
  - `src/tools/AgentTool/built-in/claudeCodeGuideAgent.ts`（讲解真实 Claude Code）
  - `src/types/generated/**`（生成代码）
  - `src/constants/github-app.ts`（真实 claude-code-action 模板）
  - `src/constants/oauth.ts`（协议常量）
  - `CLAUDECODE=1` 协议字面量与注释（`src/tools/BashTool/BashTool.tsx:1038-1039`、`src/tools/PowerShellTool/PowerShellTool.tsx:745-746`）
  - 上游历史注释：`src/global.d.ts:12`、`src/setup.ts:422`、`src/history.ts:412`
  - 小写外部标识符：`claude-code-hint`、`com.anthropic.claude-code-url-handler`、`claude-code-keybindings.json`、`claude-code-github-action`、`anthropics/claude-code`、`claude-code-action`、`claude-code-plugins`、`#claude-code-feedback`、`platform.claude.com/…app=claude-code`（`src/main.tsx:820,965`、`src/keybindings/template.ts:46`、`src/constants/prompts.ts:244,436`）
- 小写 `claude-code` 的替换**仅限** `scripts/build-binary.ts`、`scripts/install.sh`、`package.json`、README、`docs/RELEASING.md`、`docs/RELEASE.md`；`src/` 内不做小写替换。
- 自称 "Anthropic's official CLI for Claude" 的句子须删改该短语（flash 不是官方 CLI）。
- macOS 环境：`sed -i ''`（BSD sed）。所有提交信息以 `Co-Authored-By: Claude <noreply@anthropic.com>` 结尾。

## 实施理由与步骤依据

依赖顺序依据规格第 6 节：先改产物命名链并同步打包测试（任务 1，TDD：先改断言看失败，再改实现），因为 `tests/releasePackaging.test.ts` 直接断言 `getBinaryName`/`getArchiveName` 的输出与 README 标题，命名链是其余任务的锚点；随后做源码字符串与提示词（任务 2，变更面最大，独立提交便于 diff 审查与回滚）；README 与发布文档最后（任务 3），因为它们描述任务 1-2 的结果，且打包测试会校验 README 标题；最后任务 4 执行规格第 8 节的客观验收标准。任何一步可独立 `git revert`。

## File Structure

- Modify: `tests/releasePackaging.test.ts` — 断言产物名与 README 标题
- Modify: `scripts/build-binary.ts` — 产物/归档命名单点（`:71-72,81`）、测试隔离目录前缀（`:284`）
- Modify: `scripts/install.sh` — `BINARY_NAME`（`:5`）、临时目录前缀（`:95,131`）、消息（`:124,126,137`）
- Modify: `package.json` — name/bin/description（`:2,5,8`）
- Modify: `src/**`（约 214 个含 "Claude Code" 的文件，按排除清单过滤）— 用户可见字符串、提示词、自指注释
- Modify: `README.md`、`README.zh-CN.md` — 标题、归属首行、命令与归档示例
- Modify: `docs/RELEASING.md`（双语）、`docs/RELEASE.md:21` — 产物命名规则与安装器描述
- 不修改：`.github/workflows/*`（工件名 `binary-*`，产物名由 `build-binary.ts` 决定）、`docs/architecture/`、`docs/status/`、coverage manifest（本规格为工程改造类，非功能子系统，不在 `check-design-docs.ts` 校验范围）

---

### Task 1: 产物命名链（测试先行）

**Files:**
- Modify: `tests/releasePackaging.test.ts:109,114,206-212,216,221,229,242`
- Modify: `scripts/build-binary.ts:71-72,81,284`
- Modify: `scripts/install.sh:5,95,124,126,131,137`
- Modify: `package.json:2,5,8`

**Interfaces:**
- Consumes: `getBinaryName(target: ReleaseTarget): string`、`getArchiveName(target: ReleaseTarget, version?: string): string`（现有导出，签名不变）
- Produces: `getBinaryName` 返回 `'flash.exe'`（win32）/ `'flash'`（其余）；`getArchiveName` 返回 `flash-v${version}-${platform}-${arch}.${extension}`；`package.json` bin 键 `flash`。任务 3 的文档示例依赖这些确切字符串。

- [ ] **Step 1: 更新打包测试断言（先写失败测试）**

将 `tests/releasePackaging.test.ts` 中以下断言逐字替换（注意 `:216` 中 `C:\a\flash\...` 是既有路径片段，保持不动）：

`:109` 与 `:114`（双语 README 标题断言）：
```ts
    expect(english.split('\n').slice(0, 3)).toEqual([
      '# flash',
      '',
      englishSelector,
    ])
    expect(chinese.split('\n').slice(0, 3)).toEqual([
      '# flash',
      '',
      chineseSelector,
    ])
```

`:206-212`：
```ts
    expect(getArchiveName('bun-darwin-arm64', '1.2.3')).toBe(
      'flash-v1.2.3-darwin-arm64.tar.gz',
    )
    expect(getArchiveName('bun-windows-arm64', '1.2.3')).toBe(
      'flash-v1.2.3-win32-arm64.zip',
    )
    expect(getBinaryName('bun-windows-x64')).toBe('flash.exe')
    expect(getBinaryName('bun-linux-x64')).toBe('flash')
```

`:216-242`（Windows/Unix tar 命令断言中的二进制名与归档路径）：
```ts
    const archivePath = 'C:\\a\\flash\\flash-v1.0.0-win32-x64.zip'
    expect(
      getArchiveCreationCommand(
        'bun-windows-x64',
        archivePath,
        'flash.exe',
      ),
    ).toEqual([
      'tar',
      '--force-local',
      '-a',
      '-cf',
      archivePath,
      'flash.exe',
      'README.md',
      'README.zh-CN.md',
    ])
```
Unix 用例中 `'/tmp/claude-code.tar.gz'` → `'/tmp/flash.tar.gz'`、`'claude-code'` → `'flash'`（结构与上同，只换名字符串）。

- [ ] **Step 2: 运行测试确认失败**

Run: `bun run test 2>&1 | grep -A2 "release target metadata\|release documentation" | head -30`
Expected: FAIL — `'claude-code.exe'` 相关断言收到 `'flash.exe'`（实现尚未改）；README 标题断言失败（README 尚未改，属预期，任务 3 修复）。

- [ ] **Step 3: 修改产物命名链实现**

`scripts/build-binary.ts:71-72`：
```ts
  return RELEASE_TARGETS[target].platform === 'win32'
    ? 'flash.exe'
    : 'flash'
```
`scripts/build-binary.ts:81`：
```ts
  return `flash-v${version}-${platform}-${arch}.${extension}`
```
`scripts/build-binary.ts:284`：
```ts
  const isolatedHome = await mkdtemp(join(tmpdir(), 'flash-binary-home-'))
```

`package.json`：
```json
  "name": "flash",
  "version": "1.0.1",
  "description": "Educational/research snapshot built on Claude Code: an agentic coding CLI and TypeScript Agent SDK built with Bun, React, and Ink.",
```
```json
  "bin": {
    "flash": "dist/main.js"
  },
```

`scripts/install.sh`：`:5` `BINARY_NAME='flash'`；`:95` `work_dir=$(mktemp -d "${TMPDIR:-/tmp}/flash-install.XXXXXX")`；`:124` `... || fail 'Unable to extract flash from the verified archive.'`；`:126` `... fail 'The archive did not contain a regular flash binary.'`；`:131` `staging_file=$(mktemp "$INSTALL_DIR/.flash.XXXXXX")`；`:137` `printf 'Installed flash %s to %s\n' "$VERSION" "$destination"`。

- [ ] **Step 4: 运行测试确认产物命名通过**

Run: `bun run test 2>&1 | tail -5`
Expected: 产物命名相关断言 PASS；仅 README 标题断言仍 FAIL（任务 3 修复，属预期中间态）。

Run: `bun scripts/build-binary.ts --validate-only`
Expected: 退出码 0，无命名报错。

- [ ] **Step 5: Commit**

```bash
git add tests/releasePackaging.test.ts scripts/build-binary.ts scripts/install.sh package.json
git commit -m "Rename release artifacts and installer to flash

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: 源码用户可见字符串与提示词替换

**Files:**
- Modify: `src/**` 中含 `Claude Code` 的文件（grep 清单过滤排除项后约 210 个）
- 不修改：`src/tools/AgentTool/built-in/claudeCodeGuideAgent.ts`、`src/types/generated/**`、`src/constants/github-app.ts`、`src/constants/oauth.ts`

**Interfaces:**
- Consumes: 任务 1 已完成（package.json 已更名，避免 `bun install`/构建期名字不一致）。
- Produces: 所有面向用户/模型的字符串以 flash 自称；无接口签名变化。

- [ ] **Step 1: 生成过滤后的文件清单并机械替换**

```bash
grep -rl "Claude Code" src --include="*.ts" --include="*.tsx" \
  | grep -v "^src/tools/AgentTool/built-in/claudeCodeGuideAgent.ts$" \
  | grep -v "^src/types/generated/" \
  | grep -v "^src/constants/github-app.ts$" \
  | grep -v "^src/constants/oauth.ts$" > /tmp/flash-rename-files.txt
wc -l /tmp/flash-rename-files.txt   # 预期约 210
xargs sed -i '' 's/Claude Code/flash/g' < /tmp/flash-rename-files.txt
```

- [ ] **Step 2: 逐 hunk 审查 diff，回退保留行**

决策规则：diff 中每个 hunk，凡属「上游机制注释/真实产品指称」则恢复原文，凡「本代码库自指/面向用户自称」则保留 flash。

必须回退（sed 已误改，恢复原文）：
- `src/global.d.ts:12` → 恢复 "In the original Claude Code build, Bun's bundler uses `bun:bundle`"
- `src/setup.ts:422` → 恢复 "CCD (Claude Code in Desktop)"
- `src/history.ts:412` → 恢复 "spawned by Claude Code's Tungsten tool"
- `src/tools/BashTool/BashTool.tsx:1038` 与 `src/tools/PowerShellTool/PowerShellTool.tsx:745` → 恢复注释中的 "Claude Code hints protocol"

自查命令（输出应仅剩以上保留行）：
```bash
git diff src | grep "^+" | grep -c "flash"    # 总替换量参考
grep -rn "Claude Code" src --include="*.ts" --include="*.tsx" \
  | grep -v "claudeCodeGuideAgent" | grep -v "^src/types/generated/" \
  | grep -v "github-app" | grep -v "oauth.ts"
# 预期：仅 global.d.ts:12、setup.ts:422、history.ts:412、BashTool.tsx:1038、PowerShellTool.tsx:745
```

- [ ] **Step 3: 人工改写 sed 无法正确处理的行**

sed 会产生 "flash, Anthropic's official CLI for Claude" 这类不通顺结果，逐处改为：

- `src/tools/AgentTool/built-in/generalPurposeAgent.ts:3`：
  `const SHARED_PREFIX = \`You are an agent for flash. Given the user's message, you should use the tools available to complete the task. Complete the task fully—don't gold-plate, but don't leave it half-done.\``
- `src/tools/AgentTool/built-in/exploreAgent.ts:24`：
  `You are a file search specialist for flash. You excel at thoroughly navigating and exploring codebases.`
- `src/main.tsx:1721`：`chalk.yellow('Tip: You can launch flash with just \`flash\`')`（命令名也要改，sed 只改了产品名）
- `src/constants/prompts.ts:244`：sed 后为 "…with flash itself…"（正确，保留）；同行的 `#claude-code-feedback` 保持不动（小写外部频道名，sed 不触及）。

- [ ] **Step 4: 构建与全量测试**

Run: `bun run build 2>&1 | tail -3 && bun run test 2>&1 | tail -5`
Expected: build 成功；测试全绿（任务 1 后仅剩的 README 标题断言此时仍 FAIL——README 未改；若无其他失败即通过）。

- [ ] **Step 5: Commit**

```bash
git add src
git commit -m "Rename product self-references in UI strings and prompts to flash

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: README 与发布文档

**Files:**
- Modify: `README.md:1,5,63,84,89-99,106-112`
- Modify: `README.zh-CN.md:1,5,63,84,89-112`
- Modify: `docs/RELEASING.md:3,10,154-160`
- Modify: `docs/RELEASE.md:21`

**Interfaces:**
- Consumes: 任务 1 的产物命名（`flash-vX.Y.Z-…`、`flash`、`flash.exe`），文档示例必须与之逐字符一致；任务 1 Step 1 已断言 README 标题 `# flash`。
- Produces: 无代码接口；文档与产物命名一致。

- [ ] **Step 1: 更新双语 README**

`README.md:1`：
```markdown
# flash
```
`README.md:5`：
```markdown
Educational/research snapshot built on Claude Code: an agentic coding CLI and TypeScript Agent SDK built with Bun, React, and Ink.
```
命令与产物示例（英文版 `:63,84,89-99,106-112`，行号与中文版一致）：`claude-code --version` → `flash --version`；`tar -xzf claude-code-vX.Y.Z-darwin-arm64.tar.gz` → `tar -xzf flash-vX.Y.Z-darwin-arm64.tar.gz`；`./claude-code` → `./flash`；`claude-code.exe` → `flash.exe`；SHA256SUMS grep 示例与 `Get-FileHash` 路径同步。

`README.zh-CN.md:1`：
```markdown
# flash
```
`README.zh-CN.md:5`：
```markdown
基于 Claude Code 的教学/研究快照：使用 Bun、React 和 Ink 构建的智能体编程 CLI 与 TypeScript Agent SDK。
```
中文版命令/归档示例同上替换。

替换命令（两文件同时处理，避免遗漏）：
```bash
sed -i '' 's/claude-code-v/flash-v/g; s/\.\/claude-code/.\/flash/g; s/\\\ claude-code.exe/\\\ flash.exe/g; s/claude-code\.exe/flash.exe/g; s/^claude-code /flash /; s/# Claude Code/# flash/' README.md README.zh-CN.md
git diff README.md README.zh-CN.md   # 人工核对首行归属句保留 "built on Claude Code"
```
注意：`README.md:5` 的归属句若被误改（不含小写 `claude-code`，不会被上述 sed 触及），用 Step 1 的目标文本核对。

- [ ] **Step 2: 更新发布文档**

`docs/RELEASING.md:10`（双语行）：产物命名 → `flash-vX.Y.Z-<platform>-<arch>.tar.gz`，Windows 使用 `.zip`。
`docs/RELEASING.md:3`：`本文定义 flash 独立二进制和 GitHub Release 的发布流程…` / `This guide defines the release process for standalone flash binaries…`。
`docs/RELEASING.md:154-160`：提取/校验示例中的 `./claude-code`、`claude-code.exe` → flash。
`docs/RELEASE.md:21`：`…verifies the archive against SHA256SUMS, and installs flash without sudo…`。
`docs/RELEASE.md:33` 的 legacy URL `wencaiwulue/claude-code` **保持不动**。

```bash
sed -i '' 's/claude-code-v/flash-v/g; s/`claude-code`/`flash`/g; s/\.\/claude-code/.\/flash/g; s/claude-code\.exe/flash.exe/g; s/installs claude-code/installs flash/' docs/RELEASING.md docs/RELEASE.md
git diff docs/RELEASING.md docs/RELEASE.md   # 核对 :33 legacy URL 未被改动
```

- [ ] **Step 3: 运行打包测试确认 README 断言通过**

Run: `bun run test 2>&1 | tail -5`
Expected: 全绿（含任务 1 遗留的 README 标题断言）。

- [ ] **Step 4: Commit**

```bash
git add README.md README.zh-CN.md docs/RELEASING.md docs/RELEASE.md
git commit -m "Update READMEs and release docs to flash product naming

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: 客观验收

**Files:**
- 无新修改（若验收发现问题，回到对应任务修复后重跑本任务）

**Interfaces:**
- Consumes: 任务 1-3 的全部产物。
- Produces: 规格第 8 节验收标准的执行结果。

- [ ] **Step 1: 构建与运行时验证**

```bash
bun run build 2>&1 | tail -3
bun dist/main.js --version        # 预期输出含 "(flash)"
bun dist/main.js --help 2>&1 | head -20   # 预期以 flash 自称，无 "Claude Code" 产品自称
```
Expected: build 成功；`--version` 含 `(flash)`；`--help` 首屏无 "Claude Code"。

- [ ] **Step 2: CI 同参验证**

Run: `bun scripts/build-binary.ts --validate-only`
Expected: 退出码 0。

- [ ] **Step 3: 全量测试**

Run: `bun run test 2>&1 | tail -5`
Expected: 全绿。

- [ ] **Step 4: 残留 grep 验收（规格第 8 节标准 4）**

```bash
grep -rn "Claude Code\|claude-code" src scripts package.json README.md README.zh-CN.md docs/RELEASING.md docs/RELEASE.md
```
Expected: 输出仅包含规格第 4 节排除清单条目——`claudeCodeGuideAgent.ts`、`src/types/generated/`、`github-app.ts`、`oauth.ts` URL、`CLAUDECODE`/`claude-code-hint` 注释、`global.d.ts:12`、`setup.ts:422`、`history.ts:412`、`main.tsx:820,965`、`keybindings/template.ts:46`、`prompts.ts:244,436` 小写外部标识符、`docs/RELEASE.md:33` legacy URL，以及 README 首行归属句中的 "Claude Code"。

- [ ] **Step 5: 无差异则无需提交**

若 Step 1-4 全部通过且工作区干净，本任务不产生提交；若发现问题，修复后 `git add <files> && git commit -m "Fix flash rename acceptance findings"` 并重跑 Step 1-4。
