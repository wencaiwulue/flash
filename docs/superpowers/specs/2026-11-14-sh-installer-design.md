---
title: POSIX sh 独立二进制安装器与发布资产设计
date: 2026-11-14
status: approved
---

# POSIX sh 独立二进制安装器与发布资产设计

本文约定实施后的安装与发布行为，不表示安装器、测试、Release 工作流或真实 Release 已验证通过。

## 1. 问题与约束

独立归档已经提供原生二进制和 checksum，但 macOS/Linux 用户仍须手工识别平台、选择版本、下载两个文件、筛选 checksum、解包并安全替换命令。把这些步骤复制到 README 不仅容易出错，还可能诱导用户使用不校验摘要的 `curl | tar`、通过 `sudo` 写入系统目录，或用会跟随目标 symlink 的复制方式覆盖其他文件。

本功能提供一个可从 GitHub Releases 直接执行的 POSIX `sh` 安装器：

```bash
(
  set -e
  installer="$(mktemp)"
  trap 'rm -f "$installer"' EXIT
  curl -fsSL https://github.com/wencaiwulue/flash/releases/latest/download/install.sh -o "$installer"
  sh "$installer"
)
```

设计必须同时满足以下约束：

- 脚本使用 POSIX `sh` 和 `set -eu`，不能依赖 Bash 数组、`pipefail`、关联数组或 `[[ ... ]]`。
- 默认解析最新 Release；显式 `VERSION` 只接受与现有发布规则一致的严格 `vX.Y.Z`，包括拒绝前导零和预发布后缀。
- `INSTALL_DIR` 默认是 `$HOME/.local/bin`，由用户目录权限完成安装，不调用 `sudo`，不自动修改 shell rc 文件，不读取交互输入。
- 仅支持 Darwin/Linux，机器名 `arm64`/`aarch64` 映射为 `arm64`，`x86_64`/`amd64` 映射为 `x64`；Windows 继续走手动 `.zip` 流程。
- 必须依赖 `curl`、`uname`、`tar`、`mktemp` 以及 `sha256sum` 或 `shasum -a 256`，并使用标准 POSIX 文件工具；缺少任何所选工具都应明确失败。
- 从同一 Release 下载归档和 `SHA256SUMS`，要求清单中恰好一个与所选归档文件名完全匹配的合法条目，再比较实际 SHA-256。缺失、重复、格式错误或不匹配均不能解包安装。
- tar 只提取精确的 `claude-code` 成员；平台归档中的两份 README 和其他潜在成员不能被撒入安装目录。
- 最终 staging 文件必须由目标同目录的 `mktemp` 创建，写入后设为 `0755`，再用同文件系统内的原子 `mv` 替换目标。若目标是普通文件或指向普通文件的 symlink，应替换目录项本身，不能覆盖 symlink referent。
- 临时目录和 staging 文件在成功、失败、HUP/INT/TERM 时均清理；失败发生在提交点之前时，既有目标保持原样。
- 下载基址默认为 `https://github.com/wencaiwulue/flash/releases`。`CLAUDE_CODE_DOWNLOAD_BASE_URL` 只供测试注入本地 HTTP fake release，不是公开镜像配置或生产绕过开关。
- Release 工作流必须使用 `sh -n scripts/install.sh` 做语法门禁，并将源码脚本以 `install.sh` 名称发布。六个归档 + `SHA256SUMS` + `install.sh` 恰好构成八个公开资产；不得新增 ShellCheck 依赖。
- checksum 提供 Release 资产完整性检查，但不等同于代码签名、公证或抵御 Release 与清单同时被篡改。HTTPS、GitHub Release 和 checksum 的信任边界必须准确表述。

README 双语内容与归档内的双文档打包由 [README 英中拆分设计](2026-11-14-readme-language-split-design.md) 负责；本设计只消费其中的归档命名和 `SHA256SUMS` 契约。

## 2. 设计理由与备选方案

### 2.1 为什么使用 Release redirect，而不是 GitHub API

未指定 `VERSION` 时，安装器对 `${RELEASES_URL}/latest` 发起 `curl -fsSL -o /dev/null -w '%{url_effective}'`，要求最终 URL 位于同一 releases-root 的 `${RELEASES_URL}/tag/` 下，再取其后的严格 `vX.Y.Z` 作为版本。生产默认 URL 因而落在 `/releases/tag/vX.Y.Z`，本地 override 则使用对应的 `/tag/vX.Y.Z`。随后资产从 `${RELEASES_URL}/download/${VERSION}/...` 下载。

这种方式直接复用 GitHub 对 latest 的判定，不需要 JSON 解析器，也不引入 API 速率限制和 API 响应 schema。最终 URL 仍须经过同一严格版本检查，不能把任意 redirect 路径或查询参数拼进资产 URL。

显式版本存在时不请求 latest redirect。这样固定版本安装是确定性的，也便于测试证明没有额外解析请求。

### 2.2 为什么先下载脚本，并把主体包在 `main()` 中

普通 POSIX `curl | sh` 管道只返回 `sh` 的状态：下载失败时，空输入可能让 `sh` 以零退出，造成假成功。公共命令因此在 `set -e` 子 shell 中先用 `curl -o` 下载到 `mktemp` 文件，成功后才交给 `sh`，并通过 EXIT trap 删除脚本；下载或安装的非零状态都会传回调用者。

直接把脚本通过管道执行仍是可能的调用方式，因此脚本顶部只做 `set -eu`、常量/环境初始化和函数定义，不执行网络或文件系统安装副作用；唯一安装入口 `main "$@"` 放在完整脚本末尾。截断脚本最多形成初始化、函数定义或语法错误，不应执行半个 `main`。这不是对恶意脚本的沙箱，也不能替代 HTTPS，但能缩小意外截断的执行面。

### 2.3 为什么先验证清单条目，再计算和比较摘要

`SHA256SUMS` 含六个归档条目，不能用未锚定的 `grep` 选取子串，也不能把多个匹配行交给平台工具后假定它一定拒绝。安装器逐行读取清单，只接受：

```text
<64 个小写十六进制字符>  <精确的归档文件名>
```

匹配条目计数必须等于一。文件名中的点不按正则处理，其他五个条目被忽略，重复行和零匹配都失败。随后根据可用工具计算摘要，只取工具输出的第一个空白前字段，并与预期值做字面比较。摘要验证成功之前不调用 tar，避免让未验证归档进入解析器。

工具选择顺序为 `sha256sum`，否则 `shasum -a 256`。二者输出都兼容“摘要 + 文件名”的常见格式，但安装器不信任输出中的文件名，只使用计算出的摘要字段。

### 2.4 为什么分离临时工作目录与目标同目录 staging

下载和解包只需要临时空间，不要求提前创建或写入安装目录，因此使用 `${TMPDIR:-/tmp}/claude-code-install.XXXXXX`。这样 404、checksum、tar 和成员检查失败时，甚至尚未执行 `mkdir -p "$INSTALL_DIR"`。

最终提交不能直接把该工作文件跨文件系统 `mv` 到目标，否则可能退化为非原子复制。只有最终 staging 在目标同目录创建：

```sh
mkdir -p "$INSTALL_DIR"
staging_file=$(mktemp "$INSTALL_DIR/.claude-code.XXXXXX")
cp "$work_dir/claude-code" "$staging_file"
chmod 0755 "$staging_file"
mv -f "$staging_file" "$INSTALL_DIR/claude-code"
staging_file=''
```

`mktemp` 已独占创建 staging，`cp` 写入的是这个新文件而不是目标；`chmod` 在提交前完成；最后的同文件系统 rename 替换目录项，不会像直接 `cp source "$INSTALL_DIR/claude-code"` 那样跟随目标 symlink 写 referent。若目标是目录（包括解析到目录的 symlink），安装器在 staging 前明确失败，避免 `mv` 把文件移入目录。

这一布局把工作目录清理交给 TMPDIR，把原子性要求限制在最终 staging 所在目录。安装目录仅在归档已经验证和解包后才需要可写，隐藏 staging 也由同一 trap 清理。

### 2.5 为什么测试只注入下载基址，而不注入安全开关

本地 HTTP server 可以提供 latest redirect、tag 页面、归档和清单，让测试不依赖公网、GitHub 状态或真实发布版本。`CLAUDE_CODE_DOWNLOAD_BASE_URL` 是 releases-root override：测试把 server 根 URL 注入后，完整覆盖其 `/latest`、`/tag/...` 和 `/download/...` 流程；生产默认 root 才是 `https://github.com/wencaiwulue/flash/releases`。

不提供跳过 checksum、强制安装、允许非严格版本、自定义可执行文件名或禁用清理的环境变量。测试通过伪造工具目录和 Release 内容进入失败路径，而不是为测试增加生产旁路。生产文档只给固定 GitHub URL；内部 override 不承诺镜像兼容性或 HTTPS 以外的生产安全。

### 2.6 备选方案与不采用原因

| 备选方案 | 不采用原因 |
|---|---|
| 使用 GitHub API 获取 latest | 需要 JSON 解析和额外错误/schema 处理，并引入 API rate limit；redirect 已提供所需版本 |
| 使用 Bash 并依赖 `pipefail` | 与 POSIX `sh` 目标不符，macOS/Linux 的 `/bin/sh` 不保证 Bash 特性 |
| `curl ... | tar` 直接解到安装目录 | 无法在解包前验证整个归档 SHA-256，也可能把 README 或恶意额外成员写入目录 |
| 只下载归档，不下载 `SHA256SUMS` | 无法发现损坏、错误资产或测试 fake 中的摘要不匹配 |
| 用 `grep "$archive"` 取 checksum | 点和子串会误匹配，重复条目处理不明确，不能表达恰好一个精确条目 |
| 在 `/tmp` staging 后直接移动 | 与目标可能不同文件系统，失去 rename 原子性 |
| `cp` 或 `cat > "$INSTALL_DIR/claude-code"` 覆盖目标 | 写入期间读者可看到部分内容，并会跟随目标 symlink 修改 referent |
| 安装到 `/usr/local/bin` 并自动 `sudo` | 扩大权限、引入交互和策略差异，不符合无 sudo、无 prompts 的用户级安装约束 |
| 自动编辑 `.profile`/`.zshrc` | 不同 shell 和启动文件语义复杂，自动写用户配置超出一个原子二进制安装器的职责 |
| 把 `CLAUDE_CODE_DOWNLOAD_BASE_URL` 公开为任意镜像功能 | 会扩大 TLS、镜像同步和兼容性承诺；本变量只用于本地 fake release |
| 在 Release job 安装 ShellCheck | 增加工具安装和网络依赖；本功能只要求现有 `sh -n` 语法门禁，测试负责行为验证 |
| 把 `install.sh` 加入六个平台归档或 `SHA256SUMS` | 安装器是入口资产，不属于归档；现有清单严格覆盖六个归档，改变它会破坏既有校验流程 |

## 3. 目标与非目标

### 目标

- **版本解析**：默认从 latest redirect 获得严格版本；显式版本跳过 redirect，所有版本统一验证。
- **目标映射**：Darwin/Linux 和四种机器别名映射到既有 `darwin/linux`、`arm64/x64` 归档名。
- **完整性与解包**：使用同一 Release 的 `SHA256SUMS`，恰好一个精确条目和摘要匹配后才只解出 `claude-code`。
- **安全提交**：用户目录可写、同目录独占 staging、提交前 `0755`、原子 rename、替换 symlink 本身而非 referent。
- **失败与清理**：无自动重试和隐式降级；错误非零退出，临时资源在退出和 HUP/INT/TERM 时清理，提交前旧目标不变。
- **可观察结果**：成功后目标执行的是下载的新二进制；PATH 不包含安装目录时只打印指导，不写配置。
- **可测试性**：本地 fake release 和受控工具目录覆盖 latest、四个代表性平台映射、checksum、解包、原子替换和清理失败路径，不需要公网；不把该套件描述为信号或全组合测试。
- **发布契约**：Release validate 执行 `sh -n`；publish 将脚本作为 `install.sh`，公开资产集合恰好八项。

### 非目标

- 不支持 Windows、其他 Unix、x86 32 位、RISC-V 或 musl 专用构建，也不自动选择 Rosetta。
- 不提供 npm/Homebrew 包、系统服务、自动更新、卸载器、版本回滚或并发锁。
- 不提供代码签名、macOS 公证、SBOM、GPG/cosign 验证，也不声称 checksum 能防御 Release 和清单同时被恶意替换。
- 不自动使用 `sudo`、不提示确认、不读取 stdin、不修改 shell rc、不创建桌面入口。
- 不执行新二进制的 `--version` 作为安装成功的必要条件；真实二进制的版本/帮助 smoke 由原生 Release build 负责，安装器只交付已验证字节。
- 不保证断电、`SIGKILL`、文件系统损坏或恶意本地管理员场景下的清理和恢复。
- 不迁移或删除旧安装，也不删除用户已经安装的二进制来回滚仓库代码。
- 不承诺任意第三方镜像、代理或 `CLAUDE_CODE_DOWNLOAD_BASE_URL` 的生产支持。

## 4. 架构、模块与数据流

### 4.1 入口、环境变量与内部接口

公开入口只有脚本和三个用户可见输入：

| 输入 | 默认值 | 合法值与副作用 |
|---|---|---|
| stdin 脚本 | GitHub latest 的 `install.sh` | `sh` 读取完整脚本，最后调用 `main`；脚本不读取安装确认输入 |
| `VERSION` | 未设置或空字符串时解析 latest | 严格 `vX.Y.Z`；决定所有下载路径，不能含前缀 `v` 之外的额外字符 |
| `INSTALL_DIR` | `$HOME/.local/bin` | 非空目录路径；必要时 `mkdir -p`，最终目标固定为 `$INSTALL_DIR/claude-code` |
| `PATH` | 调用者环境 | 用于查找工具；只影响安装后是否打印 PATH 指导，脚本不改写它 |

内部测试输入：

| 输入 | 默认值 | 边界 |
|---|---|---|
| `CLAUDE_CODE_DOWNLOAD_BASE_URL` | `https://github.com/wencaiwulue/flash/releases` | 测试设为本地 server 的 releases-root，消费 `/latest`、`/tag`、`/download`；不是 README 公开配置，也没有 checksum 绕过能力 |

实际内部函数只有以下通用边界；版本解析、目标选择和 checksum 检查在 `main` 中内联，不要求拆成额外函数：

```sh
main "$@"                  # 编排并拒绝位置参数
valid_version value       # 用严格 vX.Y.Z 正则返回成功/失败
require_command name      # 缺工具时经 fail 退出
cleanup                   # 清理 work_dir/staging_file，保留原失败；纯清理失败返回非零
fail message              # stderr + exit 1
```

`work_dir` 和 `staging_file` 只由本次进程拥有，不读取已有临时文件恢复安装。rename 后立即把 `staging_file` 置空，避免 cleanup 误删已提交目标。

### 4.2 模块与状态所有权

| 模块/对象 | 拥有的状态 | 主要操作 | 不承担的职责 |
|---|---|---|---|
| `scripts/install.sh` | 当前进程的环境、目标元数据、work_dir、staging_file、退出 trap | 解析、下载、校验、解包、提交、PATH 提示 | 不编译二进制，不创建 Release，不验证模型服务 |
| `${TMPDIR:-/tmp}/claude-code-install.XXXXXX/` | 本次下载的 archive、SHA256SUMS 和唯一解出的 binary | 隔离未提交内容，退出时递归删除 | 不要求位于 INSTALL_DIR，不作为缓存或断点续传目录 |
| `$INSTALL_DIR/.claude-code.XXXXXX` | 已通过校验并已写全的新 binary | `chmod 0755` 后成为 rename source | 不跨文件系统移动，不被其他安装复用 |
| `$INSTALL_DIR/claude-code` | 唯一对外命令路径 | 提交点原子替换 | 不保存备份，不跟随 symlink referent 写入 |
| `tests/installScript.test.ts` | fake Release、fake uname/工具目录、临时 HOME/TMPDIR/INSTALL_DIR、子进程和请求记录 | 通过真实 `sh` 子进程验证端到端语义 | 不访问真实 GitHub，不用 mock 函数代替脚本行为 |
| `.github/workflows/release.yml` | 语法门禁和显式上传列表 | `sh -n`、直接上传 `scripts/install.sh` 为 `install.sh`，与七项既有资产组成八项 | 不在 Ubuntu 上替代 macOS 行为测试，不做额外 staging 或安装 ShellCheck |

下载/解包临时状态位于 TMPDIR；只有最终 staging 位于 INSTALL_DIR，以保证 rename 的文件系统一致性。成功和失败都不保留下载缓存；再次安装重新解析和下载。

### 4.3 主控制流

```text
curl -fsSL <latest>/install.sh -o "$installer"（set -e 子 shell + trap）
  → 下载成功后：sh "$installer"
  → sh: set -eu，初始化并定义函数，完整文件末尾调用 main
  → 安装 EXIT/HUP/INT/TERM trap
  → require_command preflight；选择 sha256sum 或 shasum
  → 确定 INSTALL_DIR 默认值；uname -s/-m 映射 platform/arch
  → VERSION 为空？
      ├─ 是：curl -L <releases-root>/latest，读取 url_effective
      │       → 要求同一 root 的 /tag/vX.Y.Z → VERSION
      └─ 否：不访问 latest
  → valid_version：严格 vX.Y.Z，否则退出 1
  → asset = claude-code-${VERSION}-${platform}-${arch}.tar.gz
  → work_dir = mktemp -d ${TMPDIR:-/tmp}/claude-code-install.XXXXXX
  → curl SHA256SUMS 与 archive 到 work_dir
  → awk：精确文件名匹配计数必须等于 1，digest 格式合法
  → 计算实际 digest；不一致则失败，尚未 tar
  → tar -xzf archive -C work_dir claude-code，只选择该成员
  → 要求解出文件为 regular file 且不是 symlink
  → mkdir -p INSTALL_DIR；若 target 为目录则失败
  → staging_file = mktemp INSTALL_DIR/.claude-code.XXXXXX
  → cp 已验证 binary 到 staging；chmod 0755 staging
  → mv -f staging target；staging_file 置空             ← 唯一提交点
  → 打印成功信息，必要时打印 PATH 指导
  → EXIT trap 删除 work_dir；返回 0
```

显式版本、平台映射和资产命名均发生在网络资产请求之前。latest 解析本身需要一次网络请求；失败时没有可安全猜测的 fallback 版本。

### 4.4 清单与文件布局

所选文件名严格为：

```text
claude-code-vX.Y.Z-darwin-arm64.tar.gz
claude-code-vX.Y.Z-darwin-x64.tar.gz
claude-code-vX.Y.Z-linux-arm64.tar.gz
claude-code-vX.Y.Z-linux-x64.tar.gz
```

清单的合法匹配行严格为 64 个小写十六进制字符、两个空格、上述完整文件名和换行。其他五行属于其他归档，可以存在但不参与计算。CRLF、额外空格、`*filename` 形式、大写摘要、重复匹配或缺失匹配都拒绝；这与构建脚本当前 `formatChecksumManifest()` 的输出契约一致。

工作目录与最终安装目录分离：

```text
${TMPDIR:-/tmp}/claude-code-install.XXXXXX/
├── claude-code-vX.Y.Z-<platform>-<arch>.tar.gz
├── SHA256SUMS
└── claude-code                  # 仅校验后由 tar 提取

$INSTALL_DIR/
├── .claude-code.XXXXXX          # 最终同目录 staging，提交前 0755
└── claude-code                  # 最终原子替换目标
```

成功后两个临时路径都消失；平台归档内的 `README.md`、`README.zh-CN.md` 不会出现在安装目录。临时文件名由 `mktemp` 生成，脚本不用 PID 作为“唯一”文件名，也不先检查再创建。

### 4.5 清理、信号和并发语义

`trap` 在创建临时路径之前安装，变量初始为空。EXIT trap 记录原状态、禁用重入 trap、尽力删除非空 work_dir/staging_file，再以原状态退出。HUP、INT、TERM 分别通过 `exit 129`、`130`、`143` 进入同一 EXIT 清理；不能用直接 `kill -9` 或让多个信号处理器重复递归清理。

提交后立即使 `staging_file` 变量失去所有权，避免 cleanup 删除已经 rename 的目标路径。work_dir 始终可以删除。清理失败不能覆盖最初的安装错误；成功路径若只有清理失败，应输出诊断并返回非零，但不能宣称已提交的二进制被回滚。

并发安装没有锁：不同进程使用不同 `mktemp` 路径，各自提交完整文件，最后一次 rename 决定目标内容。允许不同显式版本的并发安装，但不承诺先到请求最终胜出；任何时刻读者只能看到旧完整文件或新完整文件，不能看到 staging 的部分写入。

### 4.6 Release 发布流

```text
validate (ubuntu-latest)
  → actions/checkout + setup-bun
  → sh -n scripts/install.sh（只解析，不执行、不联网）
  → 既有 package/tag 校验

verify/build
  → 复用 CI
  → 六个原生 runner 编译、双 README 打包、直接/解包 smoke、sidecar

publish（仅 tag）
  → 下载 build candidates
  → 校验恰好六个归档及 sidecar，生成/复验 SHA256SUMS
  → action-gh-release 显式上传六个归档、SHA256SUMS 和源码路径 scripts/install.sh
  → 源码 basename 使最后一项公开资产名为 install.sh；无 build/release 复制或独立预发布八项检查
```

`.sha256` sidecar 继续作为 workflow 中间产物，不进入公开 Release。`install.sh` 不进入六个平台归档，也不改变 `SHA256SUMS` 的六条记录。手动 dry-run 不进入 publish，因此不能凭 dry-run 声称真实 Release 已有八项资产。

## 5. 失败语义与工程取舍

| 触发条件 | 检测位置 | 退出与重试 | 状态与清理 | 调用方可见结果 |
|---|---|---|---|---|
| 脚本下载失败或被截断 | 公共命令的 `curl -f`/子 shell `set -e`；直接管道执行时由末尾 `main` 调用降低部分脚本执行面 | 非零，不自动重试 | 公共命令删除临时脚本，顶层无安装副作用 | 下载失败不会执行空脚本并报告成功，也不应执行半个安装 |
| latest HTTP/redirect 失败 | `curl -fsSL ... -w url_effective` | 非零，无 fallback | 清理已创建路径 | stderr 诊断，目标不变 |
| latest 最终 URL 不在同一 releases-root 的 `/tag/` 下或版本无效 | main 内联 URL 检查 + `valid_version` | 退出 1 | 不请求任意推导出的资产 | 拒绝空版本、查询串、其他 root 或 malformed tag |
| 显式 VERSION 非严格格式 | `valid_version` | 在资产请求之前退出 1；显式版本不请求 latest | 无临时状态 | 拒绝 `1.2.3`、`v1.2`、`v01.2.3`、prerelease 等 |
| 缺少 curl/uname/tar/mktemp/文件工具 | `command -v` preflight | 退出 1，不降级到其他协议实现 | 目标不变 | 消息指出缺失工具 |
| 无 sha256sum 和 shasum | digest 工具选择 | 退出 1，不跳过校验 | work_dir 清理，目标不变 | 明确提示需要 SHA-256 工具 |
| OS/arch 不支持 | `uname` 映射 | 退出 1 | 不下载资产 | Windows 等用户改用手动归档，不生成错误文件名 |
| HOME 未设且未给 INSTALL_DIR | 默认值计算 | 退出 1 | 不创建目录 | 不猜测系统目录或调用 sudo |
| mkdir/mktemp 权限失败 | 对应命令和 `set -e` | 非零，不重试 | 只清理本次非空路径 | 既有目标不变，无系统级提权 |
| archive 或清单 HTTP/传输失败 | curl `-f` 和命令状态 | 非零，无部分文件复用 | work_dir 清理，目标不变 | 不使用残留 archive 继续安装 |
| 清单零个或多个精确匹配 | 逐行计数 | 退出 1 | 未运行 tar，目标不变 | 不选择第一行或让工具隐式处理重复 |
| 匹配条目 digest 非 64 位小写 hex | 条目格式检查 | 退出 1 | 未运行 tar | 不接受空白、CRLF、大写或二进制 `*` 标记作为兼容格式 |
| 实际 digest 不匹配 | main 内联字面比较 | 退出 1 | 未运行 tar，目标不变 | 显示不匹配诊断，不打印完整敏感环境信息 |
| tar 失败或缺少 `claude-code` | tar 状态及文件检查 | 非零 | work_dir/stage 清理，目标不变 | 不解出 README 或其他成员 |
| 解出成员不是 regular file 或是 symlink | `-f` 与 `-L`/`-h` 检查 | 退出 1 | 不复制到 stage | 不跟随归档内 symlink 写外部文件 |
| 目标是目录 | 提交前 `-d` 检查 | 退出 1 | stage/work_dir 清理，目录不变 | 避免 mv 将文件塞进目录 |
| cp/chmod/mv 失败 | `set -e` | 非零，无自动重试 | 提交前目标不变；staging_file/work_dir 清理 | 不留下 0755 的部分目标 |
| 已有目标是文件 symlink | rename 目录项 | 成功返回 0 | symlink 路径成为新 regular file | referent 内容不变，目标 mode 为 0755 |
| HUP/INT/TERM | signal trap → 固定 128+signal 退出 | 分别 129/130/143，不重试 | EXIT trap 删除本次路径 | 提交前旧目标保留；提交后不自动回滚 |
| 清理失败 | cleanup 内显式诊断 | 不覆盖原始失败；纯成功清理失败则非零 | 已提交 binary 不撤销 | 不能把“脚本非零”解释为所有路径都未改变 |
| PATH 不含 INSTALL_DIR | 提交后的 case 检查 | 安装仍成功 | 不写配置文件 | stdout 给出 export 示例，用户自行持久化 |
| 两个安装器并发 | 独占 mktemp + atomic rename | 无锁、无重试 | 各自清理临时路径 | 最后 rename 胜出，不暴露部分写入 |

工程上选择“失败即停止、重新执行完整命令”而不是断点续传或恢复状态机。这样不需要信任上次下载的部分文件，也避免恢复逻辑扩大攻击面。代价是失败后的网络重复传输和安装目录临时写入，但语义可用本地端到端测试逐项验证。

## 6. 验收标准

### 安装成功路径

1. 未设置 `VERSION` 且 `INSTALL_DIR` 为空时，fake `/latest` redirect 到同一 server 的 `/tag/v1.2.3`，安装器使用 `$HOME/.local/bin`；PATH 已包含该目录时不重复打印 export 指导。
2. 四个代表性映射分别覆盖 Darwin `arm64`、Darwin `x86_64`、Linux `aarch64`、Linux `amd64`，请求对应归档；不把这四个用例描述为所有 OS/alias 交叉组合或两种 digest 实现的穷尽测试。
3. fake archive 含 `claude-code` 和两份 README，安装后目录只有 `claude-code`，TMPDIR 工作路径被清理，最终 mode 精确为 `0755`，fake binary 可执行并输出目标标识。
4. PATH 不含安装目录时打印 export 指导但不修改 shell 配置；已有目标 symlink 被新 regular file 替换，referent 字节不变。

### 失败、原子性与清理

1. `VERSION=v1.2` 在下载前失败；不支持 OS/arch 在下载前失败；不存在版本的 HTTP 404 不安装目标。严格版本函数仍拒绝其他非法形式，但离线套件不声称穷举所有拼写。
2. wrong、missing、duplicate、malformed 四类所选 checksum 条目均导致非零退出，既有目标内容不变，TMPDIR 清理完成。
3. 缺失 `claude-code`、checksum 正确但损坏的 tar、归档内 binary 为 symlink 均失败，不安装目标并清理工作目录。
4. 两种 checksum 工具都缺失时在下载前明确失败；这不等同于分别执行两种工具成功路径的覆盖声明。
5. 安装完成后的 work_dir 清理失败会输出 Warning 并返回 1，已提交的新 binary 保持 `0755`；原始安装失败与清理失败同时发生时保留原失败状态。
6. 脚本没有 `sudo`、交互 `read`、checksum bypass、curl `-k`/`--insecure` 或自动 shell rc 写入。HUP/INT/TERM 的 129/130/143 和 target-dir/mv 等路径仍是设计契约，不把它们写成当前离线套件已覆盖的验收场景。

### 发布与工程验收

1. Release validate 在任何 build 之前执行 `sh -n scripts/install.sh`；该步骤不运行安装器、不访问 GitHub Release，也不安装 ShellCheck。
2. publish 的上传列表直接包含 `scripts/install.sh`，其公开 basename 为 `install.sh`；不复制到 `build/release/`，也不增加独立的预发布八项 staging 检查。
3. 显式上传列表产生六个平台归档、`SHA256SUMS` 和 `install.sh` 共八项；六个 `.sha256` sidecar 不上传，清单仍只含六个归档。真实资产集合在发布后核对，而不是由本地测试声称已验证。
4. 双语 README 仍随每个归档分发；回滚安装器不得删除 `README.zh-CN.md` 或恢复单文档归档。

以下是实施后的验收命令，不是历史结果：

```bash
sh -n scripts/install.sh
bun run test tests/installScript.test.ts
bun run test tests/releasePackaging.test.ts
bun run typecheck
bun run build
bun run build:binary
bun run test
git diff --check
```

还应在 Release dry-run 中确认 validate 的语法步骤和六个原生 build，但不得把 dry-run 描述为已发布。真实 tag Release 只有经维护者正常授权发布后，才能用 `gh release view <tag> --json assets` 核对八项资产，并从公开 latest URL 做一次干净用户目录安装；该项属于发布后验证，不应由本地 fake 或 CI 模拟结果代替。
