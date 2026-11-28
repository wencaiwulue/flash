import { describe, test, expect } from 'bun:test'
import { stripAnsi } from './ansi.ts'

describe('stripAnsi', () => {
  test('plain text unchanged', () => {
    expect(stripAnsi('hello world')).toBe('hello world')
  })
  test('strips SGR color codes', () => {
    expect(stripAnsi('\x1b[32mgreen\x1b[0m')).toBe('green')
  })
  test('strips cursor movement and erase sequences', () => {
    expect(stripAnsi('\x1b[2J\x1b[3;5Htext')).toBe('text')
  })
  test('strips OSC window title', () => {
    expect(stripAnsi('\x1b]0;flash title\x07body')).toBe('body')
  })
  test('strips OSC with ST terminator', () => {
    expect(stripAnsi('\x1b]8;;http://x\x1b\\link')).toBe('link')
  })
  test('keeps readable text across Ink frames', () => {
    const frame = '\x1b[1m\x1b[36mflash\x1b[39m\x1b[22m v0.0.3\x1b[0m'
    expect(stripAnsi(frame)).toBe('flash v0.0.3')
  })
})
