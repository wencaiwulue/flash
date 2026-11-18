#!/usr/bin/env python3
"""B1 交互事件 pty 驱动器（上游 2.1.311）。

在伪终端中启动交互 REPL，按时间序发送命令并收集全部输出。
hook 记录器把 stdin 写入 <out>/<event>.stdin.jsonl，本脚本只负责驱动交互。

用法（由 b1-hooks-probe.ts 调用）：
  b1-interactive.py <upstream> <cwd> <script.json>
script.json: {"steps":[{"send":"/probe a b","wait":6},...], "startup_wait":8}
环境（HOME/CLAUDE_CONFIG_DIR/RECORDER_MODE/ANTHROPIC_*）由调用方注入。
输出：原始终端字节写入 <script.json 同名>.transcript.txt。
"""
import json
import os
import pty
import select
import sys
import time


def main() -> None:
    upstream, cwd, script_path = sys.argv[1], sys.argv[2], sys.argv[3]
    with open(script_path) as f:
        script = json.load(f)
    transcript_path = script_path + ".transcript.txt"
    chunks = []

    pid, fd = pty.fork()
    if pid == 0:
        try:
            os.chdir(cwd)
            os.execve(upstream, [upstream], os.environ)
        finally:
            os._exit(127)

    def drain(duration: float) -> None:
        end = time.time() + duration
        while time.time() < end:
            r, _, _ = select.select([fd], [], [], 0.2)
            if fd in r:
                try:
                    data = os.read(fd, 65536)
                except OSError:
                    break
                if not data:
                    break
                chunks.append(data)

    try:
        drain(float(script.get("startup_wait", 8)))
        for step in script["steps"]:
            if "keys" in step:
                # 原始按键（方向键等），不追加回车
                os.write(fd, step["keys"].encode())
            else:
                os.write(fd, step["send"].encode() + b"\r")
            drain(float(step.get("wait", 5)))
        # 优雅退出
        os.write(fd, b"/exit\r")
        drain(3)
    finally:
        try:
            os.close(fd)
        except OSError:
            pass
        try:
            os.waitpid(pid, 0)
        except OSError:
            pass
        with open(transcript_path, "wb") as f:
            f.write(b"".join(chunks))


if __name__ == "__main__":
    main()
