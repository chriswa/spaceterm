import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { useMicActivity } from './dictation'
import { MicLabel } from './MicIndicator'

afterEach(() => {
  cleanup()
  useMicActivity.setState({ capturing: 0, transcribing: 0 })
})

describe('the MIC label above the Dynamic Island', () => {
  it('shows only while speech is going to the transcriber or its words are awaited', () => {
    const { container } = render(<MicLabel alwaysOn={false} />)
    const label = () => container.querySelector('.m-mic-label')
    expect(label()).toBeNull()

    act(() => useMicActivity.setState({ capturing: 1 }))
    expect(label()?.className).toBe('m-mic-label')

    act(() => useMicActivity.setState({ capturing: 0, transcribing: 1 }))
    expect(label()?.className).toContain('m-mic-label--waiting')

    act(() => useMicActivity.setState({ transcribing: 0 }))
    expect(label()).toBeNull()
  })

  it('reminds of "let me turn this off" while always-on mode holds the microphone, and gives way to MIC', () => {
    const { container, rerender } = render(<MicLabel alwaysOn={true} />)
    const label = () => container.querySelector('.m-mic-label')
    expect(label()?.className).toContain('m-mic-label--reminder')
    expect(label()?.textContent).toBe('“let me turn this off”')

    act(() => useMicActivity.setState({ capturing: 1 }))
    expect(label()?.textContent).toBe('MIC')
    expect(container.querySelectorAll('.m-mic-label')).toHaveLength(1)

    act(() => useMicActivity.setState({ capturing: 0, transcribing: 1 }))
    expect(label()?.textContent).toBe('MIC')

    act(() => useMicActivity.setState({ transcribing: 0 }))
    expect(label()?.textContent).toBe('“let me turn this off”')

    rerender(<MicLabel alwaysOn={false} />)
    expect(label()).toBeNull()
  })
})
