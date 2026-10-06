import { useEffect, useMemo, useRef, useState } from 'react'
import {
  approvalKey, defaultPicks, parseApprovalDocument,
  type ApprovalDocument, type ApprovalItem, type ApprovalSection, type ApprovalSource, type SignedApprovalReply
} from '../shared/approvals'
import { useSurfacePresenterStore } from '@/stores/surfacePresenterStore'
import { useNodeStore } from '@/stores/nodeStore'
import { toneOf, useApprovalsStore } from './approvals-store'
import { ApprovalPairing, usePhoneIdentity } from './ApprovalPairing'
import { armApproval, disarmApproval, nativeApprovalsAvailable, signApproval } from './native-approvals'
import { timeLeft, useNow } from './NotificationsSheet'
import type { NodeId } from '../shared/ids'

/**
 * One approval request, the whole screen: what the provider's document says,
 * its options, and its answers. Nothing here knows what is being approved;
 * it draws the document's blocks (APPROVAL_FEED.md).
 *
 * Deny and the like are buttons. An approval is the iPhone app's own slide
 * panel, docked at the foot of this screen while it is open
 * (`native-approvals.ts`): this page arms it with the chosen options, and it
 * hands back the signed reply once slid across. Changing an option re-arms it.
 *
 * Answered here, the screen goes as soon as the provider accepts it — back
 * to the list if anything else is waiting. When the request goes some other
 * way — answered on the Mac, or timed out — the screen says why and offers
 * only Close.
 */

type Sending = { kind: 'idle' } | { kind: 'sending' } | { kind: 'failed'; error: string }

function Section({ section }: { section: ApprovalSection }) {
  if (section.kind === 'fields' && 'rows' in section) {
    return (
      <div className="m-approval__section">
        {section.label && <div className="m-approval__label">{section.label}</div>}
        <dl className="m-approval__fields">
          {section.rows.map((row, i) => (
            <div key={i} className="m-approval__field">
              <dt>{row.label}</dt>
              <dd className={row.mono ? 'm-approval__mono' : undefined}>{row.value}</dd>
            </div>
          ))}
        </dl>
      </div>
    )
  }
  const text = 'text' in section && typeof section.text === 'string' ? section.text : null
  if (text === null && !section.label) return null
  const mono = 'mono' in section && section.mono === true
  return (
    <div className="m-approval__section">
      {section.label && <div className="m-approval__label">{section.label}</div>}
      {text !== null && <pre className={`m-approval__text${mono ? ' m-approval__mono' : ''}`}>{text}</pre>}
    </div>
  )
}

function Pickers({ doc, picks, onPick }: { doc: ApprovalDocument; picks: Record<string, string>; onPick(picker: string, option: string): void }) {
  return (
    <>
      {(doc.pickers ?? []).map((picker) => {
        const chosen = picker.options.find((o) => o.id === picks[picker.id])
        return (
          <div key={picker.id} className="m-approval__picker">
            <div className="m-approval__label">{picker.label}</div>
            <div className="m-approval__options" role="radiogroup" aria-label={picker.label}>
              {picker.options.map((option) => (
                <button
                  key={option.id}
                  role="radio"
                  aria-checked={option.id === picks[picker.id]}
                  className={`m-approval__option${option.id === picks[picker.id] ? ' m-approval__option--on' : ''}`}
                  onClick={() => onPick(picker.id, option.id)}
                >
                  {option.label}
                </button>
              ))}
            </div>
            {chosen?.hint && <p className="m-approval__hint">{chosen.hint}</p>}
          </div>
        )
      })}
    </>
  )
}

/** Keeps the app's slide panel armed for this request and these picks, and sends what it signs. */
function useArmedApproval(
  item: ApprovalItem | null, action: string | null, picks: Record<string, string>, enabled: boolean,
  send: (reply: SignedApprovalReply) => void
): boolean {
  const sendRef = useRef(send)
  sendRef.current = send
  const armed = enabled && item !== null && action !== null && nativeApprovalsAvailable()
  const picksKey = JSON.stringify(picks)
  useEffect(() => {
    if (!armed || !item || !action) return
    let live = true
    armApproval(item, action, JSON.parse(picksKey) as Record<string, string>).then(
      (reply) => { if (live && reply) sendRef.current(reply) },
      (err) => window.api.log(`[approvals] the slide panel failed: ${String(err)}`)
    )
    // No disarm here: the next arm replaces this one in place. Leaving disarms.
    return () => { live = false }
    // Re-armed for a new revision (the reply must name the document shown) or new picks.
  }, [armed, item?.source, item?.id, item?.revision, action, picksKey])
  useEffect(() => { if (!armed) disarmApproval() }, [armed])
  useEffect(() => () => disarmApproval(), [])
  return armed
}

export function ApprovalView() {
  const openKey = useApprovalsStore((s) => s.openKey)
  const snapshot = useApprovalsStore((s) => s.snapshot)
  const identity = usePhoneIdentity()
  const now = useNow()
  const live = snapshot.items.find((i) => approvalKey(i) === openKey) ?? null
  // The last version seen, so the screen still shows what went after it goes.
  const [lastSeen, setLastSeen] = useState<ApprovalItem | null>(live)
  useEffect(() => { if (live) setLastSeen(live) }, [live])
  const item = live ?? lastSeen
  const closed = live ? null : snapshot.closed.find((c) => approvalKey(c) === openKey) ?? { note: undefined }
  const doc = useMemo(() => (item ? parseApprovalDocument(item.document) : null), [item?.document])
  const [picks, setPicks] = useState<Record<string, string>>(() => (doc ? defaultPicks(doc) : {}))
  const [sending, setSending] = useState<Sending>({ kind: 'idle' })
  const source: ApprovalSource | undefined = snapshot.sources.find((s) => s.name === item?.source)
  const paired = !!identity && !!source?.pairedKeys.includes(identity.keyId)
  const approve = doc?.actions.find((a) => a.role === 'approve') ?? null
  const others = doc?.actions.filter((a) => a.role !== 'approve') ?? []

  const send = (reply: SignedApprovalReply) => {
    if (!live) return
    setSending({ kind: 'sending' })
    window.api.log(`[approvals] answering ${live.source} ${live.id}`)
    window.api.node.answerApproval(live.source, live.id, reply).then(
      (outcome) => {
        // Answered from here: nothing left to read, so straight back.
        if (outcome.ok) useApprovalsStore.getState().answered(approvalKey(live))
        else setSending({ kind: 'failed', error: outcome.error ?? 'It was not accepted.' })
      },
      (err) => setSending({ kind: 'failed', error: String(err) })
    )
  }

  const armed = useArmedApproval(live, approve?.id ?? null, picks, paired && sending.kind !== 'sending', send)
  const close = () => useApprovalsStore.getState().closeItem()

  if (!item) return null
  const tone = toneOf(doc?.tone)
  const left = timeLeft(item.expiresAt, now)
  const surfaceId = doc?.surfaceId as NodeId | undefined
  const surfaceKnown = useNodeStore.getState().nodes[surfaceId ?? ''] !== undefined

  return (
    <div className={`m-approval m-approval--${tone}${armed ? ' m-approval--armed' : ''}`} role="dialog" aria-label={doc?.title ?? 'Approval request'}>
      <div className="m-approval__stripe" aria-hidden="true" />
      <div className="m-approval__top">
        <button className="m-approval__back" onClick={close}>‹ Back</button>
        <span className="m-approval__timer">
          {closed ? '' : left ? `Times out in ${left}` : 'Waiting its turn on the Mac'}
        </span>
      </div>
      <div className="m-approval__body">
        {!doc ? (
          <p className="m-approval__notice">This phone can&rsquo;t show this request. Answer it on the Mac.</p>
        ) : (
          <>
            {doc.kicker && <div className="m-approval__kicker">{doc.kicker}</div>}
            <h1 className="m-approval__title">{doc.title}</h1>
            {doc.subtitle && <div className="m-approval__subtitle">{doc.subtitle}</div>}
            {surfaceId && surfaceKnown && (
              <button
                className="m-approval__link"
                onClick={() => {
                  close()
                  useSurfacePresenterStore.getState().requestFocus(surfaceId)
                }}
              >
                Open the surface ›
              </button>
            )}
            {closed && <p className="m-approval__closed">{closed.note ?? 'No longer waiting.'}</p>}
            {doc.notice && !closed && <p className="m-approval__notice">{doc.notice}</p>}
            {(doc.sections ?? []).map((section, i) => <Section key={i} section={section} />)}
            {!closed && <Pickers doc={doc} picks={picks} onPick={(p, o) => setPicks((cur) => ({ ...cur, [p]: o }))} />}
          </>
        )}
      </div>
      <div className="m-approval__actions">
        {closed ? (
          <button className="m-approval__button" onClick={close}>Close</button>
        ) : source && !paired ? (
          <ApprovalPairing source={source} identity={identity} />
        ) : (
          <>
            {sending.kind === 'sending' && <p className="m-approval__hint">Sending…</p>}
            {sending.kind === 'failed' && <p className="m-approval__error">{sending.error}</p>}
            <div className="m-approval__buttons">
              {others.map((action) => (
                <button
                  key={action.id}
                  className={`m-approval__button${action.role === 'deny' ? ' m-approval__button--deny' : ''}`}
                  disabled={!live || !paired || sending.kind === 'sending'}
                  onClick={() => {
                    if (!live) return
                    signApproval(live, action.id, picks).then(send, (err) => setSending({ kind: 'failed', error: String(err) }))
                  }}
                >
                  {action.label}
                </button>
              ))}
            </div>
            {approve && !armed && !nativeApprovalsAvailable() && (
              <p className="m-approval__hint">To {approve.label.toLowerCase()}, use the Spaceterm iPhone app or the Mac.</p>
            )}
          </>
        )}
      </div>
    </div>
  )
}
