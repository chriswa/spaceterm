import AVFoundation
import UIKit
import WebKit

/// The microphone, held by the app rather than the page — what hands-free mode
/// listens to (src/mobile/native-microphone.ts, hands-free.ts).
///
/// The page cannot do this itself: WebKit holds a microphone only in
/// play-and-record, whose default route is the earpiece, so Control's answers
/// would come out as a whisper; and it opens one only inside a tap. Here the
/// session is play-and-record *defaulting to the speaker*, and *mixing* with
/// the page's own audio — without `mixWithOthers` the page's sound interrupted
/// the recording for good (spike/native-audio-test, October 2026). The
/// background audio mode keeps it recording with the screen locked.
///
/// While it runs, nothing on the page may open its own microphone: iOS lets
/// one recorder win, and this one never got the microphone back.
///
/// Audio goes to the page as 16 kHz signed 16-bit mono, base64, a tenth of a
/// second at a time. Nothing is kept here.
///
/// It also plays Control's voice, while it runs (`speech-play`), through the
/// same engine with Apple's voice processing on — the echo cancellation a
/// speakerphone call uses. Echo cancellation can only take out what it knows
/// is being played, and audio the page plays goes through WebKit's own
/// process, out of its sight; played here, Control's voice is subtracted from
/// what the microphone hears, so hands-free can listen through it and the
/// user can interrupt with "Control". Each sentence's start and end go back
/// to the page, which tells the server how far the listener got.
///
/// And it keeps the app awake while this phone holds Control (`stay-awake`).
/// iOS suspends an app in the background unless its audio is running, and
/// with the app goes the page and its connection to the server, so Control
/// fell silent the moment the phone was locked or put away. Without the
/// microphone the engine runs to play alone (`Mode.speaker`): silence, and
/// Control's voice when it has something to say.
@MainActor
final class NativeMicrophone: NSObject, WKScriptMessageHandler {
    weak var webView: WKWebView?
    /// The audio and lifecycle record, which outlives a suspended page.
    private let events: NativeEvents

    /// A new engine for every bring-up: one kept across an AirPods route change
    /// kept its old format and delivered nothing.
    private var engine = AVAudioEngine()
    private let capture = Converter()
    /// The page wants the microphone: hands-free.
    private var wanted = false
    /// The page wants the app kept running in the background: this phone holds Control.
    private var stayAwake = false
    /// What the engine is up for: listening (and playing), only playing, or nothing.
    private enum Mode: String { case off, speaker, microphone }
    /// What the engine should be up for. The microphone, when wanted, plays Control's voice too.
    private var mode: Mode { wanted ? .microphone : stayAwake ? .speaker : .off }
    /// What the engine is up for now.
    private var up = Mode.off
    /// The microphone is running — what the page means by `running`.
    private var running: Bool { up == .microphone }
    private var timer: Timer?
    private var pendingRestart: DispatchWorkItem?
    private var lastBringUp = Date.distantPast
    private var lastError: String?
    private var observers: [NSObjectProtocol] = []
    /// `evaluateJavaScript` calls not yet answered. A suspended page answers
    /// none; past a bound, audio is dropped rather than piled up behind it.
    private var unanswered = 0
    private var dropping = false
    private var tick = 0
    /// Control's voice, playing through the engine: see `SpeechQueue`.
    private var player: AVAudioPlayerNode?
    private var speech = SpeechQueue()
    /// Bumped whenever scheduled buffers are thrown away, so their late completions are ignored.
    private var speechGeneration = 0
    /// Whether this bring-up got voice processing (echo cancellation); false where it would not turn on.
    private var voiceProcessing = false
    /**
     * Whether to ask for voice processing at all. Turning it on reconfigures
     * the audio hardware, and iOS announces that as a configuration change;
     * answered with a new engine, that is a loop (October 2026: a restart
     * every 1.5 s, and no audio ever reached the page). Changes are answered
     * in place now; if they loop anyway, this goes false for the rest of the
     * app's run, and the microphone carries on without echo cancellation.
     */
    private var voiceProcessingAllowed = true
    /// Recent configuration changes, for telling a loop from a one-off.
    private var configChanges: [Date] = []
    private static let configLoopWindow: TimeInterval = 10
    private static let configLoopLimit = 3
    /// When the engine last started, and which start that was, for the audio check after it.
    private var lastStart = Date.distantPast
    private var startNumber = 0

    private static let sendInterval: TimeInterval = 0.1
    private static let maxUnanswered = 50
    /// No taps, or nothing but digital silence, for this long: start again.
    private static let stallSeconds: Double = 2
    private static let minSecondsBetweenRebuilds: TimeInterval = 3

    init(events: NativeEvents) {
        self.events = events
        super.init()
        observe()
        events.microphoneStatus = { [weak self] in self?.status() ?? [:] }
    }

    // MARK: - From the page

    nonisolated func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        let action = (message.body as? [String: Any])?["action"] as? String
        MainActor.assumeIsolated {
            switch action {
            case "start": start()
            case "stop": stop()
            case "stay-awake": setStayAwake((message.body as? [String: Any])?["on"] as? Bool ?? false)
            // Hands-free heard "Control": a tap the user feels, since a tone would land mid-sentence.
            case "haptic": UIImpactFeedbackGenerator(style: .heavy).impactOccurred()
            case "speech-play": playSpeech(message.body as? [String: Any] ?? [:])
            case "speech-stop": stopSpeech(id: (message.body as? [String: Any])?["id"] as? String ?? "")
            // Someone started talking over Control: quieter until it is known whether they said "Control".
            case "speech-duck": duckSpeech((message.body as? [String: Any])?["on"] as? Bool ?? false)
            default: log("unknown action \(action ?? "nil")")
            }
        }
    }

    private func start() {
        wanted = true
        // A new attempt: the page waits for running or an error, and an old error would answer it.
        lastError = nil
        if running {
            // A reloaded page asking again: it needs to hear the state.
            sendState()
            return
        }
        AVAudioApplication.requestRecordPermission { granted in
            Task { @MainActor in
                guard self.wanted else { return }
                if granted { self.bringUp(why: "asked by the page") } else { self.fail("microphone permission refused") }
            }
        }
    }

    private func stop() {
        wanted = false
        let was = up
        events.record("native-mic-stopped")
        if was == .microphone { log("stopped") }
        // Still holding Control: on without the microphone, so the app stays awake.
        if mode == .speaker {
            if was != .speaker { bringUp(why: "the microphone was turned off") }
        } else {
            tearDown(why: "the microphone was turned off")
        }
    }

    private func setStayAwake(_ on: Bool) {
        guard on != stayAwake else { return }
        stayAwake = on
        events.record("native-stay-awake", ["on": on, "mode": mode.rawValue])
        log(on ? "this phone holds Control: staying awake in the background" : "this phone no longer holds Control")
        // The microphone keeps the app awake already; only a bare engine comes and goes.
        if wanted { return }
        if on { bringUp(why: "this phone holds Control") } else { tearDown(why: "this phone no longer holds Control") }
    }

    /// Everything off, the audio session given back.
    private func tearDown(why: String) {
        pendingRestart?.cancel()
        pendingRestart = nil
        timer?.invalidate()
        timer = nil
        engine.stop()
        if up == .microphone { engine.inputNode.removeTap(onBus: 0) }
        // No engine, no voice: whatever was still to be said will not be.
        failSpeech(why: why)
        player = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        up = .off
        sendState()
    }

    // MARK: - Engine

    private func bringUp(why: String) {
        let mode = self.mode
        guard mode != .off else { return }
        lastBringUp = Date()
        do {
            engine.stop()
            // The input node is made on first use: touched on an engine that never recorded, it would make one.
            if up == .microphone { engine.inputNode.removeTap(onBus: 0) }
            up = .off
            let session = AVAudioSession.sharedInstance()
            if mode == .speaker {
                // Playback alone, which records nothing and so shows no microphone in use.
                try session.setCategory(.playback, mode: .default, options: [.mixWithOthers])
                try session.setActive(true)
                engine = AVAudioEngine()
                voiceProcessing = false
                attachPlayer()
                engine.prepare()
                try engine.start()
                up = .speaker
                lastError = nil
                log("awake, playing to \(outputName()) (\(why))")
                events.record("native-awake-running", ["why": why, "route": NativeEvents.describeRoute(session.currentRoute)])
                rescheduleSpeech()
                sendState()
                startTimer()
                return
            }
            try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetooth, .mixWithOthers])
            // iOS silences haptics while recording unless told otherwise; hands-free's cue is one.
            try? session.setAllowHapticsAndSystemSoundsDuringRecording(true)
            try session.setActive(true)
            engine = AVAudioEngine()
            let input = engine.inputNode
            // Echo cancellation, against what `player` plays. Set before anything is connected.
            voiceProcessing = false
            if voiceProcessingAllowed {
                do {
                    try input.setVoiceProcessingEnabled(true)
                    voiceProcessing = true
                    // Its default turns every other app's audio — and the page's cues — right down.
                    if #available(iOS 17.0, *) {
                        input.voiceProcessingOtherAudioDuckingConfiguration = .init(enableAdvancedDucking: false, duckingLevel: .min)
                    }
                } catch {
                    events.record("voice-processing-failed", ["error": error.localizedDescription])
                }
            }
            attachPlayer()
            let format = input.outputFormat(forBus: 0)
            guard format.sampleRate > 0 else { throw Failure("the input has no format (sample rate 0)") }
            capture.reset(converter: AVAudioConverter(from: format, to: Converter.outFormat))
            let sink = capture
            input.installTap(onBus: 0, bufferSize: 2048, format: format) { buffer, _ in sink.handle(buffer) }
            engine.prepare()
            try engine.start()
            up = .microphone
            lastError = nil
            expectAudio(why)
            log("running on \(inputName()) at \(Int(format.sampleRate)) Hz, echo cancellation \(voiceProcessing ? "on" : "OFF") (\(why))")
            events.record("native-mic-running", ["why": why, "sampleRate": format.sampleRate, "voiceProcessing": voiceProcessing, "route": NativeEvents.describeRoute(session.currentRoute)])
            // A new engine: anything still to be said starts again on it, from the sentence it was in.
            rescheduleSpeech()
            sendState()
            startTimer()
        } catch {
            up = .off
            failSpeech(why: "the audio engine would not start")
            let nsError = error as NSError
            events.record("native-mic-failed", ["mode": mode.rawValue, "why": why, "error": error.localizedDescription, "domain": nsError.domain, "code": nsError.code, "appState": UIApplication.shared.applicationState == .background ? "background" : "foreground"])
            fail("could not start (\(why)): \(error.localizedDescription)")
            // The page retries the microphone itself; nothing asks again for the bare engine.
            if mode == .speaker { scheduleRestart("staying awake would not start", after: 5) }
        }
    }

    /// The player Control's voice goes through, on a new engine.
    private func attachPlayer() {
        let player = AVAudioPlayerNode()
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: SpeechQueue.format)
        self.player = player
        player.volume = ducked ? Self.duckedVolume : 1
    }

    /**
     * The same engine, started again after a configuration change stopped it:
     * the tap put back at whatever the input's format is now, the player and
     * whatever it was saying kept. Unlike a new engine, it does not set up
     * voice processing again — which is what announced the next change. A new
     * engine is still the answer when this will not start, and for a headset
     * coming or going (`bringUp`), which needed one.
     */
    private func restartInPlace(why: String) {
        guard mode != .off else { return }
        // Up for something else since — or not up at all: a new engine, for what is wanted now.
        guard up == mode else {
            bringUp(why: why)
            return
        }
        var sampleRate: Double = 0
        if up == .microphone {
            let input = engine.inputNode
            input.removeTap(onBus: 0)
            let format = input.outputFormat(forBus: 0)
            guard format.sampleRate > 0 else {
                events.record("native-mic-restart-in-place-failed", ["why": why, "error": "the input has no format"])
                bringUp(why: "\(why), and the input had no format")
                return
            }
            sampleRate = format.sampleRate
            capture.reset(converter: AVAudioConverter(from: format, to: Converter.outFormat))
            let sink = capture
            input.installTap(onBus: 0, bufferSize: 2048, format: format) { buffer, _ in sink.handle(buffer) }
        }
        do {
            try AVAudioSession.sharedInstance().setActive(true)
            engine.prepare()
            try engine.start()
            if up == .microphone { expectAudio(why) }
            events.record("native-mic-restarted-in-place", ["mode": up.rawValue, "why": why, "sampleRate": sampleRate, "voiceProcessing": voiceProcessing])
            rescheduleSpeech()
            sendState()
        } catch {
            events.record("native-mic-restart-in-place-failed", ["why": why, "error": error.localizedDescription])
            bringUp(why: "\(why), and it would not start in place")
        }
    }

    /// A second after each start: did audio arrive? A start that delivers nothing is otherwise silent until the page gives up on it.
    private func expectAudio(_ why: String) {
        startNumber += 1
        lastStart = Date()
        let start = startNumber
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
            MainActor.assumeIsolated {
                guard let self, start == self.startNumber, self.running else { return }
                let firstAudioMs = self.capture.firstAudioMs()
                self.events.record("native-mic-audio", [
                    "arrived": firstAudioMs != nil, "firstAudioMs": firstAudioMs ?? -1,
                    "engineRunning": self.engine.isRunning, "voiceProcessing": self.voiceProcessing, "why": why,
                ])
                if firstAudioMs == nil { self.log("no audio a second after starting (\(why))") }
            }
        }
    }

    /**
     * iOS changed the audio configuration, which stops the engine. Once:
     * start it again in place. Over and over with echo cancellation on: give
     * up on echo cancellation (see `voiceProcessingAllowed`).
     */
    private func configurationChanged() {
        let now = Date()
        configChanges = configChanges.filter { now.timeIntervalSince($0) < Self.configLoopWindow } + [now]
        events.record("audio-engine-config-change", [
            "engineRunning": engine.isRunning, "sinceStartMs": Int(now.timeIntervalSince(lastStart) * 1000),
            "voiceProcessing": voiceProcessing, "recentChanges": configChanges.count,
        ])
        if voiceProcessing, configChanges.count > Self.configLoopLimit {
            voiceProcessingAllowed = false
            configChanges = []
            events.record("voice-processing-abandoned", ["why": "configuration changes looped", "within": Self.configLoopWindow])
            log("the audio configuration keeps changing with echo cancellation on — carrying on without it until the app restarts")
            scheduleRestart("echo cancellation abandoned", after: 0.3)
            return
        }
        scheduleRestart("the audio configuration changed", after: 0.3, inPlace: true)
    }

    /// Route changes come in bursts — AirPods flap between themselves and the
    /// speaker for a second or two — so start again once, after it settles.
    /// `inPlace`: the same engine (`restartInPlace`), rather than a new one.
    private func scheduleRestart(_ why: String, after delay: TimeInterval = 0.8, inPlace: Bool = false) {
        guard mode != .off else { return }
        pendingRestart?.cancel()
        let work = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated {
                self?.pendingRestart = nil
                if inPlace { self?.restartInPlace(why: why) } else { self?.bringUp(why: why) }
            }
        }
        pendingRestart = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    private func startTimer() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: Self.sendInterval, repeats: true) { _ in
            MainActor.assumeIsolated { self.onTick() }
        }
    }

    private func onTick() {
        tick += 1
        // Every 2 s, in case the page reloaded and missed the last change.
        if tick % 20 == 0 { sendState() }
        guard running else { return }
        let (pcm, stalled) = capture.drain(stallSeconds: Self.stallSeconds)
        if stalled, pendingRestart == nil, Date().timeIntervalSince(lastBringUp) > Self.minSecondsBetweenRebuilds {
            log("no sound for \(Int(Self.stallSeconds)) s (nothing, or only digital silence) — starting again")
            events.record("native-mic-stalled", ["seconds": Self.stallSeconds])
            scheduleRestart("a stalled microphone", after: 0)
        }
        guard !pcm.isEmpty, let webView else { return }
        if unanswered >= Self.maxUnanswered {
            if !dropping {
                log("the page is not taking audio (suspended?) — dropping it until it does")
                events.record("native-mic-page-not-taking-audio")
            }
            dropping = true
            return
        }
        if dropping {
            dropping = false
            log("the page is taking audio again")
            events.record("native-mic-page-taking-audio")
        }
        let b64 = pcm.withUnsafeBufferPointer { Data(buffer: $0) }.base64EncodedString()
        unanswered += 1
        webView.evaluateJavaScript("window.spacetermNativeMicrophone && window.spacetermNativeMicrophone.audio('\(b64)'), 0") { _, _ in
            MainActor.assumeIsolated { self.unanswered = max(0, self.unanswered - 1) }
        }
    }

    // MARK: - To the page

    private func sendState() {
        // `speech`: this app plays Control's voice itself, while running — an older one does not.
        // `awake`: the engine is up without the microphone, and plays it all the same.
        var state: [String: Any] = ["running": running, "awake": up == .speaker, "speech": true, "voiceProcessing": voiceProcessing]
        if running { state["input"] = inputName() }
        if let lastError, !running { state["error"] = lastError }
        guard let json = try? JSONSerialization.data(withJSONObject: state), let text = String(data: json, encoding: .utf8) else { return }
        webView?.evaluateJavaScript("window.spacetermNativeMicrophone && window.spacetermNativeMicrophone.state(\(text)), 0", completionHandler: nil)
    }

    private func fail(_ message: String) {
        lastError = message
        log(message)
        sendState()
    }

    // MARK: - Control's voice

    /// One sentence from the page: s16le mono PCM at its own rate, base64.
    private func playSpeech(_ body: [String: Any]) {
        guard let id = body["id"] as? String, let index = body["index"] as? Int, let count = body["count"] as? Int,
              let rate = body["sampleRate"] as? Double, let pcm = (body["pcm"] as? String).flatMap({ Data(base64Encoded: $0) }) else {
            log("speech-play without id, index, count, sampleRate and pcm")
            return
        }
        guard up != .off, let player else {
            sendSpeech(id: id, index: index, event: "failed")
            return
        }
        guard let sentence = SpeechQueue.Sentence(id: id, index: index, count: count, pcm: pcm, sampleRate: rate) else {
            sendSpeech(id: id, index: index, event: "failed")
            return
        }
        let idle = speech.current == nil
        speech.append(sentence)
        schedule(sentence, on: player)
        if !player.isPlaying { player.play() }
        if idle { begin(sentence) }
    }

    /// Control's voice turned down while the user may be talking over it, and back up.
    private static let duckedVolume: Float = 0.25
    private var ducked = false

    private func duckSpeech(_ on: Bool) {
        guard on != ducked else { return }
        ducked = on
        player?.volume = on ? Self.duckedVolume : 1
        events.record("native-speech-duck", ["on": on])
    }

    /// The server cut this job off: drop its sentences, and carry on with any queued behind it.
    private func stopSpeech(id: String) {
        guard speech.contains(id: id) else { return }
        speech.remove(id: id)
        events.record("native-speech-stopped", ["id": String(id.prefix(11))])
        if speech.isEmpty { duckSpeech(false) }
        rescheduleSpeech()
    }

    private func schedule(_ sentence: SpeechQueue.Sentence, on player: AVAudioPlayerNode) {
        let generation = speechGeneration
        let key = sentence.key
        player.scheduleBuffer(sentence.buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            DispatchQueue.main.async {
                MainActor.assumeIsolated { self?.finished(key, generation: generation) }
            }
        }
    }

    /// A sentence has been heard to its end: say so, and the next has begun.
    private func finished(_ key: String, generation: Int) {
        guard generation == speechGeneration, let sentence = speech.current, sentence.key == key else { return }
        speech.removeCurrent()
        sendSpeech(id: sentence.id, index: sentence.index, event: "finished", outputDb: sentence.levelDb)
        if let next = speech.current { begin(next) } else { duckSpeech(false) }
    }

    private func begin(_ sentence: SpeechQueue.Sentence) {
        sendSpeech(id: sentence.id, index: sentence.index, event: "started", outputDb: sentence.levelDb)
    }

    /// Throw away what is scheduled and schedule what is left again — after a stop, or on a new engine.
    private func rescheduleSpeech() {
        speechGeneration += 1
        player?.stop()
        guard up != .off, let player, !speech.isEmpty else { return }
        for sentence in speech.sentences { schedule(sentence, on: player) }
        player.play()
        if let current = speech.current { begin(current) }
    }

    /// Nothing more can be played: every sentence still to come fails.
    private func failSpeech(why: String) {
        guard !speech.isEmpty else { return }
        speechGeneration += 1
        player?.stop()
        events.record("native-speech-failed", ["why": why, "sentences": speech.sentences.count])
        for sentence in speech.sentences { sendSpeech(id: sentence.id, index: sentence.index, event: "failed") }
        speech = SpeechQueue()
    }

    private func sendSpeech(id: String, index: Int, event: String, outputDb: Double? = nil) {
        var detail: [String: Any] = ["id": id, "index": index, "event": event]
        if let outputDb { detail["outputDb"] = outputDb }
        guard let json = try? JSONSerialization.data(withJSONObject: detail), let text = String(data: json, encoding: .utf8) else { return }
        webView?.evaluateJavaScript("window.spacetermNativeMicrophone && window.spacetermNativeMicrophone.speech && window.spacetermNativeMicrophone.speech(\(text)), 0", completionHandler: nil)
    }

    /// To the server's log through the page, as the page's own lines go.
    private func log(_ message: String) {
        NSLog("[native-mic] %@", message)
        guard let data = try? JSONSerialization.data(withJSONObject: ["[native-mic] \(message)"]),
              let array = String(data: data, encoding: .utf8) else { return }
        webView?.evaluateJavaScript("window.api && window.api.log(\(array)[0]), 0", completionHandler: nil)
    }

    /// For the heartbeat: whether it is meant to run and does, and what it has heard since the last.
    private func status() -> [String: Any] {
        let heard = capture.takeStats()
        return [
            "wanted": wanted, "running": running, "stayAwake": stayAwake, "mode": up.rawValue, "engineRunning": engine.isRunning,
            "secondsHeard": Double(heard.samples) / 16_000,
            "peakDbfs": heard.peak > 0 ? Int(20 * log10(heard.peak)) : -999,
            "pageTakingAudio": !dropping,
            "input": inputName(),
        ]
    }

    private func inputName() -> String {
        AVAudioSession.sharedInstance().currentRoute.inputs.first?.portName ?? "no input"
    }

    private func outputName() -> String {
        AVAudioSession.sharedInstance().currentRoute.outputs.first?.portName ?? "no output"
    }

    // MARK: - The system

    private func observe() {
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { note in
            let raw = (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt) ?? 0
            let options = (note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt) ?? 0
            let reason = (note.userInfo?[AVAudioSessionInterruptionReasonKey] as? UInt) ?? 0
            MainActor.assumeIsolated {
                let began = AVAudioSession.InterruptionType(rawValue: raw) == .began
                self.events.record(began ? "audio-interruption-began" : "audio-interruption-ended", [
                    "reason": Self.describe(AVAudioSession.InterruptionReason(rawValue: reason)),
                    "shouldResume": AVAudioSession.InterruptionOptions(rawValue: options).contains(.shouldResume),
                    "running": self.running, "wanted": self.wanted, "stayAwake": self.stayAwake,
                ])
                if began {
                    self.log("interrupted (a call, Siri, another app)")
                } else {
                    self.scheduleRestart("an interruption ended", after: 0.3)
                }
            }
        })
        observers.append(center.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { note in
            let reason = (note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt) ?? 0
            let previous = note.userInfo?[AVAudioSessionRouteChangePreviousRouteKey] as? AVAudioSessionRouteDescription
            MainActor.assumeIsolated {
                let why = AVAudioSession.RouteChangeReason(rawValue: reason)
                // AirPods coming and going, among other things.
                var detail: [String: Any] = [
                    "reason": NativeEvents.describe(why),
                    "route": NativeEvents.describeRoute(AVAudioSession.sharedInstance().currentRoute),
                    "running": self.running,
                ]
                if let previous { detail["previous"] = NativeEvents.describeRoute(previous) }
                self.events.record("audio-route-change", detail)
                if self.running, why == .newDeviceAvailable || why == .oldDeviceUnavailable {
                    self.scheduleRestart("a headset came or went")
                }
            }
        })
        observers.append(center.addObserver(forName: AVAudioSession.mediaServicesWereLostNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { self.events.record("audio-media-services-lost") }
        })
        observers.append(center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated {
                self.events.record("audio-media-services-reset")
                self.scheduleRestart("media services were reset")
            }
        })
        observers.append(center.addObserver(forName: .AVAudioEngineConfigurationChange, object: nil, queue: .main) { note in
            MainActor.assumeIsolated {
                guard (note.object as AnyObject?) === self.engine else { return }
                self.configurationChanged()
            }
        })
    }

    private static func describe(_ reason: AVAudioSession.InterruptionReason?) -> String {
        switch reason {
        case .default: "default"
        case .builtInMicMuted: "built-in mic muted"
        case .routeDisconnected: "route disconnected"
        default: "raw \(reason?.rawValue ?? 0)"
        }
    }

    private struct Failure: LocalizedError {
        let errorDescription: String?
        init(_ message: String) { errorDescription = message }
    }
}

/// The audio thread's side: each tap converted to 16 kHz s16, kept until drained.
private final class Converter: @unchecked Sendable {
    static let outFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true)!

    private let lock = NSLock()
    private var converter: AVAudioConverter?
    private var pcm: [Int16] = []
    private var lastTap: CFTimeInterval = 0
    /// When the input last held anything but exact zeros.
    private var lastSound: CFTimeInterval = 0
    /// Since the last `takeStats`: samples out, and the loudest input sample.
    private var statSamples = 0
    private var statPeak: Float = 0

    /// When it was last reset, and the first tap after that.
    private var resetAt: CFTimeInterval = 0
    private var firstTap: CFTimeInterval?

    func reset(converter: AVAudioConverter?) {
        lock.lock(); defer { lock.unlock() }
        self.converter = converter
        pcm = []
        let now = CACurrentMediaTime()
        lastTap = now
        lastSound = now
        resetAt = now
        firstTap = nil
    }

    /// How long after the last reset audio first arrived; nil if it has not.
    func firstAudioMs() -> Int? {
        lock.lock(); defer { lock.unlock() }
        return firstTap.map { Int(($0 - resetAt) * 1000) }
    }

    func handle(_ buffer: AVAudioPCMBuffer) {
        lock.lock()
        let converter = self.converter
        lock.unlock()
        var silent = true
        var peak: Float = 0
        if let channel = buffer.floatChannelData?[0] {
            for i in 0..<Int(buffer.frameLength) {
                let v = abs(channel[i])
                if v > peak { peak = v }
            }
            silent = peak == 0
        }
        var out: [Int16] = []
        if let converter {
            let capacity = AVAudioFrameCount(Double(buffer.frameLength) * 16_000 / buffer.format.sampleRate) + 32
            if let converted = AVAudioPCMBuffer(pcmFormat: Self.outFormat, frameCapacity: capacity) {
                var fed = false
                var error: NSError?
                converter.convert(to: converted, error: &error) { _, status in
                    if fed { status.pointee = .noDataNow; return nil }
                    fed = true
                    status.pointee = .haveData
                    return buffer
                }
                if let samples = converted.int16ChannelData?[0] {
                    out = Array(UnsafeBufferPointer(start: samples, count: Int(converted.frameLength)))
                }
            }
        }
        let now = CACurrentMediaTime()
        lock.lock()
        if firstTap == nil { firstTap = now }
        lastTap = now
        if !silent { lastSound = now }
        pcm.append(contentsOf: out)
        statSamples += out.count
        statPeak = max(statPeak, peak)
        lock.unlock()
    }

    /// What has come through since the last call, and start counting again.
    func takeStats() -> (samples: Int, peak: Float) {
        lock.lock(); defer { lock.unlock() }
        let result = (statSamples, statPeak)
        statSamples = 0
        statPeak = 0
        return result
    }

    /// The audio since the last drain, and whether the input has stalled.
    func drain(stallSeconds: Double) -> (pcm: [Int16], stalled: Bool) {
        lock.lock(); defer { lock.unlock() }
        let result = pcm
        pcm = []
        let now = CACurrentMediaTime()
        return (result, now - lastTap > stallSeconds || now - lastSound > stallSeconds)
    }
}

/// Control's sentences waiting to be heard, in order, the first one playing.
/// Buffers are kept until heard, so a new engine can play them again.
private struct SpeechQueue {
    /// What the player is connected with; every sentence is converted to it.
    static let format = AVAudioFormat(standardFormatWithSampleRate: 24_000, channels: 1)!

    struct Sentence {
        let id: String
        let index: Int
        let count: Int
        let buffer: AVAudioPCMBuffer
        /// Its loudness, RMS dBFS: what the microphone would hear of it without cancellation.
        let levelDb: Double
        var key: String { "\(id)#\(index)" }

        init?(id: String, index: Int, count: Int, pcm: Data, sampleRate: Double) {
            let frames = pcm.count / 2
            guard frames > 0, sampleRate > 0,
                  let source = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: sampleRate, channels: 1, interleaved: true),
                  let input = AVAudioPCMBuffer(pcmFormat: source, frameCapacity: AVAudioFrameCount(frames)),
                  let samples = input.int16ChannelData?[0] else { return nil }
            input.frameLength = AVAudioFrameCount(frames)
            var sum = 0.0
            pcm.withUnsafeBytes { raw in
                for i in 0..<frames {
                    let v = raw.loadUnaligned(fromByteOffset: i * 2, as: Int16.self)
                    samples[i] = v
                    sum += Double(v) * Double(v)
                }
            }
            let rms = (sum / Double(frames)).squareRoot() / 32768
            levelDb = rms > 0 ? (20 * log10(rms)).rounded() : -120
            guard let converter = AVAudioConverter(from: source, to: SpeechQueue.format),
                  let output = AVAudioPCMBuffer(pcmFormat: SpeechQueue.format,
                                                frameCapacity: AVAudioFrameCount(Double(frames) * SpeechQueue.format.sampleRate / sampleRate) + 64) else { return nil }
            var fed = false
            var error: NSError?
            converter.convert(to: output, error: &error) { _, status in
                if fed { status.pointee = .endOfStream; return nil }
                fed = true
                status.pointee = .haveData
                return input
            }
            guard error == nil, output.frameLength > 0 else { return nil }
            self.id = id
            self.index = index
            self.count = count
            self.buffer = output
        }
    }

    private(set) var sentences: [Sentence] = []
    var current: Sentence? { sentences.first }
    var isEmpty: Bool { sentences.isEmpty }
    mutating func append(_ sentence: Sentence) { sentences.append(sentence) }
    mutating func removeCurrent() { if !sentences.isEmpty { sentences.removeFirst() } }
    func contains(id: String) -> Bool { sentences.contains { $0.id == id } }
    mutating func remove(id: String) { sentences.removeAll { $0.id == id } }
}
