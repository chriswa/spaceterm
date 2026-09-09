import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { ArchiveConfirm } from './ArchiveConfirm'

afterEach(cleanup)

const props = { label: 'planning notes', count: 4, onConfirm: vi.fn(), onCancel: vi.fn() }

describe('ArchiveConfirm', () => {
  it('leads with how many cards go, which is the part that is easy to miss', () => {
    const { getByRole } = render(<ArchiveConfirm {...props} />)

    expect(getByRole('alertdialog').textContent).toContain('Archive 4 cards?')
    expect(getByRole('alertdialog').textContent).toContain('planning notes')
    expect(getByRole('alertdialog').textContent).toContain('3 cards beneath it')
  })

  it('counts a single child in the singular', () => {
    const { getByRole } = render(<ArchiveConfirm {...props} count={2} />)
    expect(getByRole('alertdialog').textContent).toContain('1 card beneath it')
  })

  it('archives only on the confirm button', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    const { getByRole } = render(<ArchiveConfirm {...props} onConfirm={onConfirm} onCancel={onCancel} />)

    fireEvent.click(getByRole('button', { name: /Cancel/ }))
    expect(onConfirm).not.toHaveBeenCalled()
    expect(onCancel).toHaveBeenCalledOnce()

    fireEvent.click(getByRole('button', { name: /Archive/ }))
    expect(onConfirm).toHaveBeenCalledOnce()
  })

  it('focuses confirm, so the dialog owns Enter rather than whatever was behind it', () => {
    const { getByRole } = render(<ArchiveConfirm {...props} />)
    expect(document.activeElement).toBe(getByRole('button', { name: /Archive/ }))
  })

  it('treats a click outside as cancelling, never as confirming', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    render(<ArchiveConfirm {...props} onConfirm={onConfirm} onCancel={onCancel} />)

    fireEvent.mouseDown(document.body)
    expect(onCancel).toHaveBeenCalledOnce()
    expect(onConfirm).not.toHaveBeenCalled()
  })
})
