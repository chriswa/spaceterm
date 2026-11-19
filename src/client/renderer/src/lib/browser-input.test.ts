import { describe, expect, it } from 'vitest'
import { keyInput, pagePoint } from './browser-input'

const keys = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false }

describe('pagePoint', () => {
  it('maps through a frame drawn to fit its box and centred', () => {
    // A 390×780 phone page in a 1280×800 card: drawn 400 tall, 200 wide, centred.
    const box = { left: 100, top: 50, width: 1280, height: 800 }
    const frame = { width: 390, height: 780 }
    const fit = 800 / 780
    const left = 100 + (1280 - 390 * fit) / 2
    const corner = pagePoint(left + 0.01, 50.01, box, frame)!
    expect(corner.x).toBeCloseTo(0, 1)
    expect(corner.y).toBeCloseTo(0, 1)
    const middle = pagePoint(100 + 640, 50 + 400, box, frame)!
    expect(middle.x).toBeCloseTo(195, 5)
    expect(middle.y).toBeCloseTo(390, 5)
  })

  it('is null outside the frame, in the bars either side of it', () => {
    expect(pagePoint(110, 400, { left: 100, top: 0, width: 1280, height: 800 }, { width: 390, height: 780 })).toBeNull()
  })
})

describe('keyInput', () => {
  it('types a printable key, and Enter as a carriage return', () => {
    expect(keyInput({ ...keys, key: 'a', code: 'KeyA', keyCode: 65 }, 'keyDown')).toMatchObject({ text: 'a' })
    expect(keyInput({ ...keys, key: 'Enter', code: 'Enter', keyCode: 13 }, 'keyDown')).toMatchObject({ text: '\r' })
  })

  it('types nothing for a shortcut, a non-printing key, or a key coming up', () => {
    expect(keyInput({ ...keys, metaKey: true, key: 'c', code: 'KeyC', keyCode: 67 }, 'keyDown')).not.toHaveProperty('text')
    expect(keyInput({ ...keys, key: 'Backspace', code: 'Backspace', keyCode: 8 }, 'keyDown')).not.toHaveProperty('text')
    expect(keyInput({ ...keys, key: 'a', code: 'KeyA', keyCode: 65 }, 'keyUp')).not.toHaveProperty('text')
  })
})
