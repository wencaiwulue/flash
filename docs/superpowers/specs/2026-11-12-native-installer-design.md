---
id: native-installer
batch: 7
title: Native Installer 原生安装与更新恢复设计
date: 2026-11-12
status: draft
---

# Native Installer 原生安装与更新恢复设计

本文是对当前实现的回溯性设计说明，不冒充原始历史设计记录。

## 1. 问题与约束

Claude Code 需要提供原生二进制安装方式，相比 npm 安装有更快的启动速度、更低的依赖要求。同时需要支持自动更新、多版本共存、并发安全、失败回滚、以及与包管理器（Homebrew/winget 等）的边界处理。如果没有统一的原生安装系统，会导致：

- 安装过程中断电导致半安装状态，用户无法启动也无法修复
- 多个 CLI 实例同时更新导致竞态，版本目录损坏
- 运行中的版本被清理导致 subprocess 调用失败（如使用 ripgrep 等内置二进制）
- npm 安装与原生安装冲突，用户不知道哪个生效
- 包管理器安装与自更新冲突，导致双重更新

因此本子系统必须在以下约束下完成原生安装管理：

- **多版本共存**：保留最近两个版本，支持快速回滚
- **原子安装**：下载到 staging，验证通过后原子移动到最终位置
- **并发安全**：PID 锁 + mtime 锁双重机制，防止跨进程竞态
- **运行保护**：正在运行的版本不会被清理
- **回滚支持**：保留旧版本，更新失败可回滚
- **包管理器边界**：检测并尊重 Homebrew/winget/pacman/deb/rpm/apk/mise/asdf 等包管理器的安装，不自更新
- **跨平台**：支持 macOS/Linux/Windows，Windows 上不用 symlink 而用直接复制
- **完整性校验**：下载后校验 checksum，防止损坏
- **并发去重**：同进程内多个更新请求去重，只下载一次
- **清理策略**：自动清理旧版本、staging 文件、Windows 旧副本

## 2. 设计理由与备选方案

| 决策 | 实际机制 | 为什么采用 | 备选方案及不采用原因 | 代价 | 证据 |
|---|---|---|---|---|---|
| 版本目录结构：`~/.local/share/claude/versions/{version}` | `getBaseDirectories()` 返回 XDG 标准路径，版本作为独立文件 | XDG 符合各平台约定，版本独立便于共存与清理 | 每个版本一个目录：增加复杂度，单文件已足够 | 需要管理版本文件权限 | `src/utils/nativeInstaller/installer.ts:115-133` |
| Staging 目录：`~/.cache/claude/staging/{version}` | 下载到 staging，验证通过后原子移动到 versions | 原子性保证，下载中断不影响已安装版本 | 直接下载到最终位置：半下载文件污染版本目录 | 需要清理过期 staging 文件 | `src/utils/nativeInstaller/installer.ts:424-448` |
| 双重锁机制：PID 锁（优先）+ mtime 锁（fallback） | `pidLock.ts` 提供 PID 锁，内容包含 PID/version/execPath/acquiredAt；`tryWithVersionLock()` 根据配置选择 | PID 锁能立即检测进程是否存活，mtime 锁作为 fallback 兼容旧版本和禁用 PID 锁的场景 | 只用 mtime 锁：崩溃后需要等待 7 天才能重新获取锁；只用 PID 锁：PID 复用有风险 | 需要维护两套锁实现，代码复杂度增加 | `src/utils/nativeInstaller/pidLock.ts:35-49` |
| 进程生命周期锁：启动时锁定当前版本 | `lockCurrentVersion()` 在启动时获取锁并持有到进程退出 | 防止正在运行的版本被 `cleanupOldVersions()` 清理 | 不锁定：清理可能删除正在运行的版本，导致 subprocess 调用失败 | 需要在启动时加锁，忽略锁失败（非致命） | `src/utils/nativeInstaller/installer.ts:1048-1156` |
| 原子更新 symlink：`~/.local/bin/claude` → 版本文件 | `updateSymlink()` 先创建临时 symlink，然后原子 rename | 保证 symlink 始终指向有效版本，防止竞态导致的中间状态 | 直接修改 symlink：存在时间窗口 symlink 无效 | 需要处理 Windows 上的 symlink 权限问题（改用直接复制） | `src/utils/nativeInstaller/installer.ts:639-798` |
| Windows 上不用 symlink，直接复制可执行文件 | Windows 上 `updateSymlink()` 实际执行复制，旧文件重命名为 `.old.{timestamp}` | Windows 上 symlink 需要管理员权限，且正在运行的文件无法覆盖 | 强制要求用户以管理员权限运行：体验差；始终用硬链接：跨卷不支持 | 需要在启动时清理旧的 `.old` 文件 | `src/utils/nativeInstaller/installer.ts:648-722` |
| 版本保留策略：保留最近两个未锁定版本 | `cleanupOldVersions()` 保留两个最新版本，跳过有锁的和当前运行的 | 快速回滚，同时节省磁盘空间；保护正在运行的版本不被删除 | 只保留一个版本：回滚需要重新下载；保留更多：浪费空间 | 需要计算版本修改时间来排序 | `src/utils/nativeInstaller/installer.ts:1184-1439` |
| 包管理器检测：不更新由包管理器安装的版本 | `getPackageManager()` 检测 Homebrew/winget/pacman/deb/rpm/apk/mise/asdf，`update` 命令中如果是包管理器安装则提示用户用包管理器更新 | 尊重用户的包管理选择，避免双重更新导致版本混乱 | 总是自更新：可能与包管理器版本冲突，用户困惑 | 需要维护多种包管理器的检测逻辑 | `src/utils/nativeInstaller/packageManagers.ts:302-336` |
| 下载完整性校验：GCS 下载校验 sha256，Artifactory 下载校验 npm integrity | `downloadAndVerifyBinary()` 先 fetch manifest 获取 checksum，下载后对比；npm install 自动校验 package-lock.json 中的 integrity | 防止下载损坏或被篡改 | 不校验：可能运行损坏的二进制，导致崩溃或未定义行为 | 需要从 manifest 获取 checksum，或从 npm registry 获取 integrity | `src/utils/nativeInstaller/download.ts:292-380` |
| 下载去重：同进程内 `inFlightInstall` Promise 共享 | `installLatest()` 检查 `inFlightInstall`，有则复用，无则创建新 Promise | 多个更新入口同时触发时（如 CLI 提示 + 用户手动运行），只下载一次 | 不设去重：下载多次浪费带宽和时间 | 需要管理 Promise 状态和清除 | `src/utils/nativeInstaller/installer.ts:954-974` |
| 下载 stall 检测：60 秒无数据则重试 | `downloadAndVerifyBinary()` 用 `AbortController`，每次数据到达重置计时器；最多重试 3 次 | 网络卡顿或中断时自动恢复，无需用户手动重试 | 不设 stall 检测：可能无限期挂起 | 需要处理 axios 的 onDownloadProgress | `src/utils/nativeInstaller/download.ts:271-280` |
| 版本来源路由：ant 用户用 Artifactory npm 包，外部用户用 GCS 二进制 | `getLatestVersion()` 和 `downloadVersion()` 根据 `USER_TYPE=ant` 路由到不同源 | ant 用户需要内部测试版本，外部用户用公开分发；npm 包提供更好的完整性校验，GCS 二进制更轻量 | 统一用一种源：ant 用户无法访问 GCS，外部用户无法访问 Artifactory | 需要维护两套下载逻辑 | `src/utils/nativeInstaller/download.ts:112-149` |
| npm 安装与原生安装边界：自动检测并禁用 legacy auto-updater | `installLatest()` 成功后设置 `installMethod: 'native'` 和 `autoUpdates: false`；`getCurrentInstallationType()` 检测当前运行方式 | 防止 npm 更新与原生更新冲突，保护原生安装 | 不设边界：两种更新机制可能互相覆盖 | 需要在多个地方检查 installMethod | `src/utils/nativeInstaller/installer.ts:992-1017` |
| 旧 npm 安装清理：提供 `cleanupNpmInstallations()` 移除全局 npm 包和本地安装 | 尝试 `npm uninstall -g`，失败则尝试手动删除 symlink/可执行文件，保留 node_modules 目录作为安全网 | 帮助用户从 npm 安装迁移到原生安装，避免冲突 | 不清理：两个 `claude` 命令在 PATH 中，用户困惑 | 需要谨慎处理，避免误删用户数据 | `src/utils/nativeInstaller/installer.ts:1608-1709` |
| 锁文件位置：`~/.local/state/claude/locks/{version}.lock` | `getLockFilePathFromVersionPath()` 将锁放在 XDG state 目录 | 锁文件有明确的生命周期，XDG state 目录适合放置可变状态 | 锁放在版本目录旁边：版本目录清理时可能误删锁 | 需要创建 locks 目录 | `src/utils/nativeInstaller/installer.ts:1033-1040` |
| 过期 staging/tmp 文件清理：超过 1 小时的自动删除 | `cleanupOldVersions()` 检查 mtime，删除超过 1 小时的 staging 目录和 tmp 文件 | 清理崩溃或中断留下的临时文件，避免浪费磁盘空间 | 不清理：临时文件累积占用空间 | 需要在清理时检查 mtime | `src/utils/nativeInstaller/installer.ts:1188-1203` |
| 最大版本限制：服务器端可设置 `maxVersion` 阻止更新到有问题的版本 | `updateLatest()` 检查 `getMaxVersion()`，如果目标版本 > maxVersion 则降级到 maxVersion；如果当前版本 ≥ maxVersion 则跳过 | 快速回滚有问题的发布，无需等待用户手动操作 | 不设此机制：有问题的版本会继续扩散，需要发新版本修复 | 需要从 GrowthBook 获取 maxVersion 配置 | `src/utils/nativeInstaller/installer.ts:510-533` |

## 3. 目标与非目标

### 状态与生命周期

- **目标**：`installLatest()` 安装最新版本并更新 symlink，失败时保留旧版本
- **目标**：`lockCurrentVersion()` 保护正在运行的版本不被清理
- **目标**：`cleanupOldVersions()` 保留最近两个版本，清理过期临时文件
- **目标**：`checkInstall()` 验证原生安装是否正确，提示 PATH 问题
- **目标**：`getPackageManager()` 检测当前是否由包管理器安装
- **非目标**：不提供跨大版本的破坏性迁移（如配置格式变更）

### 接口与数据

- **目标**：`SetupMessage` 类型返回安装/检查结果消息（path/alias/info/error）
- **目标**：`VersionLockContent` 包含 PID/version/execPath/acquiredAt 用于锁验证
- **目标**：`getPlatform()` 返回规范化平台标识（含 musl 检测）
- **非目标**：不提供从原生安装回滚到 npm 安装的自动化（用户可手动）

### 执行与环境

- **目标**：支持 macOS/Linux/Windows，Linux 上检测 musl
- **目标**：支持 ant 内部用户和外部用户不同的下载源
- **目标**：支持 lockless 模式（环境变量 `ENABLE_LOCKLESS_UPDATES`）用于测试
- **目标**：失败开放：锁获取失败时提示用户而非崩溃
- **非目标**：不支持离线安装（需要网络下载）

### 依赖边界

- **autoUpdater**：原生安装后禁用 legacy auto-updater，本文描述边界
- **config**：`installMethod` 存储在 global config，本文描述读写
- **packageManagers**：包管理器检测由独立模块负责，本文描述调用方式
- **lockfile**：mtime 锁使用 lockfile 模块，本文描述调用方式

## 4. 架构、模块与数据流

### 4.1 入口与公共契约

```typescript
// 主要安装入口
function installLatest(channelOrVersion: string, forceReinstall?: boolean): Promise<{
  latestVersion: string | null
  wasUpdated: boolean
  lockFailed?: boolean
  lockHolderPid?: number
}>

// 主要检查入口
function checkInstall(force?: boolean): Promise<SetupMessage[]>

// 生命周期管理
function lockCurrentVersion(): Promise<void>
function cleanupOldVersions(): Promise<void>

// 版本管理
function cleanupNpmInstallations(): Promise<{
  removed: number
  errors: string[]
  warnings: string[]
}>
function removeInstalledSymlink(): Promise<void>
function cleanupShellAliases(): Promise<SetupMessage[]>
```

调用方式：

1. **安装路径**：用户运行 `/install` 或 CLI 提示更新 → 调用 `installLatest('latest')`
2. **启动路径**：`main.tsx` 启动时调用 `lockCurrentVersion()` 保护当前版本
3. **清理路径**：`installLatest()` 成功后后台调用 `cleanupOldVersions()`
4. **检查路径**：`doctor` 命令调用 `checkInstall(true)` 验证安装状态

### 4.2 模块与状态所有权

| 模块/对象 | 拥有的状态 | 主要操作 | 不承担的职责 | 与其他模块的接口 |
|---|---|---|---|---|
| `installer.ts` | `inFlightInstall`（同进程去重用）、`VERSION_RETENTION_COUNT=2` | `installLatest`、`updateLatest`、`performVersionUpdate`、`checkInstall`、`lockCurrentVersion`、`cleanupOldVersions`、`cleanupNpmInstallations` | 实际下载逻辑（委托给 download.ts） | 调用 download.ts、pidLock.ts、packageManagers.ts |
| `download.ts` | 无（纯函数 + 闭包状态） | `getLatestVersion`、`downloadVersion`、`downloadAndVerifyBinary`、`getLatestVersionFromArtifactory`、`getLatestVersionFromBinaryRepo` | 安装逻辑（委托给 installer.ts） | 返回下载类型（npm/binary）和版本 |
| `pidLock.ts` | 无（锁状态在文件系统） | `isPidBasedLockingEnabled`、`isLockActive`、`readLockContent`、`tryAcquireLock`、`withLock`、`acquireProcessLifetimeLock`、`cleanupStaleLocks` | mtime 锁（委托给 lockfile 模块） | 提供 PID 锁接口，fallback 到 lockfile |
| `packageManagers.ts` | 无（memoized 检测结果） | `getPackageManager`、`detectHomebrew`、`detectWinget`、`detectMise`、`detectAsdf`、`detectPacman`、`detectDeb`、`detectRpm`、`detectApk` | 包管理器更新操作（只检测） | 返回 PackageManager 类型 |
| `cli/update.ts` | 无（命令处理） | `update()` 命令 | 实际更新逻辑（委托给 installer.ts / autoUpdater.ts） | CLI 入口，调用 installLatest 或 installGlobalPackage |

状态位置与理由：

- **inFlightInstall** 放在 `installer.ts` 模块级：同进程内多个调用点去重更新请求
- **锁状态** 放在文件系统（`~/.local/state/claude/locks/`）：跨进程同步
- **版本状态** 放在文件系统（`~/.local/share/claude/versions/`）：持久化版本
- **symlink/可执行文件** 放在 `~/.local/bin/`：用户 PATH 可访问

### 4.3 模块设计卡

#### 4.3.1 版本检测模块

| 属性 | 描述 |
|------|------|
| **入口签名** | `getLatestVersion(channelOrVersion: string): Promise<string>` |
| **关键类型** | `ReleaseChannel = 'stable' \| 'latest'` |
| **输入** | `channelOrVersion`: 可以是 'stable'/'latest' 渠道，也可以是具体版本号（如 '1.2.3' 或 '1.2.3-dev.shaf4937ce'） |
| **输出** | 规范化的版本号字符串（不带前导 'v'） |
| **安装与锁状态** | 只读操作，不获取锁，不修改安装状态 |
| **双源路由** | `USER_TYPE=ant` → Artifactory npm 包；外部用户 → GCS 二进制仓库 |
| **检测流程** | 1. 若输入匹配版本格式 → 直接返回规范化版本；2. 验证渠道合法性；3. 根据用户类型路由到对应源获取最新版本；4. 禁止 99.99.x 测试版本（除非启用 ALLOW_TEST_VERSIONS） |
| **GCS 源流程** | 调用 `getLatestVersionFromBinaryRepo(channel, GCS_BUCKET_URL)` → GET `${GCS_BUCKET_URL}/${channel}` → 返回纯文本版本号 → 超时 30s |
| **Artifactory 源流程** | 调用 `getLatestVersionFromArtifactory(npmTag)` → `npm view ${MACRO.NATIVE_PACKAGE_URL}@${tag} version --registry ${ARTIFACTORY_REGISTRY_URL}` → 超时 30s |
| **错误与恢复** | 网络错误/超时直接抛出，不重试；返回 `npm view` 失败记录 `tengu_version_check_failure` 事件 |
| **设计取舍** | 直接版本输入不验证版本存在性（安装阶段再验证）；禁止测试版本避免误安装 |
| **源码位置** | `src/utils/nativeInstaller/download.ts:112-149` |
| **测试证据** | 无直接测试覆盖 |

---

#### 4.3.2 下载与校验模块

| 属性 | 描述 |
|------|------|
| **入口签名** | `downloadVersion(version: string, stagingPath: string): Promise<'npm' \| 'binary'>` |
| **关键类型** | `StallTimeoutError extends Error`, `MAX_DOWNLOAD_RETRIES = 3`, `STALL_TIMEOUT_MS = 60000` |
| **输入** | `version`: 目标版本号；`stagingPath`: staging 目录路径 |
| **输出** | 下载类型：'npm' 或 'binary' |
| **安装与锁状态** | 在锁保护下调用（除非 ENABLE_LOCKLESS_UPDATES），清空已有 staging 目录 |
| **双源路由** | `USER_TYPE=ant` → Artifactory npm 包（完整性由 npm 验证）；外部用户 → GCS 二进制（sha256 校验） |
| **下载流程** | 1. 清空 staging 目录；2. 根据用户类型路由到对应下载函数；3. GCS 源：fetch manifest.json → 获取 checksum → 下载二进制 → 校验 sha256；4. Artifactory 源：fetch integrity → 创建临时 package.json/package-lock.json → npm ci（自动校验 integrity） |
| **Stall 检测** | `downloadAndVerifyBinary` 使用 AbortController，每次 onDownloadProgress 重置计时器，60s 无数据触发 StallTimeoutError，最多重试 3 次，每次重试前 sleep 1s |
| **Staging 重命名** | 先下载到 `~/.cache/claude/staging/${version}`，原子性由原子性保证半下载不污染 versions 目录 |
| **错误与恢复** | Stall 超时自动重试；checksum 不匹配不重试直接抛错；网络错误不重试；HTTP 错误不重试 |
| **设计取舍** | 60s 超时平衡网络卡顿与用户等待；3 次重试平衡成功率与用户体验；Artifactory 使用 npm ci 而非直接下载二进制，利用 npm 的完整性校验和缓存；GCS 直接二进制更轻量 |
| **源码位置** | `src/utils/nativeInstaller/download.ts:487-518`, `downloadAndVerifyBinary:293-380` |
| **测试证据** | 无直接测试覆盖 |

---

#### 4.3.3 安装原子性模块

| 属性 | 描述 |
|------|------|
| **入口签名** | `performVersionUpdate(version: string, forceReinstall: boolean): Promise<boolean>` |
| **关键类型** | 无特殊导出类型，内部使用 stagingPath, installPath |
| **输入** | `version`: 目标版本；`forceReinstall`: 是否强制重新安装 |
| **输出** | 是否执行了新安装（true）或仅更新 symlink（false） |
| **安装与锁状态** | 在锁保护下调用（除非 ENABLE_LOCKLESS_UPDATES）；创建/更新版本文件；更新 symlink/复制可执行文件 |
| **原子性保证** | 1. 先下载到 staging；2. 复制到 `${installPath}.tmp.${pid}.${timestamp}`；3. chmod 0o755；4. 原子 rename 到最终 installPath；5. symlink 更新：先创建临时 symlink，再原子 rename |
| **Windows 特殊处理** | 不使用 symlink，直接复制可执行文件；若旧文件存在，先重命名为 `claude.exe.old.${timestamp}`，复制新文件后尝试删除旧文件（非阻塞） |
| **Staging 重命名** | 支持 lockless 模式：`stagingPath = baseStagingPath + '.' + pid + '.' + timestamp` |
| **可执行文件验证** | 更新后验证：检查文件存在且可执行；失败则抛出错误 |
| **错误与恢复** | 原子 rename 失败清理临时文件；symlink 更新失败保留旧版本；权限不足抛出错误不重试 |
| **设计取舍** | staging 与 versions 可能跨文件系统，故用 copy+rename 而非直接 rename；Windows 不用 symlink 避免权限问题和正在运行文件无法覆盖问题 |
| **源码位置** | `src/utils/nativeInstaller/installer.ts:441-488`, `atomicMoveToInstallPath:300-326`, `updateSymlink:639-798` |
| **测试证据** | 无直接测试覆盖 |

---

#### 4.3.4 PID 锁模块

| 属性 | 描述 |
|------|------|
| **入口签名** | `withLock(versionPath: string, lockFilePath: string, callback: () => void \| Promise<void>): Promise<boolean>`; `acquireProcessLifetimeLock(versionPath: string, lockFilePath: string): Promise<boolean>`; `tryWithVersionLock(versionFilePath: string, callback: () => void \| Promise<void>, retries?: number): Promise<boolean>` |
| **关键类型** | `VersionLockContent = { pid: number; version: string; execPath: string; acquiredAt: number }`; `LockInfo = { version: string; pid: number; isProcessRunning: boolean; execPath: string; acquiredAt: Date; lockFilePath: string }` |
| **输入** | `versionPath`: 版本文件路径；`lockFilePath`: 锁文件路径；`callback`: 持有锁时执行的回调；`retries`: 重试次数（默认 0） |
| **输出** | `withLock`/`tryWithVersionLock`: 是否成功获取锁并执行回调；`acquireProcessLifetimeLock`: 是否成功获取进程生命周期锁 |
| **安装与锁状态** | 锁文件位于 `~/.local/state/claude/locks/${version}.lock`；进程生命周期锁在启动时获取，退出时释放；版本更新时获取锁保护安装操作 |
| **PID+mtime 双锁策略** | PID 锁优先：检查锁文件内容中的 PID，验证进程存活且是 Claude 进程；mtime 锁 fallback：使用 proper-lockfile，7 天 stale 超时；可通过 `ENABLE_PID_BASED_VERSION_LOCKING` 环境变量或 GrowthBook 开关控制 |
| **进程命令身份校验** | `isClaudeProcess(pid, expectedExecPath)`：检查进程命令包含 'claude' 或期望的 execPath；处理 PID 复用场景；若无法获取命令，保守返回 true |
| **锁获取流程** | 1. 检查锁文件是否存在且活跃；2. 原子写入锁文件（临时文件 → rename）；3. 验证锁是否被其他进程抢占；4. 返回释放函数 |
| **锁释放流程** | 仅当仍持有锁时才删除锁文件 |
| **错误与恢复** | 锁获取失败返回 false 不抛出；锁获取失败记录 `tengu_version_lock_failure` 事件；tryWithVersionLock 支持指数退避重试（min 1s，max 5s） |
| **设计取舍** | PID 锁可立即检测崩溃进程，避免 30 天等待；PID 锁优先但保留 mtime 锁作为兼容性 fallback；锁文件单独存放避免版本清理时误删；进程生命周期锁失败不阻止启动，失败开放设计 |
| **源码位置** | `src/utils/nativeInstaller/pidLock.ts:1-433`, `tryWithVersionLock:181-298` |
| **测试证据** | 无直接测试覆盖 |

---

#### 4.3.5 包管理器检测模块

| 属性 | 描述 |
|------|------|
| **入口签名** | `getPackageManager(): Promise<PackageManager>` |
| **关键类型** | `PackageManager = 'homebrew' \| 'winget' \| 'pacman' \| 'deb' \| 'rpm' \| 'apk' \| 'mise' \| 'asdf' \| 'unknown'` |
| **输入** | 无显式输入，使用 `process.execPath` |
| **输出** | 检测到的包管理器类型，'unknown' 表示未检测到 |
| **安装与锁状态** | 只读操作，不获取锁，不修改安装状态；检测结果 memoize 缓存 |
| **检测流程** | 1. `detectHomebrew()`: 检查路径包含 '/Caskroom/'；2. `detectWinget()`: 检查路径包含 WinGet Patterns；3. `detectMise()`/`detectAsdf()`: 检查路径包含对应 installs 目录；4. `detectPacman()`/`detectDeb()`/`detectRpm()`/`detectApk()`: 先检查发行版家族，再查询包管理器数据库 |
| **Linux 发行版路由** | `/etc/os-release` 解析 `ID` 和 `ID_LIKE`；Arch 家族→pacman；Debian 家族→deb；Fedora/RHEL/SUSE→rpm；Alpine→apk；避免误调用游戏 pacman |
| **边界处理** | Homebrew 检测仅匹配 Caskroom，避免与 npm global 混淆；各检测均超时 5s；结果 memoize 避免重复调用 |
| **错误与恢复** | 检测失败不抛出，返回 'unknown'；包管理器安装的版本不自更新，提示用户使用包管理器更新 |
| **设计取舍** | 路径检测优先于数据库查询（更快）；Linux 先查发行版避免误调用同名命令；memoize 避免重复昂贵的数据库查询 |
| **源码位置** | `src/utils/nativeInstaller/packageManagers.ts:302-336` |
| **测试证据** | 无直接测试覆盖 |

---

#### 4.3.6 回滚与清理模块

| 属性 | 描述 |
|------|------|
| **入口签名** | `cleanupOldVersions(): Promise<void>`; `lockCurrentVersion(): Promise<void>`; `cleanupNpmInstallations(): Promise<{ removed: number; errors: string[]; warnings: string[] }>`; `removeInstalledSymlink(): Promise<void>` |
| **关键类型** | `VERSION_RETENTION_COUNT = 2`；1 小时超时用于 staging/tmp/Windows 旧文件清理 |
| **输入** | 无显式输入，使用当前进程信息 |
| **输出** | `cleanupOldVersions()` 无返回值（后台执行）；`cleanupNpmInstallations()` 返回删除数量和错误警告；`lockCurrentVersion()` 无返回值 |
| **安装与锁状态** | `lockCurrentVersion()` 获取进程生命周期锁；`cleanupOldVersions()` 删除版本时先获取锁；清理操作不抛出，尽力而为；后台执行不阻塞主流程 |
| **最近两个版本保留策略** | 1. 获取所有版本文件按 mtime 排序；2. 保护当前运行版本（进程 execPath 匹配）；3. 保护 symlink 指向版本；4. 保护有活跃锁版本；5. 删除超过最近两个的未保护版本 |
| **Stale 锁清理** | PID 锁：检查进程不存活立即清理；mtime 锁：7 天后视为 stale；同时清理 legacy 遗留的目录锁 |
| **过期 Staging/Tmp 清理** | 超过 1 小时的 staging 目录删除；超过 1 小时的 `.tmp.${pid}.${timestamp}` 文件删除；Windows 旧文件 `.old.${timestamp}` 超过 1 小时删除 |
| **Windows 旧文件清理** | 更新时旧文件重命名为 `.old.${timestamp}`；下次启动时清理超过 1 小时的旧文件；更新时尝试立即删除旧文件（非阻塞，可能被占用） |
| **Npm 安装清理** | `npm uninstall -g @anthropic-ai/claude-code`；失败时尝试手动删除可执行文件/链接；保留 node_modules 作为安全网；也清理 `~/.claude/local` |
| **错误与恢复** | 所有清理操作 try/catch 包裹，不抛出；删除版本时锁获取失败跳过该版本；记录 `tengu_native_version_cleanup` 等事件 |
| **设计取舍** | 保留最近两个版本支持快速回滚；保留 node_modules 避免误删用户数据；清理操作尽力而为不阻塞主流程；版本按 mtime 排序而非 semver（简单可靠）；不提供显式回滚命令，用户手动切换 symlink |
| **源码位置** | `src/utils/nativeInstaller/installer.ts:1048-1439`, `cleanupOldVersions:1184-1439`, `lockCurrentVersion:1048-1156`, `cleanupNpmInstallations:1609-1708` |
| **测试证据** | 无直接测试覆盖 |

---

### 4.4 主控制流

完整原生安装与更新流（端到端）：

```text
用户运行 claude install 或 claude update
  ↓
update() 命令调用 getDoctorDiagnostic() 检测安装类型
  ↓
检查是否是包管理器安装：
  ├─ 是 → 提示用户用包管理器更新，退出
  └─ 否 → 继续
  ↓
调用 installLatest(channel, forceReinstall?)
  ↓
检查 inFlightInstall：
  ├─ 有 → 复用 in-flight Promise
  └─ 无 → 继续
  ↓
调用 updateLatest()
  ↓
调用 getLatestVersion() 获取目标版本
  ├─ USER_TYPE=ant → Artifactory npm 包
  └─ 外部用户 → GCS 二进制
  ↓
检查 maxVersion：
  ├─ 目标版本 > maxVersion → 降级到 maxVersion
  ├─ 当前版本 ≥ maxVersion → 跳过更新，直接返回成功
  └─ 否则 → 继续
  ↓
检查是否已在运行该版本且已安装：
  ├─ 是 → 跳过下载，只更新 symlink
  └─ 否 → 继续
  ↓
检查 ENABLE_LOCKLESS_UPDATES：
  ├─ 是 → 直接 performVersionUpdate()（无锁）
  └─ 否 → tryWithVersionLock() 带重试（3 次，指数退避）
    ↓
    尝试获取版本锁：
      ├─ PID 锁优先：检查锁文件内容，验证 PID 是否存活且是 Claude 进程
      └─ mtime 锁 fallback：使用 proper-lockfile，7 天 stale 超时
    ↓
    获取锁成功 → performVersionUpdate()
    ↓
performVersionUpdate()
  ↓
检查版本是否已安装或 forceReinstall：
  ├─ 已安装且不强制 → 跳过下载
  └─ 需要下载 → downloadVersion()
    ↓
    downloadVersion()：
      ├─ ant 用户 → downloadVersionFromArtifactory()
      │  ├─ npm view 获取 integrity
      │  ├─ 创建临时 package.json/package-lock.json
      │  └─ npm ci 安装到 staging（自动校验 integrity）
      └─ 外部用户 → downloadVersionFromBinaryRepo()
         ├─ fetch manifest.json 获取 checksum
         └─ downloadAndVerifyBinary() 下载并校验 sha256（60 秒 stall 检测，最多重试 3 次）
  ↓
installVersion()：
  ├─ npm 包 → installVersionFromPackage()：从 node_modules 提取二进制
  └─ 二进制 → installVersionFromBinary()：直接使用 staging 中的二进制
  ↓
atomicMoveToInstallPath()：
  ├─ 复制到 {version}.tmp.{pid}.{timestamp}
  ├─ chmod 0o755
  └─ 原子重命名到最终版本文件
  ↓
cleanup staging 目录
  ↓
updateSymlink()：
  ├─ Windows：
  │  ├─ 重命名旧文件为 claude.exe.old.{timestamp}（如果存在）
  │  ├─ 复制新版本到 claude.exe
  │  └─ 尝试删除旧文件（非阻塞，可能被占用）
  └─ Unix：
     ├─ 创建临时 symlink claude.tmp.{pid}.{timestamp}
     └─ 原子重命名到 claude
  ↓
验证可执行文件有效（isPossibleClaudeBinary）
  ↓
返回 success
  ↓
（后台）cleanupOldVersions()：
  ├─ 清理超过 1 小时的 staging 目录和 tmp 文件
  ├─ 清理 stale 锁文件（PID 锁：进程不存在；mtime 锁：超过 7 天）
  ├─ 清理 Windows 旧 .old 文件（超过 1 小时）
  ├─ 获取当前运行版本和 symlink 指向版本（保护不被清理）
  ├─ 获取所有版本文件，按 mtime 排序
  ├─ 保留最近两个未锁定版本
  └─ 删除其余版本（获取锁后删除）
  ↓
（如果是首次安装）saveGlobalConfig 设置 installMethod: 'native' 和 autoUpdates: false
  ↓
返回结果给用户
```

版本锁获取流：

```text
tryWithVersionLock(versionFilePath, callback, retries)
  ↓
检查 isPidBasedLockingEnabled()：
  ├─ 是 → PID 锁路径
  │  ├─ 循环最多 retries + 1 次：
  │  │  ├─ 调用 withLock(versionFilePath, lockfilePath, callback)
  │  │  ├─ 成功 → 返回 true
  │  │  └─ 失败 → 等待指数退避（min 1s，max 5s），重试
  │  └─ 所有重试失败 → 返回 false
  └─ 否 → mtime 锁路径
     ├─ lockfile.lock(versionFilePath, { stale: 7天, retries, lockfilePath })
     ├─ 成功 → 执行 callback，然后 release
     └─ 失败 → 返回 false
```

PID 锁获取流：

```text
tryAcquireLock(versionPath, lockfilePath)
  ↓
检查 isLockActive(lockfilePath)：
  ├─ 是 → 读取锁内容，记录 lockHolderPid，返回 null
  └─ 否 → 继续
  ↓
创建锁内容 VersionLockContent：
  { pid: process.pid, version: basename(versionPath), execPath: process.execPath, acquiredAt: Date.now() }
  ↓
原子写入锁文件：
  ├─ 写入临时文件 {lockfilePath}.tmp.{pid}.{timestamp}
  ├─ 原子重命名到 lockfilePath
  └─ 失败 → 返回 null
  ↓
验证锁（防止竞态）：
  ├─ 读取锁内容
  ├─ pid === process.pid → 成功，返回 release 函数
  └─ 否则 → 另一个进程赢得竞态，返回 null
  ↓
返回 release 函数（调用时检查是否仍拥有锁，是则删除）
```

### 4.4 数据结构与持久化

关键数据结构：

```typescript
// 安装/检查结果消息
type SetupMessage = {
  message: string
  userActionRequired: boolean
  type: 'path' | 'alias' | 'info' | 'error'
}

// PID 锁文件内容
type VersionLockContent = {
  pid: number
  version: string
  execPath: string
  acquiredAt: number  // Unix timestamp ms
}

// 包管理器类型
type PackageManager =
  | 'homebrew'
  | 'winget'
  | 'pacman'
  | 'deb'
  | 'rpm'
  | 'apk'
  | 'mise'
  | 'asdf'
  | 'unknown'
```

持久化：

- **版本目录**：`~/.local/share/claude/versions/{version}`，单个文件，权限 0o755
- **Staging 目录**：`~/.cache/claude/staging/{version}`（或带 pid/timestamp 后缀的 lockless 模式）
- **锁目录**：`~/.local/state/claude/locks/{version}.lock`，JSON 格式
- **Symlink/可执行文件**：`~/.local/bin/claude`（Unix）或 `~/.local/bin/claude.exe`（Windows）
- **Windows 旧文件**：`~/.local/bin/claude.exe.old.{timestamp}`（启动时清理超过 1 小时的）

恢复时：

- 启动时检查并清理 stale 锁文件
- 启动时清理过期 staging/tmp 文件
- 启动时清理 Windows 旧 .old 文件
- checkInstall() 可以检测并提示修复常见问题（PATH 缺失、symlink 损坏等）

### 4.6 跨子系统依赖

- **autoUpdater**：原生安装后禁用 legacy auto-updater，防止冲突
- **config**：`installMethod` 存储在 global config，用于检测安装类型
- **doctorDiagnostic**：提供安装类型检测，供 update 命令使用
- **packageManagers**：检测是否由包管理器安装，update 命令中尊重此选择
- **lockfile**：提供 mtime 锁实现，作为 PID 锁的 fallback
- **analytics**：记录安装/更新/清理事件（tengu_native_install_package_success、tengu_native_update_complete、tengu_native_version_cleanup 等）

## 5. 失败语义与工程取舍

| 触发条件 | 检测位置 | 消息/异常如何传播 | 是否重试及上限 | 状态与资源清理 | 调用方可见结果 |
|---|---|---|---|---|---|
| 下载 stall（60 秒无数据） | `downloadAndVerifyBinary()` AbortController | 抛出 StallTimeoutError，重试最多 3 次 | 3 次，每次之间 sleep 1 秒 | 清理不完整的 staging 目录 | 用户看到重试，最终成功或失败 |
| 下载 checksum 不匹配 | `downloadAndVerifyBinary()` 对比 sha256 | 抛出异常，不重试 | 否（损坏很可能是服务端问题） | 清理不完整的 staging 目录 | 用户看到错误，提示稍后重试或联系支持 |
| 锁获取失败（另一进程持有） | `tryWithVersionLock()` / `tryAcquireLock()` | 返回 false，installLatest 返回 lockFailed: true 和 lockHolderPid | 3 次（指数退避） | 不修改任何状态 | 用户看到提示："另一个 Claude 进程正在运行，请稍后重试" |
| 原子移动失败（如磁盘满） | `atomicMoveToInstallPath()` | 抛出异常 | 否 | 清理临时文件（`.tmp.{pid}.{timestamp}`） | 用户看到错误，提示释放磁盘空间 |
| symlink/可执行文件验证失败（如权限问题） | `performVersionUpdate()` 最后检查 | 抛出异常 | 否 | 不删除已安装的版本文件（用户可手动修复 symlink） | 用户看到错误，提示检查权限 |
| npm install 失败（Artifactory 路径） | `downloadVersionFromArtifactory()` | 抛出异常 | 否 | 清理 staging 目录 | 用户看到错误，提示检查网络或稍后重试 |
| maxVersion 限制（服务器端阻止更新） | `updateLatest()` 开头检查 | 不抛出，降级到 maxVersion 或跳过 | 否（无需重试） | 无（如果当前版本 ≥ maxVersion 则直接返回成功） | 用户看到已是最新版本（实际被服务器限制） |
| 包管理器安装检测（不自更新） | `update()` 命令开头 | 不抛出，提示用户用包管理器更新 | 否 | 无 | 用户看到提示："Claude 由 {packageManager} 管理，请用 {packageManager} 更新" |
| cleanupOldVersions 中删除版本时锁获取失败 | `cleanupOldVersions()` 中 tryWithVersionLock | 静默跳过该版本，继续清理其他 | 否（跳过即可） | 保留该版本不删除 | 用户无感知，日志记录 |
| lockCurrentVersion 锁获取失败 | `lockCurrentVersion()` | 静默忽略（非致命） | 否 | 无 | 用户无感知，该版本可能在运行中被清理（但有版本保留策略保护） |
| Windows 旧文件删除失败（仍在运行） | `updateSymlink()` 和 `cleanupOldVersions()` | 静默忽略 | 否 | 保留旧文件，下次启动时重试 | 用户无感知，旧文件最终会被清理 |

工程取舍：

| 取舍 | 当前选择 | 代价 | 收益 |
|---|---|---|---|
| 双重锁机制：PID 锁优先 + mtime 锁 fallback | 根据 isPidBasedLockingEnabled() 选择 | 代码复杂度增加，需要维护两套逻辑 | PID 锁能立即检测崩溃，mtime 锁保证兼容性和 fallback |
| 版本保留策略：保留最近两个 | VERSION_RETENTION_COUNT=2 | 占用更多磁盘空间（两个二进制约 200-300MB） | 快速回滚，无需重新下载 |
| Windows 上直接复制，不用 symlink | updateSymlink() 在 Windows 上执行复制 | 磁盘占用翻倍（两个文件），更新时需要重命名旧文件 | 无需管理员权限，兼容性好 |
| 同进程内去重用 inFlightInstall Promise | installLatest() 检查并复用 in-flight | 实现略复杂，需要管理 Promise 状态 | 多个调用点同时触发时只下载一次 |
| 锁文件放在 XDG state 目录，不与版本放一起 | getLockFilePathFromVersionPath() 返回独立路径 | 需要创建额外的 locks 目录 | 锁文件生命周期与版本文件解耦，清理版本时不会误删锁 |
| 失败开放：锁获取失败提示用户而非崩溃 | installLatest() 返回 lockFailed: true，lockCurrentVersion() 忽略失败 | 用户可能在极端情况下遇到竞态 | 高可用性，锁问题不阻止使用 |
| cleanupOldVersions() 不抛出，尽力而为 | 所有清理操作都有 try/catch，失败则跳过 | 可能残留一些垃圾文件 | 不会因为清理失败而影响主流程 |
| 下载 stall 检测 60 秒超时 + 3 次重试 | downloadAndVerifyBinary() 用 AbortController + 计时器 | 略增加下载时间（最坏情况 3*60 秒） | 网络卡顿时自动恢复，无需用户干预 |
| maxVersion 服务器端控制：可降级或跳过 | updateLatest() 检查 getMaxVersion() | 需要维护 GrowthBook 配置 | 快速回滚有问题的发布，无需等待用户手动操作 |
| 包管理器检测并尊重：不自更新 | update() 命令开头检查 getPackageManager() | 需要维护多种包管理器的检测逻辑 | 避免双重更新，尊重用户选择 |
| installMethod 配置：标记原生安装，禁用 legacy auto-updater | installLatest() 成功后设置 config | 需要在多个地方检查 installMethod | 防止 npm 更新与原生更新冲突 |
| 清理 npm 安装时保留 node_modules 作为安全网 | cleanupNpmInstallations() 只删除 symlink/可执行文件 | 可能残留一些文件 | 不会误删用户数据，更安全 |

## 6. 现状验收标准

| 初始状态与输入 | 执行场景 | 必须观察到的行为 | 禁止发生的副作用 |
|---|---|---|---|
| 未安装过原生版本 | 用户运行 claude install | 下载最新版本，安装到 ~/.local/share/claude/versions/，更新 symlink 到 ~/.local/bin/，提示 PATH | 不应该修改 npm 安装的版本 |
| 已安装旧版本，有新版本可用 | 用户运行 claude update | 下载新版本，原子切换 symlink，旧版本保留（最近两个），后台清理更旧的 | 不应该删除正在运行的版本 |
| 版本 A 正在运行，用户更新到版本 B | 进程 A 持有版本 A 的锁，用户运行 claude update 安装 B | 版本 B 安装成功，symlink 指向 B，cleanupOldVersions() 不删除 A（有锁） | 不应该删除正在运行的版本 A |
| 两个进程同时尝试更新同一版本 | 进程 A 和进程 B 同时调用 installLatest() | 只有一个成功获取锁并执行下载安装，另一个等待或提示 lockFailed | 不应该出现竞态导致版本文件损坏 |
| 下载过程中断网/进程被 kill | 下载中途失败 | staging 目录残留，下次启动时 cleanupOldVersions() 清理超过 1 小时的 staging | 不应该污染 versions 目录 |
| 下载完成但 checksum 不匹配 | downloadAndVerifyBinary() 校验失败 | 清理 staging，抛出错误，不安装 | 不应该安装损坏的二进制 |
| 用户通过 Homebrew 安装 | 用户运行 claude update | 提示"Claude 由 Homebrew 管理，请用 brew upgrade claude-code" | 不应该执行自更新 |
| 用户从 npm 安装切换到原生 | 用户运行 claude install 后，再运行 npm update -g @anthropic-ai/claude-code | 原生安装设置 installMethod: 'native' 并禁用 autoUpdates，npm 更新不会影响原生安装 | 不应该出现两个更新机制冲突 |
| Windows 上 claude.exe 正在运行 | 用户运行 claude update | 旧文件重命名为 claude.exe.old.{timestamp}，新文件复制为 claude.exe，下次启动时清理旧文件 | 不应该因为文件被占用而更新失败 |
| 服务器设置 maxVersion 阻止有问题的版本 | 用户尝试更新到 maxVersion 以上的版本 | 自动降级到 maxVersion，或如果当前版本 ≥ maxVersion 则跳过 | 不应该更新到有问题的版本 |
| 进程崩溃留下锁文件 | 进程崩溃后用户再次尝试更新 | PID 锁：检测到 PID 不存在，自动清理 stale 锁；mtime 锁：7 天后视为 stale | 不应该永久阻塞更新 |

## 7. 代码与测试证据

| 设计陈述 | 源码证据 | 测试场景与不变量 | 证据边界 |
|---|---|---|---|
| 双重锁机制：PID 锁优先 + mtime 锁 fallback | `src/utils/nativeInstaller/pidLock.ts:35-49` | 无直接测试 | 未找到直接测试覆盖 |
| 原子安装：staging 下载 + 原子移动 + 临时 symlink | `src/utils/nativeInstaller/installer.ts:300-448` | 无直接测试 | 未找到直接测试覆盖 |
| 版本保留策略：保留最近两个未锁定版本 | `src/utils/nativeInstaller/installer.ts:1184-1439` | 无直接测试 | 未找到直接测试覆盖 |
| 运行保护：lockCurrentVersion() 锁定正在运行的版本 | `src/utils/nativeInstaller/installer.ts:1048-1156` | 无直接测试 | 未找到直接测试覆盖 |
| 包管理器检测：尊重 Homebrew/winget/pacman/deb/rpm/apk/mise/asdf | `src/utils/nativeInstaller/packageManagers.ts:302-336` | 无直接测试 | 未找到直接测试覆盖 |
| 下载完整性校验：sha256（GCS）/ npm integrity（Artifactory） | `src/utils/nativeInstaller/download.ts:292-380` | 无直接测试 | 未找到直接测试覆盖 |
| 下载去重：同进程内 inFlightInstall Promise 共享 | `src/utils/nativeInstaller/installer.ts:954-974` | 无直接测试 | 未找到直接测试覆盖 |
| 下载 stall 检测：60 秒无数据则重试（最多 3 次） | `src/utils/nativeInstaller/download.ts:271-280` | 无直接测试 | 未找到直接测试覆盖 |
| maxVersion 服务器端限制：可降级或跳过 | `src/utils/nativeInstaller/installer.ts:510-533` | 无直接测试 | 未找到直接测试覆盖 |
| npm 安装与原生安装边界：installMethod 配置 + 禁用 legacy auto-updater | `src/utils/nativeInstaller/installer.ts:992-1017` | 无直接测试 | 未找到直接测试覆盖 |
| Windows 上直接复制 + 旧文件重命名 + 启动时清理 | `src/utils/nativeInstaller/installer.ts:648-722` | 无直接测试 | 未找到直接测试覆盖 |
| 过期 staging/tmp 文件清理：超过 1 小时的自动删除 | `src/utils/nativeInstaller/installer.ts:1188-1203` | 无直接测试 | 未找到直接测试覆盖 |
| cleanupNpmInstallations() 清理旧 npm 安装但保留 node_modules 作为安全网 | `src/utils/nativeInstaller/installer.ts:1608-1709` | 无直接测试 | 未找到直接测试覆盖 |

### 7.1 核心模块

| 文件 | 关键符号 | 说明 |
|---|---|---|
| `src/utils/nativeInstaller/installer.ts` | `installLatest`、`updateLatest`、`performVersionUpdate`、`checkInstall`、`lockCurrentVersion`、`cleanupOldVersions`、`cleanupNpmInstallations`、`tryWithVersionLock`、`atomicMoveToInstallPath`、`updateSymlink`、`getBaseDirectories`、`getVersionPaths`、`versionIsAvailable`、`isPossibleClaudeBinary`、`removeDirectoryIfEmpty`、`getPlatform`、`getBinaryName`、`VERSION_RETENTION_COUNT` | 核心安装、更新、检查、清理逻辑，锁管理，symlink 管理，原子操作 |
| `src/utils/nativeInstaller/download.ts` | `getLatestVersion`、`downloadVersion`、`downloadAndVerifyBinary`、`getLatestVersionFromArtifactory`、`downloadVersionFromArtifactory`、`getLatestVersionFromBinaryRepo`、`downloadVersionFromBinaryRepo`、`StallTimeoutError`、`MAX_DOWNLOAD_RETRIES`、`STALL_TIMEOUT_MS`、`GCS_BUCKET_URL`、`ARTIFACTORY_REGISTRY_URL` | 版本获取、下载、校验，支持 Artifactory 和 GCS 双源 |
| `src/utils/nativeInstaller/pidLock.ts` | `isPidBasedLockingEnabled`、`isLockActive`、`readLockContent`、`tryAcquireLock`、`withLock`、`acquireProcessLifetimeLock`、`cleanupStaleLocks`、`getAllLockInfo`、`isProcessRunning` | PID 锁实现，支持进程存活检测，stale 锁清理 |
| `src/utils/nativeInstaller/packageManagers.ts` | `getPackageManager`、`detectHomebrew`、`detectWinget`、`detectMise`、`detectAsdf`、`detectPacman`、`detectDeb`、`detectRpm`、`detectApk`、`getOsRelease`、`isDistroFamily` | 包管理器检测，支持多种包管理器和 Linux distro |
| `src/utils/nativeInstaller/index.ts` | (re-exports) | 公共 API 导出，只导出实际使用的符号 |
| `src/cli/update.ts` | `update()` | `/update` 命令实现，根据安装类型路由到原生或 npm 更新 |
| `src/utils/autoUpdater.ts` | `assertMinVersion()`、`getMaxVersion()`、`shouldSkipVersion()` | 最小版本检查、最大版本限制、跳过版本判断（与 nativeInstaller 共享使用） |

### 7.2 未覆盖行为（基于代码阅读）

- PID 锁与 mtime 锁切换的完整测试
- 并发更新的竞态测试（多进程同时更新）
- 运行中版本被保护不被清理的测试
- Windows 上正在运行的可执行文件更新测试
- 下载 stall 与重试的完整测试
- 包管理器检测的完整测试（各包管理器）
- checksum 不匹配的错误处理测试
- maxVersion 降级与跳过逻辑测试
- inFlightInstall 同进程去重测试
- 过期 staging/tmp 文件清理测试
- 原子 symlink 更新竞态测试
- npm 安装与原生安装边界测试
- cleanupNpmInstallations() 安全网测试

## 8. 文件覆盖与相关子系统

[Coverage](../../architecture/coverage/native-installer.yaml)

### 8.1 本 spec 主拥有的文件

| 分组 | 主拥有职责 |
|---|---|
| native-installer-core | 核心安装、更新、检查、清理逻辑，锁管理，symlink 管理，原子操作 |
| native-installer-download | 版本获取、下载、校验，支持 Artifactory 和 GCS 双源，stall 检测与重试 |
| native-installer-pid-lock | PID 锁实现，进程存活检测，stale 锁清理 |
| native-installer-package-managers | 包管理器检测，支持 Homebrew/winget/pacman/deb/rpm/apk/mise/asdf |
| native-installer-index | 公共 API 导出 |
| native-installer-cli-update | /update 命令实现，路由到原生或 npm 更新 |

### 8.2 共享证据但由其他 spec 主拥有的文件

- `src/utils/autoUpdater.ts` → 主归 auto-updater spec，本文只描述 getMaxVersion()、shouldSkipVersion()、assertMinVersion() 的共享使用
- `src/utils/config.ts` → 主归 global config spec，本文只描述 installMethod、autoUpdates、autoUpdatesProtectedForNative 的读写边界
- `src/utils/lockfile.ts` → 主归其他 spec，本文只描述作为 mtime 锁 fallback 的调用方式
- `src/utils/doctorDiagnostic.ts` → 主归 doctor spec，本文只描述安装类型检测的调用方式
- `src/cli/update.ts` → 部分内容由 auto-updater spec 主拥有，本文只描述原生安装相关部分

## 9. 改进建议

| 优先级 | 触发场景与证据 | 建议方向 | 回归风险 | 验收方式 | 工作量 | 置信度 |
|---|---|---|---|---|---|---|
| P2 | 已证实当前缺少原生安装器的核心测试覆盖（见 7.2 列表） | 增加完整的单元测试和集成测试，特别是并发、竞态、失败恢复场景 | 低（只加测试） | 所有核心场景都有测试覆盖 | L | 已证实 |
| P1 | Windows 上更新后旧文件可能残留较长时间（直到下次启动），如果用户长期不重启可能占用空间 | 尝试在后台进程中延迟删除旧文件（如 5 分钟后重试），或在下次 CLI 启动时立即清理而不是等待 1 小时 | 低（只优化清理时机） | Windows 上旧文件在更新后尽快被清理 | S | 已证实 |
| P2 | PID 锁虽然验证了进程命令，但 PID 复用仍有理论风险 | 在锁内容中增加启动时间戳（或其他进程唯一标识），验证时结合 PID 和启动时间 | 中（需要修改锁文件格式，保持向后兼容） | PID 复用不会导致误判锁有效 | M | 设计推断 |
| P2 | 当前 cleanupOldVersions() 按 mtime 排序版本，但 mtime 可能被用户或其他工具修改 | 在版本文件名或文件内容中存储版本号，直接解析版本号并用 semver 排序 | 中（需要处理旧版本文件没有版本号的情况） | 版本保留策略基于真实版本号而非 mtime | M | 设计推断 |
| P2 | 当前没有回滚命令，用户需要手动切换 symlink | 增加 `/rollback` 命令，自动切换到上一个版本 | 低（不改变现有流程，只增加新命令） | 用户可以用 claude rollback 快速回滚 | M | 设计推断 |
| P3 | 当前只保留最近两个版本，可配置性不足 | 允许用户通过配置或环境变量调整 VERSION_RETENTION_COUNT | 低（默认仍为 2，不影响现有行为） | 用户可以设置保留更多版本 | S | 设计推断 |
| P3 | 当前 staging 目录清理超时硬编码为 1 小时，可配置性不足 | 允许用户通过环境变量调整 staging/tmp 文件的清理超时 | 低（默认仍为 1 小时） | 用户可以设置更长或更短的清理超时 | S | 设计推断 |
