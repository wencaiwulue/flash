---
commit: 4b9d30f7953273e567a18eb819f4eddd45fcc877
title: 单根源码快照的还原步骤
date: 2026-03-31
retrospective: true
---

# 单根源码快照的还原步骤

> 目标是还原“怎样形成一个内容一致的单根快照”，不是编造 1902 个源码文件的开发顺序。以下操作只在临时仓库进行，不改写现有分支或远端。

## 1. 固定源对象与验收身份

```bash
SOURCE=4b9d30f7953273e567a18eb819f4eddd45fcc877
REPO_ROOT="$PWD"
EXPECTED_TREE="$(git rev-parse "$SOURCE^{tree}")"
```

`EXPECTED_TREE` 是最终内容是否一致的唯一判据。commit hash 会因提交时间、作者和消息不同而变化，不应作为复现目标。

## 2. 在临时仓库取得源对象

```bash
TMP="$(mktemp -d)"
git -C "$TMP" init -q
git -C "$TMP" config user.name snapshot-test
git -C "$TMP" config user.email snapshot@example.invalid
git -C "$TMP" fetch -q "$REPO_ROOT" "$SOURCE"
```

fetch 只读取原仓库对象。后续 checkout/restore 都使用临时仓库里的 `FETCH_HEAD`。

## 3. 建立无父分支并恢复指定内容

```bash
git -C "$TMP" switch --orphan snapshot
git -C "$TMP" restore --source=FETCH_HEAD -- README.md src
git -C "$TMP" add README.md src
git -C "$TMP" commit -qm 'Source baseline'
```

这里没有产品代码实施步骤：根提交的设计动作是保留指定 tree 并切断父历史。不能为快照补写 package.json、测试或构建配置，否则 tree 已不相同。

## 4. 验证根身份和内容

```bash
test "$(git -C "$TMP" rev-list --count HEAD)" = '1'
test "$(git -C "$TMP" rev-parse HEAD^{tree})" = "$EXPECTED_TREE"
test "$(git -C "$TMP" diff-tree --root --no-commit-id --name-status -r HEAD | wc -l | tr -d ' ')" = '1903'
! git -C "$TMP" diff-tree --root --no-commit-id --name-status -r HEAD | rg '^R'
git -C "$TMP" ls-tree --name-only HEAD
```

验收要求：

- 当前分支只有一个 commit；
- 新 commit 的 tree hash 与 `EXPECTED_TREE` 完全相同；
- 根 diff 为 1903 个文件且没有 rename；
- 顶层输出只有 `README.md` 和 `src`。

再检查构建边界仍然真实存在：

```bash
test ! -e "$TMP/package.json"
test ! -e "$TMP/tsconfig.json"
test ! -e "$TMP/bun.lock"
```

这些断言用于防止把后续恢复提交的内容倒放进根快照。

## 5. 静态核对架构入口

在原 revision 上执行只读检查：

```bash
git show "$SOURCE:src/QueryEngine.ts" | rg -n 'submitMessage|tool_use|permission'
git show "$SOURCE:src/Tool.ts" | rg -n 'inputSchema|checkPermissions|isReadOnly'
git show "$SOURCE:src/entrypoints/agentSdkTypes.ts" | rg -n 'unavailable|not implemented|unsupported'
```

如果 SDK 文件没有显式边界，或查询/工具接口与 SPEC 不符，应修改 SPEC 的事实描述，而不是补写一套看似完整的能力。

## 6. 清理临时仓库

```bash
rm -rf "$TMP"
```

只有 tree hash、根身份和文件清单全部一致，才算复现完成。若任一项不符，删除临时分支并重新从 `FETCH_HEAD` 恢复，不通过手工增删文件来逼近文件数量。
