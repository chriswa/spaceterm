import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { ControlTranscript } from './ControlTranscript'
import { installFakeBridge, type FakeBridge } from '../testing/fake-bridge'
import { useControlTranscriptStore } from '../stores/controlTranscriptStore'
import type { ControlTranscriptEntry } from '../../../../shared/protocol'
import { asNodeId } from '../../../../shared/ids'

let bridge: FakeBridge

const shown: ControlTranscriptEntry = {
  offset: 10, timestamp: '2026-10-15T08:00:00Z', kind: 'images', from: 'Kevin', nodeId: asNodeId('kevin'),
  images: [{ id: 'a.png', caption: 'Water at dusk' }, { id: 'b.png' }], summary: 'The new water',
}

beforeEach(() => {
  bridge = installFakeBridge(globalThis as never)
  useControlTranscriptStore.getState().setOpen(false)
  useControlTranscriptStore.getState().setOpen(true)
  // jsdom has no object URLs of its own.
  URL.createObjectURL = vi.fn((blob: Blob) => `blob:${blob.type}:${blob.size}`)
  URL.revokeObjectURL = vi.fn()
  bridge.responses.controlTranscript = () => ({ entries: [shown], more: false })
  bridge.responses.controlImage = (id, size) => (id === 'a.png' ? { mime: size === 'thumb' ? 'image/jpeg' : 'image/png', data: btoa(`${id}-${size}`) } : undefined)
})

afterEach(cleanup)

describe('pictures in the transcript', () => {
  it('shows the agent, its summary and each picture small, asking only for the small copies', async () => {
    render(<ControlTranscript variant="modal" onDismiss={() => {}} />)
    await screen.findByText('The new water')
    expect(screen.getByText('Kevin')).toBeTruthy()
    expect(screen.getByText(/2 pictures/)).toBeTruthy()
    expect(screen.getByText('Water at dusk')).toBeTruthy()
    await waitFor(() => expect(document.querySelector('.control-images__thumb img')?.getAttribute('src')).toBe('blob:image/jpeg:11'))
    // One the server no longer keeps says so rather than spinning.
    await screen.findByText('Not kept')
    expect(bridge.callsTo('receptionist.image').map((call) => call.args[1])).not.toContain('full')
  })

  it('opens a picture whole on a tap, and closes it on Escape without closing the transcript', async () => {
    const dismissed = vi.fn()
    render(<ControlTranscript variant="modal" onDismiss={dismissed} />)
    fireEvent.click(await screen.findByLabelText('Open Water at dusk'))
    await waitFor(() => expect(document.querySelector('.control-images__viewer img')?.getAttribute('src')).toBe('blob:image/png:10'))
    expect(screen.getByText('Water at dusk (1 of 2)')).toBeTruthy()
    fireEvent.keyDown(document.querySelector('.control-images__viewer')!, { key: 'Escape' })
    expect(document.querySelector('.control-images__viewer')).toBeNull()
    expect(dismissed).not.toHaveBeenCalled()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:image/png:10')
  })
})
