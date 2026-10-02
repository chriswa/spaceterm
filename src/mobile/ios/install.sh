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
bundle_id=com.chriswaddell.spaceterm

url="$(cd "$repo" && npx tsx src/cli/mobile-link.ts --url)"

devices_json="$(mktemp)"
trap 'rm -f "$devices_json"' EXIT
xcrun devicectl list devices --json-output "$devices_json" >/dev/null

# "<coredevice identifier>\t<name>" of the best paired iPhone. Tab-separated:
# names have spaces in them ("Chris’s iPhone").
IFS=$'\t' read -r device_id device_name < <(python3 - "$devices_json" "${SPACETERM_IOS_DEVICE:-}" <<'PY'
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
    found.append((conn.get("tunnelState") == "connected", d["identifier"], name))
found.sort(reverse=True)
if found:
    print(found[0][1], found[0][2], sep="\t")
PY
) || true

if [ -z "${device_id:-}" ]; then
  echo "No paired iPhone found. Pair it once: connect it by cable, open Xcode → Window →"
  echo "Devices and Simulators, select it, and tick \"Connect via network\". On the phone,"
  echo "trust this Mac and turn on Settings → Privacy & Security → Developer Mode."
  exit 1
fi
echo "Building for ${device_name}…"

# Built against the SDK rather than a destination: a destination makes Xcode
# want the whole iOS platform component (simulators included) downloaded first.
# Automatic signing registers the paired phone with the team if it is new.
# A previous run's signed app must not pass for this one's.
rm -rf "$here/build/Release-iphoneos"
xcodebuild \
  -project "$here/SpacetermMobile.xcodeproj" \
  -target SpacetermMobile \
  -sdk iphoneos \
  -configuration Release \
  -allowProvisioningUpdates \
  -allowProvisioningDeviceRegistration \
  SYMROOT="$here/build" \
  SPACETERM_URL="$url" \
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
