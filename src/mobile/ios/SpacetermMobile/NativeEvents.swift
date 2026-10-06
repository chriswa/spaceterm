import AVFoundation
import CallKit
import UIKit
import WebKit

/// What the app sees of its own life and of the audio session, for the phone's
/// audio and lifecycle record (src/mobile/mobile-events.ts, kept on the Mac in
/// ~/.spaceterm/mobile-events.jsonl): launches, going to the background and
/// coming back, the screen locking, calls, interruptions, AirPods coming and
/// going, the input being muted, and a heartbeat while the app is alive.
///
/// The page is the wrong place to notice most of this: iOS suspends the web
/// view's process in the background while the app itself keeps running (it
/// holds the microphone), and kills the page or the app without warning. So
/// each event is numbered and stamped here, and kept — in a file that survives
/// the app being killed — until the *server* has written it: the page passes
/// it on (`window.spacetermNativeEvents.push`), keeps it until the server
/// acknowledges the batch, and then tells the app which numbers are safe to
/// forget (`nativeEvents` message, `ack`). Until then the app hands them over
/// again to every new page, and the page skips those it already has. A
/// suspended page answers nothing until it wakes, and then gets everything,
/// in order.
@MainActor
final class NativeEvents: NSObject, WKScriptMessageHandler {
    weak var webView: WKWebView? {
        didSet {
            captureObservation = webView?.observe(\.microphoneCaptureState, options: [.new]) { [weak self] view, _ in
                let state = view.microphoneCaptureState
                MainActor.assumeIsolated { self?.record("webkit-mic-capture", ["state": Self.describe(state)]) }
            }
            deliver()
        }
    }

    /// The microphone's own account for the heartbeat: running, audio received, how loud.
    var microphoneStatus: (() -> [String: Any])?

    /// Every event the server has not yet acknowledged, oldest first, each with its `seq`.
    private var queue: [[String: Any]] = []
    /// The highest `seq` the current page has taken; reset for a new page.
    private var handedThrough = 0
    private var delivering = false
    private var nextSeq: Int
    private var retry: Timer?
    private var heartbeat: Timer?
    private var observers: [NSObjectProtocol] = []
    private var captureObservation: NSKeyValueObservation?
    private let calls = CXCallObserver()
    private lazy var callWatcher = CallWatcher { [weak self] detail in self?.record("phone-call", detail) }
    /// Since when the audio session has been interrupted with no end heard.
    private var interruptedSince: Date?
    /// The last ping of the page: sent when, answered after how long.
    private var pingSent: Date?
    private var lastPingMs: Int?
    private let clock: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static let maxQueued = 2000
    private static let batch = 100
    private static let retrySeconds: TimeInterval = 5
    private static let heartbeatSeconds: TimeInterval = 60
    /// Kept across launches, so events from a run iOS killed reach the page on the next.
    private static let queueFile = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("native-events.json")
    private static let runStateKey = "spaceterm.runState"
    private static let seqKey = "spaceterm.nativeEventSeq"
    private static let lastAliveKey = "spaceterm.lastAlive"

    override init() {
        // Never reused, even if the last run died before its count was saved:
        // the page skips any number it has already taken.
        nextSeq = max(UserDefaults.standard.integer(forKey: Self.seqKey) + 1, Int(Date().timeIntervalSince1970 * 1000))
        super.init()
        load()
        recordLaunch()
        observeApp()
        observeAudio()
        calls.setDelegate(callWatcher, queue: .main)
        heartbeat = Timer.scheduledTimer(withTimeInterval: Self.heartbeatSeconds, repeats: true) { _ in
            MainActor.assumeIsolated { self.beat() }
        }
    }

    func record(_ kind: String, _ detail: [String: Any] = [:]) {
        let seq = nextSeq
        nextSeq += 1
        UserDefaults.standard.set(seq, forKey: Self.seqKey)
        var event: [String: Any] = ["seq": seq, "t": clock.string(from: Date()), "kind": kind]
        if !detail.isEmpty { event["detail"] = detail }
        queue.append(event)
        if queue.count > Self.maxQueued { queue.removeFirst(queue.count - Self.maxQueued) }
        save()
        deliver()
    }

    /// A new page — loaded, reloaded, or after its process died — has none of
    /// them: hand it everything not yet acknowledged. It skips what it has.
    func pageChanged() {
        handedThrough = 0
        deliver()
    }

    /// Hand the page what it has not taken. Also the retry, when the page was not there to take it.
    func deliver() {
        guard !delivering, let webView else { return }
        let batch = Array(queue.lazy.filter { Self.seq($0) > self.handedThrough }.prefix(Self.batch))
        guard let last = batch.last.map(Self.seq),
              let json = try? JSONSerialization.data(withJSONObject: batch),
              let text = String(data: json, encoding: .utf8) else { return }
        delivering = true
        webView.evaluateJavaScript("!!(window.spacetermNativeEvents && window.spacetermNativeEvents.push(\(text)))") { result, _ in
            MainActor.assumeIsolated {
                self.delivering = false
                if (result as? Bool) == true {
                    self.handedThrough = max(self.handedThrough, last)
                    self.deliver()
                } else {
                    self.scheduleRetry()
                }
            }
        }
    }

    /// The page says the server has written everything up to `through`: forget it.
    nonisolated func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        let body = message.body as? [String: Any]
        let through = (body?["through"] as? NSNumber)?.intValue
        MainActor.assumeIsolated {
            guard body?["action"] as? String == "ack", let through else { return }
            let before = queue.count
            queue.removeAll { Self.seq($0) <= through }
            if queue.count != before { save() }
        }
    }

    private static func seq(_ event: [String: Any]) -> Int {
        (event["seq"] as? NSNumber)?.intValue ?? 0
    }

    private func scheduleRetry() {
        guard retry == nil else { return }
        retry = Timer.scheduledTimer(withTimeInterval: Self.retrySeconds, repeats: false) { _ in
            MainActor.assumeIsolated {
                self.retry = nil
                self.deliver()
            }
        }
    }

    // MARK: - Kept across launches

    private func load() {
        guard let data = try? Data(contentsOf: Self.queueFile),
              let saved = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return }
        queue = saved
    }

    private func save() {
        guard let data = try? JSONSerialization.data(withJSONObject: queue) else { return }
        try? FileManager.default.createDirectory(at: Self.queueFile.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: Self.queueFile, options: .atomic)
    }

    /// A launch, and how the last run ended. iOS ends a backgrounded app with no
    /// event at all — for memory, or because it was swiped away — so a previous
    /// run last seen in the background, not terminated, ended one of those ways.
    private func recordLaunch() {
        let defaults = UserDefaults.standard
        record("app-launch", [
            "previousRun": defaults.string(forKey: Self.runStateKey) ?? "none",
            "previousLastAlive": defaults.string(forKey: Self.lastAliveKey) ?? "never",
            "ios": UIDevice.current.systemVersion,
            "nativeVersion": Bundle.main.object(forInfoDictionaryKey: "SpacetermNativeVersion") as? String ?? "",
            "session": Self.session(),
        ])
        setRunState("foreground")
        markAlive()
    }

    private func setRunState(_ state: String) {
        UserDefaults.standard.set(state, forKey: Self.runStateKey)
    }

    private func markAlive() {
        UserDefaults.standard.set(clock.string(from: Date()), forKey: Self.lastAliveKey)
    }

    // MARK: - The heartbeat

    /// Once a minute while the app runs at all: whether the microphone is
    /// delivering, the session, and whether the page answers.
    private func beat() {
        markAlive()
        var detail: [String: Any] = ["session": Self.session()]
        if let status = microphoneStatus?() { detail["mic"] = status }
        if let since = interruptedSince { detail["interruptedForSeconds"] = Int(Date().timeIntervalSince(since)) }
        if let sent = pingSent {
            detail["page"] = "no answer to a ping \(Int(Date().timeIntervalSince(sent))) s ago"
        } else if let ms = lastPingMs {
            detail["pageAnsweredMs"] = ms
        }
        record("native-heartbeat", detail)
        ping()
    }

    /// Is the page running? A suspended web view answers when it wakes, if ever.
    private func ping() {
        guard pingSent == nil, let webView else { return }
        let sent = Date()
        pingSent = sent
        webView.evaluateJavaScript("1") { _, _ in
            MainActor.assumeIsolated {
                self.lastPingMs = Int(Date().timeIntervalSince(sent) * 1000)
                self.pingSent = nil
            }
        }
    }

    // MARK: - The app

    private func observeApp() {
        let center = NotificationCenter.default
        let app: [(Notification.Name, String, String?)] = [
            (UIApplication.didBecomeActiveNotification, "app-active", "foreground"),
            (UIApplication.willResignActiveNotification, "app-resign-active", nil),
            (UIApplication.didEnterBackgroundNotification, "app-background", "background"),
            (UIApplication.willEnterForegroundNotification, "app-foreground", "foreground"),
            (UIApplication.willTerminateNotification, "app-terminate", "terminated"),
            (UIApplication.didReceiveMemoryWarningNotification, "app-memory-warning", nil),
            // The screen locking and unlocking (with a passcode set).
            (UIApplication.protectedDataWillBecomeUnavailableNotification, "screen-locked", nil),
            (UIApplication.protectedDataDidBecomeAvailableNotification, "screen-unlocked", nil),
            (Notification.Name.NSProcessInfoPowerStateDidChange, "low-power-mode", nil),
            (ProcessInfo.thermalStateDidChangeNotification, "thermal-state", nil),
        ]
        for (name, kind, runState) in app {
            observers.append(center.addObserver(forName: name, object: nil, queue: .main) { _ in
                MainActor.assumeIsolated {
                    if let runState { self.setRunState(runState) }
                    var detail: [String: Any] = ["session": Self.session()]
                    if let status = self.microphoneStatus?() { detail["mic"] = status }
                    self.record(kind, detail)
                    if kind == "app-active" { self.deliver() }
                }
            })
        }
    }

    private func observeAudio() {
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { note in
            let raw = (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt) ?? 0
            MainActor.assumeIsolated {
                // Recorded by NativeMicrophone; tracked here so the heartbeat says when an end never came.
                self.interruptedSince = AVAudioSession.InterruptionType(rawValue: raw) == .began ? Date() : nil
            }
        })
        // Another app starting or stopping audio that wants ours quiet.
        observers.append(center.addObserver(forName: AVAudioSession.silenceSecondaryAudioHintNotification, object: nil, queue: .main) { note in
            let raw = (note.userInfo?[AVAudioSessionSilenceSecondaryAudioHintTypeKey] as? UInt) ?? 0
            MainActor.assumeIsolated {
                let begin = AVAudioSession.SilenceSecondaryAudioHintType(rawValue: raw) == .begin
                self.record("other-audio-hint", ["otherAppWantsQuiet": begin])
            }
        })
        // AirPods' stem press, or Control Center, muting the input: audio keeps flowing, as silence.
        observers.append(center.addObserver(forName: AVAudioApplication.inputMuteStateChangeNotification, object: nil, queue: .main) { note in
            let muted = (note.userInfo?[AVAudioApplication.muteStateKey] as? Bool) ?? AVAudioApplication.shared.isInputMuted
            MainActor.assumeIsolated { self.record("input-muted", ["muted": muted]) }
        })
    }

    // MARK: - Describing things

    /// The audio session and the app, as they are now.
    static func session() -> [String: Any] {
        let s = AVAudioSession.sharedInstance()
        let app = UIApplication.shared
        var out: [String: Any] = [
            "appState": describe(app.applicationState),
            "category": s.category.rawValue,
            "mode": s.mode.rawValue,
            "options": s.categoryOptions.rawValue,
            "otherAudioPlaying": s.isOtherAudioPlaying,
            "otherAppWantsQuiet": s.secondaryAudioShouldBeSilencedHint,
            "inputAvailable": s.isInputAvailable,
            "inputMuted": AVAudioApplication.shared.isInputMuted,
            "recordPermission": describe(AVAudioApplication.shared.recordPermission),
            "sampleRate": s.sampleRate,
            "route": describeRoute(s.currentRoute),
            "lowPower": ProcessInfo.processInfo.isLowPowerModeEnabled,
            "thermal": describe(ProcessInfo.processInfo.thermalState),
        ]
        if app.applicationState == .background {
            let left = app.backgroundTimeRemaining
            out["backgroundTimeLeft"] = left > 100_000 ? "unlimited" : Int(left)
        }
        return out
    }

    static func describeRoute(_ route: AVAudioSessionRouteDescription) -> [String: Any] {
        [
            "inputs": route.inputs.map { "\($0.portName) (\($0.portType.rawValue))" },
            "outputs": route.outputs.map { "\($0.portName) (\($0.portType.rawValue))" },
        ]
    }

    static func describe(_ reason: AVAudioSession.RouteChangeReason?) -> String {
        switch reason {
        case .newDeviceAvailable: "new device available"
        case .oldDeviceUnavailable: "old device unavailable"
        case .categoryChange: "category change"
        case .override: "override"
        case .wakeFromSleep: "wake from sleep"
        case .noSuitableRouteForCategory: "no suitable route for category"
        case .routeConfigurationChange: "route configuration change"
        default: "raw \(reason?.rawValue ?? 0)"
        }
    }

    private static func describe(_ state: UIApplication.State) -> String {
        switch state {
        case .active: "active"
        case .inactive: "inactive"
        case .background: "background"
        @unknown default: "unknown"
        }
    }

    private static func describe(_ permission: AVAudioApplication.recordPermission) -> String {
        switch permission {
        case .granted: "granted"
        case .denied: "denied"
        case .undetermined: "undetermined"
        @unknown default: "unknown"
        }
    }

    private static func describe(_ state: ProcessInfo.ThermalState) -> String {
        switch state {
        case .nominal: "nominal"
        case .fair: "fair"
        case .serious: "serious"
        case .critical: "critical"
        @unknown default: "unknown"
        }
    }

    private static func describe(_ state: WKMediaCaptureState) -> String {
        switch state {
        case .none: "none"
        case .active: "active"
        case .muted: "muted"
        @unknown default: "unknown"
        }
    }
}

/// Phone calls starting, connecting and ending — the interruption iOS most
/// often never says has ended.
private final class CallWatcher: NSObject, CXCallObserverDelegate {
    private let onChange: @MainActor ([String: Any]) -> Void

    init(_ onChange: @escaping @MainActor ([String: Any]) -> Void) {
        self.onChange = onChange
    }

    func callObserver(_ callObserver: CXCallObserver, callChanged call: CXCall) {
        let detail: [String: Any] = [
            "outgoing": call.isOutgoing,
            "connected": call.hasConnected,
            "ended": call.hasEnded,
            "onHold": call.isOnHold,
        ]
        let onChange = self.onChange
        MainActor.assumeIsolated { onChange(detail) }
    }
}
