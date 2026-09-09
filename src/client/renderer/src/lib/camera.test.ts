import { describe, it, expect } from 'vitest'
import { cameraToFitBounds, focusZoomCeiling, wheelZoomFactor } from './camera'
import { CARD_TYPES } from '../../../../shared/card-types'
import { MAX_ZOOM, WHEEL_ZOOM_SENSITIVITY, WHEEL_ZOOM_MAX_RATE, WHEEL_ZOOM_RATE_WINDOW_MS } from './constants'

describe('focusZoomCeiling', () => {
  it('caps label-ish cards well short of filling the viewport', () => {
    // Focusing a title or a directory should leave its neighbourhood visible —
    // one word blown up to full screen is the thing this exists to prevent.
    expect(focusZoomCeiling('title')).toBeLessThanOrEqual(0.15)
    expect(focusZoomCeiling('directory')).toBeLessThanOrEqual(0.15)
  })

  it('leaves cards you read the inside of uncapped', () => {
    for (const type of ['terminal', 'markdown', 'file'] as const) {
      expect(focusZoomCeiling(type), type).toBe(MAX_ZOOM)
    }
  })

  it('falls back to the absolute maximum for the root node', () => {
    // The root has no card type, so there is nothing to look up.
    expect(focusZoomCeiling(null)).toBe(MAX_ZOOM)
    expect(focusZoomCeiling(undefined)).toBe(MAX_ZOOM)
  })

  it('returns a usable zoom for every card type', () => {
    // A new card type that forgot its ceiling would otherwise fly the camera to
    // NaN, which is silent — the transform simply stops updating.
    for (const type of CARD_TYPES) {
      const z = focusZoomCeiling(type)
      expect(Number.isFinite(z) && z > 0, type).toBe(true)
    }
  })
})

describe('cameraToFitBounds honours the focus ceiling', () => {
  const tinyCard = { x: 0, y: 0, width: 200, height: 40 }

  it('stops at the ceiling instead of zooming as close as it can', () => {
    const fitted = cameraToFitBounds(tinyCard, 1600, 1000, 0, focusZoomCeiling('title'))
    expect(fitted.z).toBeCloseTo(0.15)
  })

  it('still centres the card it declined to fill the screen with', () => {
    const vw = 1600, vh = 1000
    const cam = cameraToFitBounds(tinyCard, vw, vh, 0, focusZoomCeiling('title'))
    const centerX = (tinyCard.x + tinyCard.width / 2) * cam.z + cam.x
    const centerY = (tinyCard.y + tinyCard.height / 2) * cam.z + cam.y
    expect(centerX).toBeCloseTo(vw / 2)
    expect(centerY).toBeCloseTo(vh / 2)
  })

  it('does not zoom past the fit when the card is larger than the ceiling allows', () => {
    // A wide title still gets fitted, not scaled up to the cap.
    const wide = { x: 0, y: 0, width: 40000, height: 400 }
    const cam = cameraToFitBounds(wide, 1600, 1000, 0, focusZoomCeiling('title'))
    expect(cam.z).toBeLessThan(0.15)
    expect(cam.z).toBeCloseTo(1600 / 40000)
  })
})

describe('wheelZoomFactor', () => {
  const FULL_WINDOW_STEP = Math.exp(WHEEL_ZOOM_MAX_RATE * WHEEL_ZOOM_RATE_WINDOW_MS / 1000)

  it('leaves a trackpad pinch alone', () => {
    // Single-digit deltas at ~60Hz — the cap should be invisible here, or
    // pinch-to-zoom would feel throttled on hardware that was never the problem.
    for (const delta of [1, 3, 6]) {
      expect(wheelZoomFactor(delta, 16), String(delta))
        .toBeCloseTo(Math.exp(-delta * WHEEL_ZOOM_SENSITIVITY), 6)
    }
  })

  it('caps one oversized notch from a fast mouse', () => {
    // A mouse that reports 500 in a single event asks for e^8 ≈ 3000x.
    const zoomOut = wheelZoomFactor(500, 16)
    const zoomIn = wheelZoomFactor(-500, 16)
    expect(zoomIn).toBeLessThanOrEqual(FULL_WINDOW_STEP)
    expect(zoomOut).toBeGreaterThanOrEqual(1 / FULL_WINDOW_STEP)
  })

  it('stays positive and directional no matter how large the delta', () => {
    // The linear form this replaced changed sign past delta ≈ 62 and threw the
    // camera to MIN_ZOOM on one notch.
    expect(wheelZoomFactor(100000, 1000)).toBeGreaterThan(0)
    expect(wheelZoomFactor(100000, 1000)).toBeLessThan(1)
    expect(wheelZoomFactor(-100000, 1000)).toBeGreaterThan(1)
    expect(wheelZoomFactor(0, 1000)).toBe(1)
  })

  it('spends the same budget whether the events arrive in a flood or one at a time', () => {
    // 20 saturating events across 50ms must not out-zoom a single event that
    // waited the whole window.
    let flood = 1
    for (let i = 0; i < 20; i++) flood *= wheelZoomFactor(-500, WHEEL_ZOOM_RATE_WINDOW_MS / 20)
    expect(flood).toBeCloseTo(FULL_WINDOW_STEP, 6)
  })

  it('does not bank budget across a long pause', () => {
    // Idling for a second must not buy a 400x lurch on the next notch.
    expect(wheelZoomFactor(-500, 5000)).toBeCloseTo(FULL_WINDOW_STEP, 6)
    expect(wheelZoomFactor(-500, Infinity)).toBeCloseTo(FULL_WINDOW_STEP, 6)
  })

  it('is symmetric, so a capped scroll back up undoes a capped scroll down', () => {
    expect(wheelZoomFactor(500, 20) * wheelZoomFactor(-500, 20)).toBeCloseTo(1, 6)
  })
})
