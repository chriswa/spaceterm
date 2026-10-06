import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { useMicActivity } from './dictation'
import { MicIndicator } from './MicIndicator'

afterEach(() => {
  cleanup()
  useMicActivity.setState({ capturing: 0, transcribing: 0 })
})

describe('the MIC label above the Dynamic Island', () => {
  it('shows only while speech is going to the transcriber or its words are awaited', () => {
    const { container } = render(<MicIndicator />)
    const label = () => container.querySelector('.m-mic-label')
    expect(label()).toBeNull()

    act(() => useMicActivity.setState({ capturing: 1 }))
    expect(label()?.className).toBe('m-mic-label')

    act(() => useMicActivity.setState({ capturing: 0, transcribing: 1 }))
    expect(label()?.className).toContain('m-mic-label--waiting')

    act(() => useMicActivity.setState({ transcribing: 0 }))
    expect(label()).toBeNull()
  })
})
