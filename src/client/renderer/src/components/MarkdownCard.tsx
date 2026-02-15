import { useEffect, useRef } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView, ViewPlugin, ViewUpdate, Decoration, DecorationSet, keymap } from '@codemirror/view'
import { markdown } from '@codemirror/lang-markdown'
import { syntaxTree } from '@codemirror/language'
import { MARKDOWN_MIN_WIDTH, MARKDOWN_MIN_HEIGHT } from '../lib/constants'
import { COLOR_PRESET_MAP, blendHex } from '../lib/color-presets'
import type { ArchivedNode } from '../../../../shared/state'
import { NodeTitleBarSharedControls } from './NodeTitleBarSharedControls'

const DRAG_THRESHOLD = 5
const URL_RE = /https?:\/\/[^\s\])<>]+/g

interface MarkdownCardProps {
  id: string
  x: number
  y: number
  width: number
  height: number
  zIndex: number
  zoom: number
  content: string
  name?: string
  colorPresetId?: string
  archivedChildren: ArchivedNode[]
  focused: boolean
  onFocus: (id: string) => void
  onClose: (id: string) => void
  onMove: (id: string, x: number, y: number) => void
  onResize: (id: string, width: number, height: number) => void
  onContentChange: (id: string, content: string) => void
  onRename: (id: string, name: string) => void
  onColorChange: (id: string, color: string) => void
  onUnarchive: (parentNodeId: string, archivedNodeId: string) => void
  onArchiveDelete: (parentNodeId: string, archivedNodeId: string) => void
  onNodeReady?: (nodeId: string, bounds: { x: number; y: number; width: number; height: number }) => void
  onDragStart?: (id: string) => void
  onDragEnd?: (id: string) => void
}

// CodeMirror theme — colors use CSS custom properties so presets can override them
const cmTheme = EditorView.theme({
  '&': {
    backgroundColor: '#1e1e2e',
    color: 'var(--markdown-fg, #cdd6f4)',
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    fontSize: '14px',
  },
  '.cm-content': {
    caretColor: '#f5e0dc',
    padding: '8px',
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
    color: 'var(--markdown-accent, #89b4fa)',
  },
  '.cm-header-2': {
    fontSize: '1.3em',
    fontWeight: '700',
    color: 'var(--markdown-accent, #89b4fa)',
  },
  '.cm-header-3': {
    fontSize: '1.1em',
    fontWeight: '600',
    color: 'var(--markdown-accent, #89b4fa)',
  },
  '.cm-header-4, .cm-header-5, .cm-header-6': {
    fontWeight: '600',
    color: 'var(--markdown-accent, #89b4fa)',
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
    color: 'var(--markdown-accent, #89b4fa)',
  },
  // Italic
  '.cm-emphasis': {
    fontStyle: 'italic',
    color: 'var(--markdown-highlight, #f9e2af)',
  },
  // Markdown link [text](url)
  '.cm-md-link': {
    color: 'var(--markdown-accent, #89b4fa)',
    textDecoration: 'underline',
    cursor: 'pointer',
  },
  // Auto-detected bare URLs
  '.cm-autolink': {
    color: 'var(--markdown-accent, #89b4fa)',
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
    color: 'var(--markdown-accent, #89b4fa)',
  },
  // Horizontal rule
  '.cm-hr-line': {
    color: '#585b70',
  },
}, { dark: true })

// ViewPlugin that walks the syntax tree and applies decorations
const markdownDecorations = ViewPlugin.fromClass(class {
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
const autolinkPlugin = ViewPlugin.fromClass(class {
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
const linkClickHandler = EditorView.domEventHandlers({
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

export function MarkdownCard({
  id, x, y, width, height, zIndex, zoom, content, colorPresetId, archivedChildren, focused,
  onFocus, onClose, onMove, onResize, onContentChange, onColorChange, onUnarchive, onArchiveDelete, onNodeReady,
  onDragStart, onDragEnd
}: MarkdownCardProps) {
  const preset = colorPresetId ? COLOR_PRESET_MAP[colorPresetId] : undefined
  const bodyRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const propsRef = useRef({ x, y, zoom, id, width, height, onNodeReady, onContentChange, onResize })
  propsRef.current = { x, y, zoom, id, width, height, onNodeReady, onContentChange, onResize }

  // Auto-size helper: collapse scroller to 0×0 so scrollWidth/scrollHeight
  // report intrinsic content size (otherwise they never shrink below container).
  // Both shrink + restore happen in the same rAF, before paint, so no flicker.
  const autoSize = (view: EditorView) => {
    requestAnimationFrame(() => {
      const scroller = view.scrollDOM
      scroller.style.width = '0px'
      scroller.style.height = '0px'
      // 4px chrome = 2px border × 2 sides
      const newWidth = Math.max(MARKDOWN_MIN_WIDTH, scroller.scrollWidth + 4)
      const newHeight = Math.max(MARKDOWN_MIN_HEIGHT, scroller.scrollHeight + 4)
      scroller.style.width = ''
      scroller.style.height = ''
      const { width: curW, height: curH } = propsRef.current
      if (Math.abs(newWidth - curW) > 1 || Math.abs(newHeight - curH) > 1) {
        propsRef.current.onResize(propsRef.current.id, newWidth, newHeight)
      }
    })
  }

  // Mount CodeMirror
  useEffect(() => {
    if (!bodyRef.current) return

    const state = EditorState.create({
      doc: content,
      extensions: [
        markdown(),
        cmTheme,
        markdownDecorations,
        autolinkPlugin,
        linkClickHandler,
        EditorView.updateListener.of((update: ViewUpdate) => {
          if (update.docChanged) {
            propsRef.current.onContentChange(propsRef.current.id, update.state.doc.toString())
            autoSize(update.view)
          }
        }),
        // Prevent Cmd+M from being swallowed by CodeMirror
        keymap.of([]),
      ]
    })

    const view = new EditorView({
      state,
      parent: bodyRef.current
    })

    viewRef.current = view

    // Initial auto-size on mount for restored content
    autoSize(view)

    return () => {
      view.destroy()
      viewRef.current = null
    }
  }, [id]) // Only remount if id changes

  // Focus management
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    if (focused) {
      view.focus()
    } else {
      view.contentDOM.blur()
    }
  }, [focused])

  // Notify parent when focused node size is known (no width/height deps to avoid jitter)
  useEffect(() => {
    if (!focused) return
    const { x: px, y: py, width: pw, height: ph } = propsRef.current
    propsRef.current.onNodeReady?.(id, { x: px - pw / 2, y: py - ph / 2, width: pw, height: ph })
  }, [focused, id])

  // Apply color to CodeMirror editor background
  useEffect(() => {
    const view = viewRef.current
    if (view) {
      view.dom.style.backgroundColor = preset?.terminalBg ?? '#1e1e2e'
    }
  }, [preset])

  // Drag handler
  const handleMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.node-titlebar__actions, .node-titlebar__color-picker, .archive-panel')) return

    const bodyClickWhileFocused = focused
    if (!bodyClickWhileFocused) {
      e.preventDefault()
    }

    const startScreenX = e.clientX
    const startScreenY = e.clientY
    const startX = propsRef.current.x
    const startY = propsRef.current.y
    const currentZoom = propsRef.current.zoom
    let dragging = false

    const onMouseMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startScreenX
      const dy = ev.clientY - startScreenY

      if (!dragging && Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD) {
        dragging = true
        onDragStart?.(id)
      }

      if (dragging && !bodyClickWhileFocused) {
        onMove(id, startX + dx / currentZoom, startY + dy / currentZoom)
      }
    }

    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      if (dragging) {
        onDragEnd?.(id)
      } else {
        onFocus(id)
      }
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }

  return (
    <div
      style={{
        position: 'absolute',
        left: x - width / 2,
        top: y - height / 2,
        width,
        height,
        zIndex
      }}
    >
      <div
        data-node-id={id}
        className={`markdown-card canvas-node ${focused ? 'markdown-card--focused' : ''}`}
        style={{
          backgroundColor: preset?.terminalBg ?? '#1e1e2e',
          '--markdown-fg': preset?.markdownFg ?? '#cdd6f4',
          '--markdown-accent': preset?.markdownAccent ?? '#89b4fa',
          '--markdown-highlight': preset?.markdownHighlight ?? '#f9e2af',
          '--markdown-blockquote-fg': blendHex(preset?.markdownFg ?? '#cdd6f4', preset?.terminalBg ?? '#1e1e2e', 0.7),
        } as React.CSSProperties}
        onMouseDown={handleMouseDown}
      >
        <NodeTitleBarSharedControls id={id} archivedChildren={archivedChildren} onClose={onClose} onColorChange={onColorChange} onUnarchive={onUnarchive} onArchiveDelete={onArchiveDelete} />
        <div className="markdown-card__body" ref={bodyRef} />
      </div>
    </div>
  )
}
