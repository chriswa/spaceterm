import { usePeerStore } from '../stores/peerStore'

/**
 * Renders other clients' camera viewports as white rectangles on the canvas.
 * Lives inside canvas-surface (world space), so coordinates are in canvas pixels.
 * Border width is zoom-compensated via the --camera-zoom CSS custom property
 * that the camera system sets on the canvas-surface element.
 */
export function PeerCameraOverlay() {
  const peers = usePeerStore((s) => s.peers)

  const entries = Object.entries(peers)
  if (entries.length === 0) return null

  return (
    <>
      {entries.map(([clientId, peer]) => {
        if (!peer.bounds) return null
        const { x, y, width, height } = peer.bounds
        return (
          <div
            key={clientId}
            className="peer-camera-rect"
            style={{
              position: 'absolute',
              left: x,
              top: y,
              width,
              height,
            }}
          />
        )
      })}
    </>
  )
}
