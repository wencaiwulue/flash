---
commit: 8117aaa81ba58bb7ddae1256712797880a6cdebd
title: 历史清单排除 HEAD 的实施步骤
date: 2026-11-11
retrospective: true
---

# 历史清单排除 HEAD 的实施步骤

> 依据 `8117aaa` 的 parent diff 重建；目标是用一个可重复的双 commit 仓库验证身份边界。

## 前置条件

- 工作文件：`scripts/document-commits.ts`。
- 目标函数：`buildCommitDocuments()`。
- 已确认 `commits()` 使用 `git log --reverse`，数组最后一项是当前 HEAD。
- 不修改 `specFor()`、`planFor()`、`selfSpecFor()`、`selfPlanFor()` 或索引结构。

## 1. 先建立会失败的验收脚本

创建 `/tmp/check-head-self.sh`：

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT="$1"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

git -C "$TMP" init -q
git -C "$TMP" config user.name test
git -C "$TMP" config user.email test@example.invalid

printf 'A\n' > "$TMP/file.txt"
git -C "$TMP" add file.txt
git -C "$TMP" commit -qm A
A="$(git -C "$TMP" rev-parse --short HEAD)"

printf 'B\n' >> "$TMP/file.txt"
git -C "$TMP" add file.txt
git -C "$TMP" commit -qm B
B="$(git -C "$TMP" rev-parse --short HEAD)"

(
  cd "$TMP"
  COMMIT_DOC_ID=current-work \
  COMMIT_DOC_SUBJECT='Current work' \
  bun "$SCRIPT"
)

test -f "$TMP/docs/specs/${A}-SPEC.md"
test -f "$TMP/docs/plans/${A}-PLAN.md"
test ! -e "$TMP/docs/specs/${B}-SPEC.md"
test ! -e "$TMP/docs/plans/${B}-PLAN.md"
test -f "$TMP/docs/specs/self-SPEC.md"
test -f "$TMP/docs/plans/self-PLAN.md"
rg -n '^commit: self$' "$TMP/docs/specs/self-SPEC.md"
rg -n '^changeId: current-work$' "$TMP/docs/specs/self-SPEC.md"

! rg -n "\\| ${B} \\|" "$TMP/docs/INDEX.md"
rg -n 'self \(current-work\)' "$TMP/docs/INDEX.md"
bun -e '
  const index = await Bun.file(process.argv[1]).json()
  const historical = index.commits.filter(item => item.fullSha !== "self")
  if (historical.length !== 1) throw new Error("HEAD entered historical JSON")
  if (index.commits.at(-1)?.changeId !== "current-work") throw new Error("self identity changed")
' "$TMP/docs/status/index.json"
```

脚本前半段建立 A、B 两个 commit，后半段直接检查文件、INDEX 和 JSON，而不是只检查源码里有没有 `slice`。

在 parent 版本上运行，确认它会因为 B 被当成历史 commit 而失败：

```bash
chmod +x /tmp/check-head-self.sh
git show 8117aaa^:scripts/document-commits.ts > /tmp/document-commits.parent.ts
/tmp/check-head-self.sh /tmp/document-commits.parent.ts
```

预期失败点：`docs/specs/<B>-SPEC.md` 存在，后续 `test ! -e` 返回非零。

## 2. 修改唯一历史入口

在 `buildCommitDocuments()` 中应用下面的精确变更：

```diff
-  for (const commit of commits()) {
+  for (const commit of commits().slice(0, -1)) {
```

不要修改 `commits()` 本身，也不要在循环内增加 `if (commit === last)`。前一种做法会影响其他调用者，后一种做法无法明确表达“只处理祖先”的输入契约。

## 3. 运行验收脚本

```bash
/tmp/check-head-self.sh "$PWD/scripts/document-commits.ts"
```

必须同时满足：

- A 的历史文档存在；
- B 的 SHA 文档不存在；
- self 文档和 self 索引存在；
- JSON 只有 A 一个历史对象；
- self 的 `changeId` 仍为 `current-work`。

再执行静态检查，确认修改范围只有这一行：

```bash
git diff --check
git diff -- scripts/document-commits.ts
```

## 4. 验证单 commit 边界

创建只有一个 commit 的临时仓库并运行同一生成器：

```bash
SCRIPT="$PWD/scripts/document-commits.ts"
TMP_ONE="$(mktemp -d)"
git -C "$TMP_ONE" init -q
git -C "$TMP_ONE" config user.name test
git -C "$TMP_ONE" config user.email test@example.invalid
printf 'root\n' > "$TMP_ONE/file.txt"
git -C "$TMP_ONE" add file.txt
git -C "$TMP_ONE" commit -qm root
(
  cd "$TMP_ONE"
  bun "$SCRIPT"
)
test -f "$TMP_ONE/docs/specs/self-SPEC.md"
test -f "$TMP_ONE/docs/plans/self-PLAN.md"
bun -e '
  const index = await Bun.file(process.argv[1]).json()
  if (index.commits.filter(item => item.fullSha !== "self").length !== 0) process.exit(1)
' "$TMP_ONE/docs/status/index.json"
rm -rf "$TMP_ONE"
```

预期历史数组为空，self 仍正常生成，不出现 `undefined` 文档或异常。

## 回滚条件

如果祖先文档数量、self 身份或单 commit 行为不符合上述检查，只回滚 `buildCommitDocuments()` 的这一行，不通过调整索引或删除 self 来掩盖边界错误。
