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
@MainActor
final class NativeMicrophone: NSObject, WKScriptMessageHandler {
    weak var webView: WKWebView?
    /// The audio and lifecycle record, which outlives a suspended page.
    private let events: NativeEvents

    /// A new engine for every bring-up: one kept across an AirPods route change
    /// kept its old format and delivered nothing.
    private var engine = AVAudioEngine()
    private let capture = Converter()
    private var wanted = false
    private var running = false
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
            // Hands-free heard "Control": a tap the user feels, since a tone would land mid-sentence.
            case "haptic": UIImpactFeedbackGenerator(style: .heavy).impactOccurred()
            default: log("unknown action \(action ?? "nil")")
            }
        }
    }

    private func start() {
        wanted = true
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
        pendingRestart?.cancel()
        pendingRestart = nil
        timer?.invalidate()
        timer = nil
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        if running { log("stopped") }
        events.record("native-mic-stopped")
        running = false
        sendState()
    }

    // MARK: - Engine

    private func bringUp(why: String) {
        guard wanted else { return }
        lastBringUp = Date()
        do {
            engine.stop()
            engine.inputNode.removeTap(onBus: 0)
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetooth, .mixWithOthers])
            // iOS silences haptics while recording unless told otherwise; hands-free's cue is one.
            try? session.setAllowHapticsAndSystemSoundsDuringRecording(true)
            try session.setActive(true)
            engine = AVAudioEngine()
            let input = engine.inputNode
            let format = input.outputFormat(forBus: 0)
            guard format.sampleRate > 0 else { throw Failure("the input has no format (sample rate 0)") }
            capture.reset(converter: AVAudioConverter(from: format, to: Converter.outFormat))
            let sink = capture
            input.installTap(onBus: 0, bufferSize: 2048, format: format) { buffer, _ in sink.handle(buffer) }
            engine.prepare()
            try engine.start()
            running = true
            lastError = nil
            log("running on \(inputName()) at \(Int(format.sampleRate)) Hz (\(why))")
            events.record("native-mic-running", ["why": why, "sampleRate": format.sampleRate, "route": NativeEvents.describeRoute(session.currentRoute)])
            sendState()
            startTimer()
        } catch {
            running = false
            let nsError = error as NSError
            events.record("native-mic-failed", ["why": why, "error": error.localizedDescription, "domain": nsError.domain, "code": nsError.code, "appState": UIApplication.shared.applicationState == .background ? "background" : "foreground"])
            fail("could not start (\(why)): \(error.localizedDescription)")
        }
    }

    /// Route changes come in bursts — AirPods flap between themselves and the
    /// speaker for a second or two — so start again once, after it settles.
    private func scheduleRestart(_ why: String, after delay: TimeInterval = 0.8) {
        guard wanted else { return }
        pendingRestart?.cancel()
        let work = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated {
                self?.pendingRestart = nil
                self?.bringUp(why: why)
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
        let (pcm, stalled) = capture.drain(stallSeconds: Self.stallSeconds)
        if stalled, pendingRestart == nil, Date().timeIntervalSince(lastBringUp) > Self.minSecondsBetweenRebuilds {
            log("no sound for \(Int(Self.stallSeconds)) s (nothing, or only digital silence) — starting again")
            events.record("native-mic-stalled", ["seconds": Self.stallSeconds])
            scheduleRestart("a stalled microphone", after: 0)
        }
        // Every 2 s, in case the page reloaded and missed the last change.
        if tick % 20 == 0 { sendState() }
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
        var state: [String: Any] = ["running": running]
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
            "wanted": wanted, "running": running, "engineRunning": engine.isRunning,
            "secondsHeard": Double(heard.samples) / 16_000,
            "peakDbfs": heard.peak > 0 ? Int(20 * log10(heard.peak)) : -999,
            "pageTakingAudio": !dropping,
            "input": inputName(),
        ]
    }

    private func inputName() -> String {
        AVAudioSession.sharedInstance().currentRoute.inputs.first?.portName ?? "no input"
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
                    "running": self.running, "wanted": self.wanted,
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
                self.events.record("audio-engine-config-change")
                self.scheduleRestart("the audio configuration changed")
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

    func reset(converter: AVAudioConverter?) {
        lock.lock(); defer { lock.unlock() }
        self.converter = converter
        pcm = []
        let now = CACurrentMediaTime()
        lastTap = now
        lastSound = now
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
