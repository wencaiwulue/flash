---
commit: ab30aec7490292b93198d53c8436081dd8b06cdf
title: SkillHub 远程搜索、下载与版本缓存设计
date: 2026-11-10
retrospective: true
---

# SkillHub 远程搜索、下载与版本缓存设计

## Client 协议

`SkillHubClient` 统一处理 search/resolve/download：请求超时 10 秒并支持 AbortSignal，token 只进入 Authorization Bearer header。JSON 响应兼容 `{code,data}` 包装；zip 下载限制 10 MB。

search 限制 1–20 条，兼容数组和 items/skills/results 包装；slug 缺失时回退 name，namespace 缺省为 default，version 回退 latestVersion，shortId 来自 id/shortId。namespace 和 slug 在 resolve/download 路径中分别 encode。

`searchRemoteSkills()` 只有配置 registry URL 且 query 非空才执行。结果注册为 namespace/slug 与下载 URL，并以 `_canonical_` 前缀暴露给发现链路。

## 版本缓存与安全解包

`loadRemoteSkill()` 先 resolve version，再以以下键缓存：

```text
sha256(baseUrl/namespace/slug@version-or-latest)
```

SKILL.md 与 .skillhub.json 同时可读才 cache hit；不完整缓存重新下载。相同 slug@url 的并发加载共享 inFlight Promise，完成后删除。

解包执行多层限制：

- ZIP central directory 不得声明 symlink；
- 文件数 1–100，必须包含 SKILL.md；
- 路径不得为空、绝对、含反斜杠或 `.`/`..` 段；
- 解压总大小最多 5 MB。

文件先写随机 staging，目录 0700、文件 0600，同时写 fileCount/totalBytes metadata；完成后替换正式目录，失败清理 staging。

## 本地与远程发现合并

预取并行执行 local 与 remote 搜索，remote 失败只降级为空数组。`_canonical_<namespace/slug>` 与本地名称分别去重；已出现过的 canonical skill 被过滤，新发现项加入 discoveredSkillNames。附件 source 根据实际结果标为 native、aki 或 both。

DiscoverSkillsTool 同样并行合并结果，并把 remoteError 作为独立可选字段返回，不把远程失败误报为本地零结果。

## 验收标准

1. search 包装、字段回退、URL 编码、Authorization、超时和下载大小限制正确。
2. 缓存键包含版本，完整缓存命中，版本变化重新下载，相同加载并发去重。
3. symlink、路径逃逸、文件数、缺失 SKILL.md 和 5 MB 上限均在写盘前拒绝；staging 清理完整。
4. 本地/远程合并、canonical 去重、source 标记和 remoteError 降级正确。
5. `remoteSkills.test.ts` 使用本地 HTTP registry、缓存变化与恶意 zip 覆盖上述分支。
