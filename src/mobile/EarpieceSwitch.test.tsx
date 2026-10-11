import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, fireEvent, screen } from '@testing-library/react'
import { EarpieceSwitch } from './EarpieceSwitch'
import { listensOnEarpiece, setListenOnEarpiece } from './audio-session'

const chosen = () => screen.getAllByRole('radio').filter((el) => el.getAttribute('aria-checked') === 'true').map((el) => el.textContent)

afterEach(() => {
  cleanup()
  setListenOnEarpiece(false)
})

describe('EarpieceSwitch', () => {
  it('chooses between the speaker and the earpiece', () => {
    setListenOnEarpiece(false)
    render(<EarpieceSwitch />)
    expect(screen.getByRole('radiogroup', { name: 'Play Control on' })).toBeTruthy()
    expect(chosen()).toEqual(['Speaker'])
    fireEvent.click(screen.getByRole('radio', { name: 'Earpiece' }))
    expect(listensOnEarpiece()).toBe(true)
    expect(chosen()).toEqual(['Earpiece'])
    fireEvent.click(screen.getByRole('radio', { name: 'Speaker' }))
    expect(listensOnEarpiece()).toBe(false)
    expect(chosen()).toEqual(['Speaker'])
  })
})
