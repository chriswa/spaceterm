import { useLayoutEffect, useRef, type CSSProperties } from 'react'
import { deadlineExtended, labelClickAction, type NameTagPlacement, type NodeLabel } from '../../../../shared/node-label'
import { DEFAULT_PRESET, type ColorPreset } from '../lib/color-presets'
import { staleFilter } from '../lib/dim-stale'
import type { NodeId } from '../../../../shared/ids'

interface NodeLabelsProps {
  labels: readonly NodeLabel[]
  /** The receptionist's names for agent surfaces, each worn above its node's label. */
  nameTags?: readonly NameTagPlacement[]
  /** Inherited colour presets, keyed by node id — a label wears its node's colour. */
  resolvedPresets: Record<string, ColorPreset>
  /** "Dim stale nodes" freshness, so a label drains with the node that supplies it. */
  nodeFreshness: Map<NodeId, number>
  onLabelClick: (nodeId: NodeId) => void
  /** Mute or unmute a surface's cache countdown — see `labelClickAction`. */
  onCacheTimerMute: (nodeId: NodeId, muted: boolean) => void
}

/**
 * Captions drawn directly above each labelled node's card.
 *
 * Rendered as direct children of the canvas surface rather than inside a
 * wrapper, so each label competes with the cards on one z-index scale: every
 * card's z-index comes from the server's counter and starts at 1, so a label at
 * 0 sits under any card it happens to overlap and never steals its clicks.
 *
 * They carry `canvas-node` for the same reason cards do — it is how the
 * viewport tells its own background from anything drawn on top of it, and a
 * label must not start a pan, arm the edge-split indicator, or count as empty
 * space for a double-click. It deliberately carries no `data-node-id`: that
 * attribute means "this element *is* that node", which the cmd-click and flash
 * paths both rely on, and a label is a caption for one rather than the node.
 *
 * Clicking a name navigates, and clicking a live countdown mutes it (see
 * `labelClickAction`), but nothing about either says so — no cursor change, no
 * hover state. A caption that lit up under the pointer read as a control the
 * canvas was offering rather than as a name written on the canvas.
 */
export function NodeLabels({ labels, nameTags = [], resolvedPresets, nodeFreshness, onLabelClick, onCacheTimerMute }: NodeLabelsProps) {
  return (
    <>
      {labels.map((label) => (
        <NodeLabelView
          // A node supplies at most one label of each kind, so the pair is
          // the identity — `nodeId` alone would collide the moment a card
          // carried both its name and its elapsed caption.
          key={`${label.kind}:${label.nodeId}`}
          label={label}
          fg={label.fg ?? (resolvedPresets[label.nodeId] ?? DEFAULT_PRESET).titleBarBg}
          freshness={nodeFreshness.get(label.nodeId) ?? 1}
          onLabelClick={onLabelClick}
          onCacheTimerMute={onCacheTimerMute}
        />
      ))}
      {nameTags.map((tag) => {
        const preset = resolvedPresets[tag.nodeId] ?? DEFAULT_PRESET
        return (
          // A pill of the node's label colour with black text: the inverse of
          // the label beneath it, so it reads as a tag worn by the node rather
          // than a second line of its name.
          <div
            key={`name-tag:${tag.nodeId}`}
            className="agent-name-tag canvas-node"
            style={{
              left: tag.x - tag.width / 2,
              top: tag.y - tag.height / 2,
              width: tag.width,
              height: tag.height,
              backgroundColor: preset.titleBarBg,
              '--node-label-text-scale': tag.textScale,
              filter: staleFilter(nodeFreshness.get(tag.nodeId) ?? 1),
            } as CSSProperties}
            onClick={() => onLabelClick(tag.nodeId)}
          >
            {tag.name}
          </div>
        )
      })}
    </>
  )
}

/** How long a refreshed countdown takes to settle from white back to its colour. */
const DEADLINE_FLASH_MS = 1000

interface NodeLabelViewProps {
  label: NodeLabel
  fg: string
  freshness: number
  onLabelClick: (nodeId: NodeId) => void
  onCacheTimerMute: (nodeId: NodeId, muted: boolean) => void
}

function NodeLabelView({ label, fg, freshness, onLabelClick, onCacheTimerMute }: NodeLabelViewProps) {
  const textRef = useRef<HTMLSpanElement>(null)
  const prevDeadlineRef = useRef<number | undefined>(undefined)
  const mountedRef = useRef(false)

  // Flash white and fade back when the cache deadline moves later. Layout
  // effect, so the white frame is the first one painted with the new number.
  useLayoutEffect(() => {
    const isFirst = !mountedRef.current
    mountedRef.current = true
    const prev = prevDeadlineRef.current
    prevDeadlineRef.current = label.deadline
    const el = textRef.current
    if (!el || !deadlineExtended(prev, label.deadline, isFirst)) return
    // Web Animations is absent under jsdom.
    el.animate?.(
      { color: ['#ffffff', getComputedStyle(el).color] },
      { duration: DEADLINE_FLASH_MS, easing: 'ease-out' }
    )
  }, [label.deadline])

  return (
    <div
      className="node-label canvas-node"
      style={{
        left: label.x - label.width / 2,
        top: label.y - label.height / 2,
        width: label.width,
        height: label.height,
        '--node-label-fg': fg,
        '--node-label-text-scale': label.textScale,
        filter: staleFilter(freshness)
      } as CSSProperties}
      onClick={() => {
        const action = labelClickAction(label)
        if (action === 'navigate') onLabelClick(label.nodeId)
        else if (action === 'toggle-cache-mute') onCacheTimerMute(label.nodeId, !label.muted)
      }}
    >
      <span ref={textRef} className="node-label__text">{label.lines.join('\n')}</span>
    </div>
  )
}
