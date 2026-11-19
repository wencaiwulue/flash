import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test'
import chalk from 'chalk'
import * as React from 'react'
import stripAnsi from 'strip-ansi'
import { Text } from '../src/ink.ts'
import { renderToScreen } from '../src/ink/render-to-screen.ts'
import { cellAt, charInCellAt } from '../src/ink/screen.ts'
import { stringWidth } from '../src/ink/stringWidth.ts'
import {
  getCliHighlightPromise,
  getLanguageName,
  type CliHighlight,
} from '../src/utils/cliHighlight.ts'
import {
  stripDisplayTags,
  stripDisplayTagsAllowEmpty,
  stripIdeContextTags,
} from '../src/utils/displayTags.ts'
import { generateHeatmap } from '../src/utils/heatmap.ts'
import { highlightMatch } from '../src/utils/highlightMatch.tsx'
import {
  createHyperlink,
  OSC8_START,
  OSC8_END,
} from '../src/utils/hyperlink.ts'
import {
  calculateLayoutDimensions,
  calculateOptimalLeftWidth,
  formatModelAndBilling,
  formatWelcomeMessage,
  getLayoutMode,
  truncatePath,
} from '../src/utils/logoV2Utils.ts'
import {
  applyMarkdown,
  configureMarked,
  padAligned,
} from '../src/utils/markdown.ts'
import type { ThemeName } from '../src/utils/theme.ts'
import {
  truncate,
  truncatePathMiddle,
  truncateStartToWidth,
  truncateToWidth,
  truncateToWidthNoEllipsis,
  wrapText,
} from '../src/utils/truncate.ts'

const originalChalkLevel = chalk.level
const testTheme: ThemeName = 'claude'

beforeEach(() => {
  chalk.level = 1
})

afterEach(() => {
  chalk.level = originalChalkLevel
  setSystemTime()
})

function withHyperlinks<T>(run: () => T): T {
  const previous = process.env.TERM_PROGRAM
  process.env.TERM_PROGRAM = 'ghostty'
  try {
    return run()
  } finally {
    if (previous === undefined) delete process.env.TERM_PROGRAM
    else process.env.TERM_PROGRAM = previous
  }
}

configureMarked()

describe('Markdown', () => {
  test('renders heading levels with their exact ANSI styles', () => {
    expect(applyMarkdown('# Heading 1', testTheme)).toBe(
      '\x1b[1m\x1b[3m\x1b[4mHeading 1\x1b[24m\x1b[23m\x1b[22m',
    )
    expect(applyMarkdown('## Heading 2', testTheme)).toBe(
      '\x1b[1mHeading 2\x1b[22m',
    )
    expect(applyMarkdown('### Heading 3', testTheme)).toBe(
      '\x1b[1mHeading 3\x1b[22m',
    )
  })

  test('renders code blocks verbatim without a highlighter', () => {
    expect(applyMarkdown('```\nconst x = 1\n```', testTheme)).toBe(
      'const x = 1',
    )
  })

  test('passes supported and unknown code languages to the highlighter boundary', () => {
    const calls: Array<{ text: string; language?: string }> = []
    const highlight: CliHighlight = {
      supportsLanguage: language => language === 'ts',
      highlight: (text, options) => {
        calls.push({ text, language: options.language })
        return `<${options.language}>${text}</>`
      },
    }
    expect(applyMarkdown('```ts\nconst x = 1\n```', testTheme, highlight)).toBe(
      '<ts>const x = 1</>',
    )
    expect(applyMarkdown('```not-real\nx\n```', testTheme, highlight)).toBe(
      '<plaintext>x</>',
    )
    expect(calls).toEqual([
      { text: 'const x = 1', language: 'ts' },
      { text: 'x', language: 'plaintext' },
    ])
  })

  test('renders inline code with the permission color', () => {
    expect(applyMarkdown('`code`', testTheme)).toBe('\x1b[97mcode\x1b[39m')
  })

  test('renders blockquotes with a dim bar and italic content', () => {
    expect(applyMarkdown('> quote', testTheme)).toBe(
      '\x1b[2m▎\x1b[22m \x1b[3mquote\x1b[23m',
    )
  })

  test('renders ordered and unordered list markers', () => {
    expect(stripAnsi(applyMarkdown('- Item 1\n- Item 2', testTheme))).toBe(
      '- Item 1\n- Item 2',
    )
    expect(stripAnsi(applyMarkdown('1. Item 1\n2. Item 2', testTheme))).toBe(
      '1. Item 1\n2. Item 2',
    )
  })

  test('renders emphasis and strong text with exact ANSI styles', () => {
    expect(applyMarkdown('*italic* **bold**', testTheme)).toBe(
      '\x1b[3mitalic\x1b[23m \x1b[1mbold\x1b[22m',
    )
  })

  test('keeps tilde text instead of parsing strikethrough', () => {
    expect(applyMarkdown('~100 and ~~literal~~', testTheme)).toBe(
      '~100 and ~~literal~~',
    )
  })

  test('renders links and bare URLs as exact OSC8 hyperlinks when supported', () => {
    withHyperlinks(() => {
      expect(applyMarkdown('[text](https://example.com)', testTheme)).toBe(
        `${OSC8_START}https://example.com${OSC8_END}\x1b[34mtext\x1b[39m${OSC8_START}${OSC8_END}`,
      )
      expect(applyMarkdown('https://example.com', testTheme)).toBe(
        `${OSC8_START}https://example.com${OSC8_END}\x1b[34mhttps://example.com\x1b[39m${OSC8_START}${OSC8_END}`,
      )
    })
  })

  test('mailto links show only the email without OSC8', () => {
    withHyperlinks(() => {
      const result = applyMarkdown('[email](mailto:user@example.com)', testTheme)
      expect(result).toBe('user@example.com')
      expect(result).not.toContain(OSC8_START)
    })
  })

  test('owner/repo#123 issue references use the exact GitHub issue URL', () => {
    withHyperlinks(() => {
      expect(applyMarkdown('See ant-ai/claude-code#123', testTheme)).toBe(
        `See ${OSC8_START}https://github.com/ant-ai/claude-code/issues/123${OSC8_END}\x1b[34mant-ai/claude-code#123\x1b[39m${OSC8_START}${OSC8_END}`,
      )
    })
  })

  test('renders table borders and left/center/right alignment exactly', () => {
    const result = applyMarkdown(
      '| Left | Center | Right |\n|------|:------:|------:|\n| A | B | C |',
      testTheme,
    )
    expect(stripAnsi(result)).toBe(
      '| Left | Center | Right |\n|------|--------|-------|\n| A    |   B    |     C |',
    )
  })

  test('padAligned pads using display width rather than ANSI length', () => {
    expect(padAligned('test', 4, 8, 'left')).toBe('test    ')
    expect(padAligned('test', 4, 8, 'right')).toBe('    test')
    expect(padAligned('test', 4, 8, 'center')).toBe('  test  ')
    expect(padAligned('\x1b[31m界\x1b[39m', 2, 4, 'left')).toBe(
      '\x1b[31m界\x1b[39m  ',
    )
  })
})

describe('Width & Truncation', () => {
  test('stringWidth calculates ASCII, CJK, emoji, and ANSI display width', () => {
    expect(stringWidth('hello')).toBe(5)
    expect(stringWidth('你好')).toBe(4)
    expect(stringWidth('😊')).toBe(2)
    expect(stringWidth('\x1b[31mred\x1b[0m')).toBe(3)
    expect(stringWidth('a😊b你好c')).toBe(9)
  })

  test('truncateToWidth truncates at grapheme boundaries with ellipsis', () => {
    expect(truncateToWidth('hello world', 8)).toBe('hello w…')
    expect(truncateToWidth('你好世界', 5)).toBe('你好…')
    expect(truncateToWidth('😊😊😊', 5)).toBe('😊😊…')
    expect(truncateToWidth('hello', 10)).toBe('hello')
    expect(truncateToWidth('hello', 1)).toBe('…')
  })

  test('truncateStartToWidth truncates from the start with ellipsis', () => {
    expect(truncateStartToWidth('hello world', 8)).toBe('…o world')
    expect(truncateStartToWidth('你好世界', 5)).toBe('…世界')
    expect(truncateStartToWidth('😊😊😊', 5)).toBe('…😊😊')
  })

  test('truncateToWidthNoEllipsis preserves whole graphemes', () => {
    expect(truncateToWidthNoEllipsis('hello world', 8)).toBe('hello wo')
    expect(truncateToWidthNoEllipsis('你好世界', 5)).toBe('你好')
    expect(truncateToWidthNoEllipsis('hello', 10)).toBe('hello')
    expect(truncateToWidthNoEllipsis('hello', 0)).toBe('')
  })

  test('truncatePathMiddle preserves the filename and respects display width', () => {
    const result = truncatePathMiddle('src/components/MyComponent.tsx', 25)
    expect(result).toContain('…')
    expect(result.endsWith('MyComponent.tsx')).toBe(true)
    expect(stringWidth(result)).toBeLessThanOrEqual(25)
    expect(truncatePathMiddle('short.txt', 20)).toBe('short.txt')
    expect(stringWidth(truncatePathMiddle('too-long-to-show.txt', 5))).toBeLessThanOrEqual(5)
  })

  test('truncate handles single-line and max-width contracts', () => {
    expect(truncate('hello\nworld', 10, true)).toBe('hello…')
    expect(truncate('hello world', 8)).toBe('hello w…')
    expect(truncate('hello', 10)).toBe('hello')
  })

  test('wrapText wraps at word and CJK display boundaries', () => {
    expect(wrapText('hello world test', 6)).toEqual(['hello ', 'world ', 'test'])
    expect(wrapText('你好世界', 4)).toEqual(['你好', '世界'])
  })
})

describe('displayTags', () => {
  test('strips lowercase blocks while preserving surrounding content', () => {
    expect(stripDisplayTags('<system>Hello</system>\nworld')).toBe('world')
    expect(stripDisplayTags('Hello\n<tag>world</tag>')).toBe('Hello')
  })

  test('preserves uppercase user tags', () => {
    expect(stripDisplayTags('<Button>Click</Button>')).toBe('<Button>Click</Button>')
    expect(stripDisplayTags('Use <MyComponent>')).toBe('Use <MyComponent>')
  })

  test('distinguishes fallback-to-original from allow-empty exactly', () => {
    expect(stripDisplayTags('<tag></tag>\n')).toBe('<tag></tag>\n')
    expect(stripDisplayTags('<tag>content</tag>\n')).toBe('<tag>content</tag>\n')
    expect(stripDisplayTagsAllowEmpty('<tag>content</tag>\n')).toBe('')
    expect(stripDisplayTagsAllowEmpty('<tag>content</tag>\nkeep')).toBe('keep')
  })

  test('strips only IDE context tags', () => {
    expect(stripIdeContextTags('<ide_opened_file>file.ts</ide_opened_file>\ncontent')).toBe('content')
    expect(stripIdeContextTags('<ide_selection>text</ide_selection>\ncontent')).toBe('content')
    expect(stripIdeContextTags('<other_tag>keep</other_tag>')).toBe('<other_tag>keep</other_tag>')
  })

  test('preserves unclosed tags and handles nested different tags', () => {
    expect(stripDisplayTags('<tag>text')).toBe('<tag>text')
    expect(stripDisplayTagsAllowEmpty('<outer><inner>x</inner></outer>\nkeep')).toBe('keep')
  })
})

describe('hyperlink', () => {
  test('creates the exact OSC8 sequence with display text', () => {
    expect(createHyperlink('https://example.com', 'text', { supportsHyperlinks: true })).toBe(
      `${OSC8_START}https://example.com${OSC8_END}\x1b[34mtext\x1b[39m${OSC8_START}${OSC8_END}`,
    )
  })

  test('falls back to the URL when unsupported', () => {
    expect(createHyperlink('https://example.com', 'text', { supportsHyperlinks: false })).toBe(
      'https://example.com',
    )
  })

  test('uses the URL as display text when content is omitted', () => {
    expect(createHyperlink('https://example.com', undefined, { supportsHyperlinks: true })).toBe(
      `${OSC8_START}https://example.com${OSC8_END}\x1b[34mhttps://example.com\x1b[39m${OSC8_START}${OSC8_END}`,
    )
  })
})

function renderHighlight(text: string, query: string) {
  const { screen, height } = renderToScreen(
    <Text>{highlightMatch(text, query)}</Text>,
    40,
  )
  let rendered = ''
  for (let x = 0; x < screen.width; x++) {
    rendered += charInCellAt(screen, x, 0) ?? ' '
  }
  return {
    height,
    text: rendered.trimEnd(),
    styleAt: (x: number) => cellAt(screen, x, 0)?.styleId,
  }
}

describe('highlightMatch', () => {
  test('returns the original string for an empty query or no match', () => {
    expect(highlightMatch('hello world', '')).toBe('hello world')
    expect(highlightMatch('hello world', 'xyz')).toBe('hello world')
  })

  test('uses real Ink inverse cells while preserving original casing', () => {
    const result = renderHighlight('Hello world', 'hello')
    expect(result.height).toBe(1)
    expect(result.text).toBe('Hello world')
    expect(result.styleAt(0)).not.toBe(result.styleAt(6))
    expect(result.styleAt(4)).toBe(result.styleAt(0))
    expect(result.styleAt(5)).toBe(result.styleAt(6))
  })

  test('highlights every match and leaves intervening text unchanged', () => {
    const result = renderHighlight('Hello world hello', 'hello')
    expect(result.text).toBe('Hello world hello')
    expect(result.styleAt(0)).toBe(result.styleAt(12))
    expect(result.styleAt(4)).toBe(result.styleAt(16))
    expect(result.styleAt(6)).not.toBe(result.styleAt(0))
    expect(result.styleAt(11)).not.toBe(result.styleAt(0))
  })
})

describe('cliHighlight', () => {
  test('loads the real highlighter and reuses the same promise', async () => {
    const first = getCliHighlightPromise()
    const second = getCliHighlightPromise()
    expect(first).toBe(second)
    const result = await first
    expect(result).not.toBeNull()
    expect(typeof result?.highlight).toBe('function')
    expect(typeof result?.supportsLanguage).toBe('function')
    expect(result?.supportsLanguage('typescript')).toBe(true)
    expect(result?.supportsLanguage('not-a-language')).toBe(false)
    expect(stripAnsi(result!.highlight('const x = 1', { language: 'typescript' }))).toContain('const x = 1')
  })

  test('reads exact language names from the real registry', async () => {
    expect(await getLanguageName('test.ts')).toBe('TypeScript')
    expect(await getLanguageName('test.js')).toBe('JavaScript')
    expect(await getLanguageName('test.py')).toBe('Python')
    expect(await getLanguageName('test.md')).toBe('Markdown')
    expect(await getLanguageName('test')).toBe('unknown')
  })
})

describe('heatmap', () => {
  beforeEach(() => {
    setSystemTime(new Date(2024, 0, 20, 12, 0, 0))
  })

  test('renders empty activity with day rows and legend', () => {
    const result = generateHeatmap([], { terminalWidth: 60, showMonthLabels: true })
    expect(result).toContain('Mon ')
    expect(result).toContain('Wed ')
    expect(result).toContain('Fri ')
    expect(result).toContain('Less')
    expect(result).toContain('More')
  })

  test('does not paint future activity into the grid', () => {
    const result = generateHeatmap(
      [
        { date: '2024-01-20', messageCount: 5 },
        { date: '2024-01-27', messageCount: 10 },
      ],
      { terminalWidth: 60, showMonthLabels: false },
    )
    const grid = result.split('\n').slice(0, 7).join('\n')
    expect(grid.match(/▒/g)).toHaveLength(1)
    expect(grid).not.toContain('█')
  })

  test('shows fixed month labels only when enabled', () => {
    const withLabels = generateHeatmap([], { terminalWidth: 60, showMonthLabels: true })
    const withoutLabels = generateHeatmap([], { terminalWidth: 60, showMonthLabels: false })
    expect(withLabels.split('\n')[0]).toContain('Jan')
    expect(withLabels.split('\n')).toHaveLength(withoutLabels.split('\n').length + 1)
  })

  test('renders all percentile intensity buckets with fixed data', () => {
    const activity = Array.from({ length: 20 }, (_, i) => ({
      date: `2024-01-${String(i + 1).padStart(2, '0')}`,
      messageCount: i + 1,
    }))
    const grid = generateHeatmap(activity, { terminalWidth: 60, showMonthLabels: false })
      .split('\n')
      .slice(0, 7)
      .join('\n')
    expect(grid).toContain('░')
    expect(grid).toContain('▒')
    expect(grid).toContain('▓')
    expect(grid).toContain('█')
  })
})

describe('logoV2Utils', () => {
  test('uses the 70-column layout threshold', () => {
    expect(getLayoutMode(69)).toBe('compact')
    expect(getLayoutMode(70)).toBe('horizontal')
    expect(getLayoutMode(100)).toBe('horizontal')
  })

  test('calculates exact horizontal and compact dimensions', () => {
    expect(calculateLayoutDimensions(100, 'horizontal', 40)).toEqual({
      leftWidth: 40,
      rightWidth: 53,
      totalWidth: 96,
    })
    expect(calculateLayoutDimensions(60, 'compact', 40)).toEqual({
      leftWidth: 56,
      rightWidth: 56,
      totalWidth: 56,
    })
  })

  test('calculates left width from the longest content with bounds', () => {
    expect(calculateOptimalLeftWidth('Welcome back!', '/path/to/repo', 'Model · Billing')).toBe(24)
    expect(calculateOptimalLeftWidth('x'.repeat(60), '', '')).toBe(50)
  })

  test('formats welcome messages for normal, long, and missing usernames', () => {
    expect(formatWelcomeMessage('Alice')).toBe('Welcome back Alice!')
    expect(formatWelcomeMessage('VeryLongUsernameExceedsLimit')).toBe('Welcome back!')
    expect(formatWelcomeMessage(null)).toBe('Welcome back!')
  })

  test('truncates relative and absolute paths with exact middle elision', () => {
    expect(truncatePath('src/components/MyComponent.tsx', 20)).toBe('sr/…/MyComponent.tsx')
    expect(truncatePath('src/MyComponent.tsx', 30)).toBe('src/MyComponent.tsx')
    expect(truncatePath('/absolute/path/to/file.tsx', 20)).toBe('/…/path/to/file.tsx')
  })

  test('formats model and billing with exact combined and split outputs', () => {
    expect(formatModelAndBilling('Claude 3.5', 'API Billing', 50)).toEqual({
      shouldSplit: false,
      truncatedModel: 'Claude 3.5',
      truncatedBilling: 'API Billing',
    })
    expect(formatModelAndBilling('Claude 3.5', 'API Billing', 10)).toEqual({
      shouldSplit: true,
      truncatedModel: 'Claude 3.5',
      truncatedBilling: 'API Billi…',
    })
  })
})
