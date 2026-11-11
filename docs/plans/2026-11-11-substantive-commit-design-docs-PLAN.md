---
commit: c69c271db2278642918bce5caf9641108e4f6cab
title: 结构化设计记录的实施顺序
date: 2026-11-11
retrospective: true
---

# 结构化设计记录的实施顺序

## 1. 建立不可兜底的数据契约

先实现 schema 与 load：每条记录绑定 full SHA、kind/status、设计字段、references 和 plan.steps；缺记录立即失败，不再回退通用正文。

## 2. 实现 Git 与质量校验

git.ts 提供 topo 历史、rename-aware changedFiles 和 fileAtRevision。validate.ts 对照 diff 检查覆盖、路径、symbol、rename、证据 revision，并扫描占位、复制和敏感内容。

## 3. 分离渲染、写入与检查

render.ts 只转换记录为 Markdown/索引。document-commits 提供 head/next 写入口，checker 只读比较并发现孤儿；CI 固定目标 revision，移除检查前 writer。

## 4. 回填并审查记录

按提交时间和子系统补齐 records，再用 tests/commitDocs.test.ts 覆盖缺记录、空章节、旧模板、错误路径、证据来源和复制正文。语义审查与自动检查分开执行。

## 5. 验收

```bash
bun test tests/commitDocs.test.ts
bun run docs:generate -- --next
bun run docs:check -- --next
bun run typecheck
bun test
bun run build
```

额外核对 next 包含当前 HEAD、head 包含祖先+self、重复生成无差异。不得用结构通过替代逐提交设计准确性。
