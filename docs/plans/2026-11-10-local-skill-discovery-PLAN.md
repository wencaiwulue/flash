---
commit: e92caa6639daf982d3299a485dfc6c0b5ff7f1e7
title: 本地技能发现的实施顺序
date: 2026-11-10
retrospective: true
---

# 本地技能发现的实施顺序

## 1. 建立可缓存的本地索引

**文件：** `src/services/skillSearch/localSearch.ts`。

用动态 import 调 `getSkillToolCommands(cwd)`，过滤 `loadedFrom==='bundled'|'mcp'`，映射为 name/description/whenToUse。`indexCache` 缓存 Promise 而非已完成数组；catch 中删除对应 cwd 后重新抛出，避免永久缓存失败。

**验收：** 注入 index 数组，先测排名、排除和 limit，不依赖真实命令 registry。

## 2. 实现搜索与自然语言 fallback

Fuse 配置固定为三个权重字段、threshold 0.4、ignoreLocation、includeScore、minMatchCharLength 2。完整查询无结果时：

1. 小写拆分非字母数字/_/-；
2. 去掉长度小于 3 的 term 和内置 stop words；
3. 对每个 term 搜索，按名称合并 matchedTerms 和最小 score；
4. matchedTerms 降序、score 升序，最后应用 limit。

实现 `getVisibleSkillNames()` 同时识别附件与 Skill tool_use，并在 `searchLocalSkills()` 中应用 exclude 和 discoveredSkillNames。

## 3. 实现三类发现信号

**文件：** `src/services/skillSearch/prefetch.ts`。

依次实现 lastDiscoveryIndex、findWritePivot、buildDiscoveryQuery、startSkillDiscoveryPrefetch。信号优先级必须是 input → subagent_spawn → write_pivot；write pivot 只看最后附件之后的四种写工具。

查询以最近用户文本开头，write_pivot 再拼 file_path/command/description，截断到 2000。`discover()` 在关闭、空查询、无结果或异常时返回空数组；有结果才创建 native 附件。

## 4. 暴露主动搜索工具并接入构建

**文件：** `src/tools/DiscoverSkillsTool/DiscoverSkillsTool.ts`、`src/tools.ts`、`scripts/build.ts`。

DiscoverSkillsTool 的 query 必填、limit 1–10，call 直接复用 searchLocalSkills；结果只含 name/description，空结果返回明确文本。构建加入 `EXPERIMENTAL_SKILL_SEARCH`，featureCheck 和运行时 `CLAUDE_CODE_SKILL_SEARCH=0` 都能关闭入口。

**验收：**

```bash
bun test tests/skillSearch.test.ts tests/enabledFeatures.test.ts
bun run typecheck
bun test
```

重点覆盖：完整查询零结果后的 term 合并、附件/Skill 去重、turn-zero、write pivot 只触发一次、subagent spawn、异常降级和 kill switch。不要通过远程搜索替代本地索引，也不要让预取异常阻断模型主查询。
