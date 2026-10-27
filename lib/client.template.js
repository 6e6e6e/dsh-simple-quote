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
    // @@inject:quote-text@@
    // @@inject:selection-markdown@@

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
