import { useEffect, useRef, useState } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView, ViewPlugin, ViewUpdate, Decoration, DecorationSet, keymap } from '@codemirror/view'
import { markdown } from '@codemirror/lang-markdown'
import { syntaxTree } from '@codemirror/language'
import { MARKDOWN_MIN_WIDTH, MARKDOWN_MIN_HEIGHT } from '../lib/constants'
import { COLOR_PRESETS, COLOR_PRESET_MAP } from '../lib/color-presets'

const DRAG_THRESHOLD = 5
const RESIZE_HANDLE_SIZE = 12

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
  focused: boolean
  onFocus: (id: string) => void
  onClose: (id: string) => void
  onMove: (id: string, x: number, y: number) => void
  onResize: (id: string, width: number, height: number) => void
  onContentChange: (id: string, content: string) => void
  onRename: (id: string, name: string) => void
  onColorChange: (id: string, color: string) => void
  onNodeReady?: (nodeId: string, bounds: { x: number; y: number; width: number; height: number }) => void
}

// CodeMirror theme matching the terminal dark theme
const cmTheme = EditorView.theme({
  '&': {
    backgroundColor: '#1e1e2e',
    color: '#cdd6f4',
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
    overflow: 'auto',
  },
  // Markdown heading decorations
  '.cm-header-1': {
    fontSize: '1.6em',
    fontWeight: '700',
    color: '#89b4fa',
  },
  '.cm-header-2': {
    fontSize: '1.3em',
    fontWeight: '700',
    color: '#89b4fa',
  },
  '.cm-header-3': {
    fontSize: '1.1em',
    fontWeight: '600',
    color: '#89b4fa',
  },
  '.cm-header-4, .cm-header-5, .cm-header-6': {
    fontWeight: '600',
    color: '#89b4fa',
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
    color: '#f9e2af',
  },
  // Italic
  '.cm-emphasis': {
    fontStyle: 'italic',
    color: '#a6e3a1',
  },
  // Link
  '.cm-md-link': {
    color: '#89b4fa',
    textDecoration: 'underline',
  },
  // Blockquote
  '.cm-blockquote-line': {
    borderLeft: '3px solid #585b70',
    paddingLeft: '8px',
    color: '#a6adc8',
  },
  // List marker
  '.cm-list-marker': {
    color: '#cba6f7',
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

export function MarkdownCard({
  id, x, y, width, height, zIndex, zoom, content, name, colorPresetId, focused,
  onFocus, onClose, onMove, onResize, onContentChange, onRename, onColorChange, onNodeReady
}: MarkdownCardProps) {
  const preset = colorPresetId ? COLOR_PRESET_MAP[colorPresetId] : undefined
  const bodyRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const propsRef = useRef({ x, y, zoom, id, onNodeReady, onContentChange })
  propsRef.current = { x, y, zoom, id, onNodeReady, onContentChange }

  // Mount CodeMirror
  useEffect(() => {
    if (!bodyRef.current) return

    const state = EditorState.create({
      doc: content,
      extensions: [
        markdown(),
        cmTheme,
        markdownDecorations,
        EditorView.updateListener.of((update: ViewUpdate) => {
          if (update.docChanged) {
            propsRef.current.onContentChange(propsRef.current.id, update.state.doc.toString())
          }
        }),
        // Prevent Cmd+M from being swallowed by CodeMirror
        keymap.of([]),
        EditorView.lineWrapping,
      ]
    })

    const view = new EditorView({
      state,
      parent: bodyRef.current
    })

    viewRef.current = view

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

  // Notify parent when focused node size is known
  useEffect(() => {
    if (!focused) return
    propsRef.current.onNodeReady?.(id, { x: propsRef.current.x, y: propsRef.current.y, width, height })
  }, [focused, width, height, id])

  // Editable title state
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState('')

  // Color picker state
  const [pickerOpen, setPickerOpen] = useState(false)
  const pickerRef = useRef<HTMLDivElement>(null)

  // Close color picker on outside click
  useEffect(() => {
    if (!pickerOpen) return
    const handleClick = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [pickerOpen])

  // Drag handler
  const handleMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.terminal-card__close, .terminal-card__color-btn, .terminal-card__title, .terminal-card__title-input, .terminal-card__color-picker, .markdown-card__resize-handle')) return

    const isHeader = !!(e.target as HTMLElement).closest('.terminal-card__header')
    const bodyClickWhileFocused = focused && !isHeader
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
      }

      if (dragging && !bodyClickWhileFocused) {
        onMove(id, startX + dx / currentZoom, startY + dy / currentZoom)
      }
    }

    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      if (!dragging) {
        onFocus(id)
      }
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }

  // Resize handler
  const handleResizeMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()

    const startScreenX = e.clientX
    const startScreenY = e.clientY
    const startWidth = width
    const startHeight = height
    const currentZoom = propsRef.current.zoom

    const onMouseMove = (ev: MouseEvent) => {
      const dx = (ev.clientX - startScreenX) / currentZoom
      const dy = (ev.clientY - startScreenY) / currentZoom
      const newWidth = Math.max(MARKDOWN_MIN_WIDTH, startWidth + dx)
      const newHeight = Math.max(MARKDOWN_MIN_HEIGHT, startHeight + dy)
      onResize(id, newWidth, newHeight)
    }

    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }

  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        width,
        height,
        zIndex
      }}
    >
      <div
        data-node-id={id}
        className={`markdown-card canvas-node ${focused ? 'markdown-card--focused' : ''}`}
        onMouseDown={handleMouseDown}
      >
        <div
          className="terminal-card__header"
          style={preset ? {
            backgroundColor: preset.titleBarBg,
            color: preset.titleBarFg,
            borderBottomColor: preset.titleBarBg
          } : undefined}
        >
          {editing ? (
            <input
              className="terminal-card__title-input"
              value={editValue}
              style={preset ? { color: preset.titleBarFg } : undefined}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  onRename(id, editValue)
                  setEditing(false)
                } else if (e.key === 'Escape') {
                  setEditing(false)
                }
                e.stopPropagation()
              }}
              onBlur={() => {
                onRename(id, editValue)
                setEditing(false)
              }}
              onMouseDown={(e) => e.stopPropagation()}
              autoFocus
            />
          ) : (
            <span
              className="terminal-card__title"
              style={preset ? { color: preset.titleBarFg } : undefined}
              onClick={(e) => {
                e.stopPropagation()
                setEditValue(name || 'note')
                setEditing(true)
              }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              {name || 'note'}
            </span>
          )}
          <div className="terminal-card__actions">
            <div style={{ position: 'relative' }} ref={pickerRef}>
              <button
                className="terminal-card__color-btn"
                title="Header color"
                style={preset ? { color: preset.titleBarFg } : undefined}
                onClick={(e) => {
                  e.stopPropagation()
                  setPickerOpen((prev) => !prev)
                }}
                onMouseDown={(e) => e.stopPropagation()}
              >
                &#9679;
              </button>
              {pickerOpen && (
                <div className="terminal-card__color-picker" onMouseDown={(e) => e.stopPropagation()}>
                  {COLOR_PRESETS.map((p) => (
                    <button
                      key={p.id}
                      className="terminal-card__color-swatch"
                      style={{ backgroundColor: p.titleBarBg }}
                      onClick={(e) => {
                        e.stopPropagation()
                        onColorChange(id, p.id)
                        setPickerOpen(false)
                      }}
                    />
                  ))}
                </div>
              )}
            </div>
            <button
              className="terminal-card__close"
              style={preset ? { color: preset.titleBarFg } : undefined}
              onClick={(e) => { e.stopPropagation(); onClose(id) }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              &times;
            </button>
          </div>
        </div>
        <div className="markdown-card__body" ref={bodyRef} />
        <div
          className="markdown-card__resize-handle"
          onMouseDown={handleResizeMouseDown}
        />
      </div>
    </div>
  )
}
