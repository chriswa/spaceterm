import { EditorView, ViewPlugin, ViewUpdate, Decoration, DecorationSet } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import { blendHex } from './color-presets'

/**
 * The CodeMirror setup a markdown surface is made of: the theme, the heading
 * and inline-code decorations, bare-URL autolinking, and click-to-open.
 *
 * Lifted out of `MarkdownCard` verbatim so the generated agent-meta document
 * cards render a skill or a CLAUDE.md exactly the way a markdown card renders a
 * note — one definition of what markdown looks like here, rather than two that
 * drift.
 *
 * Deliberately only the *extensions*. `MarkdownCard`'s two-pass measurement,
 * draft dimensions and drag handling stay where they are: they are the fiddly
 * part, they are entangled with that card's resize affordances, and the meta
 * cards size themselves far more simply.
 */

const URL_RE = /https?:\/\/[^\s\])<>]+/g

export const cmTheme = EditorView.theme({
  '&': {
    backgroundColor: 'transparent',
    color: 'var(--markdown-fg, #cdd6f4)',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    fontSize: '12px',
    fontWeight: '400',
  },
  '.cm-content': {
    caretColor: '#f5e0dc',
    padding: '8px',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    fontSize: '12px',
    fontWeight: '400',
  },
  '&.cm-focused .cm-cursor': {
    borderLeftColor: '#f5e0dc',
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: '#585b70 !important',
  },
  '.cm-gutters': {
    display: 'none',
  },
  '.cm-activeLine': {
    backgroundColor: 'transparent',
  },
  '&.cm-focused .cm-activeLine': {
    backgroundColor: 'rgba(88, 91, 112, 0.15)',
  },
  '.cm-scroller': {
    overflow: 'hidden',
  },
  // Markdown heading decorations
  '.cm-header-1': {
    fontSize: '1.6em',
    fontWeight: '700',
    color: 'var(--markdown-accent, #4d9eff)',
  },
  '.cm-header-2': {
    fontSize: '1.3em',
    fontWeight: '700',
    color: 'var(--markdown-accent, #4d9eff)',
  },
  '.cm-header-3': {
    fontSize: '1.1em',
    fontWeight: '600',
    color: 'var(--markdown-accent, #4d9eff)',
  },
  '.cm-header-4, .cm-header-5, .cm-header-6': {
    fontWeight: '600',
    color: 'var(--markdown-accent, #4d9eff)',
  },
  // Inline code
  '.cm-inline-code': {
    backgroundColor: 'rgba(88, 91, 112, 0.4)',
    borderRadius: '3px',
    padding: '0 2px',
  },
  // Fenced code block lines
  '.cm-code-block-line': {
    backgroundColor: 'rgba(88, 91, 112, 0.3)',
  },
  // Bold
  '.cm-strong': {
    fontWeight: '700',
    color: 'var(--markdown-accent, #4d9eff)',
  },
  // Italic
  '.cm-emphasis': {
    fontStyle: 'italic',
    color: 'var(--markdown-highlight, #ffc94d)',
  },
  // Markdown link [text](url)
  '.cm-md-link': {
    color: 'var(--markdown-accent, #4d9eff)',
    textDecoration: 'underline',
    cursor: 'pointer',
  },
  // Auto-detected bare URLs
  '.cm-autolink': {
    color: 'var(--markdown-accent, #4d9eff)',
    textDecoration: 'underline',
    cursor: 'pointer',
  },
  // Blockquote
  '.cm-blockquote-line': {
    borderLeft: '3px solid #585b70',
    paddingLeft: '8px',
    color: `var(--markdown-blockquote-fg, ${blendHex('#cdd6f4', '#1e1e2e', 0.7)})`,
  },
  // List marker
  '.cm-list-marker': {
    color: 'var(--markdown-accent, #4d9eff)',
  },
  // Horizontal rule
  '.cm-hr-line': {
    color: '#585b70',
  },
}, { dark: true })

// ViewPlugin that walks the syntax tree and applies decorations
export const markdownDecorations = ViewPlugin.fromClass(class {
  decorations: DecorationSet

  constructor(view: EditorView) {
    this.decorations = this.buildDecorations(view)
  }

  update(update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged) {
      this.decorations = this.buildDecorations(update.view)
    }
  }

  buildDecorations(view: EditorView): DecorationSet {
    const widgets: any[] = []
    const tree = syntaxTree(view.state)

    tree.iterate({
      enter: (node) => {
        const type = node.type.name

        // Headings: apply line decoration for the whole line
        if (type.startsWith('ATXHeading1')) {
          this.addLineDecos(view, node.from, node.to, 'cm-header-1', widgets)
          return false
        }
        if (type.startsWith('ATXHeading2') && !type.startsWith('ATXHeading2')) {
          // handled below
        }
        if (type === 'ATXHeading2') {
          this.addLineDecos(view, node.from, node.to, 'cm-header-2', widgets)
          return false
        }
        if (type === 'ATXHeading3') {
          this.addLineDecos(view, node.from, node.to, 'cm-header-3', widgets)
          return false
        }
        if (type === 'ATXHeading4' || type === 'ATXHeading5' || type === 'ATXHeading6') {
          this.addLineDecos(view, node.from, node.to, 'cm-header-4', widgets)
          return false
        }

        // Inline code (including backtick marks)
        if (type === 'InlineCode') {
          widgets.push(Decoration.mark({ class: 'cm-inline-code' }).range(node.from, node.to))
          return false
        }

        // Fenced code block — decorate all lines
        if (type === 'FencedCode') {
          this.addLineDecos(view, node.from, node.to, 'cm-code-block-line', widgets)
          return false
        }

        // Bold / strong emphasis
        if (type === 'StrongEmphasis') {
          widgets.push(Decoration.mark({ class: 'cm-strong' }).range(node.from, node.to))
          return false
        }

        // Italic / emphasis
        if (type === 'Emphasis') {
          widgets.push(Decoration.mark({ class: 'cm-emphasis' }).range(node.from, node.to))
          return false
        }

        // Links
        if (type === 'Link') {
          widgets.push(Decoration.mark({ class: 'cm-md-link' }).range(node.from, node.to))
          return false
        }

        // Blockquote
        if (type === 'Blockquote') {
          this.addLineDecos(view, node.from, node.to, 'cm-blockquote-line', widgets)
          return false
        }

        // Horizontal rule
        if (type === 'HorizontalRule') {
          this.addLineDecos(view, node.from, node.to, 'cm-hr-line', widgets)
          return false
        }
      }
    })

    // Sort by from position (required by RangeSet)
    widgets.sort((a, b) => a.from - b.from || a.startSide - b.startSide)

    return Decoration.set(widgets)
  }

  addLineDecos(view: EditorView, from: number, to: number, cls: string, widgets: any[]) {
    for (let pos = from; pos <= to;) {
      const line = view.state.doc.lineAt(pos)
      widgets.push(Decoration.line({ class: cls }).range(line.from))
      pos = line.to + 1
    }
  }
}, {
  decorations: (v) => v.decorations
})

// Auto-detect bare URLs and decorate them as links
export const autolinkPlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet

  constructor(view: EditorView) {
    this.decorations = this.build(view)
  }

  update(update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged) {
      this.decorations = this.build(update.view)
    }
  }

  build(view: EditorView): DecorationSet {
    const widgets: any[] = []
    const tree = syntaxTree(view.state)

    for (const { from, to } of view.visibleRanges) {
      const text = view.state.doc.sliceString(from, to)
      URL_RE.lastIndex = 0
      let m
      while ((m = URL_RE.exec(text)) !== null) {
        const start = from + m.index
        const end = start + m[0].length
        // Skip if inside a markdown Link node (already decorated by markdownDecorations)
        let insideLink = false
        tree.iterate({
          from: start,
          to: start + 1,
          enter: (n) => {
            if (n.type.name === 'Link') {
              insideLink = true
              return false
            }
          }
        })
        if (!insideLink) {
          widgets.push(Decoration.mark({ class: 'cm-autolink' }).range(start, end))
        }
      }
    }

    widgets.sort((a, b) => a.from - b.from || a.startSide - b.startSide)
    return Decoration.set(widgets, true)
  }
}, {
  decorations: (v) => v.decorations
})

// Cmd+click to open links (both markdown [text](url) and bare URLs)
export const linkClickHandler = EditorView.domEventHandlers({
  click: (event: MouseEvent, view: EditorView) => {
    if (!event.metaKey && !event.ctrlKey) return false
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
    if (pos === null) return false

    // Check bare URLs on this line
    const line = view.state.doc.lineAt(pos)
    URL_RE.lastIndex = 0
    let m
    while ((m = URL_RE.exec(line.text)) !== null) {
      const start = line.from + m.index
      const end = start + m[0].length
      if (pos >= start && pos < end) {
        window.api.openExternal(m[0])
        event.preventDefault()
        return true
      }
    }

    // Check markdown links [text](url)
    const tree = syntaxTree(view.state)
    let url: string | null = null
    tree.iterate({
      from: pos,
      to: pos + 1,
      enter: (n) => {
        if (n.type.name === 'Link') {
          const linkText = view.state.doc.sliceString(n.from, n.to)
          const urlMatch = linkText.match(/\((https?:\/\/[^)]+)\)/)
          if (urlMatch) url = urlMatch[1]
          return false
        }
      }
    })
    if (url) {
      window.api.openExternal(url)
      event.preventDefault()
      return true
    }

    return false
  }
})
