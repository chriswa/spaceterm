#!/usr/bin/env node
/**
 * Give the development Electron its own identity, so `spaceterm-surface://`
 * links open *this* checkout rather than some other Electron on the machine.
 *
 * A packaged build has no such problem: electron-builder.yml declares
 * `appId: com.spaceterm.app` and the `spaceterm-surface` protocol, and macOS
 * resolves the scheme to that bundle. Development is the broken case.
 * `electron-vite dev` runs `node_modules/electron/dist/Electron.app`, which is
 * the stock Electron bundle — `CFBundleIdentifier` is `com.github.Electron`,
 * and it declares no URL types at all.
 *
 * `app.setAsDefaultProtocolClient` still registers the scheme at runtime, but
 * it can only register it to the bundle id it has, so the handler preference
 * points at "whichever bundle claims com.github.Electron". Every Electron app
 * ever run from a checkout or an `npx` cache claims exactly that. LaunchServices
 * picks one, and the odds it picks yours fall with every Electron you install:
 * on this machine it chose an `~/.npm/_npx/…` copy, which has no app inside it,
 * so a clicked link opened Electron's "run a local app" placeholder window.
 *
 * So: stamp the dev bundle with an id nobody else uses and the URL type it
 * should have had, ad-hoc re-sign it (editing Info.plist invalidates the
 * signature), and re-register it with LaunchServices.
 *
 * Idempotent, and cheap to re-run — which matters, because `npm install`
 * replaces the whole `dist` directory and silently undoes all of this. That is
 * why `electron:install` runs it rather than leaving it as a step someone has
 * to remember after every dependency change.
 *
 * Not fatal, ever: a machine where this fails still builds, tests and runs.
 * Deep links are the only thing that degrades, and it says so.
 */
import { existsSync, readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { execFileSync } from 'child_process'

/**
 * The dev bundle id.
 *
 * Deliberately *not* `com.spaceterm.app`, which electron-builder stamps on a
 * packaged build: a machine with both installed would otherwise have two
 * bundles claiming one id, which is the exact failure this script exists to
 * undo.
 */
const DEV_BUNDLE_ID = 'com.spaceterm.app.dev'
const SCHEME = 'spaceterm-surface'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework'
  + '/Frameworks/LaunchServices.framework/Support/lsregister'

/** Log and exit zero: a missing deep-link registration must not fail a build. */
function skip(reason) {
  console.log(`[url-scheme] skipped: ${reason}`)
  process.exit(0)
}

if (process.platform !== 'darwin') skip('not macOS')

/** The `Electron.app` that `electron-vite dev` will actually launch. */
function electronApp() {
  const pathFile = join(repoRoot, 'node_modules', 'electron', 'path.txt')
  if (!existsSync(pathFile)) return null
  const relative = readFileSync(pathFile, 'utf-8').trim()
  if (!relative) return null
  // path.txt holds e.g. `Electron.app/Contents/MacOS/Electron`.
  const marker = relative.indexOf('.app/')
  if (marker === -1) return null
  const app = join(repoRoot, 'node_modules', 'electron', 'dist', relative.slice(0, marker + 4))
  return existsSync(app) ? app : null
}

const app = electronApp()
if (!app) skip('no Electron binary installed — run `npm run electron:install` first')

const plist = join(app, 'Contents', 'Info.plist')
if (!existsSync(plist)) skip(`no Info.plist at ${plist}`)

const plistBuddy = (...args) =>
  execFileSync('/usr/libexec/PlistBuddy', [...args, plist], { encoding: 'utf-8' }).trim()

/**
 * A PlistBuddy read, or null when the key is absent.
 *
 * stderr is swallowed rather than inherited: "Entry Does Not Exist" is the
 * expected answer on a fresh bundle, and printing it makes a working run look
 * like a failing one.
 */
function read(entry) {
  try {
    return execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${entry}`, plist], {
      encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
}

const alreadyIdentified = read('CFBundleIdentifier') === DEV_BUNDLE_ID
const alreadyDeclared = read('CFBundleURLTypes:0:CFBundleURLSchemes:0') === SCHEME

if (alreadyIdentified && alreadyDeclared) {
  // Still re-register: the bundle can be stamped correctly while LaunchServices
  // holds a stale record of it, which is what a restored backup or a moved
  // checkout looks like.
  try {
    execFileSync(LSREGISTER, ['-f', app], { stdio: 'ignore' })
  } catch {
    // Registration is best-effort; the stamp is the part that persists.
  }
  console.log(`[url-scheme] ${SCHEME}:// already registered to ${DEV_BUNDLE_ID}`)
  process.exit(0)
}

try {
  if (!alreadyIdentified) {
    plistBuddy('-c', `Set :CFBundleIdentifier ${DEV_BUNDLE_ID}`)
  }
  if (!alreadyDeclared) {
    // Replace rather than append: a half-written entry from an interrupted run
    // would otherwise accumulate a second, wrong URL type.
    if (read('CFBundleURLTypes') !== null) plistBuddy('-c', 'Delete :CFBundleURLTypes')
    plistBuddy('-c', 'Add :CFBundleURLTypes array')
    plistBuddy('-c', 'Add :CFBundleURLTypes:0 dict')
    plistBuddy('-c', 'Add :CFBundleURLTypes:0:CFBundleURLName string Spaceterm Surface')
    plistBuddy('-c', 'Add :CFBundleURLTypes:0:CFBundleURLSchemes array')
    plistBuddy('-c', `Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string ${SCHEME}`)
  }
} catch (err) {
  skip(`could not edit ${plist}: ${err.message}`)
}

// Editing Info.plist breaks the bundle's signature, and macOS refuses to launch
// an Electron whose signature no longer matches its contents. Ad-hoc is all
// that is needed — and all that is possible without a developer certificate.
try {
  execFileSync('codesign', ['--force', '--sign', '-', app], { stdio: 'ignore' })
} catch (err) {
  console.log(`[url-scheme] warning: could not re-sign ${app}: ${err.message}`)
}

try {
  execFileSync(LSREGISTER, ['-f', app], { stdio: 'ignore' })
} catch (err) {
  skip(`could not register with LaunchServices: ${err.message}`)
}

console.log(`[url-scheme] ${SCHEME}:// → ${DEV_BUNDLE_ID} (${app})`)
console.log('[url-scheme] restart the Spaceterm client for it to claim the scheme')
