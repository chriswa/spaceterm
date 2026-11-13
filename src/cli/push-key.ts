/**
 * Carry the APNs key to another Mac through the repo, sealed with a password
 * (src/cli/sealed-push-key.ts; src/mobile/README.md, "Told when an agent is blocked").
 *
 *   npm run mobile:push-key -- seal     # on the Mac that has the key: writes src/mobile/ios/push-key.sealed.json
 *   npm run mobile:push-key -- unseal   # on any other, after a pull: writes the key to ~/.spaceterm
 *
 * Both ask for the password without showing it. Unsealing also writes
 * src/mobile/ios/Local.xcconfig if this Mac has none, since the server reads
 * the team and bundle id from it. The server reads the key on each push, so
 * no restart is needed.
 */
import { createInterface } from 'readline'
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { xcconfigValue } from '../server/apns'
import { SOCKET_DIR } from '../shared/protocol'
import { sealPushKey, unsealPushKey, type SealedPushKey } from './sealed-push-key'

const REPO_ROOT = join(__dirname, '..', '..')
const SEALED = join(REPO_ROOT, 'src/mobile/ios/push-key.sealed.json')
const XCCONFIG = join(REPO_ROOT, 'src/mobile/ios/Local.xcconfig')

/** Lines typed without echo; read plainly when stdin is not a terminal. One interface for all, so piped lines are not lost between questions. */
function hiddenAsker(): { ask(prompt: string): Promise<string>; close(): void } {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY })
  const lines: string[] = []
  const waiting: Array<(line: string) => void> = []
  rl.on('line', (line) => { const next = waiting.shift(); if (next) next(line); else lines.push(line) })
  rl.on('close', () => { for (const next of waiting.splice(0)) next('') })
  // Echo only the prompt itself: what is typed after it is not shown.
  const muted = rl as unknown as { _writeToOutput(text: string): void }
  muted._writeToOutput = () => {}
  return {
    ask(prompt) {
      process.stdout.write(prompt)
      return new Promise((resolve) => {
        const answer = (line: string) => { process.stdout.write('\n'); resolve(line) }
        const ready = lines.shift()
        if (ready !== undefined) answer(ready); else waiting.push(answer)
      })
    },
    close: () => rl.close(),
  }
}

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

async function seal(): Promise<void> {
  const keyFile = readdirSync(SOCKET_DIR).filter((name) => /^AuthKey_\w+\.p8$/.test(name)).sort().at(-1)
  if (!keyFile) fail(`No AuthKey_<id>.p8 in ${SOCKET_DIR} to seal.`)
  const config = existsSync(XCCONFIG) ? readFileSync(XCCONFIG, 'utf8') : ''
  const teamId = xcconfigValue(config, 'DEVELOPMENT_TEAM')
  const bundleId = xcconfigValue(config, 'PRODUCT_BUNDLE_IDENTIFIER')
  if (!teamId || !bundleId) fail(`${XCCONFIG} has no DEVELOPMENT_TEAM or PRODUCT_BUNDLE_IDENTIFIER to seal with the key.`)
  console.log('The sealed file will be public: anyone can try passwords against it. Use a long passphrase, five or more random words.')
  const asker = hiddenAsker()
  const password = await asker.ask('Password: ')
  const again = await asker.ask('Again: ')
  asker.close()
  if (again !== password) fail('The two did not match; nothing written.')
  const key = { keyId: keyFile.slice('AuthKey_'.length, -'.p8'.length), key: readFileSync(join(SOCKET_DIR, keyFile), 'utf8'), teamId, bundleId }
  let sealed: SealedPushKey
  try {
    sealed = sealPushKey(key, password)
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err))
  }
  writeFileSync(SEALED, JSON.stringify(sealed, null, 2) + '\n')
  console.log(`Sealed ${keyFile} into ${SEALED}. Commit it, then on the other Mac pull and run: npm run mobile:push-key -- unseal`)
}

async function unseal(): Promise<void> {
  if (!existsSync(SEALED)) fail(`No ${SEALED}: seal it on the Mac that has the key, commit it, and pull here.`)
  const sealed = JSON.parse(readFileSync(SEALED, 'utf8')) as SealedPushKey
  const asker = hiddenAsker()
  const password = await asker.ask('Password: ')
  asker.close()
  const key = unsealPushKey(sealed, password)
  if (!key) fail('Wrong password (or the sealed file was altered). Nothing written.')
  const keyPath = join(SOCKET_DIR, `AuthKey_${key.keyId}.p8`)
  writeFileSync(keyPath, key.key, { mode: 0o600 })
  chmodSync(keyPath, 0o600)
  console.log(`Wrote ${keyPath}`)
  if (!existsSync(XCCONFIG)) {
    writeFileSync(XCCONFIG, `// Your Apple signing identity for the iPhone app. Not committed: each person\n// building Spaceterm's iPhone app signs it with their own team. See install.sh.\nDEVELOPMENT_TEAM = ${key.teamId}\nPRODUCT_BUNDLE_IDENTIFIER = ${key.bundleId}\n`)
    console.log(`Wrote ${XCCONFIG}`)
  } else {
    const config = readFileSync(XCCONFIG, 'utf8')
    if (xcconfigValue(config, 'DEVELOPMENT_TEAM') !== key.teamId || xcconfigValue(config, 'PRODUCT_BUNDLE_IDENTIFIER') !== key.bundleId) {
      console.log(`${XCCONFIG} names a different team or bundle id than the key was sealed with (${key.teamId}, ${key.bundleId}); left as it is. Apple will refuse pushes until they match.`)
    }
  }
  console.log('Done. The server reads the key on its next push; no restart needed. Open the phone app on this Mac\'s tailnet once, so this Mac learns where to send.')
}

const command = process.argv[2]
if (command === 'seal') void seal()
else if (command === 'unseal') void unseal()
else fail('Usage: npm run mobile:push-key -- seal | unseal')
