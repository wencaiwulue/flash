import { describe, test, expect } from 'bun:test'
import { spawnPty } from './pty-driver.ts'

const echoScript = `
let buf = ''
process.stdout.write('> ')
process.stdin.on('data', d => {
  buf += d
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (line === 'QUIT') process.exit(0)
    process.stdout.write(line.toUpperCase() + '\\n> ')
  }
})
`

describe('spawnPty', () => {
  test('writes input and waits for patterned output', async () => {
    const session = await spawnPty({
      cmd: [process.execPath, '-e', echoScript],
    })
    await session.waitFor('> ', 5000)
    session.write('hello pty\n')
    await session.waitFor(/HELLO PTY/, 5000)
    await session.waitFor('> ', 5000)
    session.write('QUIT\n')
    expect(await session.exited()).toBe(0)
  })

  test('waitFor times out with diagnostic output and session stays usable', async () => {
    const session = await spawnPty({ cmd: [process.execPath, '-e', echoScript] })
    await session.waitFor('> ', 5000)
    let message = ''
    try {
      await session.waitFor('NEVER_APPEARS', 800)
    } catch (error) {
      message = String((error as Error).message)
    }
    expect(message).toContain('NEVER_APPEARS')
    expect(message).toContain('> ')
    session.write('QUIT\n')
    expect(await session.exited()).toBe(0)
  })

  test('collects raw output including escape sequences', async () => {
    const session = await spawnPty({
      cmd: [process.execPath, '-e', "process.stdout.write('a\\u001B[31mb\\n')"],
    })
    await session.waitFor('b', 5000)
    await session.kill()
    expect(session.output()).toContain('\x1b[31m')
  })

  test('child runs with a real tty and requested size', async () => {
    const session = await spawnPty({
      cmd: ['sh', '-c', 'if [ -t 0 ]; then echo TTY-YES; else echo TTY-NO; fi; stty size'],
      cols: 40,
      rows: 10,
    })
    await session.waitFor('TTY-YES', 5000)
    const out = session.output()
    expect(out).toContain('TTY-YES')
    expect(out).toContain('10 40')
    await session.kill()
  })
})
