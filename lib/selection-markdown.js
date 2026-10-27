/**
 * Selection → Markdown for dsh-simple-quote.
 *
 * Walks the rendered chat DOM instead of using `Selection.toString()`, so the
 * syntax the Markdown renderer already consumed (list numbers, link targets,
 * code fences, headings, tables) is restored in the quote. Only the DOM is
 * touched here; the text helpers live in `./quote-text.js`.
 */

import {
  blockText,
  elementOf,
  formatTableRows,
  normalizeBlankLines,
  wrapDelimited,
  wrapInline,
} from './quote-text.js'

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS'])
const BLOCK_TAGS = new Set([
  'DIV', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'ASIDE', 'FIGURE', 'FIGCAPTION',
  'DL', 'DT', 'DD', 'ADDRESS', 'DETAILS', 'SUMMARY', 'FORM', 'FIELDSET', 'MAIN', 'NAV',
])
// Inline wrappers that a text-node selection can sit inside without the
// element itself being part of the serialized range.
const INLINE_WRAPPERS = new Set(['A', 'STRONG', 'B', 'EM', 'I', 'CODE', 'DEL', 'S', 'STRIKE'])
// Block ancestors stop the inline-wrapper walk; they serialize themselves.
const BLOCK_BOUNDARIES = new Set([
  'P', 'DIV', 'LI', 'UL', 'OL', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'BLOCKQUOTE', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'PRE',
  'SECTION', 'ARTICLE', 'MAIN', 'BODY',
])

function isSelected(node, range) {
  try {
    return range.intersectsNode(node)
  } catch {
    return false
  }
}

/** The part of one text node covered by the range. */
function textWithin(node, range) {
  const data = node.data
  const start = node === range.startContainer ? range.startOffset : 0
  const end = node === range.endContainer ? range.endOffset : data.length
  return start < end ? data.slice(start, end) : ''
}

/** Every selected text node under `el`, in document order (code blocks). */
function collectText(el, range) {
  let out = ''
  const walker = document.createTreeWalker(el, 4 /* NodeFilter.SHOW_TEXT */)
  let node = walker.nextNode()
  while (node !== null) {
    if (isSelected(node, range)) out += textWithin(node, range)
    node = walker.nextNode()
  }
  return out
}

function serializeChildren(el, range, ctx) {
  let out = ''
  for (const child of el.childNodes) {
    if (child.nodeType === 3 /* TEXT_NODE */) {
      if (isSelected(child, range)) out += textWithin(child, range)
      continue
    }
    if (child.nodeType !== 1 /* ELEMENT_NODE */) continue
    if (!isSelected(child, range)) continue
    out += serializeElement(child, range, ctx)
  }
  return out
}

/** Language label of a rendered fenced code block (banner or `language-*`). */
function codeLanguage(pre) {
  const code = pre.querySelector('code') ?? pre
  const fromCode = /language-([A-Za-z0-9_+#.-]+)/u.exec(code.getAttribute('class') ?? '')
  if (fromCode !== null) return fromCode[1]
  const banner = pre.closest('[data-code-block-content]')?.parentElement?.querySelector('[data-code-block-banner]')
  const first = banner?.firstElementChild ?? null
  if (first === null) return ''
  const candidate = ((first.firstElementChild ?? first).textContent ?? '').trim()
  if (candidate !== '' && /^[A-Za-z][\w+#.-]{0,29}$/u.test(candidate) && !/^code$/iu.test(candidate)) {
    return candidate
  }
  return ''
}

function codeBlock(pre, range) {
  const raw = collectText(pre, range).replace(/\r\n?/gu, '\n').replace(/\n+$/u, '')
  if (raw.trim() === '') return ''
  let longest = 0
  for (const run of raw.match(/`+/gu) ?? []) longest = Math.max(longest, run.length)
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}${codeLanguage(pre)}\n${raw}\n${fence}\n\n`
}

/** Ordered/unordered marker of one `<li>`, read from its live list. */
function listMarker(li) {
  const list = li.parentElement
  if (list === null || (list.tagName !== 'UL' && list.tagName !== 'OL')) return ''
  if (list.tagName === 'UL') return '- '
  const start = Number.parseInt(list.getAttribute('start') ?? '1', 10)
  let number = Number.isFinite(start) && start > 0 ? start : 1
  for (const sibling of list.children) {
    if (sibling === li) break
    if (sibling.tagName === 'LI') number += 1
  }
  return `${number}. `
}

function serializeList(el, range, ctx) {
  const ordered = el.tagName === 'OL'
  const start = Number.parseInt(el.getAttribute('start') ?? '1', 10)
  let number = Number.isFinite(start) && start > 0 ? start : 1
  const lines = []
  for (const child of el.children) {
    if (child.tagName !== 'LI') continue
    if (isSelected(child, range)) {
      const body = serializeChildren(child, range, {
        ...ctx,
        inListItem: true,
        listDepth: (ctx.listDepth ?? 0) + 1,
      }).replace(/^\n+|\n+$/gu, '')
      const marker = ordered ? `${number}. ` : '- '
      if (body === '') {
        lines.push(marker.trimEnd())
      } else {
        const bodyLines = body.split('\n')
        const pad = ' '.repeat(marker.length)
        lines.push(marker + bodyLines[0])
        for (const line of bodyLines.slice(1)) lines.push(line === '' ? '' : `${pad}${line}`)
      }
    }
    number += 1
  }
  return lines.length === 0 ? '' : `${lines.join('\n')}\n\n`
}

/** One row's serialized cells, clipped to `cellRange`. */
function readTableCells(row, cellRange, ctx) {
  const cells = []
  for (const cell of row.children) {
    if (cell.tagName !== 'TH' && cell.tagName !== 'TD') continue
    const text = serializeChildren(cell, cellRange, { ...ctx, inTableCell: true })
      .replace(/\s*\n\s*/gu, ' ')
      .replace(/\|/gu, '\\|')
      .trim()
    cells.push(text)
  }
  return cells
}

/**
 * A table's header always comes from `<thead>` when the table has one — even
 * when the selection starts in `<tbody>` and never touches the header. Selected
 * body rows then form the data rows. Without `<thead>` the first selected row
 * is the header (the only option Markdown gives us).
 */
function tableMarkdown(table, range, ctx) {
  const headerRow = table.tHead?.rows?.[0] ?? null
  if (headerRow !== null) {
    const headerRange = document.createRange()
    headerRange.selectNodeContents(headerRow)
    const header = readTableCells(headerRow, headerRange, ctx)
    if (header.length === 0) return ''
    const rows = []
    for (const row of table.rows) {
      if (row === headerRow) continue
      if (row.parentElement?.tagName === 'THEAD') continue
      if (!isSelected(row, range)) continue
      const cells = readTableCells(row, range, ctx)
      if (cells.length > 0) rows.push(cells)
    }
    return formatTableRows(header, rows)
  }

  const selected = []
  for (const row of table.rows) {
    if (!isSelected(row, range)) continue
    const cells = readTableCells(row, range, ctx)
    if (cells.length > 0) selected.push(cells)
  }
  if (selected.length === 0) return ''
  return formatTableRows(selected[0], selected.slice(1))
}

function serializeElement(el, range, ctx) {
  const tag = el.tagName
  if (el.getAttribute('aria-hidden') === 'true') return ''
  if (el.hidden === true) return ''
  if (SKIP_TAGS.has(tag)) return ''
  // Code-block chrome (language label, copy/wrap buttons) is not content.
  if (el.closest('[data-code-block-banner]') !== null) return ''

  // KaTeX renders a MathML copy plus an aria-hidden visual copy. Quote the TeX
  // source once instead of concatenating both trees.
  if (el.classList?.contains('katex')) {
    const annotation = el.querySelector('annotation[encoding="application/x-tex"]')
    const tex = (annotation?.textContent ?? '').trim()
    if (tex !== '') return el.closest('.katex-display') !== null ? `$$${tex}$$` : `$${tex}$`
    return (el.querySelector('.katex-mathml')?.textContent ?? '').trim()
  }
  if (el.closest('.katex') !== null) return ''

  if (tag === 'PRE') return codeBlock(el, range)
  if (el.hasAttribute('data-code-block-content')) {
    const pre = el.querySelector('pre')
    return pre !== null ? codeBlock(pre, range) : blockText(collectText(el, range))
  }

  const heading = /^H([1-6])$/u.exec(tag)
  if (heading !== null) {
    const text = serializeChildren(el, range, ctx).trim()
    return text === '' ? '' : blockText(`${'#'.repeat(Number(heading[1]))} ${text}`)
  }

  if (tag === 'UL' || tag === 'OL') {
    const rendered = serializeList(el, range, ctx)
    if (rendered === '') return ''
    // A nested list follows the item text on its own line.
    return ctx.inListItem ? `\n${rendered}` : rendered
  }
  if (tag === 'TABLE') return tableMarkdown(el, range, ctx)

  if (tag === 'BLOCKQUOTE') {
    const inner = serializeChildren(el, range, { ...ctx, inBlockquote: true }).replace(/^\n+|\n+$/gu, '')
    if (inner === '') return ''
    const lines = inner.split('\n').map((line) => (line === '' ? '>' : `> ${line}`))
    return `${lines.join('\n')}\n\n`
  }

  if (tag === 'P') {
    const inner = serializeChildren(el, range, ctx)
    if (inner.trim() === '') return ''
    return ctx.inListItem ? `${inner.replace(/\n+$/u, '')}\n` : blockText(inner)
  }

  if (tag === 'BR') return '\n'
  if (tag === 'HR') return '\n---\n\n'

  if (tag === 'IMG') {
    const alt = (el.getAttribute('alt') ?? '').trim()
    const src = (el.getAttribute('src') ?? '').trim()
    return src !== '' && !/^(data|blob):/iu.test(src) ? `![${alt}](${src})` : alt
  }

  if (tag === 'INPUT') {
    return el.type === 'checkbox' ? (el.checked ? '[x]' : '[ ]') : ''
  }

  if (tag === 'A') {
    const inner = serializeChildren(el, range, { ...ctx, inLink: true })
    if (inner.trim() === '') return inner
    const href = (el.getAttribute('href') ?? '').trim()
    if (ctx.inLink || href === '' || href.startsWith('#')) return inner
    return wrapDelimited(inner, '[', `](${href})`)
  }

  if (tag === 'STRONG' || tag === 'B') return wrapInline('**', serializeChildren(el, range, ctx))
  if (tag === 'EM' || tag === 'I') return wrapInline('*', serializeChildren(el, range, ctx))
  if (tag === 'DEL' || tag === 'S' || tag === 'STRIKE') return wrapInline('~~', serializeChildren(el, range, ctx))

  if (tag === 'CODE') {
    // Inline code keeps its internal whitespace: trimming would change it.
    const text = serializeChildren(el, range, ctx)
    if (text === '') return ''
    const fence = text.includes('`') ? '``' : '`'
    return `${fence}${text}${fence}`
  }

  if (tag === 'LI') {
    const inner = serializeChildren(el, range, { ...ctx, inListItem: true }).replace(/\n+$/u, '')
    return inner === '' ? '' : blockText(`${listMarker(el) || '- '}${inner}`)
  }

  if (BLOCK_TAGS.has(tag)) {
    const inner = serializeChildren(el, range, ctx)
    if (inner.trim() === '') return ''
    return ctx.inListItem ? `${inner.replace(/\n+$/u, '')}\n` : blockText(inner)
  }

  return serializeChildren(el, range, ctx)
}

/** Re-apply the inline wrappers around a text-node-only selection. */
function wrapInlineAncestors(node, text) {
  let out = text
  let el = node.parentElement
  while (el !== null && !BLOCK_BOUNDARIES.has(el.tagName)) {
    if (INLINE_WRAPPERS.has(el.tagName)) out = wrapInlineElement(el, out)
    el = el.parentElement
  }
  return out
}

function wrapInlineElement(el, inner) {
  const tag = el.tagName
  if (tag === 'A') {
    const href = (el.getAttribute('href') ?? '').trim()
    if (href === '' || href.startsWith('#')) return inner
    return wrapDelimited(inner, '[', `](${href})`)
  }
  if (tag === 'STRONG' || tag === 'B') return wrapInline('**', inner)
  if (tag === 'EM' || tag === 'I') return wrapInline('*', inner)
  if (tag === 'DEL' || tag === 'S' || tag === 'STRIKE') return wrapInline('~~', inner)
  if (tag === 'CODE') {
    if (inner === '') return ''
    const fence = inner.includes('`') ? '``' : '`'
    return `${fence}${inner}${fence}`
  }
  return inner
}

/** Convert the current selection to Markdown using the rendered DOM. */
export function selectionToMarkdown(range) {
  try {
    const root = range.commonAncestorContainer
    let markdown = ''
    if (root.nodeType === 3) {
      const element = elementOf(root)
      const pre = element === null ? null : element.closest('pre')
      if (pre !== null) {
        // A partial code selection still becomes a fenced block.
        markdown = codeBlock(pre, range)
      } else {
        let out = wrapInlineAncestors(root, textWithin(root, range))
        const heading = element === null ? null : element.closest('h1, h2, h3, h4, h5, h6')
        if (heading !== null) {
          out = `${'#'.repeat(Number(heading.tagName[1]))} ${out.trim()}`
        } else {
          const li = element === null ? null : element.closest('li')
          if (li !== null) {
            out = `${listMarker(li)}${out.trim()}`
          } else {
            const quote = element === null ? null : element.closest('blockquote')
            if (quote !== null) {
              out = out.split('\n').map((line) => (line === '' ? '>' : `> ${line}`)).join('\n')
            }
          }
        }
        markdown = out
      }
    } else if (root.nodeType === 1) {
      const table = root.tagName === 'TABLE'
        ? root
        : (['TR', 'THEAD', 'TBODY', 'TFOOT'].includes(root.tagName) ? root.closest('table') : null)
      markdown = table !== null
        ? tableMarkdown(table, range, { listDepth: 0 })
        : serializeElement(root, range, { listDepth: 0 })
    }
    return normalizeBlankLines(
      markdown.replace(/\u00a0/gu, ' ').replace(/^\n+|\n+$/gu, '').trim(),
    )
  } catch (error) {
    console.warn('[dsh-simple-quote] selection → markdown failed; using plain text', error)
    return ''
  }
}
