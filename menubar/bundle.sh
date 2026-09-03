#!/usr/bin/env bash
# Build SpacetermBar.app from the SwiftPM executable and install it to
# ~/Applications, relaunching it if it was running.
#
#   ./bundle.sh              build, install, (re)launch
#   ./bundle.sh --no-launch  build and install only
#
# The install location matters: "Open on Login" is registered through
# SMAppService.mainApp, which resolves against the bundle's path, so the app
# has to live somewhere stable rather than under .build/.
#
# Relaunching is safe: the server and client run in their own sessions and the
# new instance adopts them from ~/.spaceterm/spaceterm-bar.json.
set -euo pipefail

cd "$(dirname "$0")"
APP="SpacetermBar.app"
REPO="$(cd .. && pwd)"
INSTALL_DIR="$HOME/Applications"

swift build -c release

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp .build/release/SpacetermBar "$APP/Contents/MacOS/SpacetermBar"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>            <string>SpacetermBar</string>
    <key>CFBundleDisplayName</key>     <string>SpacetermBar</string>
    <key>CFBundleIdentifier</key>      <string>local.spacetermbar</string>
    <key>CFBundleExecutable</key>      <string>SpacetermBar</string>
    <key>CFBundlePackageType</key>     <string>APPL</string>
    <key>CFBundleShortVersionString</key> <string>1.0</string>
    <key>CFBundleVersion</key>         <string>1</string>
    <key>LSMinimumSystemVersion</key>  <string>14.0</string>
    <!-- Menu bar only: no Dock icon, no app switcher entry. -->
    <key>LSUIElement</key>             <true/>
    <!-- The checkout this build came from. Overridable with
         `defaults write local.spacetermbar SpacetermDirectory /path`. -->
    <key>SpacetermDirectory</key>      <string>${REPO}</string>
</dict>
</plist>
PLIST

# Ad-hoc signature so macOS will run it without a developer certificate.
codesign --force --deep --sign - "$APP" 2>/dev/null || true

mkdir -p "$INSTALL_DIR"
rm -rf "$INSTALL_DIR/$APP"
cp -R "$APP" "$INSTALL_DIR/$APP"
echo "installed $INSTALL_DIR/$APP  (spaceterm: $REPO)"

if [[ "${1:-}" == "--no-launch" ]]; then exit 0; fi

if pgrep -xq SpacetermBar; then
  echo "relaunching running SpacetermBar (Spaceterm keeps running)"
  pkill -x SpacetermBar || true
  for _ in $(seq 1 25); do pgrep -xq SpacetermBar || break; sleep 0.2; done
fi
open "$INSTALL_DIR/$APP"
