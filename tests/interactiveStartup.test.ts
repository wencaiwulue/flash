import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'

const distMain = join(import.meta.dir, '..', 'dist', 'main.js')
const CRASH_MARKERS = ['ResolveMessage', 'MODULE_NOT_FOUND', 'Cannot find module']

describe.skipIf(
  process.platform === 'win32' || !existsSync(distMain),
  'needs a unix pty and a prior bun run build',
)('interactive startup smoke', () => {
  test('dist build renders the version banner without crashing', async () => {
    const home = await mkdtemp(join(tmpdir(), 'flash-pty-home-'))
    let killed = false

    try {
      return await new Promise<void>((resolve, reject) => {
        // script 语法分平台：BSD/macOS 用位置参数，Linux (util-linux) 必须用 -c
        const innerCommand = `${process.execPath} ${distMain}`
        const scriptArgs =
          process.platform === 'darwin'
            ? ['-q', '/dev/null', process.execPath, distMain]
            : ['-qec', innerCommand, '/dev/null']
        const proc = spawn('script', scriptArgs, {
          cwd: join(import.meta.dir, '..'),
          // 剥掉 CI 类变量：CLI 检测到 CI=true 会走托管环境分支、不渲染交互 UI，
          // 而本测试要冒烟的是"真实终端下的交互启动"
          env: {
            ...process.env,
            HOME: home,
            USERPROFILE: home,
            CI: '',
            GITHUB_ACTIONS: '',
            GITLAB_CI: '',
            CIRCLECI: '',
            BUILDKITE: '',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
          // 独立进程组：kill 时把 script + 内层 CLI 一起带走，不留孤儿干扰后续测试文件
          detached: true,
        })

        let output = ''
        // 进程超时 20s，测试超时 25s（留 5s 余量给 kill + 退出等待）
        const killTree = () => {
          if (killed || proc.pid === undefined) return
          killed = true
          try {
            // 负 PID 杀整个进程组（script + bun dist/main.js 及其子进程）
            process.kill(-proc.pid, 'SIGKILL')
          } catch {
            proc.kill('SIGKILL')
          }
        }
        const timer = setTimeout(killTree, 20_000)

        const decoder = new TextDecoder()

        const onData = (data: Buffer) => {
          if (output.length < 64_000) {
            output += decoder.decode(data, { stream: true })
          }
          // pty 输出含 ANSI 转义序列，正则用 [^v]* 容忍颜色/光标控制字符
          if (/flash[^v]*v\d+\.\d+\.\d+/.test(output)) {
            killTree()
          }
        }

        proc.stdout.on('data', onData)
        proc.stderr.on('data', onData)

        proc.on('close', () => {
          clearTimeout(timer)
          try {
            expect(output).toMatch(/flash[^v]*v\d+\.\d+\.\d+/)
            for (const marker of CRASH_MARKERS) {
              expect(output).not.toContain(marker)
            }
            resolve()
          } catch (e) {
            reject(e)
          }
        })

        proc.on('error', reject)
      })
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }, 25_000)
})
