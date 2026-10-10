import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, cleanup, screen, act, fireEvent, waitFor } from '@testing-library/react'
import { installFakeBridge, type FakeBridge } from '@/testing/fake-bridge'
import type { ApprovalDocument, ApprovalItem, ApprovalsSnapshot } from '../shared/approvals'
import { approvalKey } from '../shared/approvals'
import { EMPTY_APPROVALS, useApprovalsStore } from './approvals-store'
import { useSurfacePresenterStore } from '@/stores/surfacePresenterStore'
import { RocketButton } from './RocketButton'
import { NotificationsSection } from './NotificationsSection'
import { ApprovalView } from './ApprovalView'

const DOC: ApprovalDocument = {
  tone: 'caution',
  kicker: '1Password security approval',
  title: 'GitHub token',
  subtitle: 'Claude Code · “fix tests”',
  sections: [
    { kind: 'fields', label: 'Request', rows: [{ label: 'Vault', value: 'Private' }] },
    { kind: 'text', label: 'Command', text: 'op read op://Private/GitHub/token', mono: true },
    { kind: 'chart', label: 'From the future' }
  ],
  pickers: [{ id: 'duration', label: 'Allow', default: '7d', options: [
    { id: 'once', label: 'Once', hint: 'Just this request.' },
    { id: '7d', label: '7 Days', hint: 'This command for a week.' }
  ] }],
  actions: [{ id: 'deny', label: 'Deny', role: 'deny' }, { id: 'approve', label: 'Approve', role: 'approve' }],
  confirm: 'Let Claude Code read GitHub token'
}

const item = (over: Partial<ApprovalItem> = {}, doc: ApprovalDocument = DOC): ApprovalItem => ({
  source: 'opProxy', id: 'a1', revision: 1, createdAt: 1, expiresAt: null, challenge: 'ch', document: JSON.stringify(doc), ...over
})

const KEY = { keyId: 'k1', publicKey: 'cHVi', fingerprint: 'ab12 cd34 ef56 7890', name: 'iPhone' }
const SIGNED = { keyId: 'k1', statement: '{"v":1}', signature: 'c2ln' }

function snapshot(items: ApprovalItem[], pairedKeys = ['k1'], closed: ApprovalsSnapshot['closed'] = []): ApprovalsSnapshot {
  return { sources: [{ name: 'opProxy', connected: true, pairedKeys }], items, closed }
}

/** The iPhone app's `approvals` handler, as the page sees it. */
function installNative() {
  const arms: Array<{ msg: Record<string, unknown>; resolve(v: unknown): void }> = []
  const posted: Array<Record<string, unknown>> = []
  const postMessage = vi.fn((msg: Record<string, unknown>) => {
    posted.push(msg)
    switch (msg.op) {
      case 'identity': return Promise.resolve(KEY)
      case 'arm': return new Promise((resolve) => arms.push({ msg, resolve }))
      case 'sign': return Promise.resolve(SIGNED)
      default: return Promise.resolve(null)
    }
  })
  window.webkit = { messageHandlers: { approvals: { postMessage } } }
  return { arms, posted }
}

let bridge: FakeBridge

beforeEach(() => {
  bridge = installFakeBridge()
})

afterEach(() => {
  cleanup()
  delete window.webkit
  act(() => {
    useApprovalsStore.setState({ snapshot: EMPTY_APPROVALS, seen: new Set(), openKey: null })
    useSurfacePresenterStore.getState().setToolbarSheetOpen(false)
  })
})

describe('the rocket, carrying notifications', () => {
  const rocket = () => document.querySelector('.m-rocket')!

  it('carries no count with nothing pending, a count in the tone with something, and pulses until the sheet shows it', () => {
    render(<RocketButton />)
    expect(document.querySelector('.m-rocket__count')).toBeNull()
    expect(rocket().className).not.toContain('m-rocket--caution')

    act(() => useApprovalsStore.getState().setSnapshot(snapshot([item()])))
    expect(rocket().className).toContain('m-rocket--caution')
    expect(rocket().className).toContain('m-rocket--unread')
    expect(document.querySelector('.m-rocket__count')!.textContent).toBe('1')

    // The sheet opens with the notifications at its top, which reads them.
    fireEvent.click(rocket())
    render(<NotificationsSection />)
    expect(useSurfacePresenterStore.getState().toolbarSheetOpen).toBe(true)
    expect(rocket().className).not.toContain('m-rocket--unread')
    expect(rocket().className).toContain('m-rocket--caution')
  })

  it('takes the loudest tone among what is pending', () => {
    render(<RocketButton />)
    act(() => useApprovalsStore.getState().setSnapshot(snapshot([item(), item({ id: 'a2' }, { ...DOC, tone: 'danger' })])))
    expect(rocket().className).toContain('m-rocket--danger')
  })
})

describe('NotificationsSection', () => {
  it('shows nothing with nothing to show', () => {
    const { container } = render(<NotificationsSection />)
    expect(container.innerHTML).toBe('')
  })

  it('lists what is waiting and opens one with a tap, in place of the sheet', () => {
    act(() => {
      useApprovalsStore.getState().setSnapshot(snapshot([item()]))
      useSurfacePresenterStore.getState().setToolbarSheetOpen(true)
    })
    render(<NotificationsSection />)
    fireEvent.click(screen.getByText('GitHub token'))
    expect(useApprovalsStore.getState().openKey).toBe(approvalKey(item()))
    expect(useSurfacePresenterStore.getState().toolbarSheetOpen).toBe(false)
  })

  it('offers to pair a phone the source does not trust yet', async () => {
    const { posted } = installNative()
    act(() => useApprovalsStore.getState().setSnapshot(snapshot([], [])))
    render(<NotificationsSection />)
    fireEvent.click(await screen.findByText('Pair with opProxy'))
    expect(await screen.findByText('ab12 cd34 ef56 7890')).toBeTruthy()
    expect(bridge.calls.find((c) => c.method === 'node.pairApprovalSource')?.args).toEqual(['opProxy', 'cHVi', 'iPhone'])
    expect(posted[0]).toEqual({ op: 'identity' })
  })
})

describe('ApprovalView', () => {
  function open(i: ApprovalItem, paired = ['k1']) {
    act(() => {
      useApprovalsStore.getState().setSnapshot(snapshot([i], paired))
      useApprovalsStore.getState().openItem(approvalKey(i))
    })
    return render(<ApprovalView />)
  }

  it('draws the document, and an unknown section by its label', () => {
    installNative()
    open(item())
    expect(screen.getByText('GitHub token')).toBeTruthy()
    expect(screen.getByText('Private')).toBeTruthy()
    expect(screen.getByText('op read op://Private/GitHub/token')).toBeTruthy()
    expect(screen.getByText('From the future')).toBeTruthy()
    expect(screen.getByText('This command for a week.')).toBeTruthy()
  })

  it('arms the slide panel with the default picks, and re-arms when an option changes', async () => {
    const { arms } = installNative()
    open(item())
    await waitFor(() => expect(arms).toHaveLength(1))
    expect(arms[0].msg).toMatchObject({ op: 'arm', action: 'approve', picks: { duration: '7d' },
      item: { provider: 'opProxy', id: 'a1', revision: 1, challenge: 'ch', document: JSON.stringify(DOC) } })

    fireEvent.click(screen.getByRole('radio', { name: 'Once' }))
    await waitFor(() => expect(arms).toHaveLength(2))
    expect(arms[1].msg).toMatchObject({ picks: { duration: 'once' } })
  })

  it('sends what the panel signed once it is slid across', async () => {
    const { arms } = installNative()
    open(item())
    await waitFor(() => expect(arms).toHaveLength(1))
    await act(async () => arms[0].resolve(SIGNED))
    expect(bridge.calls.find((c) => c.method === 'node.answerApproval')?.args).toEqual(['opProxy', 'a1', SIGNED])
  })

  it('goes straight back once the answer is accepted', async () => {
    const { arms } = installNative()
    open(item())
    await waitFor(() => expect(arms).toHaveLength(1))
    await act(async () => arms[0].resolve(SIGNED))
    await waitFor(() => expect(useApprovalsStore.getState().openKey).toBeNull())
    expect(useSurfacePresenterStore.getState().toolbarSheetOpen).toBe(false)
  })

  it('goes back to the sheet when something else is waiting', async () => {
    const { posted } = installNative()
    const other = item({ id: 'a2' })
    act(() => {
      useApprovalsStore.getState().setSnapshot(snapshot([item(), other]))
      useApprovalsStore.getState().openItem(approvalKey(item()))
    })
    render(<ApprovalView />)
    await waitFor(() => expect((screen.getByText('Deny') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByText('Deny'))
    await waitFor(() => expect(useApprovalsStore.getState().openKey).toBeNull())
    expect(useSurfacePresenterStore.getState().toolbarSheetOpen).toBe(true)
    expect(posted.some((m) => m.op === 'sign')).toBe(true)
  })

  it('stays, with the reason, when the answer is refused', async () => {
    const { arms } = installNative()
    bridge.responses.approvalOutcome = { ok: false, error: 'That request timed out.' }
    open(item())
    await waitFor(() => expect(arms).toHaveLength(1))
    await act(async () => arms[0].resolve(SIGNED))
    expect(await screen.findByText('That request timed out.')).toBeTruthy()
    expect(useApprovalsStore.getState().openKey).toBe(approvalKey(item()))
  })

  it('denies at a tap, signed without the panel', async () => {
    const { posted } = installNative()
    open(item())
    await screen.findByText('Deny')
    await waitFor(() => expect((screen.getByText('Deny') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByText('Deny'))
    await waitFor(() => expect(bridge.calls.some((c) => c.method === 'node.answerApproval')).toBe(true))
    expect(posted.find((m) => m.op === 'sign')).toMatchObject({ action: 'deny', picks: { duration: '7d' } })
  })

  it('says why it went when answered elsewhere, and disarms', async () => {
    const { arms, posted } = installNative()
    open(item())
    await waitFor(() => expect(arms).toHaveLength(1))
    act(() => useApprovalsStore.getState().setSnapshot(snapshot([], ['k1'],
      [{ source: 'opProxy', id: 'a1', note: 'Approved on the Mac', at: 2 }])))
    expect(screen.getByText('Approved on the Mac')).toBeTruthy()
    expect(screen.queryByText('Deny')).toBeNull()
    await waitFor(() => expect(posted.some((m) => m.op === 'disarm')).toBe(true))
  })

  it('asks to pair instead of offering answers when the phone is not trusted', async () => {
    const { arms } = installNative()
    open(item(), [])
    expect(await screen.findByText('Pair with opProxy')).toBeTruthy()
    expect(screen.queryByText('Deny')).toBeNull()
    expect(arms).toHaveLength(0)
  })

  it('in Safari, shows the request but says where to answer it', () => {
    open(item())
    expect(screen.getByText('GitHub token')).toBeTruthy()
    expect(screen.getByText('Answering needs the Spaceterm iPhone app.')).toBeTruthy()
  })
})
