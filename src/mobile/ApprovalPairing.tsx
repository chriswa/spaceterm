import { useEffect, useState } from 'react'
import type { ApprovalSource } from '../shared/approvals'
import { nativeApprovalsAvailable, nativeIdentity, type NativeIdentity } from './native-approvals'

/**
 * This phone's approval key, once the app has said what it is; null in Safari
 * or until it answers. Whether a source trusts it is the source's `pairedKeys`.
 */
export function usePhoneIdentity(): NativeIdentity | null {
  const [identity, setIdentity] = useState<NativeIdentity | null>(null)
  useEffect(() => {
    if (!nativeApprovalsAvailable()) return
    let live = true
    nativeIdentity().then(
      (id) => { if (live) setIdentity(id) },
      (err) => window.api.log(`[approvals] the app has no approval key: ${String(err)}`)
    )
    return () => { live = false }
  }, [])
  return identity
}

type PairingState = { kind: 'idle' } | { kind: 'waiting' } | { kind: 'failed'; error: string }

/**
 * Pairing this phone with a source: it asks, someone at the Mac compares the
 * fingerprint shown there with this one and confirms with Touch ID. Once the
 * source's `hello` lists the key, this says so and offers nothing more.
 */
export function ApprovalPairing({ source, identity }: { source: ApprovalSource; identity: NativeIdentity | null }) {
  const [state, setState] = useState<PairingState>({ kind: 'idle' })
  if (!nativeApprovalsAvailable()) {
    return <p className="m-pairing__note">Answering needs the Spaceterm iPhone app.</p>
  }
  if (!identity) return null
  if (source.pairedKeys.includes(identity.keyId)) {
    return <p className="m-pairing__note">This phone is paired with {source.name} · <span className="m-pairing__fp">{identity.fingerprint}</span></p>
  }
  if (!source.connected) {
    return <p className="m-pairing__note">Can&rsquo;t reach {source.name}&rsquo;s approval feed on the Mac. Is it running, and new enough to have one?</p>
  }
  const pair = () => {
    setState({ kind: 'waiting' })
    window.api.log(`[approvals] asking ${source.name} to pair key ${identity.keyId}`)
    window.api.node.pairApprovalSource(source.name, identity.publicKey, identity.name).then(
      (outcome) => setState(outcome.ok ? { kind: 'idle' } : { kind: 'failed', error: outcome.error ?? 'Pairing failed.' }),
      (err) => setState({ kind: 'failed', error: String(err) })
    )
  }
  return (
    <div className="m-pairing">
      <p className="m-pairing__note">
        To answer {source.name}&rsquo;s requests here, pair this phone. You confirm it at the Mac, once.
      </p>
      {state.kind === 'waiting' ? (
        <p className="m-pairing__waiting">
          Confirm on the Mac. It should show <span className="m-pairing__fp">{identity.fingerprint}</span>
        </p>
      ) : (
        <button className="m-approval__button" onClick={pair}>Pair with {source.name}</button>
      )}
      {state.kind === 'failed' && <p className="m-approval__error">{state.error}</p>}
    </div>
  )
}
