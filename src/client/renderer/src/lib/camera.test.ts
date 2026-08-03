import { describe, it, expect } from 'vitest'
import { cameraToFitBounds, focusZoomCeiling } from './camera'
import { CARD_TYPES } from '../../../../shared/card-types'
import { MAX_ZOOM } from './constants'

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
