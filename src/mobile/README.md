# Spaceterm mobile

A web app for the phone, served by the Spaceterm server and reached over
Tailscale. It is the desktop app with a different host underneath, not a
second client: as much as possible is literally the same code.

## What is shared, and how

| Piece | Desktop | Phone |
|---|---|---|
| Protocol client | `src/shared/server-client.ts` | same |
| `window.api` | `src/shared/client-api.ts` | same |
| Startup, resync, reconnect | `renderer/src/lib/install-api.ts` | same |
| Transport | Electron main's byte pipe to the Unix socket | WebSocket to `src/server/web-gateway.ts` |
| Host (window, perf, system) | preload | `browser-platform.ts` |
| Canvas | `App` | same `App`, plus touch (`useTouchCamera`) |
| A focused terminal | live in its card | the same `TerminalCard`, chromeless, full screen (`TerminalView.tsx`) |
| Ship it | `src/server/ship-it.ts` | same |

The one switch is `surfacePresenterStore`: with `external` set, `App` keeps
every canvas card on snapshots and publishes which terminal is focused, and
`MobileApp` draws it. Focus, unread handling and the camera stay `App`'s.

Phone-only: the gestures, the key row, the composer (dictate → edit → ship),
the surface list, dictation capture, and hands-free mode (below).

## The terminal view

Just the terminal, at a grid that fits the screen above the bottom bar. That grid is *borrowed*
(`terminal-borrow-size`): the server keeps the surface's own size as a
persisted `homeSize` and gives it back when the view closes, when the phone
disconnects, or — if the server died mid-borrow — at its next start. A
deliberate resize on the desktop ends the borrow.

Touches never reach xterm (`terminal-gesture.ts`):

| Gesture | Does |
|---|---|
| drag up / down | scrolls — sent as wheel events, so the card's own routing picks the TUI's mouse protocol or the shell's scrollback, as on the desktop |
| swipe sideways, pinch in | back to the canvas the moment it goes far enough; the rest of the gesture pans or zooms the canvas (`handTouchToCanvas`) |
| tap | the composer, keyboard up |
| long press | a radial menu around the thumb: slide to **Keyboard** (the keyboard and extra-key row, typing straight into the terminal; *Hide keyboard* while it is up), and let go. Letting go in the middle does nothing |

On the canvas, a long press on a card is the desktop's ⌘-click: the
quick-actions toolbar; moving on without lifting drags the card instead.
A long press on the bare background is the desktop's right-button drag: a
dot marks the press, and moving the finger away from it zooms out about it
(`useZoomDrag`), back toward it zooms back in.
The server rebuilds the bundle a couple of seconds after its sources stop
changing (`MobileBuildKeeper` in `src/server/mobile-build.ts`) and tells the
phone. Anything waiting — a server restart an agent flagged, a newer native
app, a newer page — counts on the rocket as a notification
(`update-notices.ts`), and in the toolbar sheet it opens, the button for each
marches its ants: **↻** (restart
the server), **Install the app** (the Mac builds and installs it:
`src/server/mobile-install.ts`, the same `install.sh`) and **Reload client**
(`updateActionsStore.ts`).
Pressing any of the three, here or on the Mac, lets go of Control first
(Away) and then puts up a screen that cannot be dismissed
(`UpdateBlocker.tsx`) until the page goes: for a restart, until the new server
answers and the page reloads; for an install, until iOS closes and relaunches
the app. Only a failure takes it down, with a toast.
These two sit after Help, where the desktop has fit-to-monitor, and only on the
phone (`mobileOnly` in `toolbar/registry.tsx`). A reload is not asked for while
a restart is, which reloads the page anyway, or while the app is behind, whose
replacement loads the new page (`clientStalenessStore.ts`). The build writes
`build.json` (its id and the native fingerprint from `ios/native-version.mjs`),
which `install.sh` also stamps into the app — see `update-check.ts`.

The bottom bar (`BottomBar.tsx`) is a solid band the canvas stops above: AI usage on the left, Control, the microphone and the hands-free button in the middle, the toolbar's rocket, which carries the notifications, on the right. It stays up over the toolbar sheet, where the rocket closes the sheet again, and over the terminal view, which stops above it (costing a few rows); it goes while the composer is open, which has its own microphone. Its left shows AI usage as [AI Spend Tracker](https://github.com/chriswa/ai-spend-tracker)'s menu-bar bars,
with the reading's age; the server reads the tracker's `--json` CLI
(`src/server/usage-tracker.ts`). Dictation streams 16 kHz PCM to the server, which
relays it through Voice Operator (`src/server/remote-dictation.ts`) — the only
process that may hold Wispr's rotating tokens.

Stacked under the AI usage on the bottom bar, against Control, is the Mac's
system monitor as mini-stats (`~/mini-stats`) draws it in the menu bar
(`SystemStatsReadout.tsx`), shrunk to fit and without the bars' letters.
mini-stats writes what its menu-bar item draws, colours and sizes decided, to
`~/.mini-stats/menubar.json`; the server reads it every 2 s, but only while a
phone is watching (`system-stats-watch`, `src/server/system-stats.ts`).
Tapping either readout opens one panel with every set of figures (`MacReadouts.tsx`):
each mini-stats module's reading, and each usage window's used, elapsed and
time-to-reset.

## Control: here, muted, or let go

The headset left of the microphone (`ControlButton.tsx`) opens Control's
transcript (below), and a tap does nothing else: taking Control, letting it go
and muting it are the transcript's buttons. The button says how those stand
(`ControlBadges.tsx`, shared with the Mac's toolbar button):

| Mark | Shows |
|---|---|
| arcs either side of the headset | sound: Control is unmuted on this phone; no arcs is muted |
| a big red X across the button | this phone does not hold Control |
| top right | the holder's name (*Mac*) while another device holds Control |
| bottom right | replies written here muted and not read yet, counted as the rocket does |

The button is filled, the headset dark on light, while the transcript is open.

Muted, Control stays on this phone but writes instead of speaking: its
replies go into the transcript, unread until read. The headset is dim while
Control is not here. A yellow ring shows while it thinks, and while anything is said
through it a ring in the colour of who is speaking — white for Control, a hue
of their own for an agent it quotes. The server takes each
of the transcript's presses as said outright (`receptionist-hold`: `mute`,
`take`, `speak-here`, `release`), so two devices pressing at once cannot cross.

Being muted is the device's own, separate from holding Control, and outlasts
handing Control away and back (`receptionistMuted` in the server state). The
transcript shows the two as one choice of what you get of Control's replies
here — **Away**, **Silent** (held, muted) or **Aloud** (held, unmuted) — since a mute matters only while Control is
here; Silent mutes before it takes, so Control never arrives speaking. A muted phone is still Control's
listener when it is not connected, so it can sleep (`stay-awake.ts` lets it):
everything is waiting in the transcript when it wakes. Letting go of Control
altogether — nobody hears it, and it tells you what you missed when you are
back — is the transcript's **Away**.

Neither holding Control nor the always-on microphone survives a relaunch: the
app lets go of Control when it starts (`main.tsx`), and the microphone hold
starts off (`held-microphone.ts`). A mute does survive.

## Control's transcript

The Control button opens the
whole conversation with Control above the bottom bar, with a box to type to it
(`ControlTranscript.tsx`, shared with the desktop, where it is a dialog).
It reads Control's full record
(`~/.spaceterm/receptionist/conversation.jsonl`), not its session, so
compaction never shortens it: it opens at the newest — or at the first reply
with words waiting for you, under a red Unread line — and loads older pages
as you scroll up.
Under the box to type in, centred: the Away / Silent / Aloud choice, captioned
Replies, and a Concise / Detailed choice of whether Control's activity shows
between its words. Above the box, while
replies wait unread: **Read aloud**, which reads them out on this device in
the voices they were written in — nothing goes to Control, and they count as
read at once, the transcript lighting each word as it is said and scrolling to
keep it in view — and **Mark all read**. A reading, like a part played again
with its own button, looks just as Control speaking does: the bar is gone,
the Control button shows who is speaking, and what stops Control stops it.

While it is open the bar stays up: the Control button is a down arrow that
closes it, and the microphone talks to Control, with what it heard appearing at the bottom. It and the toolbar sheet are screens, not
layers — opening one closes the other — and a one-finger sideways drag
dismisses either, as it leaves the terminal view (`swipe-dismiss.ts`), except
from the sheet's button strip, which scrolls sideways, a row's reorder handle,
or the transcript's text box. Agents Control quoted by handle alone
are named from the record and log (`transcript-names.ts`), since the name
registry forgets archived agents; one never named shows its title.

What you cut Control off in the middle of shows once you interrupt: the words
you never heard struck out, and, as dashed struck pills, "not done, cut off",
the actions that were waiting on them and so never ran, each with **Do it
now** to ask for it after all. While Control speaks, the word being said is
lit and the rest of the reply dim. Talked over hands-free, the cut is dated to
your first syllable, not to the moment the Mac decided you were talking to
Control: from then on Control was turned down under your voice, and unheard
(`cutInMsAgo` in `ReceptionistStopMessage`). The same holds when Control is
speaking on the Mac: the phone stops it, dated the same way, and Voice
Operator counts back to then (`heard_until`). The Mac's own push-to-talk needs
none of this — Voice Operator stops the voice on the key going down.

Words still waiting for you — written while muted, or cut off while you were
away or had moved to another device — sit under the red Unread line, with a
red edge on their bubbles, until you read them. Nothing counts as read for
being on screen: **Mark all read**, above the box to type in, says you have, and so does
typing your next message here. Speaking your next message instead strikes
them out as missed, so Control knows you never took them in.

Everything Control has said since your last message — its own words and the
agents it quoted, however many replies — can still be marked: tap a word,
struck or not, and everything up to it counts as taken in and everything
after as missed. Tap again
to move the mark, as often as you like, until you send your next message,
which locks it. Not while Control is speaking, when the voice decides. All of
it is recorded as transcript-only lines the model never sees (`amendHeard`,
`notDone`, `consumed` in `real-deps.ts`). The view follows new content while
you are near the bottom, including the circle that turns while Control
thinks; a button takes you back down when you are not.

An agent's name over what it said goes to that agent: its card, or, once
archived, the card whose archives hold it (the root when none does). Control's
own name is not a button.

Every part of a reply has a ▶ that plays it again on this device, in the
voice it was said in and with its "Kevin here." (replies keep their voices
and introductions in the record; older ones cannot be replayed). Control
holds its tongue while a replay plays, and talking over it just stops it.

**Keeping Control in step with what you took in.** Control writes knowing
everything it says, and assumes it was heard. The server's
`ConsumptionLedger` (`src/server/receptionist/consumption.ts`) follows what
you actually took in of each reply — heard, read, replayed or summed up — and
counts nothing taken in without evidence: a reply spoken through is heard,
one written while muted waits until you read it, and a cut-off one is heard
only up to the cut. Where you marked that you stopped is told to Control with
your next message, as "they stopped taking in your words after …, and cut in
there", so it answers from that point; other changes go with the next message
it gets, never with a turn of its own. So it never builds on a reply you have
not taken in, and stops repeating what you have since read or replayed.

## Hearing Control with the phone locked

While this phone holds Control, the app keeps itself running in the
background — locked, or with another app in front — so Control's reports and
answers are still heard. iOS suspends an app whose audio is not running, and
the page and its connection to the server go with it: the server then had
nobody to speak to, and saved it all for when the app came back. Now the page
asks the app to stay awake while it holds Control (`stay-awake.ts`), and the
app runs its audio engine without the microphone (`NativeMicrophone.swift`,
`Mode.speaker`): playback only, mixing with other apps' audio, playing
silence, and Control's voice through the speaker or AirPods. Hands-free's
microphone does the same job when it is on. Handing Control to the Mac, or to
nobody, or muting it, lets the app be suspended again.

It costs the battery a running audio engine, and does nothing once the app
has been swiped away; a call or Siri stops it until the interruption ends.
So does the page's own microphone — a held dictation, through WebKit — and
iOS never says when *that* interruption ends, so the app starts the engine
again itself once WebKit's capture closes. Until it has, the app reports
itself not awake and the page plays Control's voice; and a job the app says
nothing of within a few seconds is taken back and played by the page
(`native-speech-taken-back`), so a stopped engine can delay a reply but not
silence it. `native-stay-awake` and `native-awake-running` in the event record show it
coming and going, and the `native-heartbeat` while in the background says
whether the page still answers (`pageAnsweredMs`).

### Music from other apps

In the iPhone app, Spotify or any other app's audio always comes back after
Spaceterm has had it. WebKit could not manage that: its recording and its
playback type both interrupt other audio, and it deactivates without
notifying others, so music it stopped stayed stopped. So in the app every
dictation uses the app's own microphone (`held-microphone.ts`), and the
page's idle type is ambient, WebKit's one type that mixes. The app then
decides what other audio gets (`Others` in `NativeMicrophone.swift`):

- **turned down** while a dictation's microphone is open, and for two
  seconds after (`duckHoldSeconds`), so a dictation flows into Control
  thinking without the music swelling between; and while Control thinks or
  speaks aloud here (`duck-others.ts`, which waits `DUCK_RELEASE_MS` before
  letting go);
- **left alone** otherwise.

Never paused. iOS has no way for one app to mute another: the only way to
stop it is a non-mixable session, which interrupts it, and Spotify takes an
interruption as a pause. From October 12 to 13 the dictation did exactly
that ("muted"), with the music told to carry on after; now every session
of the app's mixes. `other-audio` records each time other audio starts or
stops, with what the app's audio was doing then.

Hands-free's held microphone never changes the session for any of this, as
each change would drop the AirPods' microphone link. Voice processing turns
music down instead (`voiceProcessingOtherAudioDuckingConfiguration`, at its
most rather than its least), which works on the running engine, in the
background too — only while hands-free takes a dictation down
(`followHandsFree` in `duck-others.ts`, `hands-free-dictating`).
`native-voice-ducking` shows each change.

On headphones — AirPods, any Bluetooth or wired set — hands-free runs as a
dictation does: no voice processing, and music turned down for the whole
session (`holdOnHeadphones`, decided when it starts and when a headset
comes or goes). Voice processing's voice-chat mode was what paused Spotify
for the whole of hands-free; a dictation, without it, had Spotify play on.
In an ear nothing played leaks into the microphone, so there is nothing to
cancel: the app still plays Control's voice and hands-free listens through
it, so "Control" still cuts it off (`echoFree` in the app's state). On the
phone's own speaker hands-free keeps voice processing, which does pause
Spotify.

Switching the app's active session between playback and play-and-record
pauses Spotify until a deactivation lets it carry on. So leaving the
microphone the session is given up first; going to hands-free's microphone
from the engine kept up for Control it is given up too, half a second before
the microphone (`releasePauseSeconds`). A dictation from that engine still
switches in place, for speed, and pauses Spotify until Control is done.
Otherwise no microphone is preceded by a deactivation, and never at once: a
deactivation followed at once by the microphone brought the AirPods'
microphone link up at 48 kHz sending only zeros, every time — twice on
October 13 the AirPods then needed the iPhone restarting. So a microphone keeps the treatment of
other audio it was activated with, and music is let back up when the
microphone goes. `other-audio` says when other audio plays, but counts the
page's own sonar and cues, which go through WebKit's process, as other
audio too.

iOS applies any session's treatment of other audio only when it is
activated, so each change brings the app's session up again, deactivated
between with `notifyOthersOnDeactivation`, which lets music back up.
Ambient's cost: the Ring/Silent switch silences the page's own sounds, the
sonar and the cues. `native-duck-others`, `native-duck-hold-ended` and the
`others` field on `native-awake-running` / `native-mic-running` show it.

The app's audio session is changed on its own queue, never the main thread:
activating it blocks for a second or two while AirPods change profile, and
on the main thread that froze the screen after every dictation.

Hands-free on headphones that comes up at more than 24 kHz anyway asks, on
the active session, for iOS 26's AirPods high-quality recording
(`bluetoothHighQualityRecording`): iOS sometimes brings the AirPods'
microphone link up at 48 kHz on its own, and there it sent only exact zeros
unless this had been asked for, while every 48 kHz start that asked for it
heard. At 24 kHz nothing changes: that link heard every time, and was the
one of hands-free's best session so far. A dictation does not ask,
as it may add input latency. (A dictation asked for it on October 12; then
hands-free with voice processing following one of its dictations came up
dead.) `native-mic-running`'s `highQuality` says whether it took.

The app's audio session is changed on its own queue, never the main thread:
activating it blocks for a second or two while AirPods change profile, and
on the main thread that froze the screen after every dictation.

## Control mode: the canvas stops

While Control's transcript is up, or the screen is off, the phone is only
talking to Control and nothing on the canvas could be seen, so the canvas does
nothing (`control-mode.ts`):

- It is covered, as under the terminal view: the background, card painting,
  camera flights and the clock behind the elapsed captions all stop.
- The server stops sending it terminal snapshots (`canvas-pause`,
  `src/server/snapshot-delivery.ts`). They were nearly everything the phone
  received — about 6 MB a minute with 25 terminals, parsed with the screen
  off — and are dropped, not queued: on the way back the server sends each
  card's screen as it now stands.
- The freeze and memory instruments (`diagnostics.ts`, `memory-probe.ts`)
  stop; the memory probe runs only while the canvas is on screen.

Everything else still arrives and lands in its store, so leaving Control mode
replays nothing. Agent spend and the mini stats carry on as before.

### The canvas is not always mounted

Paused, a mounted canvas still re-renders on agent updates and holds every
card, so it is only mounted while it might be looked at
(`canvas-lifecycle.ts`):

- **Every start, a reload included, opens on Control's transcript with no
  canvas at all.** It first mounts when you leave the transcript — closing
  it, the rocket's surface list, or an agent's name in it.
- **Five minutes in Control mode unmounts it** — transcript up, another app in
  front, or the phone asleep — with the terminal view and composer that are
  part of it. An open composer keeps it.
- **Coming back** to the transcript leaves it unmounted. Coming back to the
  canvas or a terminal mounts it again, and App restores the camera and focus
  it saved, which puts you back on the same view or in the same terminal.

What the canvas did that the rest of the phone needs now lives outside it:
the server sync, which fills the stores everything reads, is held by
`main.tsx` for the page's life (`retainServerSync`), and toasts have their own
host (`ToastHost`). A focus request made with no canvas — an agent's name in
the transcript — waits for it, and App takes it once it has placed the camera.
A Control camera follow while it is unmounted is not kept. `canvas` events in
the record say when it comes and goes.

Whether it holds is in the event record: `control-mode` as it comes and goes,
and a `page-work` event every minute — messages and kilobytes received (the
heaviest types in `byType`, `[count, kb]`), the time spent handling them
(`handlingMs`), and how much of the minute was in Control mode
(`controlModeS`). A minute in Control mode should be kilobytes, not megabytes.

## The microphone

The big button in the middle of the bottom bar (`MicButton.tsx`) is the
phone's microphone, and only that; the rules for its looks are pure, in
`mic-button.ts`. It is a plain button: no long press, no drag.

| Gesture | Does |
|---|---|
| tap | speak to Control, and tap again to send. Over an answer, cuts it off and listens |
| tap while it is starting | gives up on starting |
| tap on red | tries again |

Every button in the bottom bar sinks and brightens the instant a finger lands
(`press-feedback.ts`), before anything the press starts has happened, so a
press that was taken is never mistaken for one that missed.

It looks the same however the listening started — a tap, "Control", the
conversation window, or a composer's dictation:

| Look | Means |
|---|---|
| grey | the microphone is closed |
| outlined, a gold spark running round | hands-free is on, waiting for the microphone (the hands-free button shows the spark too) |
| white, lock badge, thin white ring | hands-free holds it; nothing leaves the phone until "Control" |
| white, thick bright ring | hands-free heard speech and is asking the Mac whether it was for Control |
| blue ring, draining | the conversation window: just talk. The ring is the quiet left before "Control" is needed again |
| dark, a gold spark running round the rim | a tap was taken and the microphone is starting — AirPods playing music take seconds to switch. Don't talk yet |
| dark, amber icon and spark | it did not start; trying once more by itself (the app's microphone needs no second tap) |
| solid orange, level bars | your voice is leaving the phone, whatever started it — the bars are its level (`mic-level.ts`, fed by each dictation). Only once sound is really arriving |
| orange, a white spark running round | waiting for the words |
| solid red, "!" | it failed; the message above says why, for 8 s. A tap tries again |

A small badge at its top right is where sound is going now, as the iPhone app
reads iOS's route (`audio-output.ts`): a speaker, headphones (AirPods or any
Bluetooth or wired set), or, in yellow, an ear for the earpiece or a dot for
anything else. Nothing on the phone chooses the route — iOS sends sound to
headphones while they are connected and to the speaker otherwise — so the
badge is there to make a wrong route visible. There was once a Speaker /
Earpiece choice, for holding the phone to the ear; it is gone. Only the app
can say; in a browser there is no badge.

Orange is the **MIC** label's (below) and iOS's own dot. What Control is
doing never shows here: its own button says that.

A composer's dictation carries on after its composer closes
(`dictation-session.ts`). The button stays up while it does, orange, and a tap
opens the open terminal's composer, which takes it over to stop or ship it; on
the canvas, with no terminal open, it only says so.

## What the phone makes you feel and hear

The microphone's states are haptics, not tones (`nativeHaptic`,
`native-microphone.ts`): a tone at the start or end of a dictation competed
with the ducking and echo cancellation around the microphone, and played into
AirPods still switching profile. Two patterns only:

| Haptic | Means |
|---|---|
| one tap | your words are being taken down: sound is arriving after a tap, or hands-free heard "Control" |
| two taps | the recording is over and on its way |
| three taps | hands-free's conversation window ran out; "Control" is needed again |

Speech hands-free is still checking buzzes nothing — every cough would — and
shows as the thick white ring. Haptics come from the app only (iOS gives a
page no vibration). On screen they are short taps. In a pocket or with the
screen locked, iOS plays no taps — UIKit's feedback generators and Core
Haptics are both kept to the app on screen — so the app uses the one
vibration iOS lets a background app play, `kSystemSoundID_Vibrate`, while
its audio is running (hands-free holding the microphone, or Control held
here): a buzz of about 0.4 s each, chained, so the patterns are the same
counts, longer. The phone's Sounds & Haptics settings can still silence it.
That needs the app built since this was added (`haptics: 2` in its state);
an older one taps on screen only. Every haptic is a `haptic` line in the
record, and a `native-haptic` line says how the app played it.

Sounds are few, and only where replies are **Aloud** — this phone holds
Control, unmuted; on Silent or Released the phone makes no sound of its own
(`cuesAudible`, `cues.ts`):

| Sound | Means |
|---|---|
| sonar, a soft repeating echo | Control is thinking, or its voice is being made (`thinking-cue.ts`) |
| "beep boop", soft, stepping down | Control finished and chose to say nothing — not a failure (`control-tones.ts`) |
| two low notes | something failed: the microphone, a transcription, or Control |

Hands-free's own tones play whatever Replies is set to, and the app plays
them, so the Ring/Silent switch does not silence them (`playHandsFreeCue`):

| Sound | Means |
|---|---|
| three soft steps up | hands-free is ready: the microphone is held and listening — the switch has just turned white (`ready-cue.ts`) |
| two notes up | hands-free has begun taking your words down |
| two notes down | they have been taken down and sent |
| three soft steps down | the conversation window closed; "Control" is needed again |
| an octave down, held low | "Let me turn this off" (or "Control, shutdown"): Control is away until you say "Control" again |

The microphone button leaves Control where it is — it does not bring Control
to this phone; the transcript's holder badge says where it is. When nobody
holds Control, its words are still taken but no reply is coming, and a
short odd tune says so — a tritone leap up, a stutter, a drop, a pause, then
a leap to a long high note — played the same way as hands-free's tones (`playHeardUnattachedCue`).

## Hands-free: "Control, …"

The hands-free button right of the microphone (`HandsFreeButton.tsx`, an ear
with a voice arriving at it), always on the bar, is the always-listen switch: a tap turns it on, and another off. While it
holds the microphone, start talking with
**"Control"** — "Control, what's Kevin doing?" — and just keep going. The
phone taps once (a haptic) and the button turns orange; nothing waits on that, since
the dictation is fed everything from your first syllable out of the
listener's buffer. When you are done, just stop: once a pause reaches 0.8 s
the Mac's turn model (Smart Turn, `src/server/turn-detector.ts`) judges from
your words and intonation whether you sound finished, and goes on judging
every half second (`TURN_SAMPLE_MS`) for as long as the pause lasts; the
first time it is at least 85% sure, the dictation ends there. An answer that
comes back after you have started talking again is dropped. If it is not, a pause still ends it once it
outlasts a patience that grows with how long you have been talking — three
seconds for a quick request, up to twenty seconds five minutes into a
monologue. A long enough pause after "Control" alone waits at least five
seconds instead, and Smart Turn is not asked about it; ten minutes in all
ends it regardless.

While a dictation runs, the hands-free button shows both, a half each,
filling from the bottom: **left, green**, Smart Turn's latest answer, 0 at
the bottom to 1 at the top, snapping to each answer with no smoothing and
empty while you talk, with a **red line** across it at the threshold while
Smart Turn is being asked — green reaching the line ends it; **right,
magenta**, the quiet since you last spoke, ending it at the top. Both hold while what you said is sent, so you
can see which one ended it. Two taps mean it was heard and sent: "Control" comes off the
front, and the rest goes to Control, which comes to this phone. The dictation itself is ordinary Wispr, as a tap's.

- **Only "Control" said first counts**, with nobody talking just before it;
  the word anywhere else in a sentence never triggers. "Talking" is judged by
  a voice-activity model on the phone (Silero VAD, `speech-detector.ts`,
  1.3 MB, run in ONNX Runtime web at about 0.3 ms per 32 ms frame), so music,
  a fan or a noisy room never count as talk and never block it; without the
  model, loudness stands in.
- **The conversation window.** "Control" opens it, as does turning hands-free
  on (not the microphone reopening itself after a stall), and the microphone gets a
  blue ring: from then on anything you say starts a dictation without
  "Control" — your first word kept — including cutting Control off mid-reply
  (when it speaks through echo cancellation). The Mac checks only that it was
  words: not a cough, not filler (`ignoredWords`, server-side, defaults
  "hmm", "uh", "um" and the like). It stays open while either of you is
  speaking, however long, and closes with a tone (three soft steps down)
  once neither has spoken for `conversationMs` (15 s) — Control thinking does
  not hold it open. Inside it, speech counts however soon it follows other
  speech — a rejected cough, or Control's voice leaking past echo
  cancellation, does not make the words after it "mid-sentence" — and the
  app reopening a stalled microphone does not close it (it waits
  `conversationMs` for the microphone; turning the hold off closes it at
  once). The blue ring drains as the quiet runs out, the icon
  staying put. The window needs a server that knows it: an older one
  answers the wake-word question instead, which the phone notices
  (`hands-free-server-too-old`), closing the window with its tone and logging
  that the server needs restarting; "Control" works as before meanwhile. Speech checks of two words or fewer are logged
  (`[hands-free] speech check heard …`), to find what the model hears in
  nothing at all.
- **The pending tone: do I need "Control"?** Outside the conversation
  window, from the first syllable of what may be speech — a cough, as
  likely — until it is decided, a soft medium-high beep (G5) repeats four
  times a second. It stops just before the `dictationStart` chirp — the
  words being taken down, from their first syllable — or as soon as they
  turn out to be nothing. When the Mac says they did not start with
  "Control" (or, for speech watched as perhaps "let me turn this off", that
  it was not that either), they are thrown away, and a short sad tune says
  so (`notWakeWord`: G5 sliding down a semitone at a time, then dropping to
  a long D5): stop, say "Control", and start again. A cough too short to
  check just stops the beep. In the window, where any words will do,
  neither plays; nor for speech straight after other speech, never checked.
  Only the app plays the beep (`pending-tone`, `NativeMicrophone.swift`), on
  Control's voice player, and only where that never reaches the microphone
  — echo cancellation, or AirPods — so it is not in what is dictated, and
  hands-free goes on hearing through it. Its one player being Control's
  voice's, it does not play while Control speaks, and Control's voice
  arriving stops it. An app too old to say `pendingTone` plays none
  (`playPendingTone`, cues.ts; `hands-free-pending-tone` in the record).
- **"Let me turn this off"** sends Control away at once, for when someone
  in the room needs you — and to them it sounds like you dealing with your
  phone. It needs no "Control" first: speech whose first second the Mac hears
  as "let me…" is watched until it ends (half a second's quiet, four seconds
  at most), and the whole of it is checked, as the window's speech is; only
  the phrase and nothing else counts. "Control, let me turn this off", the
  phrase in the window, a whole message of it sent to Control, and the older
  "Control, shutdown" (or "shutdown" alone in the window) all do the same.
  Nothing is
  shut down: it is the transcript's **Away**, so Control stops speaking, and
  what it has to tell you waits for your return. The window closes there and
  then with a tone of its own (an octave down, held low), so nothing more is
  taken down for Control; the hold stays on, and the next "Control" —
  even on its own, with nothing after it — brings Control back, aloud
  unless you had it on Silent, to tell you anything you missed. (Alone, it
  takes Control only when no device holds it, so a misheard wake word never
  takes it from another.) It is a fixed phrase, matched on the whole
  of what was said by the phone and the server (`src/shared/control-shutdown.ts`) —
  never inside a longer request — and the model is only told it happened.
  Asking in other words ("Control, be quiet") still goes to the model, whose
  `go_quiet` sends it away the same way, but leaves the window to run out.
- **"Control." on its own, then a breath** is fine: that first pause is not
  put to the turn model (which would call "Control." finished), and it waits
  five seconds (`afterWakeWordMs`) for the rest.
- **In the app** the microphone is the app's own (`NativeMicrophone.swift`,
  `native-microphone.ts`), so no AirPods are needed: it plays through the
  speaker, keeps listening with the screen locked, and comes back by itself
  after Siri, a call, a relaunch, or AirPods coming and going. In a browser
  the page holds it, and only with a headset (`held-microphone.ts`).
- **Nothing leaves the phone** until you start talking with nobody talking
  just before (`wake-listener.ts`). Only the first second of that goes to the Mac, where
  Voice Operator writes it down with Apple's on-device model
  (`POST /v1/wake-word?match=speech`) — never Wispr — and the server judges
  whether it starts with "control" or "let me…" (`src/server/hands-free.ts`;
  Voice Operator's own `match=start` gives no words back for a miss, so it
  could never see the phrase), passing on no words that were neither; and when
  that second was heard as "let me…", the rest of that one burst of speech,
  to the same model, to tell whether it was "let me turn this off". Audio is
  otherwise only ever in an eight-second buffer in memory.
- **Interrupting Control.** In the app, Control's voice is played by the app
  itself (`NativeMicrophone.swift`), through the microphone's own engine with
  Apple's voice processing — the echo cancellation a speakerphone call uses —
  so hands-free listens straight through it. Anyone speaking turns Control
  down at once (the cancelled microphone hears the room, not Control), and it
  comes back up if it was not "Control". "Control, …" cuts it off and is
  dictated as ever; if nothing is caught after "Control", Control says it had
  not finished and carries on. In a browser, with an app too old to play
  speech, or when the app has had to run without echo cancellation (it gives
  it up for the rest of its run if turning it on keeps reconfiguring the
  audio: `voice-processing-abandoned`), the page plays it and hands-free stops
  listening while it does.
- It does not listen while the page plays anything — a cue, or speech in a
  browser — or for a moment after, so it never hears itself; nor during a
  dictation it did not start.
- **The turn model** is fetched once (8 MB, pinned and hash-checked) into
  `~/.spaceterm/models`, loaded when the first hands-free dictation starts, and
  kept: about 130 MB of the server's memory, about 45 ms a check. Without it,
  pauses end dictations on silence alone.
- **Thresholds** are in `~/.spaceterm/hands-free.json` on the Mac, read again
  whenever it changes — any of `noSpeechBeforeMs` (700), `onsetWindowMs`
  (1000), `wordMinMs` (250), `pauseCheckMs` (800), `turnThreshold` (0.85, a
  probability), `wakeWordOnlyMs` (1500), `afterWakeWordMs` (5000),
  `endSilenceMinMs` (3000), `endSilenceMaxMs` (20000), `endSilenceRampMs`
  (300000), `maxUtteranceMs` (600000), `playbackTailMs` (400),
  `conversationMs` (15000), and `ignoredWords` (a list of words or phrases).
- **Why it did or did not trigger** is in `~/.spaceterm/mobile-events.jsonl`:
  a `hands-free-speech` event for every burst of speech the listener noticed —
  how long, how long without speech before it, how loud, and its verdict
  (`checked`, `after-speech`, `too-short`) — then `wake-word` with the Mac's
  answer; `hands-free-levels` every 30 s with the room's level and how much of
  it was speech; `hands-free-detector` with which speech detector is in use;
  `hands-free-pause` for the pause after the wake word alone; and
  `hands-free-echo` after each reply Control spoke through the app — how much
  of the microphone the speech detector still heard as speech while it
  played (`speechPercent`, `longestSpeechMs`), the microphone's level, the
  voice's own level (`outputDb`), and whether echo cancellation was on — which
  says whether interrupting can work. Never what was said. The server log's `[turn]` lines give each pause's verdict.

## Notifications

The rocket (`RocketButton.tsx`) carries the phone's notifications, which are
the updates above (`update-notices.ts`): with any waiting it has a count, and
a ring pulsing out while any is unread, which ends once the toolbar sheet has
shown it. Unread is per phone, and survives a reload but nothing longer.

## The audio and lifecycle record

Every microphone, dictation, playback and app-switching event the phone sees
is appended, one JSON object per line, to `~/.spaceterm/mobile-events.jsonl`
on the Mac — forever, outside git — for tracing a microphone that did not come
back, or an answer that talked over a dictation. `mobile-events.ts` keeps
events in the page's storage until the server acknowledges them, so a dropped
socket, a suspended page or one iOS killed loses nothing; the server
(`src/server/mobile-events.ts`) skips a resent batch's duplicates.

Each line has `kind`, `t` (the phone's clock), `detail`, and `ctx` — the
hold, hands-free phase, dictation, audio session and whether anything was
playing at that moment. `src: "native"` lines come from the iPhone app
(`NativeEvents.swift`), which keeps running in the background while iOS
suspends the page: launches (and whether the last run ended in the
background — killed — or terminated), background and foreground, screen lock,
calls, audio interruptions, route changes with the inputs and outputs before
and after (AirPods coming and going), the input muted from the AirPods stem,
another app wanting quiet, WebKit taking the microphone, Low Power Mode and
heat, page loads, and a `native-heartbeat` every minute with the audio
session, the microphone's seconds heard and peak level, how long an
interruption has gone unended, and whether the page answers a ping.
`src: "server"` lines are what the server saw: the phone connecting and
disconnecting, and speech jobs sent to it and how each ended.

For a stalled connection — speech and the wake word's answer arriving
seconds late — each side says its part. The server records every sentence of
speech as it leaves (`speech-audio-sent`: size, how long it took to make, and
how much was already queued to the phone), and `electron.log` has the web
gateway's `[web-gateway] output backing up` / `backed up for` and `slow
pong`. The page records each sentence's arrival (`speech-audio-received`,
with `lateMs` against the server's clock), the socket opening and closing
(`socket`), nothing from the Mac for 8 s (`downlink-quiet`) and the gap when
it is heard from again (`downlink-gap`, with what arrived), and on being
shown again how long since the Mac was last heard from
(`downlink-on-visible`; `downlink-watch.ts`). The app records the network
path changing (`network-path`: the interfaces, the VPN's among them, and
whether the path is satisfied).

    jq -c 'select(.kind | test("speech-audio|socket|downlink|network-path|app-foreground|app-active|visibility|screen-"))' ~/.spaceterm/mobile-events.jsonl

Nothing is fired into the void. The app numbers its events (`nativeSeq`) and
keeps them in a file until the server has written them: the page records
them, the server acknowledges the batch, and only then does the page tell the
app it may forget them. Every new page is handed all the app still holds; the
page skips what it already has, and the server skips any `nativeSeq` it has
written, across restarts too.

A page has no event for being put to sleep; a `woke` line with `asleepMs`
says it was, and `heartbeat` lines say it was still running while hidden.
Nothing said is recorded here — only lengths.

For a microphone that did not come back: `audio-interruption-began` says
whether the page's own microphone was open (`pageMicrophone`), and app
events say how long an interruption has gone unended. iOS rarely ends one —
the page's own sound starting is the commonest, and is never ended — so the
app starts its engine again itself (`native-engine-recovering`: after an
interruption, on coming back, or found stopped), never while the page's
microphone is open (`native-restart-deferred`), as that took the microphone
from it. `mic-permission-changed` is the permission changing in Settings.
`web-mic-silent` is WebKit's microphone handing back a live track that sends
nothing, seen after the app has been away and lasting until it is
relaunched; the dictation carries on with the app's own microphone, and so
does every later one on that page.

In the app, once hands-free is on, the page opens the app's microphone once
and never closes or reopens it until hands-free is turned off
(`installNativeHold`). The app keeps it going: in place after iOS stops its
engine or it stalls (`native-mic-stalled`, `inPlace`; a new engine only if a
second stall follows within 15 s), and on a new engine when AirPods come or
go, or when it would not start. The page records a stall (`hold-stalled`,
`hold-recovered`) but does not act on it: it used to close and reopen the
microphone after three quiet seconds, and each time the AirPods dropped out
of their microphone link, and with the screen locked iOS refused to record
again.

A stall is either no audio from the engine or only exact zeros from the
input (`native-mic-stalled` says which). The app restarts for it in place,
then on a new engine, then less and less often (`native-mic-stall-restart`),
never every two seconds — that flipped the route between the earpiece and
the AirPods, the badge with it. There is no switch to the iPhone's own microphone, and no giving the
Bluetooth link up to take it again: tried October 13, that left the AirPods
without their music link to the phone until they were put back in the case.

Voice processing (echo cancellation) is for hands-free only, and is left off
over a Bluetooth route faster than 24 kHz (`voiceProcessingRate`, asked for
as the preferred rate): there every voice-processed start heard only exact
zeros, while 24 kHz ones heard, and 48 kHz ones without it did too. Each
time, the restarts that followed went on to leave the AirPods' link to the
phone broken. `native-mic-running` has the rate and whether it was on;
`native-mic-stalled` has the rate and every input iOS offers. The page is told
(`native-silent-input`), and the hold shows it waiting. A dictation goes
orange on the first sample that is not exactly zero: a live microphone in a
quiet room sends noise at once (95 heartbeats with the microphone running,
none with a peak of exact zero), so this is the microphone being live, not
the user speaking. A dead one sends zeros, and after two seconds the
dictation fails saying so.

    jq -c 'select((.kind | test("no-audio|web-mic-silent|recovering|deferred|hold-stalled|hold-recovered|native-mic-stall|silent-input|relink-bluetooth")) or .detail.why? == "it stopped delivering")' ~/.spaceterm/mobile-events.jsonl

Every cue is a `cue` line with its gain, its peak in dBFS counting any cue
it overlaps (`overlapping`), and whether it had to wait for a stopped audio
context (`waiting`). A cue that waited is played when the context runs again
only if it is fresh; otherwise, or when a newer cue replaces it, a
`cue-dropped` line says so (`cues.ts`, `CueTracker`) — iOS used to save them
all up and play them together, loudly. Each Smart Turn verdict on the phone
is a `hands-free-turn` line (p, threshold, which sample of its pause, whether it ended the dictation).

**Seeing the turn model.** The left half of the hands-free button is
Smart Turn's latest answer at a pause (`samplePause` in `hands-free.ts`), the
right half the quiet against the patience (`UtteranceEndpointer.silence`);
see "Hands-free" above. Those answers are the `hands-free-turn` lines above.

    jq -c 'select(.kind | test("interruption|route|hold|native-mic"))' ~/.spaceterm/mobile-events.jsonl
    jq -c 'select(.kind | test("^cue"))' ~/.spaceterm/mobile-events.jsonl

**What was said, kept on purpose.** The Mac keeps the other half in
`~/.spaceterm/voice-decisions.jsonl` (`src/server/voice-record.ts`): each
wake-word and speech check with what Apple's model `heard` and whether it
counted, each Smart Turn verdict with its probability and the pause it heard
after the last word (`trailingQuietMs`), and each phone dictation's
transcript — every line timed, with its audio in `~/.spaceterm/voice-clips/`
(16 kHz WAV, the newest 400 kept). So a "Control" heard as "patrol", or a
finished sentence Smart Turn called unfinished, can be found and listened to.

    jq -c 'select(.kind == "wake-word-check" and .match == false)' ~/.spaceterm/voice-decisions.jsonl

While a dictation is sending your voice to be transcribed, an orange **MIC**
sits above the Dynamic Island (`MicIndicator.tsx`); it pulses while the words
are waited for. While the microphone is merely held open for hands-free, the
same place shows “let me turn this off” in cyan, a reminder of the phrase
that sends Control away; MIC replaces it whenever it shows. It uses only the strip above the island — iOS widens the island for Now
Playing and the like, and a page cannot see that — so the island's top (an
iPhone 17's) is the one measurement, in `mobile.css`.


### AirPods incidents

The AirPods' bad spells, and the iPhone restarts that ended them, are kept
apart as well, in `~/.spaceterm/airpods-incidents.jsonl` — the same lines,
written by the server (`isAirPodsIncident`, `src/server/mobile-events.ts`):

- `airpods-bad-state` — a Bluetooth microphone that came up faster than
  24 kHz without high quality on, or sent only digital silence. With what
  came before: the rate, the previous start's rate, the inputs iOS offered,
  seconds since the app launched and since the AirPods connected, whether
  the session was given up first, high quality supported / enabled before
  and after asking.
- `airpods-recovered` — sound from it again, and how.
- `iphone-restarted` — the app's first launch after a restart, from the
  boot time (`NativeEvents.swift`), with any incident still open then: the
  scenario where only a restart brought the AirPods back.
- `app-launch` with an incident still open — the app killed or relaunched
  mid-incident.

Every microphone start, good or bad, is a `native-mic-start` in the main
record with the same context, so a good one can be set beside a bad one.

## Running it

```
npm run mobile:build      # → out/mobile, served by the server on 127.0.0.1:7391
                          #   (the server also rebuilds it in the background on
                          #   startup whenever a source is newer than the build)
npm run mobile:link       # prints the pairing URL (and the tailscale serve step)
```

The gateway binds loopback only and requires the token from
`~/.spaceterm/web-token` on its socket. `tailscale serve --bg 7391` exposes it
to your tailnet with HTTPS, which Safari needs before it will open the
microphone. `SPACETERM_WEB_PORT=0` turns the gateway off.

## The iPhone app (`ios/`)

A native wrapper: one full-screen `WKWebView` on the gateway's tailnet URL,
which exists for what a browser tab cannot do — no browser chrome, a
microphone permission that sticks, and no form bar (AutoFill icons, ⌃ ⌄ Done)
above the keyboard (`FormAccessoryBar.swift`). It also reloads the page if iOS
kills its process. Everything else is the web app, so most changes need no
rebuild of this.

```
npm run mobile:ios        # build, sign, install on the paired iPhone, launch
```

A phone that moves between tailnets — home and work, say — needs every Mac's
address, and the app tries them all at launch and keeps whichever answers
first. `ios/macs.local` names each Mac by tailnet host name, one per line. It
is not committed, since host names identify you and your machines, so each Mac
you build on needs its own copy (the committed `ios/macs` is an empty
placeholder, read only when there is no local list).
`~/.spaceterm/other-macs` (private, since it carries tokens) holds the other
Macs' pairing URLs, one `npm run mobile:link -- --url` line each. The build
refuses, saying what to fill in, when this Mac is not in the list or a listed
Mac has no line in `other-macs` (`src/cli/mobile-macs.ts`).

Signing is per person, so it is not committed either: `ios/Local.xcconfig`
holds `DEVELOPMENT_TEAM` and `PRODUCT_BUNDLE_IDENTIFIER`, and `install.sh`
passes it to `xcodebuild -xcconfig`. Without it the build stops before doing
anything and prints the file to write, with the team ids Xcode is signed in to
on this Mac (Xcode → Settings → Accounts). A free Apple ID works; its builds
expire after seven days.

Once only: accept Apple's latest Program License Agreement at
developer.apple.com (signing fails until you do); pair the phone in Xcode →
Devices and Simulators by cable and tick "Connect via network"; on the phone,
turn on Developer Mode. After that it installs over Wi-Fi. It builds against
the SDK rather than a device destination, so the multi-gigabyte iOS platform
download is not needed.

## Deliberately not done (yet)

- Text size is a hard-coded constant (`SCALE` in TerminalView.tsx, 0.94 —
  about 50 columns on a 393-pt phone); there is no control for it yet.
- No push notifications: an app swiped away hears nothing from Control until it is opened.
- A reconnect reloads the page (as the desktop does); drafts and the open
  surface survive it.
