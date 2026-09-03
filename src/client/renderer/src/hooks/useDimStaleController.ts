import { useEffect, useState } from 'react'
import { useNodeStore } from '../stores/nodeStore'
import { useDimStaleStore } from '../stores/dimStaleStore'
import { computeNodeBrightness, nodeBrightnessEqual } from '../lib/dim-stale'

const RECOMPUTE_INTERVAL_MS = 30_000

/**
 * Keeps `useDimStaleStore.nodeBrightness` current while the dim view is on. Mount once
 * (in App). Recomputes when the node set changes and on a slow interval, so
 * nodes cross the staleness threshold as time passes even with no data change.
 * While the view is off it clears the set, so subscribers can dim purely by
 * membership.
 */
export function useDimStaleController(): void {
  const enabled = useDimStaleStore(s => s.enabled)
  const nodes = useNodeStore(s => s.nodes)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!enabled) return
    const id = setInterval(() => setTick(t => t + 1), RECOMPUTE_INTERVAL_MS)
    return () => clearInterval(id)
  }, [enabled])

  useEffect(() => {
    // Read the store imperatively so this effect doesn't resubscribe to the very
    // set it writes.
    const store = useDimStaleStore.getState()
    if (!enabled) {
      if (store.nodeBrightness.size > 0) store.setNodeBrightness(new Map())
      return
    }
    const next = computeNodeBrightness(nodes, Date.now())
    if (!nodeBrightnessEqual(next, store.nodeBrightness)) store.setNodeBrightness(next)
  }, [enabled, nodes, tick])
}
