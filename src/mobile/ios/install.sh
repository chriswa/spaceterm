#!/bin/bash
# Build the Spaceterm iPhone app and install it on your paired iPhone.
#
#   npm run mobile:ios
#
# Works over Wi-Fi once the phone has been paired with Xcode once (see
# src/mobile/README.md). The app is a wrapper around the web app the server
# serves, so most changes need no rebuild here — only changes to this folder.
#
# SPACETERM_IOS_DEVICE=<name or identifier> picks a device when several are paired.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
config="$here/Local.xcconfig"

# Who signs the app. Each person building it signs with their own Apple team,
# so this lives in a file that is not committed (see .gitignore).
xcconfig_value() {
  [ -f "$config" ] || return 0
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*\([^[:space:]/]*\).*/\1/p" "$config" | tail -1
}
team_id="$(xcconfig_value DEVELOPMENT_TEAM)"
bundle_id="$(xcconfig_value PRODUCT_BUNDLE_IDENTIFIER)"
if [ -z "$team_id" ] || [ -z "$bundle_id" ]; then
  # The teams Xcode is signed in to (Xcode → Settings → Accounts), to suggest one.
  teams="$(defaults export com.apple.dt.Xcode - 2>/dev/null | python3 -c '
import plistlib, sys
try:
    prefs = plistlib.loads(sys.stdin.buffer.read())
except Exception:
    sys.exit(0)
seen = set()
for teams in (prefs.get("IDEProvisioningTeamByIdentifier") or {}).values():
    for t in teams:
        if t.get("teamID") and t["teamID"] not in seen:
            seen.add(t["teamID"])
            print("  DEVELOPMENT_TEAM = %s   // %s (%s)" % (t["teamID"], t.get("teamName", ""), t.get("teamType", "")))
' || true)"
  echo "The iPhone app needs your own Apple signing team and bundle id, in"
  echo "src/mobile/ios/Local.xcconfig (not committed). Create it with:"
  echo
  echo "  DEVELOPMENT_TEAM = <your team id>"
  echo "  PRODUCT_BUNDLE_IDENTIFIER = com.<you>.spaceterm"
  echo
  if [ -n "$teams" ]; then
    echo "Teams Xcode knows on this Mac:"
    echo "$teams"
  else
    echo "Xcode has no team on this Mac yet: sign in under Xcode → Settings → Accounts"
    echo "(a free Apple ID works), then run this again to see your team id."
  fi
  echo
  echo "Spaceterm's iPhone app isn't set up on this Mac yet: create src/mobile/ios/Local.xcconfig."
  exit 1
fi

# This Mac's pairing URL, then any other Mac's from ~/.spaceterm/other-macs:
# the app tries them all and keeps whichever answers first.
urls="$(cd "$repo" && npx tsx src/cli/mobile-link.ts --urls)"

devices_json="$(mktemp)"
trap 'rm -f "$devices_json"' EXIT
xcrun devicectl list devices --json-output "$devices_json" >/dev/null

# "<coredevice identifier>\t<name>\t<tunnel state>" of the best paired iPhone.
# Tab-separated: names have spaces in them ("Chris’s iPhone").
IFS=$'\t' read -r device_id device_name device_tunnel < <(python3 - "$devices_json" "${SPACETERM_IOS_DEVICE:-}" <<'PY'
import json, sys
devices = json.load(open(sys.argv[1]))["result"]["devices"]
want = sys.argv[2]
found = []
for d in devices:
    hw, conn, props = d.get("hardwareProperties", {}), d.get("connectionProperties", {}), d.get("deviceProperties", {})
    if hw.get("platform") != "iOS" or conn.get("pairingState") != "paired":
        continue
    name = props.get("name", "")
    if want and want not in (name, d["identifier"], hw.get("udid")):
        continue
    tunnel = conn.get("tunnelState", "")
    found.append((tunnel == "connected", d["identifier"], name, tunnel))
found.sort(reverse=True)
if found:
    print(found[0][1], found[0][2], found[0][3], sep="\t")
PY
) || true

if [ -z "${device_id:-}" ]; then
  echo "No paired iPhone found. Pair it once: connect it by cable, open Xcode → Window →"
  echo "Devices and Simulators, select it, and tick \"Connect via network\". On the phone,"
  echo "trust this Mac and turn on Settings → Privacy & Security → Developer Mode."
  exit 1
fi
# Paired but out of reach — another network, Wi-Fi off, powered down. The
# install would fail anyway, after a whole build; say so now, plainly. (The
# phone's update badge shows this script's last line.)
if [ "${device_tunnel:-}" = "unavailable" ]; then
  echo "${device_name} isn't reachable from this Mac. Join the Mac's Wi-Fi (or plug it in) and try again."
  exit 2
fi
echo "Building for ${device_name}…"

# Built against the SDK rather than a destination: a destination makes Xcode
# want the whole iOS platform component (simulators included) downloaded first.
# Automatic signing registers the paired phone with the team if it is new.
# A previous run's signed app must not pass for this one's.
rm -rf "$here/build/Release-iphoneos"
# What this app is built from, so the page can tell when a newer one exists
# (native-version.mjs; the web build publishes the current one).
native_version="$(node "$here/native-version.mjs")"
xcodebuild \
  -project "$here/SpacetermMobile.xcodeproj" \
  -target SpacetermMobile \
  -sdk iphoneos \
  -configuration Release \
  -allowProvisioningUpdates \
  -allowProvisioningDeviceRegistration \
  -xcconfig "$config" \
  SYMROOT="$here/build" \
  SPACETERM_URLS="$urls" \
  SPACETERM_NATIVE_VERSION="$native_version" \
  build | grep -E "error:|BUILD (SUCCEEDED|FAILED)" || true

app="$here/build/Release-iphoneos/SpacetermMobile.app"
codesign --verify "$app" 2>/dev/null || { echo "Build or signing failed; see the errors above."; exit 1; }

echo "Installing…"
xcrun devicectl device install app --device "$device_id" "$app" >/dev/null
if launch_output="$(xcrun devicectl device process launch --device "$device_id" --terminate-existing "$bundle_id" 2>&1)"; then
  echo "Spaceterm is running on ${device_name}."
elif echo "$launch_output" | grep -q "Locked"; then
  echo "Installed on ${device_name}. It is locked, so the app could not be opened — it is there next time you unlock."
else
  echo "$launch_output" | tail -5
  exit 1
fi
