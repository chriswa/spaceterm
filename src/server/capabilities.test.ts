import { describe, it, expect } from 'vitest'
import {
  probeCapabilities,
  formatCapabilityReport,
  type Capability,
  type CapabilityDeps
} from './capabilities'

/** Everything present unless a test says otherwise. */
function deps(overrides: Partial<CapabilityDeps> = {}): CapabilityDeps {
  return {
    canRun: () => true,
    isExecutable: () => true,
    exists: () => true,
    username: () => 'someone',
    ...overrides
  }
}

function byId(capabilities: Capability[], id: string): Capability {
  const found = capabilities.find((c) => c.id === id)
  if (!found) throw new Error(`no capability ${id}`)
  return found
}

describe('probeCapabilities', () => {
  it('reports every optional integration', () => {
    const ids = probeCapabilities(deps()).map((c) => c.id)
    expect(ids).toEqual(['claude-oauth', 'voice-operator', 'pgrep', 'lsof', 'pty-daemon'])
  })

  it('marks everything available on a fully equipped machine', () => {
    const capabilities = probeCapabilities(deps())
    expect(capabilities.every((c) => c.available)).toBe(true)
    // An available capability has nothing to warn about.
    expect(capabilities.every((c) => c.affects === '')).toBe(true)
  })

  it('gives every capability a name and a detail, either way', () => {
    for (const missing of [true, false]) {
      const capabilities = probeCapabilities(
        deps({ canRun: () => !missing, isExecutable: () => !missing, exists: () => !missing })
      )
      for (const c of capabilities) {
        expect(c.name).toBeTruthy()
        expect(c.detail).toBeTruthy()
      }
    }
  })

  it('says what each missing integration costs', () => {
    const capabilities = probeCapabilities(deps({ canRun: () => false, isExecutable: () => false, exists: () => false }))
    for (const c of capabilities) {
      expect(c.available).toBe(false)
      expect(c.affects, `${c.id} should say what breaks`).toBeTruthy()
    }
  })

  describe('the Claude Code credential', () => {
    it('looks it up for the current user', () => {
      const calls: string[][] = []
      probeCapabilities(deps({ canRun: (_c, a) => { calls.push(a); return true }, username: () => 'alice' }))
      expect(calls.some((a) => a.includes('alice'))).toBe(true)
    })

    it('names Summary Chat as what degrades, and says it is macOS-only', () => {
      const c = byId(
        probeCapabilities(deps({ canRun: (cmd) => cmd !== '/usr/bin/security' })),
        'claude-oauth'
      )
      expect(c.available).toBe(false)
      expect(c.affects).toMatch(/Summary Chat/)
      expect(c.detail).toMatch(/macOS/)
    })
  })

  describe('Voice Operator', () => {
    it('is detected by its discovery file', () => {
      const c = byId(probeCapabilities(deps({ exists: () => false })), 'voice-operator')
      expect(c.available).toBe(false)
      expect(c.affects).toMatch(/spoken/)
    })

    it('distinguishes "no speech" from "no summary" — they are separate failures', () => {
      // Voice Operator down still leaves a working text summary; the credential
      // missing does not. Someone reading the log needs to tell them apart.
      const noVoice = probeCapabilities(deps({ exists: () => false }))
      expect(byId(noVoice, 'claude-oauth').available).toBe(true)
      expect(byId(noVoice, 'voice-operator').available).toBe(false)
    })
  })

  it('probes pgrep by presence, not by running it', () => {
    // pgrep exits 1 when its pattern matches nothing, so an exit-code probe
    // reports a working pgrep as missing — which is what the first version of
    // this file did, and it was wrong on the very first machine it ran on.
    const c = byId(probeCapabilities(deps({ canRun: () => false })), 'pgrep')
    expect(c.available).toBe(true)
  })

  it('probes lsof the same way', () => {
    const c = byId(probeCapabilities(deps({ canRun: () => false })), 'lsof')
    expect(c.available).toBe(true)
  })

  it('treats a cold-boot daemon socket as expected rather than alarming', () => {
    const c = byId(probeCapabilities(deps({ exists: () => false })), 'pty-daemon')
    expect(c.detail).toMatch(/normal on a cold boot/)
  })
})

describe('formatCapabilityReport', () => {
  it('marks each line available or not', () => {
    const lines = formatCapabilityReport(probeCapabilities(deps()))
    expect(lines.filter((l) => l.includes('✓')).length).toBeGreaterThan(0)
    expect(lines.some((l) => l.includes('✗'))).toBe(false)
  })

  it('says so plainly when everything is present', () => {
    const lines = formatCapabilityReport(probeCapabilities(deps()))
    expect(lines[lines.length - 1]).toMatch(/all optional integrations available/)
  })

  it('summarises what is missing by id, for grepping', () => {
    const lines = formatCapabilityReport(
      probeCapabilities(deps({ canRun: () => false, isExecutable: () => false, exists: () => false }))
    )
    const summary = lines[lines.length - 1]
    expect(summary).toMatch(/5 of 5 unavailable/)
    expect(summary).toContain('claude-oauth')
    expect(summary).toContain('voice-operator')
  })

  it('includes the consequence on a failing line, not just the failure', () => {
    const lines = formatCapabilityReport([
      { id: 'x', name: 'Thing', available: false, detail: 'not found', affects: 'widgets stop working' }
    ])
    expect(lines[0]).toContain('not found')
    expect(lines[0]).toContain('widgets stop working')
  })

  it('produces one line per capability plus a summary', () => {
    const capabilities = probeCapabilities(deps())
    expect(formatCapabilityReport(capabilities)).toHaveLength(capabilities.length + 1)
  })
})
