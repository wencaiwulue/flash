---
commit: ab30aec7490292b93198d53c8436081dd8b06cdf
title: SkillHub 远程技能的实施顺序
date: 2026-11-10
retrospective: true
---

# SkillHub 远程技能的实施顺序

## 1. 实现可注入的 SkillHubClient

**文件：** `src/services/skillSearch/skillhubClient.ts`。

request 用 createCombinedAbortSignal 实现 10 秒超时，json 模式设置 Accept application/json，zip 模式设置 application/zip；token 只用于 Bearer header。处理 code/data 包装与 HTTP 错误，zip 限制 10 MB。

实现 search 的列表解包、slug/name/namespace/version/shortId 回退，以及 resolve/download 的路径段编码。fetchImpl 必须可注入，测试不依赖公网。

## 2. 实现版本化解包缓存

**文件：** `src/services/skillSearch/remoteSkillLoader.ts`。

先 parseSkillLocation 和 resolve，再以 baseUrl/namespace/slug@version 的 SHA-256 建缓存目录。只有 SKILL.md 和 metadata 同时有效才 cache hit。

下载后按顺序执行：

1. central directory symlink 检查；
2. unzip 并过滤目录项；
3. 文件数与 SKILL.md 检查；
4. 每路径安全和累计 5 MB 检查；
5. 随机 staging 写文件与 metadata；
6. rename 替换，catch 清理 staging。

loadRemoteSkill 以 slug@url 共享 inFlight Promise，finally 删除。

**测试：** `tests/remoteSkills.test.ts` 用本地 HTTP registry 覆盖 search/resolve/download、第二次 cacheHit、版本变化、并发，以及 symlink、路径逃逸和超限 zip：

```bash
bun test tests/remoteSkills.test.ts
```

## 3. 注册远程发现并合并搜索

**文件：** `remoteSearch.ts`、`remoteSkillState.ts`。

搜索结果注册为 namespace/slug、name/description 和编码后的下载 URL。state 提供 canonical prefix 去除、注册、读取、列表和清空，不把未发现的远程技能任意加载。

`prefetch.ts` 与 DiscoverSkillsTool 并行执行本地/远程搜索，过滤已可见 canonical 名称，记录 discoveredSkillNames，并按 native/aki/both 标附件来源。远程失败单独降级，DiscoverSkillsTool 返回 remoteError。

## 4. 接入遥测与回归

`telemetry.ts` 只记录 slug、cacheHit、latency、URL scheme、文件数量、大小、fetchMethod 和 error，不记录 token 或 registry 认证信息。

运行：

```bash
bun test tests/remoteSkills.test.ts tests/skillSearch.test.ts
bun run typecheck
bun test
```

回滚时先移除远程发现合并，再回滚 loader 和 client；不得通过关闭 zip 检查、把远程错误写成本地零结果，或在缓存键中忽略版本来保留功能。
