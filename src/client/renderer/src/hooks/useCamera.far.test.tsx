import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { useCamera } from './useCamera'
import { FAR_ZOOM } from '../lib/constants'

function Surface() {
  const { surfaceRef } = useCamera()
  return <div data-testid="surface" ref={surfaceRef} />
}

afterEach(() => {
  cleanup()
  localStorage.clear()
})

describe('the far-zoom mark on the canvas surface', () => {
  it('is set below FAR_ZOOM, where the phone draws cards as plain boxes, and not above it', () => {
    localStorage.setItem('spaceterm-camera', JSON.stringify({ x: 0, y: 0, z: FAR_ZOOM / 2 }))
    const far = render(<Surface />)
    expect(far.getByTestId('surface').hasAttribute('data-far')).toBe(true)
    cleanup()
    localStorage.setItem('spaceterm-camera', JSON.stringify({ x: 0, y: 0, z: FAR_ZOOM * 2 }))
    const near = render(<Surface />)
    expect(near.getByTestId('surface').hasAttribute('data-far')).toBe(false)
  })
})
