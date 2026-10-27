/**
 * dsh-simple-quote — quote selected conversation text into the composer.
 *
 * Interaction: select text in the conversation column, click the floating
 * "添加到输入框" menu, and the selection is appended to the composer as
 *
 *     「selected text」
 *     ------
 *
 * with the caret placed on the line right below the six dashes.
 *
 * The selection is converted from the rendered Markdown DOM back to Markdown
 * (`**bold**`, links with their href, list numbers, fenced code, tables,
 * headings, blockquotes) instead of `Selection.toString()`, which loses the
 * syntax the chat renderer already consumed.
 *
 * `client.js` is generated from this template plus `lib/quote-text.js` and
 * `lib/selection-markdown.js` by `scripts/build-client.mjs` (wired to
 * `prepack`); edit those sources, not the generated bundle.
 *
 * Two slot registrations cooperate:
 * - `conversation.composer.dock` (session scope) hides an invisible bridge
 *   component whose only job is to hand the session-scoped write path to the
 *   menu; the menu itself lives in `shell.overlay`, a root-scoped frame-wide
 *   floating layer that is not clipped by the conversation's scroll container.
 * - The overlay renders a measured button beside the mouse-release point
 *   (flipping to its left near the viewport edge) and commits the quote
 *   through the bridge.
 *
 * Draft writes go through the conversation input service
 * (`ctx.get('conversation').input.for(scope).setDraft`), the same public path
 * the installed community sidebar uses. The host's `setDraft` leaves the caret
 * at the end of the rewritten draft, and the facade's own `focus()` restores
 * that stored Lexical selection — a bare focus on the contenteditable would
 * land the caret at the first character. A last-block check repairs a stale
 * Lexical selection on hosts where the editor never had focus before.
 */
window.__ModuleLoader__.load({
  id: 'dsh-simple-quote',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const Fragment = React.Fragment
    const useLayoutEffect = React.useLayoutEffect ?? React.useEffect

    const NAMESPACE = 'dsh-simple-quote'
    const MENU_ATTR = 'data-simple-quote-menu'

    /** Current viewport, passed to the pure menu geometry helper. */
    function viewport() {
      return { width: window.innerWidth, height: window.innerHeight }
    }

    const COPY = {
      zh: {
        addToInput: '添加到输入框',
        hint: '把选中的文字引用到输入框',
      },
      en: {
        addToInput: 'Add to input',
        hint: 'Quote the selected text into the composer',
      },
    }

    const MENU_KEYFRAMES = [
      '@keyframes dshSimpleQuoteIn {',
      '  from { opacity: 0; transform: translateY(2px) scale(0.98); }',
      '  to { opacity: 1; transform: none; }',
      '}',
    ].join('\n')

    /** Set from `apply`; read lazily so locale switches need no re-register. */
    let localeService = null

    function copy() {
      let active = 'zh'
      try {
        active = localeService?.getSnapshot?.().active ?? 'zh'
      } catch {
        // A locale snapshot is optional; the default copy still works.
      }
      return String(active).toLowerCase().startsWith('zh') ? COPY.zh : COPY.en
    }

    /**
     * Selection state shared by the DOM listener, the composer bridge, and the
     * overlay component. `state` is null while no menu is open; `inserter` is
     * the session-scoped draft writer registered by the bridge.
     */
    const store = (() => {
      let state = null
      let inserter = null
      const listeners = new Set()

      const notify = () => {
        for (const listener of listeners) {
          try {
            listener()
          } catch (error) {
            console.warn('[dsh-simple-quote] store listener failed', error)
          }
        }
      }

      const publish = (next) => {
        state = next
        notify()
      }

      return {
        getState() {
          return state
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        show(item) {
          // Keep the measured size across selection refreshes: the label and
          // therefore the button box do not change.
          const size = state === null ? null : state.size
          const next = { ...item, size, left: -9999, top: -9999 }
          if (size !== null) Object.assign(next, menuPosition(item.pointer, size, viewport()))
          publish(next)
        },
        measure(size) {
          if (state === null) return
          publish({ ...state, size, ...menuPosition(state.pointer, size, viewport()) })
        },
        /** Re-place the open menu after a viewport resize. */
        reflow() {
          if (state === null || state.size === null) return
          publish({ ...state, ...menuPosition(state.pointer, state.size, viewport()) })
        },
        hide() {
          if (state === null) return
          state = null
          notify()
        },
        setInserter(fn) {
          inserter = fn
          return () => {
            if (inserter === fn) inserter = null
          }
        },
        canInsert() {
          return inserter !== null
        },
        insert(block) {
          if (inserter === null) return false
          return inserter(block)
        },
      }
    })()

    // ---------------------------------------------------------------------
    // Injected pure helpers and Markdown serializer
    // ---------------------------------------------------------------------
    // Source of truth: lib/quote-text.js and lib/selection-markdown.js.
    // client.js is generated by scripts/build-client.mjs (npm run build).
    /**
     * Pure text and geometry helpers for dsh-simple-quote.
     *
     * Source of truth shared by the browser bundle (`client.js`, generated by
     * `scripts/build-client.mjs`) and `node:test`: nothing here touches the DOM or
     * React, so every function can be tested without a browser.
     */

    /** Longest quoted text kept before truncation. */
    const MAX_QUOTE_CHARS = 12000

    /**
     * One fenced-code line: optional list indentation / blockquote markers, the
     * backtick run, and whatever follows (an info string when opening).
     */
    const FENCE_LINE = /^([ \t]*(?:>[ \t]*)*)(`{3,})(.*)$/u

    function isNode(value) {
      return value !== null && typeof value === 'object' && typeof value.nodeType === 'number'
    }

    function elementOf(node) {
      if (!isNode(node)) return null
      if (node.nodeType === 1) return node
      return node.parentElement ?? null
    }

    /** A block fragment: trimmed at both newline ends, followed by one blank line. */
    function blockText(content) {
      const trimmed = content.replace(/^\n+|\n+$/gu, '')
      return trimmed === '' ? '' : `${trimmed}\n\n`
    }

    /**
     * Wrap inline content with delimiters while keeping the whitespace that sat
     * inside the boundary. `inner` is usually a mix of text and nested markdown;
     * only the outer whitespace moves outside the markers so adjacent text cannot
     * glue together (`**粗体 **普通` → `**粗体** 普通`).
     */
    function wrapDelimited(inner, open, close) {
      if (inner === '') return ''
      const match = /^(\s*)([\s\S]*?)(\s*)$/u.exec(inner)
      if (match === null) return `${open}${inner}${close}`
      const [, lead, core, trail] = match
      if (core === '') return inner
      return `${lead}${open}${core}${close}${trail}`
    }

    function wrapInline(marker, content) {
      return wrapDelimited(content, marker, marker)
    }

    /**
     * Collapse duplicate blank lines, but never inside a fenced code block. A
     * closing fence only counts when it is at least as long as the opening run and
     * carries no info string, so fence-like text inside code is preserved.
     */
    function normalizeBlankLines(text) {
      const lines = text.split('\n')
      const out = []
      let open = null
      let blank = 0
      for (const line of lines) {
        const fence = FENCE_LINE.exec(line)
        if (fence !== null) {
          if (open === null) open = { fence: fence[2] }
          else if (fence[2].length >= open.fence.length && fence[3].trim() === '') open = null
          blank = 0
          out.push(line)
          continue
        }
        if (open === null && line.trim() === '') {
          blank += 1
          if (blank > 1) continue
          out.push('')
          continue
        }
        blank = 0
        out.push(line)
      }
      return out.join('\n').replace(/^\n+|\n+$/gu, '')
    }

    /** The still-open fence of a text, with its indentation/quote prefix. */
    function openFence(text) {
      let open = null
      for (const line of text.split('\n')) {
        const match = FENCE_LINE.exec(line)
        if (match === null) continue
        if (open === null) open = { prefix: match[1], fence: match[2] }
        else if (match[2].length >= open.fence.length && match[3].trim() === '') open = null
      }
      return open
    }

    /**
     * Cap the quote at `max` characters. A cut inside a fenced block gets the
     * matching closing fence — including list indentation and blockquote prefixes —
     * so the tail of the message cannot be swallowed as code.
     */
    function truncateMarkdown(text, max = MAX_QUOTE_CHARS) {
      if (text.length <= max) return text
      let cut = text.slice(0, max)
      // Never split a surrogate pair (emoji/rare CJK) at the boundary.
      const last = cut.length === 0 ? 0 : cut.charCodeAt(cut.length - 1)
      if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1)
      cut = cut.replace(/\s+$/u, '')
      const open = openFence(cut)
      if (open !== null) cut += `\n${open.prefix}${open.fence}`
      return `${cut}\n…`
    }

    function plainQuote(raw) {
      return String(raw).replace(/\r\n?/gu, '\n').replace(/^\n+|\n+$/gu, '')
    }

    /** The quote block; it ends with a newline so the caret sits below `------`. */
    function buildQuoteBlock(quote) {
      return `「${quote}」\n------\n`
    }

    /** Append the block to the draft, separated by one blank line. */
    function composeDraft(draft, block) {
      const base = typeof draft === 'string' ? draft : ''
      if (base.trim() === '') return block
      return `${base.replace(/\s+$/u, '')}\n\n${block}`
    }

    /**
     * Place the menu to the right of the pointer, vertically centered on it; flip
     * to the pointer's left when the right side runs out of room, then clamp inside
     * the viewport. `viewport` is passed explicitly so the math is testable.
     */
    function menuPosition(pointer, size, viewport, gap = 10, margin = 8) {
      const width = viewport.width
      const height = viewport.height
      const maxLeft = Math.max(margin, width - size.width - margin)
      const maxTop = Math.max(margin, height - size.height - margin)
      const rightSide = pointer.x + gap
      const left = rightSide + size.width <= width - margin
        ? rightSide
        : pointer.x - gap - size.width
      let top = pointer.y - size.height / 2
      if (top < margin) top = pointer.y + gap
      else if (top + size.height > height - margin) top = pointer.y - size.height - gap
      return {
        left: Math.min(maxLeft, Math.max(margin, left)),
        top: Math.min(maxTop, Math.max(margin, top)),
      }
    }

    /**
     * Render a Markdown table from a header row and data rows. Cells are already
     * serialized text; `|` escaping stays with the DOM reader. The header must be
     * non-empty (Markdown requires one).
     */
    function formatTableRows(header, rows) {
      if (header === null || header === undefined || header.length === 0) return ''
      const width = rows.reduce((max, row) => Math.max(max, row.length), header.length)
      const pad = (row) => {
        const line = [...row]
        while (line.length < width) line.push('')
        return line
      }
      const head = pad(header)
      const lines = [
        `| ${head.join(' | ')} |`,
        `| ${head.map(() => '---').join(' | ')} |`,
        ...rows.map((row) => `| ${pad(row).join(' | ')} |`),
      ]
      return `${lines.join('\n')}\n\n`
    }
    /**
     * Selection → Markdown for dsh-simple-quote.
     *
     * Walks the rendered chat DOM instead of using `Selection.toString()`, so the
     * syntax the Markdown renderer already consumed (list numbers, link targets,
     * code fences, headings, tables) is restored in the quote. Only the DOM is
     * touched here; the text helpers live in `./quote-text.js`.
     */

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
    function selectionToMarkdown(range) {
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

    // ---------------------------------------------------------------------
    // DOM helpers (selection scope, composer, geometry)
    // ---------------------------------------------------------------------

    function closestElement(node, selector) {
      const element = elementOf(node)
      return element === null ? null : element.closest(selector)
    }

    /**
     * The conversation column around a node. Every slot outlet carries a
     * `data-slot` attribute, so any ancestor whose slot key starts with
     * `conversation` proves the node belongs to the transcript. `<main>` is the
     * fallback for a host that drops the attribute.
     */
    function conversationScopeOf(node) {
      const tagged = closestElement(node, '[data-slot^="conversation"]')
      if (tagged !== null) return tagged
      const root = document.getElementById('root') ?? document.body
      const main = root.querySelector('main')
      const element = elementOf(node)
      if (main === null || element === null || !main.contains(element)) return null
      return main
    }

    function composerTextarea() {
      const root = document.getElementById('root') ?? document.body
      return (
        root.querySelector('textarea[data-phase]') ??
        root.querySelector('[data-slot^="conversation"] textarea')
      )
    }

    function composerEditor() {
      const root = document.getElementById('root') ?? document.body
      return (
        root.querySelector('[data-slot^="conversation"] [data-composer-input]') ??
        root.querySelector('[data-composer-input]')
      )
    }

    function inEditable(node) {
      return closestElement(node, 'textarea, input, select, [contenteditable=""], [contenteditable="true"]') !== null
    }

    /** Pointer substitute for a trigger without coordinates (rare). */
    function fallbackPointer() {
      const composer = composerEditor() ?? composerTextarea()
      const rect = composer === null ? null : composer.getBoundingClientRect()
      if (rect !== null && rect.width > 0 && rect.height > 0) return { x: rect.right - 8, y: rect.top }
      return { x: window.innerWidth / 2, y: window.innerHeight / 2 }
    }

    /**
     * Read and validate the current selection. Returns null unless the
     * selection is non-empty, lies inside the conversation column, and stays
     * out of editable controls (the composer, inputs, contenteditable).
     */
    function readSelection(pointer) {
      const selection = window.getSelection()
      if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return null
      const range = selection.getRangeAt(0)
      if (elementOf(range.startContainer) === null || elementOf(range.endContainer) === null) return null
      if (closestElement(range.startContainer, `[${MENU_ATTR}]`) !== null) return null
      if (closestElement(range.endContainer, `[${MENU_ATTR}]`) !== null) return null
      if (inEditable(range.startContainer) || inEditable(range.endContainer)) return null
      if (conversationScopeOf(range.commonAncestorContainer) === null) return null
      const markdown = selectionToMarkdown(range)
      const quote = truncateMarkdown(markdown !== '' ? markdown : plainQuote(selection.toString()))
      if (quote.trim() === '') return null
      return { quote, block: buildQuoteBlock(quote), pointer: pointer ?? fallbackPointer() }
    }

    // ---------------------------------------------------------------------
    // Composer write path
    // ---------------------------------------------------------------------

    /**
     * Focus the composer with the caret the draft write left behind. The host
     * input facade's own `focus()` runs Lexical's focus restore; focusing the
     * contenteditable directly would land the caret at the first character.
     */
    function focusComposerInput(input) {
      try {
        if (typeof input.focus === 'function') {
          input.focus()
          return true
        }
        const editor = input.editor
        if (editor !== null && editor !== undefined && typeof editor.focus === 'function') {
          editor.getRootElement?.()?.focus?.({ preventScroll: true })
          editor.focus()
          return true
        }
      } catch (error) {
        console.warn('[dsh-simple-quote] composer focus failed', error)
      }
      return false
    }

    /** Fallback caret placement for a plain-text composer on older hosts. */
    function placeCaretInComposer(expectedValue, index) {
      let attempts = 0
      const tick = () => {
        const textarea = composerTextarea()
        if (textarea !== null) {
          if (textarea.disabled || textarea.readOnly) return
          if (textarea.value !== expectedValue) {
            attempts += 1
            if (attempts < 4) window.requestAnimationFrame(tick)
            return
          }
          textarea.focus()
          const position = Math.max(0, Math.min(index, textarea.value.length))
          textarea.setSelectionRange(position, position)
          return
        }
        const editor = composerEditor()
        if (editor !== null) {
          editor.focus()
          return
        }
        attempts += 1
        if (attempts < 4) window.requestAnimationFrame(tick)
      }
      window.requestAnimationFrame(tick)
    }

    /**
     * The host documents a caret at the end of the rewritten draft, but the
     * stored Lexical selection can be stale when the composer never had focus
     * (fresh page → select text → quote). Verify the DOM caret sits in the
     * editor's last block and move it there explicitly when it does not.
     */
    function ensureCaretInComposer(input) {
      try {
        const root = input?.editor?.getRootElement?.() ?? composerEditor()
        if (root === null || root.tagName === 'TEXTAREA') return
        const selection = window.getSelection()
        if (selection === null) return
        const anchor = elementOf(selection.anchorNode)
        const lastBlock = root.lastElementChild
        const insideLast = anchor !== null && root.contains(anchor) &&
          (lastBlock === null || anchor === lastBlock || lastBlock.contains(anchor))
        if (insideLast) return
        const range = document.createRange()
        range.selectNodeContents(lastBlock ?? root)
        range.collapse(false)
        selection.removeAllRanges()
        selection.addRange(range)
      } catch (error) {
        console.warn('[dsh-simple-quote] caret verification failed', error)
      }
    }

    /**
     * Build the session-scoped writer for one bridge mount. Reads and writes
     * through the conversation input facade (the root `conversation` service),
     * which also owns the Lexical focus restore that keeps the caret at the end.
     */
    function createInserter(ctx, sessionId) {
      return (block) => {
        try {
          const scope = ctx.sessions.scope(sessionId)
          if (scope === undefined) {
            console.warn('[dsh-simple-quote] session scope unavailable', sessionId)
            return false
          }
          const conversation =
            ctx.get('conversation') ??
            (typeof scope.get === 'function' ? scope.get('conversation') : undefined)
          if (conversation === undefined || conversation === null || typeof conversation.input?.for !== 'function') {
            console.warn('[dsh-simple-quote] conversation input service unavailable')
            return false
          }
          const input = conversation.input.for(scope)
          const snapshot = input.state.getSnapshot()
          const draft = typeof snapshot.draft === 'string' ? snapshot.draft : ''
          const next = composeDraft(draft, block)
          input.setDraft(next)
          const focused = focusComposerInput(input)
          ensureCaretInComposer(input)
          if (!focused) placeCaretInComposer(next, next.length)
          return true
        } catch (error) {
          console.warn('[dsh-simple-quote] failed to insert the quote', error)
          return false
        }
      }
    }

    // ---------------------------------------------------------------------
    // Menu component
    // ---------------------------------------------------------------------

    /** The floating "add to input" button, shown next to the pointer. */
    function SelectionMenu() {
      const [state, setState] = React.useState(store.getState())
      const [hover, setHover] = React.useState(false)
      const buttonRef = React.useRef(null)

      React.useEffect(() => store.subscribe(() => setState(store.getState())), [])

      useLayoutEffect(() => {
        const current = store.getState()
        const button = buttonRef.current
        if (current === null || current.size !== null || button === null) return
        const rect = button.getBoundingClientRect()
        store.measure({ width: rect.width, height: rect.height })
      })

      if (state === null) return h(Fragment, null, h('style', null, MENU_KEYFRAMES))

      const labels = copy()
      const ready = state.size !== null
      const background = hover ? 'var(--dsw-alias-bg-layer-2)' : 'var(--dsw-alias-bg-overlay)'

      const commit = () => {
        const current = store.getState()
        if (current === null) return
        if (!store.insert(current.block)) return
        store.hide()
        // The insert focuses the composer and moves the DOM selection there;
        // clearing the selection here would wipe out that caret.
      }

      return h(
        Fragment,
        null,
        h('style', null, MENU_KEYFRAMES),
        h(
          'div',
          {
            [MENU_ATTR]: '',
            style: {
              position: 'fixed',
              left: `${ready ? state.left : -9999}px`,
              top: `${ready ? state.top : -9999}px`,
              zIndex: 60,
              pointerEvents: 'auto',
              visibility: ready ? 'visible' : 'hidden',
              animation: ready ? 'dshSimpleQuoteIn 120ms ease-out' : undefined,
            },
          },
          h(
            'button',
            {
              ref: buttonRef,
              type: 'button',
              onMouseDown: (event) => {
                // Keep the text selection (and the stored payload) alive until click.
                event.preventDefault()
                event.stopPropagation()
              },
              onClick: commit,
              onMouseEnter: () => setHover(true),
              onMouseLeave: () => setHover(false),
              title: labels.hint,
              'aria-label': labels.addToInput,
              style: {
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                height: '30px',
                padding: '0 10px',
                border: '1px solid var(--dsw-alias-border-l1)',
                borderRadius: '8px',
                background,
                color: 'var(--dsw-alias-label-primary)',
                fontSize: '12px',
                fontWeight: 500,
                fontFamily: 'inherit',
                lineHeight: '1.2',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                userSelect: 'none',
                boxShadow: '0 6px 18px rgba(0, 0, 0, 0.14)',
              },
            },
            h(
              'span',
              {
                'aria-hidden': true,
                style: { color: 'var(--dsw-alias-brand-primary)', fontSize: '13px', lineHeight: 1 },
              },
              '「」',
            ),
            h('span', null, labels.addToInput),
          ),
        ),
      )
    }

    // ---------------------------------------------------------------------
    // Selection listeners
    // ---------------------------------------------------------------------

    function attachSelectionListeners() {
      let frame = 0
      /** Last mouse-release point; the menu is anchored to it. */
      let pointer = null

      const hide = () => store.hide()

      const refresh = () => {
        if (!store.canInsert()) {
          hide()
          return
        }
        const next = readSelection(pointer)
        if (next === null) hide()
        else store.show(next)
      }

      const scheduleRefresh = () => {
        if (frame !== 0) return
        frame = window.requestAnimationFrame(() => {
          frame = 0
          refresh()
        })
      }

      const targetInMenu = (event) => {
        const element = elementOf(event.target)
        return element !== null && element.closest(`[${MENU_ATTR}]`) !== null
      }

      const onMouseUp = (event) => {
        if (event.button !== 0) return
        if (targetInMenu(event)) return
        pointer = { x: event.clientX, y: event.clientY }
        scheduleRefresh()
      }

      const onMouseDown = (event) => {
        if (targetInMenu(event)) return
        hide()
      }

      const onSelectionChange = () => {
        if (store.getState() === null) return
        const selection = window.getSelection()
        if (selection === null || selection.isCollapsed) {
          hide()
          return
        }
        // Keyboard extensions of the selection keep updating the quote while
        // the menu stays anchored to the release point.
        scheduleRefresh()
      }

      const onKeyDown = (event) => {
        if (event.key === 'Escape') hide()
      }

      const onBlur = () => hide()
      const onResize = () => store.reflow()
      const onVisibility = () => {
        if (document.hidden) hide()
      }

      document.addEventListener('mouseup', onMouseUp, true)
      document.addEventListener('mousedown', onMouseDown, true)
      document.addEventListener('selectionchange', onSelectionChange)
      document.addEventListener('keydown', onKeyDown, true)
      document.addEventListener('scroll', hide, true)
      document.addEventListener('visibilitychange', onVisibility)
      window.addEventListener('blur', onBlur)
      window.addEventListener('resize', onResize)

      return () => {
        if (frame !== 0) window.cancelAnimationFrame(frame)
        document.removeEventListener('mouseup', onMouseUp, true)
        document.removeEventListener('mousedown', onMouseDown, true)
        document.removeEventListener('selectionchange', onSelectionChange)
        document.removeEventListener('keydown', onKeyDown, true)
        document.removeEventListener('scroll', hide, true)
        document.removeEventListener('visibilitychange', onVisibility)
        window.removeEventListener('blur', onBlur)
        window.removeEventListener('resize', onResize)
      }
    }

    // ---------------------------------------------------------------------
    // Client plugin
    // ---------------------------------------------------------------------

    function apply(ctx) {
      localeService = ctx.locale ?? null

      ctx.effect(() => {
        if (localeService === null || typeof localeService.register !== 'function') return undefined
        const disposers = []
        for (const [locale, dictionary] of Object.entries(COPY)) {
          try {
            const dispose = localeService.register(NAMESPACE, locale, dictionary)
            if (typeof dispose === 'function') disposers.push(dispose)
          } catch (error) {
            console.warn('[dsh-simple-quote] locale registration failed', locale, error)
          }
        }
        return () => {
          for (const dispose of disposers) {
            try {
              dispose()
            } catch {
              // A locale disposer from an unloading service may already be gone.
            }
          }
        }
      }, 'dsh-simple-quote: locale dictionaries')

      ctx.effect(attachSelectionListeners, 'dsh-simple-quote: selection listeners')

      /**
       * Invisible bridge in the composer cell: receives `sessionId` and
       * publishes the draft writer for the frame-wide menu. Defined inside
       * `apply` so it closes over this activation's `ctx`; a factory-scope
       * definition would throw a ReferenceError at render time, and a slot
       * entry that throws is abdicated permanently for the page.
       */
      function ComposerBridge(props) {
        const sessionId = props.sessionId
        React.useEffect(() => {
          if (sessionId === undefined || sessionId === null || sessionId === '') return undefined
          try {
            store.hide()
            const dispose = store.setInserter(createInserter(ctx, sessionId))
            return () => {
              try {
                dispose()
              } catch (error) {
                console.warn('[dsh-simple-quote] composer bridge cleanup failed', error)
              }
            }
          } catch (error) {
            console.warn('[dsh-simple-quote] composer bridge setup failed', error)
            return undefined
          }
        }, [sessionId])
        return null
      }

      ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
        name: 'conversation.composer.dock',
        id: 'dsh-simple-quote:composer-bridge',
        order: 900,
        registrant: 'dsh-simple-quote',
      }, ComposerBridge))

      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'dsh-simple-quote:menu',
        order: 900,
        registrant: 'dsh-simple-quote',
      }, SelectionMenu))
    }

    return {
      inject: ['slots', 'locale', 'sessions'],
      apply,
    }
  },
})
