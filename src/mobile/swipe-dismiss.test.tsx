import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { SWIPE_SCREENS, useSwipeToDismiss, type SwipeScreen } from './swipe-dismiss'

afterEach(cleanup)

/** One finger from `from` along `path`, then up, `ms` apart. */
function drag(target: Element, from: [number, number], path: Array<[number, number]>, ms = 40): void {
  let t = 1000
  const touch = ([x, y]: [number, number]) => ({ clientX: x, clientY: y, target } as unknown as Touch)
  const fire = (type: string, touches: Touch[]) => {
    const event = new TouchEvent(type, { touches, bubbles: true, cancelable: true })
    Object.defineProperty(event, 'timeStamp', { value: t })
    target.dispatchEvent(event)
  }
  act(() => {
    fire('touchstart', [touch(from)])
    for (const point of path) { t += ms; fire('touchmove', [touch(point)]) }
    t += ms
    fire('touchend', [])
  })
}

function Screens({ screens }: { screens: SwipeScreen[] }) {
  useSwipeToDismiss(screens)
  return (
    <>
      <div className="control-transcript--screen"><p>text</p><textarea /></div>
      <div className="toolbar-sheet__panel">
        <div className="toolbar__strip"><button>button</button></div>
        <div className="row">agent</div>
      </div>
    </>
  )
}

describe('swiping a screen away', () => {
  const setup = () => {
    const transcript = vi.fn()
    const sheet = vi.fn()
    const screens = [{ ...SWIPE_SCREENS.transcript, dismiss: transcript }, { ...SWIPE_SCREENS.sheet, dismiss: sheet }]
    const { container } = render(<Screens screens={screens} />)
    return { container, transcript, sheet }
  }

  it('dismisses the transcript on a sideways drag, but not on a scroll', () => {
    const { container, transcript } = setup()
    const text = container.querySelector('p')!
    drag(text, [100, 300], [[100, 340], [104, 400]])
    expect(transcript).not.toHaveBeenCalled()
    drag(text, [100, 300], [[130, 302], [180, 305]])
    expect(transcript).toHaveBeenCalledTimes(1)
  })

  it('leaves a drag in the text box to the text box', () => {
    const { container, transcript } = setup()
    drag(container.querySelector('textarea')!, [100, 300], [[130, 302], [180, 305]])
    expect(transcript).not.toHaveBeenCalled()
  })

  it('dismisses the agent list, except from the strip of buttons, which scrolls sideways', () => {
    const { container, sheet } = setup()
    drag(container.querySelector('.toolbar__strip button')!, [200, 40], [[160, 41], [100, 42]])
    expect(sheet).not.toHaveBeenCalled()
    drag(container.querySelector('.row')!, [200, 300], [[160, 301], [100, 302]])
    expect(sheet).toHaveBeenCalledTimes(1)
  })

  it('counts a quick flick that falls short of the distance', () => {
    const { container, transcript } = setup()
    drag(container.querySelector('p')!, [100, 300], [[120, 300], [135, 301]], 10)
    expect(transcript).toHaveBeenCalledTimes(1)
  })
})
