---
commit: e92caa6639daf982d3299a485dfc6c0b5ff7f1e7
title: 本地技能索引、搜索与预取设计
date: 2026-11-10
retrospective: true
---

# 本地技能索引、搜索与预取设计

## 索引与搜索

`localSearch.ts` 通过 `getSkillToolCommands(cwd)` 建立本地索引，排除 bundled 和 MCP 命令，只保留 name/description/whenToUse。动态 import 用于打断 commands 与 localSearch 的初始化环。

索引按 cwd 缓存 Promise；加载失败时删除该缓存项，允许下次重试。Fuse 权重为 name 0.5、description 0.3、whenToUse 0.2，threshold 0.4，limit 默认 5、最大 10。

完整查询没有结果时，拆出长度至少 3 的非 stop-word term，再按“命中 term 数降序、最佳 Fuse score 升序”合并结果。空查询直接返回空集。

`getVisibleSkillNames()` 同时收集 skill_discovery 附件和 assistant 中的 Skill tool_use，搜索时排除这些名称，并把新结果写入 `discoveredSkillNames` 供后续遥测使用。

## 发现信号与预取

`startSkillDiscoveryPrefetch()` 按以下优先级选择信号：

1. 显式 input 不为 null → `user_input`；
2. 有 agentId 且尚无 discovery 附件 → `subagent_spawn`；
3. 最近一次 discovery 之后存在 Write/Edit/NotebookEdit/MultiEdit → `write_pivot`；
4. 否则不预取。

`findWritePivot()` 只查看最后一次 discovery 之后的 assistant tool_use，避免同一写入点重复推荐。

查询由最近用户文本构成；write_pivot 额外拼接该工具的 file_path、command、description，统一截断到 2000 字符。搜索返回非空结果时生成 `source:'native'` 的 skill_discovery 附件；功能关闭、空查询、无结果或搜索异常均返回空附件数组，不阻断主查询。

`DiscoverSkillsTool` 让模型主动复用同一 `searchLocalSkills()`，因此主动搜索和自动预取共享去重、限流与 kill switch。

## 验收标准

1. 索引来源、权重、limit、空查询、自然语言 fallback 和失败重试符合上述规则。
2. 已展示附件和已调用 Skill 均被排除，新发现名称写入 context。
3. 三类信号按优先级触发，write pivot 在最近 discovery 后只触发一次；无信号或空查询返回 null。
4. 显式输入与 write metadata 的查询拼接、2000 字符上限、native attachment 和异常降级正确。
5. `skillSearch.test.ts` 覆盖排名、去重、turn-zero、write-pivot、subagent_spawn、遥测集合和运行时 kill switch。
