import { describe, expect, it } from 'vitest'
import { sealPushKey, unsealPushKey, type PushKey } from './sealed-push-key'

const FAST = { N: 2 ** 10, r: 8, p: 1 }
const KEY: PushKey = { keyId: 'ABC123', key: '-----BEGIN PRIVATE KEY-----\nxyz\n-----END PRIVATE KEY-----\n', teamId: 'TEAM1', bundleId: 'com.example.app' }
const PASSWORD = 'correct horse battery staple'

describe('sealed push key', () => {
  it('opens with the password it was sealed with', () => {
    expect(unsealPushKey(sealPushKey(KEY, PASSWORD, FAST), PASSWORD)).toEqual(KEY)
  })

  it('shows nothing of the key outside', () => {
    const text = JSON.stringify(sealPushKey(KEY, PASSWORD, FAST))
    for (const secret of ['ABC123', 'xyz', 'TEAM1', 'com.example']) expect(text).not.toContain(secret)
  })

  it('refuses a wrong password, and an altered file', () => {
    const sealed = sealPushKey(KEY, PASSWORD, FAST)
    expect(unsealPushKey(sealed, 'correct horse battery stapler')).toBeNull()
    const bytes = Buffer.from(sealed.ciphertext, 'base64')
    bytes[0] ^= 1
    expect(unsealPushKey({ ...sealed, ciphertext: bytes.toString('base64') }, PASSWORD)).toBeNull()
  })

  it('refuses to seal with a short password', () => {
    expect(() => sealPushKey(KEY, 'hunter2', FAST)).toThrow(/at least/)
  })
})
