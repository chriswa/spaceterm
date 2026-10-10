---
name: phone-memory-crash
description: Use this skill if the user complains about the phone app flashing the canvas and then going black over and over, reloading on a loop, showing empty content with no tree, crashing when zoomed out, or being "kicked out" of the app. Covers confirming it is iOS killing the page for memory (jetsam), the logs and crash reports that show it, the mitigation already in place, and proposed follow-ups.
---

# Phone memory crash (iOS kills the page)

## Symptom

The phone app shows the canvas background and the root node for under half a
second, then black for about half a second, repeating. Or it dies as the user
zooms out. A native reinstall does **not** fix it: the page is being killed,
not the app.

## Confirm it

1. **The phone's free-text log**, `~/.spaceterm/electron.log`, tagged
   `[spaceterm-mobile …]`. Look for:
   - `[lifecycle] reloaded because iOS ended the page's process (N this launch)`. N climbing once a second means a crash loop.
   - `[lifecycle] last seen before the kill: … zoom …` and `[memory] last seen before the kill: …`. These give the zoom and cards on screen at the kill.
   - `[camera] start: restored x … y … z …` just before each kill. That is the saved camera the page reloaded into.
2. **The event record**, `~/.spaceterm/mobile-events.jsonl`. A
   `page-process-terminated` event (native) with a `restarts` count. Group it
   by hour to see when it started:
   `jq -r 'select(.kind=="page-process-terminated") | .t[0:13]' ~/.spaceterm/mobile-events.jsonl | uniq -c`
3. **The phone's own crash reports**, the proof that it is memory. The phone
   is paired with the Mac:
   ```
   xcrun devicectl list devices
   xcrun devicectl device info files --device <id> --domain-type systemCrashLogs | grep JetsamEvent
   xcrun devicectl device copy from --device <id> --domain-type systemCrashLogs \
     --source JetsamEvent-<date>.ips --destination <scratchpad>/j.ips
   ```
   The `.ips` file is one header line, then JSON. In `processes`, look for
   `com.apple.WebKit.WebContent` with `reason: per-process-limit` (2–4 GB) and
   `com.apple.WebKit.GPU` with `reason: highwater` (about 2 GB). Sizes are
   `rpages * pageSize`.
4. **Rule out the native app**: `node src/mobile/ios/native-version.mjs` should
   match `curl -s http://127.0.0.1:7391/build.json` (`native`), and the
   `page-load` events carry the installed `nativeVersion`. If they match, an
   install will not help.

Desktop WebKit (Playwright, iPhone emulation) does **not** reproduce it. The
page sits at about 500 MB there. Don't spend long trying.

## What is known (2026-10-08 incident)

- **Loading straight into a far-out camera is what kills the page.** Every
  crashing load restored zoom 0.015, the minimum snap with the whole tree in
  view, and died about a second later as about 45 cards painted for the first
  time at that scale.
- **Zooming out to the same view is fine.** After recovering at 0.2, pinching
  out to 0.0075 with 7 glowing cards in view stayed at 13–56 MB of canvases. A
  pinch on the phone stretches the cards as last drawn and redraws once it
  settles (`deferCameraScaleWhileMoving` in `useCamera`). Loading in draws
  every card fresh at that scale.
- **The trigger was iOS closing the app overnight.** The relaunch restored the
  far-out camera from localStorage (`spaceterm-camera`) and looped. A code
  merge landed the same morning but was very likely not the cause: the merged
  code runs fine at that zoom once reached by pinching.
- **The same family as earlier zoom-out kills.** See the comments in
  `src/mobile/mobile.css` on canvas animations and `--glow-scale`. iOS paints
  some layers at full card resolution times screen density, whatever the
  camera's scale. That memory is in the painting, not anything the page's own
  memory probe can count.

## Mitigation in place

`src/mobile/crash-camera.ts`, called from `src/mobile/main.tsx` before the
canvas mounts: after iOS kills the page (`window.spacetermProcessRestarts > 0`,
injected by the native app), a saved camera zoomed out past
`SAFE_ZOOM_AFTER_KILL` (0.2) is replaced with the root, centred, at 0.2. The log
says `[camera] reloaded after iOS ended the page at zoom …: starting at the root
at 0.2`. Expect one last crash cycle before it takes effect.

## Proposed follow-ups (not done; the operator decides)

1. **Never load straight into a far-out camera; fly out to it.** On the phone,
   when the saved camera is zoomed out past about 0.2, start at that spot at
   0.2 and animate out to the saved zoom, reusing the pinch's deferred-scale
   path and the existing "flying out from the root" start used when there is
   no saved camera. The user still ends up where they left off, and every
   launch is covered, not only those after a crash.
2. **Keep `crash-camera.ts` as the backstop** for any other kill. With (1) it
   would rarely trigger.
3. **Find the real cause, if it comes back.** With the phone connected,
   Safari's Web Inspector on the app (the web view is inspectable): set
   `localStorage['spaceterm-camera']` to a 0.015 camera, reload, and read the
   Layers tab before the page dies. This needs the operator at the Mac. It is
   how the October zoom kills were caught.
