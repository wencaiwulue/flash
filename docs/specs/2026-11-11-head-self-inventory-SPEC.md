---
commit: 8117aaa81ba58bb7ddae1256712797880a6cdebd
title: 历史清单排除 HEAD，当前工作由 self 表示
date: 2026-11-11
kind: metadata-migration
retrospective: true
---

# 历史清单排除 HEAD，当前工作由 self 表示

## 要解决的问题

`buildCommitDocuments()` 同时生成两类文档：

- 已确定 full SHA 的历史 commit 文档；
- 用固定 `self` 身份表示当前工作的文档。

父提交却把 `commits()` 返回的最后一项（当前 HEAD）也放入历史循环。于是同一份当前工作同时占用“HEAD 的 SHA”与“self”两个身份，历史条目、索引和状态计数都会重复。

这个设计必须遵守一个约束：**一个 commit 不能在自己的树里写入会反过来改变自身 SHA 的最终记录。** 因此，HEAD 不能直接充当已定稿历史记录，必须留给 `self`。

## 方案

只在历史循环的输入边界移除数组末项：

```ts
for (const commit of commits().slice(0, -1)) {
  // 生成祖先 commit 的 SPEC、PLAN 和索引
}
```

`commits()` 仍按 `git log --reverse` 返回从旧到新的数组，所以 `slice(0, -1)` 只排除当前 HEAD，不改变祖先顺序。循环之后的 `selfSpecFor()`、`selfPlanFor()`、self 索引行和 JSON 对象保持原样。

### 身份变化示例

假设仓库依次有 A、B 两个 commit，当前 HEAD 为 B：

| 输出 | 修改前 | 修改后 |
|---|---|---|
| A 的历史 SPEC/PLAN | 有 | 有 |
| B 的历史 SPEC/PLAN | 有 | 无 |
| 当前工作的 self SPEC/PLAN | 有 | 有 |
| 状态计数 | A、B、self 所表达的当前工作重复 | 只统计 A；B 由 self 承接 |

开始下一项工作时，再按既有流程把 B 固化为历史记录，并让新的 self 表示下一项工作。

## 为什么只改这一处

- 修改 `commits()` 会把文档专用的 HEAD 规则泄漏给其他调用者；不采用。
- 在 SPEC、PLAN、INDEX、JSON 各分支分别过滤 HEAD 会产生四套相同判断；不采用。
- 在主循环入口截取一次，可以同时约束文件生成、索引行和状态计数，修改面与规则作用域一致。

## 边界

- 本方案依赖 `commits()` 的“最后一项是当前 HEAD”契约；如果排序方式改变，必须同步调整该边界。
- 本提交不处理文档正文质量、历史记录的后续固化、CI 校验或文件名规则。
- 单 commit 仓库也得到合法结果：历史循环为空，仅生成 self 和索引。

## 验收标准

1. 对包含 A、B 两个 commit 的仓库，生成结果包含 A 的 SPEC/PLAN，不包含 B 的 SHA 命名 SPEC/PLAN。
2. 生成结果始终包含 `self-SPEC.md` 和 `self-PLAN.md`。
3. INDEX 和 JSON 不含 B 的历史条目，但包含 self 条目；状态计数只统计 A。
4. `COMMIT_DOC_ID` 和 `COMMIT_DOC_SUBJECT` 仍只影响 self，不改变 A 的历史身份。
5. 单 commit 仓库不抛错，历史计数为零，self 文档仍完整生成。
6. `specFor()`、`planFor()`、self 生成函数及祖先顺序没有行为变化。
