import { useEffect, useRef, useState } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView, ViewPlugin, ViewUpdate, Decoration, DecorationSet, keymap } from '@codemirror/view'
import { markdown } from '@codemirror/lang-markdown'
import { indentWithTab } from '@codemirror/commands'
import { syntaxTree } from '@codemirror/language'
import { cmTheme, markdownDecorations, autolinkPlugin, linkClickHandler } from '../lib/markdown-extensions'
import { MARKDOWN_MIN_WIDTH, MARKDOWN_MIN_HEIGHT, MARKDOWN_DEFAULT_MAX_WIDTH, MARKDOWN_MIN_MAX_WIDTH } from '../lib/constants'
import { blendHex, cardSurfaceColor } from '../lib/color-presets'
import type { ColorPreset } from '../lib/color-presets'
import type { Camera } from '../lib/camera'
import type { ArchivedNode } from '../../../../shared/state'
import { CardShell } from './CardShell'
import { useReparentStore } from '../stores/reparentStore'
import { useFacet } from '../hooks/useFacet'
import { useRtsSelectStore } from '../stores/rtsSelectStore'
import { type NodeId } from '../../../../shared/ids'

const DRAG_THRESHOLD = 5
const CARD_TOP_PADDING = 28
const TYPING_BUFFER = 24
const URL_RE = /https?:\/\/[^\s\])<>]+/g

interface MarkdownCardProps {
  id: NodeId
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
  onFocus: (id: NodeId) => void
  onClose: (id: NodeId) => void
  onMove: (id: NodeId, x: number, y: number, metaKey?: boolean, shiftKey?: boolean) => void
  onResize: (id: NodeId, width: number, height: number) => void
  onContentChange: (id: NodeId, content: string) => void
  onMaxWidthChange: (id: NodeId, maxWidth: number) => void
  onRename: (id: NodeId, name: string) => void
  onColorChange: (id: NodeId, color: string) => void
  onOpenArchiveSearch: (nodeId: NodeId) => void
  onNodeReady?: (nodeId: NodeId, bounds: { x: number; y: number; width: number; height: number }) => void
  onDragStart?: (id: NodeId, solo?: boolean, ctrlAtStart?: boolean, shiftAtStart?: boolean) => void
  onDragEnd?: (id: NodeId) => void
  onUnfocus: () => void
  onStartReparent?: (id: NodeId) => void
  onReparentTarget?: (id: NodeId) => void
  onShipIt?: (id: NodeId) => void
  fileBacked?: boolean
  fileError?: boolean
  onAddNode?: (parentNodeId: NodeId, type: import('./AddNodeBody').AddNodeType) => void
  cameraRef: React.MutableRefObject<Camera>
}

// CodeMirror theme — colors use CSS custom properties so presets can override them

export function MarkdownCard({
  id, x, y, width, height, zIndex, zoom, content, maxWidth, colorPresetId, resolvedPreset, archivedChildren, focused, selected,
  onFocus, onClose, onMove, onResize, onContentChange, onMaxWidthChange, onColorChange, onOpenArchiveSearch, onNodeReady,
  onDragStart, onDragEnd, onUnfocus, onStartReparent, onReparentTarget, onShipIt,
  fileBacked, fileError, onAddNode, cameraRef
}: MarkdownCardProps) {
  // Where an unset node's colour comes from — see the `nodeTint` theme facet.
  const nodeTint = useFacet('nodeTint')
  const preset = resolvedPreset
  const bodyRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const isDraggingRef = useRef(false)
  const draftMaxWidthRef = useRef<number | null>(null)
  const [draftDims, setDraftDims] = useState<{ width: number; height: number } | null>(null)
  const suppressNextChangeRef = useRef(false)
  const fileWriteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const propsRef = useRef({ x, y, zoom, id, width, height, maxWidth, focused, onNodeReady, onContentChange, onResize, onMove, onUnfocus, fileBacked })
  propsRef.current = { x, y, zoom, id, width, height, maxWidth, focused, onNodeReady, onContentChange, onResize, onMove, onUnfocus, fileBacked }

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
        // Re-zoom camera to fit the new dimensions while focused
        if (propsRef.current.focused) {
          const { x: px, y: py, id: nid } = propsRef.current
          propsRef.current.onNodeReady?.(nid, {
            x: px - newWidth / 2,
            y: py - newHeight / 2,
            width: newWidth,
            height: newHeight
          })
        }
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

  // Notify parent when node first becomes focused (initial zoom).
  // Subsequent dimension changes while focused are handled by autoSize.
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
    const ctrlAtStart = e.ctrlKey
    let dragging = false

    const onMouseMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startScreenX
      const dy = ev.clientY - startScreenY

      if (!dragging && Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD) {
        dragging = true
        onDragStart?.(id, ev.metaKey, ctrlAtStart, ev.shiftKey)
      }

      if (dragging && !bodyClickWhileFocused) {
        onMove(id, startX + dx / currentZoom, startY + dy / currentZoom, ev.metaKey, ev.shiftKey)
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
  const rtsSelectActive = useRtsSelectStore(s => s.active)
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
      onOpenArchiveSearch={onOpenArchiveSearch}
      onMouseDown={handleMouseDown}
      onStartReparent={onStartReparent}
      onAddNode={onAddNode}
      onShipIt={onShipIt}
      isReparenting={reparentingNodeId === id}
      className={`markdown-card ${focused ? 'markdown-card--focused' : selected ? 'markdown-card--selected' : ''} ${isEmpty ? 'markdown-card--empty' : ''}`}
      style={{
        backgroundColor: cardSurfaceColor(preset),
        '--markdown-fg': preset?.markdownFg ?? '#cdd6f4',
        '--markdown-accent': preset?.markdownAccent ?? '#4d9eff',
        '--markdown-highlight': preset?.markdownHighlight ?? '#ffc94d',
        '--markdown-blockquote-fg': blendHex(preset?.markdownFg ?? '#cdd6f4', preset?.terminalBg ?? '#1e1e2e', 0.7),
        ...(focused && !rtsSelectActive ? { borderColor: nodeTint.borderColor(x, y), boxShadow: `0 0 4px ${nodeTint.borderColor(x, y)}` } : undefined),
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
