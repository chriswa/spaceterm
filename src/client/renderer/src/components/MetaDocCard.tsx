import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { markdown } from '@codemirror/lang-markdown'
import { indentWithTab } from '@codemirror/commands'
import {
  cmTheme,
  markdownDecorations,
  autolinkPlugin,
  linkClickHandler
} from '../lib/markdown-extensions'
import { META_DOC_MAX_HEIGHT, META_DOC_WIDTH } from '../../../../shared/node-size'
import { cardSurfaceColor } from '../lib/color-presets'
import type { ColorPreset } from '../lib/color-presets'
import type { Camera } from '../lib/camera'
import type { ArchivedNode } from '../../../../shared/state'
import { documentSummary } from '../../../../shared/frontmatter'
import { CardShell } from './CardShell'
import { useReparentStore } from '../stores/reparentStore'
import { type NodeId } from '../../../../shared/ids'

const DRAG_THRESHOLD = 5
/** Debounce on writing an edit back to the file, matching file-backed markdown. */
const WRITE_DEBOUNCE_MS = 300
const CARD_PADDING = 16

interface MetaDocCardProps {
  id: NodeId
  x: number
  y: number
  width: number
  height: number
  zIndex: number
  zoom: number
  /** File contents, streamed from the server. Empty until the first read lands. */
  content: string
  docKind: 'skill' | 'doc'
  docKey: string
  docPath: string
  expanded: boolean
  focused: boolean
  selected: boolean
  resolvedPreset?: ColorPreset
  archivedChildren: ArchivedNode[]
  onFocus: (id: NodeId) => void
  onMove: (id: NodeId, x: number, y: number, metaKey?: boolean, shiftKey?: boolean) => void
  onToggleExpanded: (id: NodeId) => void
  onContentChange: (id: NodeId, content: string) => void
  onResize: (id: NodeId, width: number, height: number) => void
  onNodeReady?: (nodeId: NodeId, bounds: { x: number; y: number; width: number; height: number }) => void
  onDragStart?: (id: NodeId, solo?: boolean, ctrlAtStart?: boolean, shiftAtStart?: boolean) => void
  onDragEnd?: (id: NodeId) => void
  cameraRef: React.MutableRefObject<Camera>
}

/**
 * One markdown document from disk — a skill's `SKILL.md`, or a `CLAUDE.md`.
 *
 * Two faces. Collapsed, it shows the document's header: a skill's `name` and
 * `description`, or, for a document with no frontmatter, its first heading and
 * lead paragraph. That is the face you read a column of. Expanded, it is the
 * whole file in the same editor a markdown card uses, and edits are written
 * back to the file.
 *
 * Sizing is deliberately simpler than `MarkdownCard`'s two-pass measurement:
 * the width is fixed, so a column of these shares an edge and reads as the list
 * it is, and only the height is measured. Opening one therefore never reflows
 * the cards beside it.
 */
export function MetaDocCard({
  id, x, y, width, height, zIndex, content, docKind, docKey, docPath,
  expanded, focused, selected, resolvedPreset, archivedChildren,
  onFocus, onMove, onToggleExpanded, onContentChange, onResize, onNodeReady,
  onDragStart, onDragEnd, cameraRef
}: MetaDocCardProps) {
  const preset = resolvedPreset
  const bodyRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const collapsedRef = useRef<HTMLDivElement>(null)
  const suppressNextChangeRef = useRef(false)
  const writeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const propsRef = useRef({ x, y, id, onContentChange })
  propsRef.current = { x, y, id, onContentChange }
  const reparentingNodeId = useReparentStore(s => s.reparentingNodeId)

  // The caption is parsed here rather than sent as node fields: the content is
  // already in hand for the editor, so the header re-renders as you type in it.
  const summary = useMemo(
    () => documentSummary(content, docKind === 'skill' ? docKey : docPath.split('/').pop() ?? docKey),
    [content, docKind, docKey, docPath]
  )

  const report = useCallback((h: number) => {
    const clamped = Math.min(META_DOC_MAX_HEIGHT, Math.max(48, Math.ceil(h)))
    if (Math.abs(clamped - height) > 1) onResize(id, META_DOC_WIDTH, clamped)
  }, [height, id, onResize])

  // --- Collapsed: measure the caption block ---
  useLayoutEffect(() => {
    if (expanded || !collapsedRef.current) return
    report(collapsedRef.current.scrollHeight + CARD_PADDING)
  }, [expanded, summary, report])

  // --- Expanded: the editor ---
  useEffect(() => {
    if (!expanded || !bodyRef.current) return

    const view = new EditorView({
      state: EditorState.create({
        doc: content,
        extensions: [
          markdown(),
          cmTheme,
          EditorView.lineWrapping,
          markdownDecorations,
          autolinkPlugin,
          linkClickHandler,
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return
            if (suppressNextChangeRef.current) {
              suppressNextChangeRef.current = false
              return
            }
            // Debounced, like file-backed markdown: one write per pause rather
            // than one per keystroke, which the server also uses to suppress
            // the rescan its own write would otherwise trigger.
            if (writeTimerRef.current) clearTimeout(writeTimerRef.current)
            writeTimerRef.current = setTimeout(() => {
              writeTimerRef.current = null
              propsRef.current.onContentChange(propsRef.current.id, update.state.doc.toString())
            }, WRITE_DEBOUNCE_MS)
          }),
          keymap.of([
            { key: 'Escape', run: () => { onToggleExpanded(propsRef.current.id); return true } },
            indentWithTab
          ])
        ]
      }),
      parent: bodyRef.current
    })
    viewRef.current = view
    requestAnimationFrame(() => report(view.scrollDOM.scrollHeight + CARD_PADDING))

    return () => {
      if (writeTimerRef.current) {
        clearTimeout(writeTimerRef.current)
        writeTimerRef.current = null
      }
      view.destroy()
      viewRef.current = null
    }
    // `content` is deliberately absent from the deps: re-creating the editor on
    // every keystroke would lose the cursor. External changes are applied by the
    // effect below, which dispatches into the live view instead.
  }, [expanded, id])

  // External edits — someone else's editor, or an agent — replace the document.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    if (content === view.state.doc.toString()) return
    if (writeTimerRef.current) {
      clearTimeout(writeTimerRef.current)
      writeTimerRef.current = null
    }
    suppressNextChangeRef.current = true
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } })
    requestAnimationFrame(() => report(view.scrollDOM.scrollHeight + CARD_PADDING))
  }, [content, report])

  useEffect(() => {
    if (!focused) return
    onNodeReady?.(id, { x: x - width / 2, y: y - height / 2, width, height })
  }, [focused, id, x, y, width, height, onNodeReady])

  const handleMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.node-titlebar__actions, .archive-body')) return
    // Let the editor take the click when it is open, or selecting text would
    // start a drag.
    if (expanded && (e.target as HTMLElement).closest('.meta-doc-card__editor')) return
    e.preventDefault()

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
      if (dragging) {
        onMove(id, startX + dx / currentZoom, startY + dy / currentZoom, ev.metaKey, ev.shiftKey)
      }
    }

    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      if (dragging) {
        onDragEnd?.(id)
        return
      }
      if (!focused) onFocus(id)
      onToggleExpanded(id)
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }

  return (
    <CardShell
      nodeId={id}
      x={x - width / 2}
      y={y - height / 2}
      width={width}
      height={height}
      zIndex={zIndex}
      focused={focused}
      headVariant="overlay"
      showClose={false}
      showColorPicker={false}
      archivedChildren={archivedChildren}
      onClose={() => {}}
      onColorChange={() => {}}
      onOpenArchiveSearch={() => {}}
      onMouseDown={handleMouseDown}
      isReparenting={reparentingNodeId === id}
      className={`meta-doc-card${expanded ? ' meta-doc-card--expanded' : ''} ${focused ? 'meta-doc-card--focused' : selected ? 'meta-doc-card--selected' : ''}`}
      style={{ backgroundColor: cardSurfaceColor(preset) } as React.CSSProperties}
    >
      {expanded ? (
        <div className="meta-doc-card__editor" ref={bodyRef} />
      ) : (
        <div className="meta-doc-card__summary" ref={collapsedRef} title={docPath}>
          <div className="meta-doc-card__name">
            {docKind === 'skill' ? null : <span className="meta-doc-card__badge">doc</span>}
            {summary.name}
          </div>
          {summary.description && (
            <div className="meta-doc-card__description">{summary.description}</div>
          )}
        </div>
      )}
    </CardShell>
  )
}
