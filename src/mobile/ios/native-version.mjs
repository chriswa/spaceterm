// The native app's version: a fingerprint of everything it is built from.
//
// install.sh stamps it into the app it installs (Info.plist
// `SpacetermNativeVersion`), and the web build writes the current one into
// `build.json` beside the page. The page compares the two, and says so when
// the app on the phone is older than its source — a change made but never
// installed. One script computes it for both, so the two can only differ when
// the code does.
//
//   node src/mobile/ios/native-version.mjs     # prints it
import { createHash } from 'crypto'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'
import { fileURLToPath } from 'url'

const here = fileURLToPath(new URL('.', import.meta.url))

/** What the app is built from: its sources and resources, and the project. */
const INPUTS = ['SpacetermMobile', 'SpacetermMobile.xcodeproj/project.pbxproj']

function files(entry) {
  const stat = statSync(entry)
  if (!stat.isDirectory()) return [entry]
  return readdirSync(entry)
    .filter((name) => !name.startsWith('.') && name !== 'xcuserdata')
    .flatMap((name) => files(join(entry, name)))
}

export function nativeVersion(iosDir = here) {
  const hash = createHash('sha256')
  const all = INPUTS.flatMap((input) => files(join(iosDir, input))).sort()
  for (const file of all) {
    hash.update(relative(iosDir, file))
    hash.update('\0')
    hash.update(readFileSync(file))
    hash.update('\0')
  }
  return hash.digest('hex').slice(0, 12)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log(nativeVersion())
}
