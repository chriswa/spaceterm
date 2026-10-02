#!/bin/bash
# How hard is Spaceterm working the phone? Records Instruments' Activity Monitor
# from the paired iPhone — over Wi-Fi, no Xcode app needed — and prints the
# app's average CPU, idle wake-ups per second and memory.
#
#   npm run mobile:energy            # 60 seconds
#   npm run mobile:energy -- 120     # or as many as you like
#
# Keep the phone awake with Spaceterm on screen for the whole recording: a
# locked phone suspends the app and drops the wireless link, which ends it.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
seconds="${1:-60}"

udid="$(xcrun xctrace list devices 2>/dev/null | grep -i iphone | grep -v Simulator | head -1 | sed -E 's/.*\(([0-9A-F-]+)\)$/\1/')"
if [ -z "$udid" ]; then
  echo "No iPhone visible to Instruments. Is it on the same Wi-Fi, unlocked, and paired (npm run mobile:ios works)?"
  exit 1
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
echo "Recording ${seconds}s from the phone. Leave Spaceterm on screen and the phone unlocked…"
xcrun xctrace record --template 'Activity Monitor' --device "$udid" --all-processes \
  --time-limit "${seconds}s" --output "$work/run.trace" >/dev/null 2>&1 || true
toc="$(xcrun xctrace export --input "$work/run.trace" --toc 2>/dev/null || true)"
if [ -z "$toc" ]; then
  echo "Nothing was recorded — the phone probably went to sleep or dropped off Wi-Fi."
  echo "Unlock it, open Spaceterm, and run this again."
  exit 1
fi

recorded="$(echo "$toc" | sed -nE 's:.*<duration>([0-9.]+)</duration>.*:\1:p' | head -1)"
reason="$(echo "$toc" | sed -nE 's:.*<end-reason>(.*)</end-reason>.*:\1:p' | head -1)"
echo "Recorded ${recorded:-?}s (${reason:-ended})."

xcrun xctrace export --input "$work/run.trace" \
  --xpath '/trace-toc/run[@number="1"]/data/table[@schema="activity-monitor-process-live"]' \
  | python3 "$here/energy-report.py"
