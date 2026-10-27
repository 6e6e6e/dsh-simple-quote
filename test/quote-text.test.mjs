import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_QUOTE_CHARS,
  blockText,
  buildQuoteBlock,
  composeDraft,
  formatTableRows,
  menuPosition,
  normalizeBlankLines,
  truncateMarkdown,
  wrapDelimited,
} from '../lib/quote-text.js'

const block = buildQuoteBlock('引用')

test('empty draft takes the quote block as-is', () => {
  assert.equal(composeDraft('', block), block)
  assert.equal(composeDraft('   \n\n', block), block)
})

test('non-empty draft is separated by one blank line', () => {
  assert.equal(composeDraft('已有内容', block), `已有内容\n\n${block}`)
  assert.equal(composeDraft('已有内容\n\n', block), `已有内容\n\n${block}`)
})

test('truncation closes an indented fence inside a list', () => {
  const source = `  \`\`\`ts\n${'const x = 1\n'.repeat(2000)}`
  const out = truncateMarkdown(source)
  assert.ok(out.length < source.length)
  assert.ok(out.endsWith('  ```\n…'), out.slice(-24))
})

test('truncation closes a blockquote fence', () => {
  const source = `> \`\`\`ts\n${'> const x = 1\n'.repeat(2000)}`
  const out = truncateMarkdown(source)
  assert.ok(out.endsWith('> ```\n…'), out.slice(-24))
})

test('truncation does not add a fence when none is open', () => {
  const source = '```ts\nsmall\n```\n' + 'x'.repeat(MAX_QUOTE_CHARS)
  const out = truncateMarkdown(source)
  assert.equal((out.match(/^`{3,}/gmu) ?? []).length, 2)
  assert.ok(out.endsWith('…'))
})

test('truncation does not split a surrogate pair', () => {
  const source = 'a'.repeat(MAX_QUOTE_CHARS - 1) + '😀' + 'b'.repeat(32)
  const out = truncateMarkdown(source)
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u.test(out))
  assert.ok(out.endsWith('…'))
})

test('blank lines collapse outside fences only', () => {
  const input = 'a\n\n\n\nb\n```\nx\n\n\ny\n```\n\n\nz'
  assert.equal(normalizeBlankLines(input), 'a\n\nb\n```\nx\n\n\ny\n```\n\nz')
})

test('menu sits right of the pointer and flips left near the right edge', () => {
  const viewport = { width: 1024, height: 768 }
  const size = { width: 120, height: 30 }
  assert.deepEqual(menuPosition({ x: 100, y: 100 }, size, viewport), { left: 110, top: 85 })
  assert.deepEqual(menuPosition({ x: 1000, y: 700 }, size, viewport), { left: 870, top: 685 })
  assert.deepEqual(menuPosition({ x: 1000, y: 760 }, size, viewport), { left: 870, top: 720 })
  assert.deepEqual(menuPosition({ x: 5, y: 5 }, size, viewport), { left: 15, top: 15 })
})

test('a single data row keeps the header and the row', () => {
  assert.equal(
    formatTableRows(['H1', 'H2'], [['a', '1']]),
    '| H1 | H2 |\n| --- | --- |\n| a | 1 |\n\n',
  )
})

test('inline wrapping keeps boundary whitespace', () => {
  assert.equal(wrapDelimited('粗体 ', '**', '**'), '**粗体** ')
  assert.equal(wrapDelimited(' 粗体', '**', '**'), ' **粗体**')
  assert.equal(wrapDelimited('   ', '**', '**'), '   ')
})

test('block text trims newlines and appends one blank line', () => {
  assert.equal(blockText('\n\na\n\n'), 'a\n\n')
  assert.equal(blockText('\n\n'), '')
})
