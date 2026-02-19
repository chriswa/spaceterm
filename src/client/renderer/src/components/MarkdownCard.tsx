import { useEffect, useRef, useState } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView, ViewPlugin, ViewUpdate, Decoration, DecorationSet, keymap } from '@codemirror/view'
import { markdown } from '@codemirror/lang-markdown'
import { indentWithTab } from '@codemirror/commands'
import { syntaxTree } from '@codemirror/language'
import { MARKDOWN_MIN_WIDTH, MARKDOWN_MIN_HEIGHT, MARKDOWN_DEFAULT_MAX_WIDTH, MARKDOWN_MIN_MAX_WIDTH } from '../lib/constants'
import { blendHex } from '../lib/color-presets'
import type { ColorPreset } from '../lib/color-presets'
import type { Camera } from '../lib/camera'
import type { ArchivedNode } from '../../../../shared/state'
import { CardShell } from './CardShell'
import { useReparentStore } from '../stores/reparentStore'

const DRAG_THRESHOLD = 5
const CARD_TOP_PADDING = 28
const TYPING_BUFFER = 24
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
  maxWidth?: number
  name?: string
  colorPresetId?: string
  resolvedPreset?: ColorPreset
  archivedChildren: ArchivedNode[]
  focused: boolean
  selected: boolean
  onFocus: (id: string) => void
  onClose: (id: string) => void
  onMove: (id: string, x: number, y: number) => void
  onResize: (id: string, width: number, height: number) => void
  onContentChange: (id: string, content: string) => void
  onMaxWidthChange: (id: string, maxWidth: number) => void
  onRename: (id: string, name: string) => void
  onColorChange: (id: string, color: string) => void
  onUnarchive: (parentNodeId: string, archivedNodeId: string) => void
  onArchiveDelete: (parentNodeId: string, archivedNodeId: string) => void
  onArchiveToggled: (nodeId: string, open: boolean) => void
  onNodeReady?: (nodeId: string, bounds: { x: number; y: number; width: number; height: number }) => void
  onDragStart?: (id: string, solo?: boolean) => void
  onDragEnd?: (id: string) => void
  onUnfocus: () => void
  onStartReparent?: (id: string) => void
  onReparentTarget?: (id: string) => void
  onShipIt?: (id: string) => void
  fileBacked?: boolean
  fileError?: boolean
  onAddNode?: (parentNodeId: string, type: import('./AddNodeBody').AddNodeType) => void
  cameraRef: React.RefObject<Camera>
}

// CodeMirror theme — colors use CSS custom properties so presets can override them
const cmTheme = EditorView.theme({
  '&': {
    backgroundColor: 'transparent',
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
  id, x, y, width, height, zIndex, zoom, content, maxWidth, colorPresetId, resolvedPreset, archivedChildren, focused, selected,
  onFocus, onClose, onMove, onResize, onContentChange, onMaxWidthChange, onColorChange, onUnarchive, onArchiveDelete, onArchiveToggled, onNodeReady,
  onDragStart, onDragEnd, onUnfocus, onStartReparent, onReparentTarget, onShipIt,
  fileBacked, fileError, onAddNode, cameraRef
}: MarkdownCardProps) {
  const preset = resolvedPreset
  const bodyRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const isDraggingRef = useRef(false)
  const draftMaxWidthRef = useRef<number | null>(null)
  const [draftDims, setDraftDims] = useState<{ width: number; height: number } | null>(null)
  const suppressNextChangeRef = useRef(false)
  const fileWriteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const propsRef = useRef({ x, y, zoom, id, width, height, maxWidth, onNodeReady, onContentChange, onResize, onMove, onUnfocus, fileBacked })
  propsRef.current = { x, y, zoom, id, width, height, maxWidth, onNodeReady, onContentChange, onResize, onMove, onUnfocus, fileBacked }

  // Clear draft state when server-synced maxWidth changes
  useEffect(() => {
    if (!isDraggingRef.current) {
      draftMaxWidthRef.current = null
      setDraftDims(null)
    }
  }, [maxWidth, width, height])

  /** Two-pass measurement: returns { width, height } for the card given a maxWidth constraint. */
  const measure = (view: EditorView, effectiveMax: number): { width: number; height: number } => {
    const scroller = view.scrollDOM
    const contentDOM = view.contentDOM

    // Pass 1: measure intrinsic (unwrapped) width
    contentDOM.style.whiteSpace = 'nowrap'
    scroller.style.width = '0px'
    scroller.style.height = '0px'
    const intrinsicWidth = scroller.scrollWidth

    // Pass 2: measure height at constrained width
    contentDOM.style.whiteSpace = ''
    const constrainedWidth = Math.max(
      MARKDOWN_MIN_WIDTH - 4,
      Math.min(intrinsicWidth, effectiveMax - 4)
    )
    scroller.style.width = `${constrainedWidth}px`
    scroller.style.height = '0px'
    const scrollHeight = scroller.scrollHeight

    // Restore
    scroller.style.width = ''
    scroller.style.height = ''

    const finalWidth = Math.min(intrinsicWidth + 8 + TYPING_BUFFER, effectiveMax)
    const finalHeight = Math.max(MARKDOWN_MIN_HEIGHT, scrollHeight + 4 + CARD_TOP_PADDING)
    return { width: Math.max(MARKDOWN_MIN_WIDTH, finalWidth), height: finalHeight }
  }

  // Auto-size helper using two-pass measurement with maxWidth constraint.
  const autoSize = (view: EditorView) => {
    requestAnimationFrame(() => {
      if (isDraggingRef.current) return
      const effectiveMax = draftMaxWidthRef.current ?? (propsRef.current.maxWidth ?? MARKDOWN_DEFAULT_MAX_WIDTH)
      const { width: newWidth, height: newHeight } = measure(view, effectiveMax)
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
        EditorView.lineWrapping,
        markdownDecorations,
        autolinkPlugin,
        linkClickHandler,
        EditorView.updateListener.of((update: ViewUpdate) => {
          if (update.docChanged) {
            if (suppressNextChangeRef.current) {
              suppressNextChangeRef.current = false
            } else if (propsRef.current.fileBacked) {
              // Debounce file writes (300ms)
              if (fileWriteTimerRef.current) clearTimeout(fileWriteTimerRef.current)
              fileWriteTimerRef.current = setTimeout(() => {
                fileWriteTimerRef.current = null
                propsRef.current.onContentChange(propsRef.current.id, update.state.doc.toString())
              }, 300)
            } else {
              propsRef.current.onContentChange(propsRef.current.id, update.state.doc.toString())
            }
          }
          if (update.docChanged || update.geometryChanged) {
            autoSize(update.view)
          }
        }),
        // Prevent Cmd+M from being swallowed by CodeMirror
        keymap.of([
          { key: 'Escape', run: () => { propsRef.current.onUnfocus(); return true } },
          indentWithTab,
        ]),
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
      if (fileWriteTimerRef.current) {
        clearTimeout(fileWriteTimerRef.current)
        fileWriteTimerRef.current = null
      }
      view.destroy()
      viewRef.current = null
    }
  }, [id, fileError]) // Remount when id changes or error state toggles (body div is conditional)

  // External content injection — sync editor when content prop changes (file-backed)
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const currentDoc = view.state.doc.toString()
    if (content === currentDoc) return

    // Cancel any pending debounced write (external change takes precedence)
    if (fileWriteTimerRef.current) {
      clearTimeout(fileWriteTimerRef.current)
      fileWriteTimerRef.current = null
    }

    suppressNextChangeRef.current = true
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: content }
    })
  }, [content])

  // Re-run autoSize when maxWidth changes from server
  useEffect(() => {
    const view = viewRef.current
    if (view && !isDraggingRef.current) {
      autoSize(view)
    }
  }, [maxWidth])

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
      view.dom.style.backgroundColor = 'transparent'
    }
  }, [preset])

  // Resize handle drag handler
  const handleResizeMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()

    const view = viewRef.current
    if (!view) return

    const startClientX = e.clientX
    const startWidth = propsRef.current.width
    const currentZoom = cameraRef.current.z
    isDraggingRef.current = true

    const handleEl = (e.target as HTMLElement).closest('.markdown-card__resize-handle')
    handleEl?.classList.add('markdown-card__resize-handle--dragging')

    const onMouseMove = (ev: MouseEvent) => {
      const dx = (ev.clientX - startClientX) / currentZoom
      const newMaxWidth = Math.max(MARKDOWN_MIN_MAX_WIDTH, startWidth + dx)
      draftMaxWidthRef.current = newMaxWidth

      // Synchronous two-pass measurement
      const { width: measuredWidth, height: newHeight } = measure(view, newMaxWidth)
      // Show maxWidth during drag so the user sees the constraint they're setting
      const displayWidth = Math.max(measuredWidth, newMaxWidth)
      setDraftDims({ width: displayWidth, height: newHeight })
    }

    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      handleEl?.classList.remove('markdown-card__resize-handle--dragging')

      isDraggingRef.current = false
      const finalMaxWidth = draftMaxWidthRef.current ?? startWidth

      // Direct measure — don't read stale draftDims closure (always null from mousedown time)
      const { width: fw, height: fh } = measure(view, finalMaxWidth)
      setDraftDims({ width: fw, height: fh })
      // Don't clear draftMaxWidthRef or draftDims — useEffect clears on server confirm

      onMaxWidthChange(id, finalMaxWidth)
      onResize(id, fw, fh)
      autoSize(view)
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }

  // Drag handler
  const handleMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.node-titlebar__actions, .node-titlebar__color-picker, .archive-body, .markdown-card__resize-handle')) return

    const bodyClickWhileFocused = focused
    if (!bodyClickWhileFocused) {
      e.preventDefault()
    }

    const startScreenX = e.clientX
    const startScreenY = e.clientY
    const startX = propsRef.current.x
    const startY = propsRef.current.y
    const currentZoom = cameraRef.current.z
    let dragging = false

    const onMouseMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startScreenX
      const dy = ev.clientY - startScreenY

      if (!dragging && Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD) {
        dragging = true
        onDragStart?.(id, ev.metaKey)
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
      } else if (useReparentStore.getState().reparentingNodeId) {
        onReparentTarget?.(id)
      } else {
        onFocus(id)
        viewRef.current?.focus()
      }
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }

  const reparentingNodeId = useReparentStore(s => s.reparentingNodeId)
  const isEmpty = !content.trim()

  const displayWidth = draftDims?.width ?? width
  const displayHeight = draftDims?.height ?? height

  return (
    <CardShell
      nodeId={id}
      x={x - displayWidth / 2}
      y={y - displayHeight / 2}
      width={displayWidth}
      height={displayHeight}
      zIndex={zIndex}
      focused={focused}
      headVariant="overlay"
      archivedChildren={archivedChildren}
      onClose={onClose}
      onColorChange={onColorChange}
      onUnarchive={onUnarchive}
      onArchiveDelete={onArchiveDelete}
      onArchiveToggled={onArchiveToggled}
      onMouseDown={handleMouseDown}
      onStartReparent={onStartReparent}
      onAddNode={onAddNode}
      onShipIt={onShipIt}
      isReparenting={reparentingNodeId === id}
      className={`markdown-card ${focused ? 'markdown-card--focused' : selected ? 'markdown-card--selected' : ''} ${isEmpty ? 'markdown-card--empty' : ''}`}
      style={{
        backgroundColor: 'transparent',
        '--markdown-fg': preset?.markdownFg ?? '#cdd6f4',
        '--markdown-accent': preset?.markdownAccent ?? '#89b4fa',
        '--markdown-highlight': preset?.markdownHighlight ?? '#f9e2af',
        '--markdown-blockquote-fg': blendHex(preset?.markdownFg ?? '#cdd6f4', preset?.terminalBg ?? '#1e1e2e', 0.7),
      } as React.CSSProperties}
      onMouseEnter={() => { if (reparentingNodeId) useReparentStore.getState().setHoveredNode(id) }}
      onMouseLeave={() => { if (reparentingNodeId) useReparentStore.getState().setHoveredNode(null) }}
    >
      {fileError ? (
        <div className="markdown-card__file-error">
          File-backed node — requires a File parent
        </div>
      ) : (
        <div className="markdown-card__body" ref={bodyRef} />
      )}
      <div className="markdown-card__resize-handle" onMouseDown={handleResizeMouseDown} />
    </CardShell>
  )
}
