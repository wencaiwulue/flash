import { describe, expect, spyOn, test } from 'bun:test'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import share from '../src/commands/share/index.ts'
import {
  escapeHtml,
  renderConversationToHtml,
  resolveShareOutputPath,
  writeSharedHtml,
} from '../src/commands/share/shareHtml.ts'
import type { Message } from '../src/types/message.ts'

const base = { uuid: '00000000-0000-0000-0000-000000000000', timestamp: '' }
const user = (content: unknown): Message =>
  ({ ...base, type: 'user', message: { role: 'user', content } }) as Message
const assistant = (content: unknown): Message =>
  ({
    ...base,
    type: 'assistant',
    message: { role: 'assistant', content },
  }) as Message

describe('/share HTML', () => {
  test('escapes markup, event attributes, and closing pre tags as text', () => {
    const hostile = `<script>alert("x")</script> onmouseover=evil() </pre> & '`
    const html = renderConversationToHtml([user(hostile)], {
      includeToolOutput: false,
    })
    expect(html).not.toContain(hostile)
    expect(html).not.toContain('<script>alert')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&lt;/pre&gt;')
    expect(html).toContain('onmouseover=evil()')
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;')
  })

  test('tool output is opt-in and empty conversations are valid', () => {
    const messages = [
      assistant([
        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pwd' } },
      ]),
      user([
        { type: 'tool_result', tool_use_id: 't1', content: 'sensitive-output' },
      ]),
    ]
    const withoutTools = renderConversationToHtml(messages, {
      includeToolOutput: false,
    })
    const withTools = renderConversationToHtml(messages, {
      includeToolOutput: true,
    })
    expect(withoutTools).not.toContain('sensitive-output')
    expect(withoutTools).not.toContain('Tool call')
    expect(withTools).toContain('sensitive-output')
    expect(withTools).toContain('Tool call: Bash')
    expect(renderConversationToHtml([], { includeToolOutput: false })).toContain(
      'No conversation messages.',
    )
  })

  test('uses a real local-jsx command definition', async () => {
    expect(share.name).toBe('share')
    expect(share.isHidden).toBeUndefined()
    expect(share.type).toBe('local-jsx')
    expect((await share.load()).call).toBeFunction()
  })
})

describe('/share file boundaries', () => {
  test('rejects traversal, absolute paths, and non-HTML destinations', () => {
    expect(() => resolveShareOutputPath('../outside.html', '/tmp/project')).toThrow(
      'inside the current working directory',
    )
    expect(() => resolveShareOutputPath('/tmp/outside.html', '/tmp/project')).toThrow(
      'relative output path',
    )
    expect(() => resolveShareOutputPath('out.txt', '/tmp/project')).toThrow(
      'must end in .html',
    )
  })

  test('rejects a symlinked parent that escapes the workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude-share-root-'))
    const outside = await mkdtemp(join(tmpdir(), 'claude-share-outside-'))
    try {
      await symlink(outside, join(root, 'linked'), 'dir')
      expect(() => resolveShareOutputPath('linked/out.html', root)).toThrow(
        'must not escape through a symbolic link',
      )
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  test('writes exclusively and never overwrites or makes network requests', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-share-'))
    const fetchSpy = spyOn(globalThis, 'fetch')
    try {
      const destination = resolveShareOutputPath('nested.html', dir)
      await writeSharedHtml(destination, '<p>first</p>')
      expect(await readFile(destination, 'utf8')).toBe('<p>first</p>')
      await expect(writeSharedHtml(destination, '<p>second</p>')).rejects.toMatchObject({
        code: 'EEXIST',
      })
      expect(await readFile(destination, 'utf8')).toBe('<p>first</p>')
      await expect(
        writeSharedHtml(join(dir, 'missing', 'out.html'), 'failure'),
      ).rejects.toThrow()
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      fetchSpy.mockRestore()
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('an existing destination remains unchanged', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-share-existing-'))
    try {
      const destination = join(dir, 'existing.html')
      await writeFile(destination, 'original')
      await expect(writeSharedHtml(destination, 'replacement')).rejects.toThrow()
      expect(await readFile(destination, 'utf8')).toBe('original')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
