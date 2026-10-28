/**
 * Edge cases found while reviewing 0.0.4.
 *
 * These pin down inputs the normal path rarely produces. All four are fixed
 * and the file is part of `npm test`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { selectionToMarkdown } from '../lib/selection-markdown.js'
import { truncateMarkdown } from '../lib/quote-text.js'

function setup(html) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`)
  globalThis.document = dom.window.document
  return dom.window.document
}

/** KaTeX's real output shape: a MathML copy plus an aria-hidden visual copy. */
const KATEX =
  '<span class="katex">' +
  '<span class="katex-mathml"><math><semantics><mrow><msup><mi>x</mi><mn>2</mn></msup></mrow>' +
  '<annotation encoding="application/x-tex">x^2</annotation></semantics></math></span>' +
  '<span class="katex-html" aria-hidden="true"><span class="mord">x</span><span class="msupsub">2</span></span>' +
  '</span>'

test('KaTeX: a whole-formula selection quotes the TeX source', () => {
  const document = setup(`<p>前 ${KATEX} 后</p>`)
  const range = document.createRange()
  range.selectNodeContents(document.querySelector('.katex'))
  // Sanity check: this one already works today.
  assert.equal(selectionToMarkdown(range), '$x^2$')
})

test('KaTeX: a selection *inside* the formula still quotes the TeX source', () => {
  const document = setup(`<p>前 ${KATEX} 后</p>`)
  const glyph = document.querySelector('.katex-html .mord').firstChild
  const range = document.createRange()
  range.setStart(glyph, 0)
  range.setEnd(glyph, 1)
  // Selecting one glyph of a formula should still quote the formula, not the
  // visual copy: the text-node branch never looks at the enclosing .katex.
  assert.equal(selectionToMarkdown(range), '$x^2$')
})

test('link text containing "]" is escaped so the markdown stays a link', () => {
  const document = setup('<p><a href="/doc">a]b</a></p>')
  const range = document.createRange()
  range.selectNodeContents(document.querySelector('a'))
  // Today this yields "[a]b](/doc)": the link closes at the inner bracket.
  assert.equal(selectionToMarkdown(range), '[a\\]b](/doc)')
})

test('truncation never leaves a partial fence line behind', () => {
  const text = '```js\nabc\n```\n' + 'x'.repeat(200)
  // 12 characters cuts inside the closing fence run: "```js\nabc\n``".
  const out = truncateMarkdown(text, 12)
  // The stray "``" line must be dropped; the closing fence is added below it.
  assert.equal(out, '```js\nabc\n```\n…')
})
