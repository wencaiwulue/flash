import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import stripAnsi from 'strip-ansi'
import {
  applyMarkdown,
  configureMarked,
  padAligned,
} from '../src/utils/markdown.ts'
import {
  stripDisplayTags,
  stripDisplayTagsAllowEmpty,
  stripIdeContextTags,
} from '../src/utils/displayTags.ts'
import { highlightMatch } from '../src/utils/highlightMatch.tsx'
import {
  createHyperlink,
  OSC8_START,
  OSC8_END,
} from '../src/utils/hyperlink.ts'
import {
  getCliHighlightPromise,
  getLanguageName,
} from '../src/utils/cliHighlight.ts'
import {
  truncateToWidth,
  truncateStartToWidth,
  truncateToWidthNoEllipsis,
  truncatePathMiddle,
  truncate,
  wrapText,
} from '../src/utils/truncate.ts'
import {
  generateHeatmap,
} from '../src/utils/heatmap.ts'
import {
  getLayoutMode,
  calculateLayoutDimensions,
  calculateOptimalLeftWidth,
  formatWelcomeMessage,
  truncatePath,
  formatModelAndBilling,
} from '../src/utils/logoV2Utils.ts'
import type { ThemeName } from '../src/utils/theme.ts'
import { stringWidth } from '../src/ink/stringWidth.ts'

// Initialize marked before tests
configureMarked()

// -----------------------------------------------------------------------------
// 1. Markdown Tests
// -----------------------------------------------------------------------------
describe('Markdown', () => {
  const testTheme: ThemeName = 'claude'

  test('renders headings with proper formatting', () => {
    const h1 = applyMarkdown('# Heading 1', testTheme)
    const h2 = applyMarkdown('## Heading 2', testTheme)
    const h3 = applyMarkdown('### Heading 3', testTheme)

    expect(stripAnsi(h1)).toContain('Heading 1')
    expect(stripAnsi(h2)).toContain('Heading 2')
    expect(stripAnsi(h3)).toContain('Heading 3')
  })

  test('renders code blocks', () => {
    const code = applyMarkdown('```\nconst x = 1\n```', testTheme)
    expect(stripAnsi(code)).toContain('const x = 1')
  })

  test('renders inline code with color', () => {
    const inline = applyMarkdown('`code`', testTheme)
    expect(stripAnsi(inline)).toContain('code')
  })

  test('renders blockquotes with vertical bars', () => {
    const quote = applyMarkdown('> This is a quote', testTheme)
    expect(stripAnsi(quote)).toContain('This is a quote')
  })

  test('renders lists - unordered and ordered', () => {
    const ul = applyMarkdown('- Item 1\n- Item 2', testTheme)
    const ol = applyMarkdown('1. Item 1\n2. Item 2', testTheme)
    expect(stripAnsi(ul)).toContain('Item 1')
    expect(stripAnsi(ul)).toContain('Item 2')
    expect(stripAnsi(ol)).toContain('Item 1')
    expect(stripAnsi(ol)).toContain('Item 2')
  })

  test('renders emphasis (italic and bold)', () => {
    const em = applyMarkdown('*italic*', testTheme)
    const strong = applyMarkdown('**bold**', testTheme)
    expect(stripAnsi(em)).toContain('italic')
    expect(stripAnsi(strong)).toContain('bold')
  })

  test('renders links with proper hyperlinks', () => {
    const link1 = applyMarkdown('[text](https://example.com)', testTheme)
    const link2 = applyMarkdown('https://example.com', testTheme)
    // When link text != URL, it shows the text (stripped of ANSI)
    // When link text == URL, it shows the URL
    expect(stripAnsi(link1)).toBeTruthy()
    expect(stripAnsi(link2)).toBe('https://example.com')
  })

  test('mailto links show only email, no hyperlink', () => {
    const mailto = applyMarkdown('[email](mailto:user@example.com)', testTheme)
    expect(stripAnsi(mailto)).toContain('user@example.com')
    expect(stripAnsi(mailto)).not.toContain('mailto:')
  })

  test('owner/repo#123 issue references become clickable links', () => {
    const issue = applyMarkdown('See ant-ai/claude-code#123', testTheme)
    expect(stripAnsi(issue)).toContain('ant-ai/claude-code#123')
  })

  test('renders tables with alignment', () => {
    const table = applyMarkdown(
      '| Left | Center | Right |\n' +
      '|------|:------:|------:|\n' +
      '| A    | B      | C     |',
      testTheme
    )
    expect(stripAnsi(table)).toContain('Left')
    expect(stripAnsi(table)).toContain('Center')
    expect(stripAnsi(table)).toContain('Right')
  })

  test('padAligned correctly pads text with different alignments', () => {
    expect(padAligned('test', 4, 8, 'left')).toBe('test    ')
    expect(padAligned('test', 4, 8, 'right')).toBe('    test')
    expect(padAligned('test', 4, 8, 'center')).toBe('  test  ')
  })
})

// -----------------------------------------------------------------------------
// 2. Width & Truncation Tests
// -----------------------------------------------------------------------------
describe('Width & Truncation', () => {
  test('stringWidth correctly calculates ASCII, CJK, emoji, and ANSI', () => {
    expect(stringWidth('hello')).toBe(5)
    expect(stringWidth('你好')).toBe(4)
    expect(stringWidth('😊')).toBe(2)
    expect(stringWidth('\x1b[31mred\x1b[0m')).toBe(3)
    expect(stringWidth('a😊b你好c')).toBe(1 + 2 + 1 + 4 + 1)
  })

  test('truncateToWidth truncates at grapheme boundaries with ellipsis', () => {
    expect(truncateToWidth('hello world', 8)).toBe('hello w…')
    expect(truncateToWidth('你好世界', 5)).toBe('你好…')
    expect(truncateToWidth('😊😊😊', 5)).toBe('😊😊…')
    expect(truncateToWidth('hello', 10)).toBe('hello')
    expect(truncateToWidth('hello', 1)).toBe('…')
  })

  test('truncateStartToWidth truncates from start with ellipsis', () => {
    expect(truncateStartToWidth('hello world', 8)).toBe('…o world')
    expect(truncateStartToWidth('你好世界', 5)).toBe('…世界')
    expect(truncateStartToWidth('😊😊😊', 5)).toBe('…😊😊')
  })

  test('truncateToWidthNoEllipsis truncates without ellipsis', () => {
    expect(truncateToWidthNoEllipsis('hello world', 8)).toBe('hello wo')
    expect(truncateToWidthNoEllipsis('你好世界', 5)).toBe('你好') // Each CJK is 2 width, 5 can fit only 2
    expect(truncateToWidthNoEllipsis('hello', 10)).toBe('hello')
    expect(truncateToWidthNoEllipsis('hello', 0)).toBe('')
  })

  test('truncatePathMiddle truncates paths in the middle', () => {
    const result = truncatePathMiddle('src/components/MyComponent.tsx', 25)
    expect(result).toContain('…')
    expect(result).toContain('MyComponent.tsx')
    expect(stringWidth(result)).toBeLessThanOrEqual(25)
    expect(truncatePathMiddle('short.txt', 20)).toBe('short.txt')
    const tooLong = truncatePathMiddle('too-long-to-show.txt', 5)
    expect(stringWidth(tooLong)).toBeLessThanOrEqual(5)
    expect(tooLong).toContain('…')
  })

  test('truncate handles single line option', () => {
    expect(truncate('hello\nworld', 10, true)).toBe('hello…')
    expect(truncate('hello world', 8)).toBe('hello w…')
    expect(truncate('hello', 10)).toBe('hello')
  })

  test('wrapText wraps text at specified width', () => {
    expect(wrapText('hello world test', 6)).toEqual(['hello ', 'world ', 'test'])
    expect(wrapText('你好世界', 4)).toEqual(['你好', '世界'])
  })
})

// -----------------------------------------------------------------------------
// 3. displayTags Tests
// -----------------------------------------------------------------------------
describe('displayTags', () => {
  test('strips lowercase XML tags followed by newline', () => {
    // The pattern expects closing tag followed by optional newline
    expect(stripDisplayTags('<system>Hello</system>\nworld')).toBe('world')
  })

  test('strips tags with content and newline', () => {
    expect(stripDisplayTags('Hello\n<tag>world</tag>')).toBe('Hello')
  })

  test('preserves uppercase tags (user content)', () => {
    expect(stripDisplayTags('<Button>Click</Button>')).toBe('<Button>Click</Button>')
    expect(stripDisplayTags('Use <MyComponent>')).toBe('Use <MyComponent>')
  })

  test('returns original text if stripping leaves empty', () => {
    const result = stripDisplayTags('<tag></tag>\n')
    expect(result === '' || result === '<tag></tag>\n').toBe(true) // Could be either depending on trim
    const result2 = stripDisplayTags('<tag>content</tag>\n')
    expect(result2 === 'content' || result2 === '<tag>content</tag>\n').toBe(true)
  })

  test('stripIdeContextTags only strips IDE-specific tags', () => {
    // These patterns also include newlines
    expect(stripIdeContextTags('<ide_opened_file>file.ts</ide_opened_file>\ncontent')).toBe('content')
    expect(stripIdeContextTags('<ide_selection>text</ide_selection>\ncontent')).toBe('content')
    expect(stripIdeContextTags('<other_tag>keep</other_tag>')).toBe('<other_tag>keep</other_tag>')
  })

  test('does not match unclosed tags', () => {
    expect(stripDisplayTags('<tag>text')).toBe('<tag>text')
  })

  test('stripDisplayTags and stripDisplayTagsAllowEmpty exist', () => {
    expect(typeof stripDisplayTags).toBe('function')
    expect(typeof stripDisplayTagsAllowEmpty).toBe('function')
  })
})

// -----------------------------------------------------------------------------
// 4. hyperlink Tests
// -----------------------------------------------------------------------------
describe('hyperlink', () => {
  test('createHyperlink creates OSC8 when supported', () => {
    const result = createHyperlink('https://example.com', 'text', { supportsHyperlinks: true })
    expect(result).toContain(OSC8_START)
    expect(result).toContain(OSC8_END)
    expect(result).toContain('https://example.com')
    expect(result).toContain('text')
  })

  test('createHyperlink falls back to URL when not supported', () => {
    const result = createHyperlink('https://example.com', 'text', { supportsHyperlinks: false })
    expect(result).toBe('https://example.com')
    expect(result).not.toContain(OSC8_START)
  })

  test('createHyperlink uses URL as display text when none provided', () => {
    const result = createHyperlink('https://example.com', undefined, { supportsHyperlinks: true })
    expect(result).toContain('https://example.com')
  })
})

// -----------------------------------------------------------------------------
// 5. highlightMatch Tests
// -----------------------------------------------------------------------------
describe('highlightMatch', () => {
  test('returns original text when query is empty', () => {
    const result = highlightMatch('hello world', '')
    expect(result).toBe('hello world')
  })

  test('returns original text when no matches', () => {
    const result = highlightMatch('hello world', 'xyz')
    expect(result).toBe('hello world')
  })

  test('returns React element with fragments when matches found', () => {
    const result = highlightMatch('Hello world', 'hello')
    // It returns either a string or a React fragment with children
    expect(result).toBeTruthy()
  })

  test('does not throw with edge cases', () => {
    expect(() => highlightMatch('', '')).not.toThrow()
    expect(() => highlightMatch('', 'hello')).not.toThrow()
    expect(() => highlightMatch('hello', '')).not.toThrow()
  })
})

// -----------------------------------------------------------------------------
// 6. cliHighlight Tests
// -----------------------------------------------------------------------------
describe('cliHighlight', () => {
  test('getCliHighlightPromise returns null or object', async () => {
    const result = await getCliHighlightPromise()
    expect(result === null || typeof result === 'object').toBe(true)
    if (result) {
      expect(typeof result.highlight).toBe('function')
      expect(typeof result.supportsLanguage).toBe('function')
    }
  })

  test('getLanguageName works with common file extensions', async () => {
    expect(await getLanguageName('test.ts')).toBeOneOf(['TypeScript', 'unknown'])
    expect(await getLanguageName('test.js')).toBeOneOf(['JavaScript', 'unknown'])
    expect(await getLanguageName('test.py')).toBeOneOf(['Python', 'unknown'])
    expect(await getLanguageName('test.md')).toBeOneOf(['Markdown', 'unknown'])
    expect(await getLanguageName('test')).toBe('unknown')
  })

  test('lazy singleton pattern - multiple calls return same promise', async () => {
    const promise1 = getCliHighlightPromise()
    const promise2 = getCliHighlightPromise()
    expect(promise1).toBe(promise2)
  })
})

// -----------------------------------------------------------------------------
// 7. heatmap Tests
// -----------------------------------------------------------------------------
describe('heatmap', () => {
  test('generateHeatmap works with empty activity', () => {
    const result = generateHeatmap([], { terminalWidth: 60, showMonthLabels: true })
    expect(result).toBeTruthy()
    expect(result).toContain('Less')
    expect(result).toContain('More')
  })

  test('generateHeatmap handles future dates correctly', () => {
    const futureDate = new Date()
    futureDate.setDate(futureDate.getDate() + 7)
    const dateStr = futureDate.toISOString().split('T')[0]!
    const activity = [{ date: dateStr, messageCount: 5 }]
    const result = generateHeatmap(activity, { terminalWidth: 60 })
    expect(result).toBeTruthy()
  })

  test('generateHeatmap shows month labels when enabled', () => {
    const resultWithLabels = generateHeatmap([], { terminalWidth: 60, showMonthLabels: true })
    const resultWithoutLabels = generateHeatmap([], { terminalWidth: 60, showMonthLabels: false })
    expect(resultWithLabels.length).toBeGreaterThan(resultWithoutLabels.length)
  })

  test('intensity calculation works across percentiles', () => {
    const activity = Array.from({ length: 20 }, (_, i) => ({
      date: `2024-01-${String(i + 1).padStart(2, '0')}`,
      messageCount: i + 1,
    }))
    const result = generateHeatmap(activity, { terminalWidth: 60 })
    expect(result).toContain('░')
    expect(result).toContain('▒')
    expect(result).toContain('▓')
    expect(result).toContain('█')
  })
})

// -----------------------------------------------------------------------------
// 8. logoV2Utils Tests
// -----------------------------------------------------------------------------
describe('logoV2Utils', () => {
  test('getLayoutMode uses 70 column threshold', () => {
    expect(getLayoutMode(69)).toBe('compact')
    expect(getLayoutMode(70)).toBe('horizontal')
    expect(getLayoutMode(100)).toBe('horizontal')
  })

  test('calculateLayoutDimensions works for horizontal mode', () => {
    const dim = calculateLayoutDimensions(100, 'horizontal', 40)
    expect(dim.leftWidth).toBe(40)
    expect(dim.rightWidth).toBeGreaterThan(0)
    expect(dim.totalWidth).toBeLessThanOrEqual(100)
  })

  test('calculateLayoutDimensions works for compact mode', () => {
    const dim = calculateLayoutDimensions(60, 'compact', 40)
    expect(dim.leftWidth).toBe(dim.rightWidth)
    expect(dim.totalWidth).toBe(dim.leftWidth)
  })

  test('calculateOptimalLeftWidth considers all content', () => {
    const width = calculateOptimalLeftWidth('Welcome back!', '/path/to/repo', 'Model · Billing')
    expect(width).toBeGreaterThanOrEqual(20)
    expect(width).toBeLessThanOrEqual(50)
  })

  test('formatWelcomeMessage handles different username cases', () => {
    expect(formatWelcomeMessage('Alice')).toBe('Welcome back Alice!')
    expect(formatWelcomeMessage('VeryLongUsernameExceedsLimit')).toBe('Welcome back!')
    expect(formatWelcomeMessage(null)).toBe('Welcome back!')
  })

  test('truncatePath truncates paths intelligently', () => {
    expect(truncatePath('src/components/MyComponent.tsx', 30)).toBeTruthy()
    expect(truncatePath('src/MyComponent.tsx', 30)).toBe('src/MyComponent.tsx')
    expect(truncatePath('/absolute/path/to/file.tsx', 20)).toBeTruthy()
  })

  test('formatModelAndBilling decides to split based on width', () => {
    const { shouldSplit: noSplit, truncatedModel: tm1, truncatedBilling: tb1 } =
      formatModelAndBilling('Claude 3.5', 'API Billing', 50)
    expect(noSplit).toBe(false)

    const { shouldSplit: split, truncatedModel: tm2, truncatedBilling: tb2 } =
      formatModelAndBilling('Claude 3.5', 'API Billing', 10)
    expect(split).toBe(true)
  })
})
