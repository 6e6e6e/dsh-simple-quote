import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { selectionToMarkdown } from '../lib/selection-markdown.js'

function setup(html) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`)
  globalThis.document = dom.window.document
  return dom.window.document
}

function selectContents(document, element) {
  const range = document.createRange()
  range.selectNodeContents(element)
  return range
}

test('a tbody selection reuses the unselected thead header', () => {
  const document = setup(
    '<table><thead><tr><th>H1</th><th>H2</th></tr></thead>' +
    '<tbody><tr id="r1"><td>r1c1</td><td>r1c2</td></tr><tr id="r2"><td>r2c1</td><td>r2c2</td></tr></tbody></table>',
  )
  const markdown = selectionToMarkdown(selectContents(document, document.getElementById('r2')))
  assert.equal(markdown, '| H1 | H2 |\n| --- | --- |\n| r2c1 | r2c2 |')
})

test('one selected tbody row still keeps the header and data row', () => {
  const document = setup(
    '<table><thead><tr><th>H1</th><th>H2</th></tr></thead>' +
    '<tbody><tr id="r1"><td>r1c1</td><td>r1c2</td></tr></tbody></table>',
  )
  const markdown = selectionToMarkdown(selectContents(document, document.getElementById('r1')))
  assert.equal(markdown, '| H1 | H2 |\n| --- | --- |\n| r1c1 | r1c2 |')
})

test('a table without thead keeps the old first-row fallback', () => {
  const document = setup(
    '<table><tbody><tr id="r1"><td>a</td><td>1</td></tr><tr id="r2"><td>b</td><td>2</td></tr></tbody></table>',
  )
  const markdown = selectionToMarkdown(selectContents(document, document.getElementById('r1')))
  assert.equal(markdown, '| a | 1 |\n| --- | --- |')
})

test('inline markers do not eat boundary whitespace', () => {
  const document = setup('<p><strong>粗体 </strong>普通</p>')
  const markdown = selectionToMarkdown(selectContents(document, document.querySelector('p')))
  assert.equal(markdown, '**粗体** 普通')
})

test('links keep their href and ignore decorative icons', () => {
  const document = setup(
    '<p><a href="https://x.test/a"><span aria-hidden="true"><svg></svg></span>链接</a></p>',
  )
  const markdown = selectionToMarkdown(selectContents(document, document.querySelector('p')))
  assert.equal(markdown, '[链接](https://x.test/a)')
})

test('list numbering and nested items survive', () => {
  const document = setup(
    '<ol start="3"><li>第三项</li><li>第四项<ul><li>子项</li></ul></li></ol>',
  )
  const markdown = selectionToMarkdown(selectContents(document, document.querySelector('ol')))
  assert.equal(markdown, '3. 第三项\n4. 第四项\n   - 子项')
})

test('KaTeX quotes the TeX source once', () => {
  const document = setup(
    '<p>公式 <span class="katex"><span class="katex-mathml"><math><semantics><mrow><mi>E</mi></mrow>' +
    '<annotation encoding="application/x-tex">E=mc^2</annotation></semantics></math></span>' +
    '<span class="katex-html" aria-hidden="true">E=mc2</span></span> 结束</p>',
  )
  const markdown = selectionToMarkdown(selectContents(document, document.querySelector('p')))
  assert.equal(markdown, '公式 $E=mc^2$ 结束')
})
