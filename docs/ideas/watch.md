# Apple Watch: Control from the wrist

A proposal, not built. Written October 2026 from the code as it stood at
`fc00775` and from what Apple and its developer forums say about watchOS.
Everything marked **verify** is a claim no source settled and a one-day spike
on a real watch would.

## What was asked

A watch app for Control only, audio only, with the three middle buttons of the
phone's bottom bar and nothing else on screen:

| Button | Phone today | Wire today |
|---|---|---|
| Talk | `MicButton.tsx`: tap to speak, tap again to send | `dictation-start {forControl}` … `receptionist-say` |
| Hands-free | `HandsFreeButton.tsx`: hands-free on/off | none: client-only, `setHoldMicrophone` → `NativeMicrophone.swift` |
| Replies | Away / Aloud (no Silent: nothing to read it on) | `receptionist-hold`: `release` / `speak-here` |

Replies in the AirPods, speech picked up by the watch, the phone asleep in a
pocket, and the least battery spent. Apart from switching always-listen, no
touching anything.

## What the phone already does, and why it matters here

Most of the hard part exists, natively, in the iPhone app (`src/mobile/ios/`):

- **Listening with the screen locked.** `NativeMicrophone.swift` holds the
  microphone in an `AVAudioEngine` under the `audio` background mode, and
  comes back by itself after Siri, a call, a relaunch or AirPods coming and
  going. It hands the page 16 kHz mono PCM a tenth of a second at a time.
- **Gating, so almost nothing is sent.** Silero VAD on the phone
  (`speech-detector.ts`, ~0.3 ms per 32 ms frame) keeps audio in an
  eight-second ring buffer; only the first second of a burst that follows
  silence goes to the Mac, where Voice Operator checks for "Control" with
  Apple's on-device model (`POST /v1/wake-word?match=start`).
- **Smart Turn on the Mac** (`src/server/turn-detector.ts`, 8 MB model, ~45 ms
  a check at each 0.8 s pause). Nothing on the phone runs it.
- **Control's voice through the AirPods** with Apple's voice processing, so
  "Control, …" can cut it off.

So the trigger word and Smart Turn are *already* off the device. The only
always-on work on the device is: microphone open, a VAD every 32 ms, and a
WebSocket kept alive. That is the floor for any design, phone or watch.

## Native, not Electron

Not a choice: there is no Electron, no web view and no WebKit on watchOS, and
the phone app is a native shell around a page. A watch app is SwiftUI.

It should **not** be a separate app, though. It is a watch target added to the
existing `SpacetermMobile.xcodeproj` — a companion that installs with the
iPhone app — because every viable option below talks to the iPhone app, and
`install.sh`, signing (`Local.xcconfig`) and the Mac list already live there.
A free Apple ID still works, with the same seven-day expiry.

## The real constraint: battery is not where it looks

The phone in a pocket already has its screen off; what it spends is the audio
engine, the VAD and the radio — exactly what a watch would have to spend
instead. An iPhone battery is roughly 3,300–4,700 mAh; an Apple Watch's is
roughly 300–600 mAh, ten or more times smaller. **Moving always-listening onto
the watch moves the same work onto the smaller battery.** The total drawn from
your devices does not go down, and the watch is the one that runs out.

And the phone cannot really sleep in any design that reaches the Mac: watchOS
sends a watch app's traffic through the paired iPhone over Bluetooth whenever
the phone is near (the companion link), and there is no public way to opt out.
The phone's *app* can sleep; its radio still carries the bytes.

## Options

### A. Watch as a remote for the iPhone app — recommended first

The watch is three buttons. They go to the iPhone app over WatchConnectivity
(`WCSession.sendMessage`, which wakes the iPhone app in the background), the
app hands them to the page, and the page does exactly what its own buttons do.
The phone keeps the microphone, the AirPods and the connection.

- **Watch battery: close to nothing.** The watch app runs only while you press
  a button. A Smart Stack / Control Center control (watchOS 26 controls; the
  Action button on an Ultra) can flip always-listen without opening the app —
  **verify** that a control can reach the iPhone app without launching the
  watch app.
- **Phone battery: unchanged from today.** It already listens in a pocket.
- **Work: small.** A watch target, a `WCSession` delegate in the iPhone app
  that forwards three commands into the page (the same path
  `NativeMicrophone` already uses with `evaluateJavaScript`), and the page's
  existing handlers. A haptic and a tone on the watch confirm each press; the
  three buttons can show their state for free.
- **Gap:** your speech is heard by the phone in your pocket, not the watch.
  If the pocket is a problem, that is option B's job — but measure it first:
  `hands-free-levels` and `hands-free-speech` in `mobile-events.jsonl` already
  record how loud you are and how often you are missed.
- **Edge:** with Control Away and hands-free off, iOS suspends the app and the
  page; a press then has to wake the app and get the page reconnected before
  it can act. The app reloads a dead page already; the press must queue until
  it is back.

### B. Watch as the microphone, phone as the hub — only if A's microphone fails

The watch records in the background, runs the cheapest possible gate, and
sends only speech (with half a second of pre-roll) to the iPhone app over
WatchConnectivity. The iPhone app feeds it into the page as if it were its own
microphone — `NativeMicrophone.swift` is already the one place PCM enters the
page, so the watch becomes a second source behind the same seam, and
`hands-free.ts`, the wake check and Smart Turn are untouched.

- **Gate on the watch:** a plain loudness threshold first, and Silero VAD
  (Core ML, ~1–2 MB) only on frames that pass it. Running the trigger word or
  Smart Turn on the watch would add a neural model on the main processor for
  no gain: they already run on the Mac, and only "Control" bursts reach it.
  Apple's own "Hey Siri" uses a low-power path third-party apps cannot use.
- **Watch battery: the open question.** A microphone held all day plus a
  process kept awake is the whole cost, and nobody publishes a number.
  **Verify** by measurement; expect hours, not a day.
- **Background recording:** needs `UIBackgroundModes: audio` (not
  `WKBackgroundModes`) and must *start* in the foreground — a tap on the
  always-listen button, which is fine. Apple says the session survives wrist
  down; one report says an interruption (Siri, a call) stops it for good
  until the app is foregrounded again. **Verify** both.
- **Latency:** WatchConnectivity is not a streaming transport; message
  latency over Bluetooth is typically a few hundred milliseconds. Fine for
  the wake check (which waits for a second of audio anyway); **verify** it
  keeps up with live dictation.
- **Echo:** the watch hears far less of the AirPods than the phone's speaker
  leaks, but the phone's echo cancellation cannot see the watch's
  microphone. Interrupting Control probably works anyway; **verify**.

### C. Watch alone, straight to the Mac — not recommended

The watch does everything the phone does: microphone, gate, a connection to
the server, Control's voice to the AirPods. Every piece of it is against the
grain of watchOS:

- **No Tailscale on the watch** (no VPN on watchOS). The gateway is
  loopback + `tailscale serve`; the watch would need it on the public
  internet (Funnel) or to rely on the companion link carrying tailnet
  traffic, which no source confirms.
- **No WebSocket in the background, reliably.** Low-level networking
  (`URLSessionWebSocketTask`, Network framework) is allowed only during an
  active audio session (TN3135), and on watchOS 26 that grant is revoked
  every ~38 s (Apple forums thread 841590, FB24377808, open as of September
  2026). Plain `URLSession` HTTPS keeps working, so this would need an HTTP
  protocol beside the WebSocket gateway.
- **Routing:** AirPods out *and* the watch's microphone in, from one app, is
  not a combination watchOS documents. Bluetooth routing for third-party
  apps is defined for playback with the long-form policy; a call (CallKit)
  takes the AirPods' microphone instead. **Verify** before anything depends
  on it. And while the watch holds the AirPods, the phone does not.
- **Radio:** away from the phone the watch uses its own Wi-Fi or LTE, the
  most expensive thing it does. Near the phone, it goes through the phone
  anyway.
- **A second implementation** of `hands-free.ts`, the wake listener and the
  dictation flow, in Swift, to keep in step with the page forever.

### D. A CallKit "call to Control" on the watch — no

A VoIP call is the one sanctioned way for a watch app to hold the microphone,
the network and the AirPods at once. But it uses the AirPods' microphone
(narrowband HFP, the reason the phone avoided it), shows a call, and an
hours-long call is the fastest way to empty a watch.

### Not a watch at all: the AirPods' microphone

If the pocket muffles you, the iPhone app could take the AirPods' microphone
(`.allowBluetooth` on its session). Zero new code paths, zero watch battery.
The cost is that Bluetooth HFP turns Control's voice to phone-call quality
while the microphone is open. Worth one afternoon's try before B.

## Recommendation

1. **Build A.** A watch target, three buttons and a control, over
   WatchConnectivity to the existing iPhone app. Small, nearly free on the
   watch, and it removes reaching for the phone.
2. **Measure the pocket microphone** with the events already recorded. If it
   misses you, try the AirPods' microphone first.
3. **Only then spike B**: one day on a real watch to answer the **verify**
   items — background recording through wrist-down and interruptions, battery
   per hour with the microphone held, WatchConnectivity latency — before
   building it.
4. Leave C and D.

## Sources

- TN3135, Low-level networking on watchOS:
  https://developer.apple.com/documentation/technotes/tn3135-low-level-networking-on-watchos
- The ~38 s revocation of the audio-session networking grant (watchOS 26):
  https://developer.apple.com/forums/thread/841590 and
  https://developer.apple.com/forums/thread/841760
- Duplex audio streaming on watchOS, unresolved:
  https://developer.apple.com/forums/thread/777373
- Playing background audio (long-form policy, Bluetooth route):
  https://developer.apple.com/documentation/watchkit/playing-background-audio
- Audio background mode is `UIBackgroundModes`, not `WKBackgroundModes`:
  https://github.com/cascadiacollections/shoutkit/pull/199
- Recording and interruptions in the background:
  https://developer.apple.com/forums/thread/750432
- Watch traffic goes through the iPhone when it is near:
  https://developer.apple.com/forums/thread/831293
- CallKit on watchOS 9: https://developer.apple.com/forums/thread/708897
