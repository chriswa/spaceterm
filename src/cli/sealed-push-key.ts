/**
 * The APNs key, sealed with a password, so it can sit in this public repo and
 * reach every Mac with a `git pull` (src/cli/push-key.ts). Only the password
 * has to travel, and it travels in your head.
 *
 * scrypt stretches the password and AES-256-GCM seals the key with it, so a
 * wrong password or an altered file is refused rather than decrypted into
 * garbage. Everything a Mac needs to send pushes is inside, the key's id and
 * the team and bundle id included, and nothing about it is readable outside.
 * Anyone may try passwords against it offline, for ever, so the password must
 * be a long one; if it is ever guessed or told, revoke the key at Apple.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto'

export interface PushKey {
  /** The `<id>` in `AuthKey_<id>.p8`. */
  keyId: string
  /** The `.p8` file's contents. */
  key: string
  teamId: string
  bundleId: string
}

export interface ScryptParams {
  N: number
  r: number
  p: number
}

export interface SealedPushKey {
  format: 'spaceterm-sealed-push-key-1'
  scrypt: ScryptParams
  salt: string
  iv: string
  tag: string
  ciphertext: string
}

/** 128 MB and about half a second a guess, on a Mac. */
export const STRONG_SCRYPT: ScryptParams = { N: 2 ** 17, r: 8, p: 1 }
export const MIN_PASSWORD_CHARS = 12

function stretch(password: string, salt: Buffer, { N, r, p }: ScryptParams): Buffer {
  return scryptSync(password.normalize('NFC'), salt, 32, { N, r, p, maxmem: 256 * N * r + 1024 * 1024 })
}

export function sealPushKey(key: PushKey, password: string, scrypt = STRONG_SCRYPT): SealedPushKey {
  if (password.length < MIN_PASSWORD_CHARS) throw new Error(`The password must be at least ${MIN_PASSWORD_CHARS} characters: anyone can try guesses against the sealed file.`)
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', stretch(password, salt, scrypt), iv)
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(key), 'utf8'), cipher.final()])
  return {
    format: 'spaceterm-sealed-push-key-1',
    scrypt,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  }
}

/** The key, or null when the password is wrong or the file was altered: GCM cannot tell which. */
export function unsealPushKey(sealed: SealedPushKey, password: string): PushKey | null {
  if (sealed.format !== 'spaceterm-sealed-push-key-1') throw new Error(`Not a sealed push key this version understands: ${String(sealed.format)}`)
  const decipher = createDecipheriv('aes-256-gcm', stretch(password, Buffer.from(sealed.salt, 'base64'), sealed.scrypt), Buffer.from(sealed.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'))
  try {
    const plain = Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, 'base64')), decipher.final()])
    return JSON.parse(plain.toString('utf8')) as PushKey
  } catch {
    return null
  }
}
