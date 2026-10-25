import Foundation
import VoiceOperatorAudio
import VoiceOperatorHandsFree
import WebKit

/// The microphone, held by the app rather than the page — what hands-free mode
/// listens to (src/mobile/native-microphone.ts) — and Control's voice, played
/// through it.
///
/// The engine itself — the audio session and its mixing rules, voice
/// processing, the one player, cues, haptics, staying awake, recovery — is
/// Voice Operator's iOS SDK now (`VoiceAudioEngine`, in
/// voiceop/sdk/VoiceOperatorKit, which keeps this file's history in its
/// comments). This is the page's side of it: the page's messages in
/// (`action` names the command), and what the engine says out as the same
/// `window.spacetermNativeMicrophone` calls as before.
///
/// Hands-free goes through Voice Operator (`HandsFreeSession`): the page
/// carries the stream's lines to the server and back, which carries them to
/// Voice Operator.
///   page → app:  `{action: "hands-free-start", client, device}`, `{action: "hands-free-stop"}`,
///                `{action: "hands-free-transport", event: "open" | "closed"}`, `{action: "hands-free-line", line}`
///   app → page:  `spacetermNativeMicrophone.handsFree({kind: "line", line})` — a line for Voice Operator;
///                `spacetermNativeMicrophone.handsFree({kind: "event", event})` — Voice Operator's own JSON, unchanged.
/// `hands-free-start` works whether or not the page has already started the
/// microphone (it takes it only if not); `hands-free-stop` stops the stream,
/// and the page's own `stop` releases the microphone.
@MainActor
final class NativeMicrophone: NSObject, WKScriptMessageHandler, VoiceAudioEngineHost {
    weak var webView: WKWebView? {
        didSet {
            captureObservation = webView?.observe(\.microphoneCaptureState, options: [.new]) { [weak self] view, _ in
                let state = view.microphoneCaptureState
                MainActor.assumeIsolated { if state == .none { self?.engine.pageMicrophoneClosed() } }
            }
        }
    }
    private var captureObservation: NSKeyValueObservation?
    /// The audio and lifecycle record, which outlives a suspended page.
    private let events: NativeEvents
    private let engine: VoiceAudioEngine
    private let handsFree: HandsFreeSession

    /// `evaluateJavaScript` calls not yet answered. A suspended page answers
    /// none; past a bound, audio is dropped rather than piled up behind it.
    private var unanswered = 0
    private var dropping = false
    private static let maxUnanswered = 50
    /// The page has the microphone started (`start` since its last `stop`), and takes its audio.
    private var pageHolds = false

    init(events: NativeEvents) {
        self.events = events
        engine = VoiceAudioEngine(badStateDefaultsKey: NativeEvents.lastBadStateKey)
        handsFree = HandsFreeSession(engine: engine)
        super.init()
        engine.host = self
        handsFree.microphoneHeldElsewhere = { [weak self] in self?.pageHolds ?? false }
        handsFree.sendLine = { [weak self] line in self?.sendHandsFreeLine(line) }
        handsFree.onRawEvent = { [weak self] line in self?.sendHandsFreeEvent(line) }
        events.microphoneStatus = { [weak self] in
            guard let self else { return [:] }
            var status = self.engine.status()
            status["pageTakingAudio"] = !self.dropping
            status["handsFree"] = self.handsFree.isOn
            return status
        }
    }

    // MARK: - From the page

    nonisolated func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        MainActor.assumeIsolated {
            let body = message.body as? [String: Any] ?? [:]
            switch body["action"] as? String {
            case "hands-free-start":
                let client = body["client"] as? String ?? "spaceterm"
                let device = body["device"] as? String ?? "iPhone"
                events.record("hands-free-start", ["client": client, "device": device, "microphoneWanted": engine.microphoneWanted])
                handsFree.start(client: client, device: device)
            case "hands-free-stop":
                events.record("hands-free-stop", [:])
                handsFree.stop()
            case "hands-free-transport":
                let event = body["event"] as? String
                events.record("hands-free-transport", ["event": event ?? "?"])
                if event == "open" { handsFree.transportOpened() } else { handsFree.transportClosed() }
            case "hands-free-line":
                if let line = body["line"] as? String { handsFree.receive(line: line) }
            case "start":
                pageHolds = true
                engine.handle(command: "start", body: body)
            case "stop":
                // The page's word is final: hands-free's stream, if still on, hears nothing until it starts again.
                pageHolds = false
                engine.handle(command: "stop", body: body)
            case let action?:
                engine.handle(command: action, body: body)
            case nil:
                engine.handle(command: "nil", body: body)
            }
        }
    }

    // MARK: - From the engine

    func engine(_ e: VoiceAudioEngine, captured pcm16k: Data) {
        // Taken by hands-free alone: the page did not ask for it.
        guard pageHolds, let webView else { return }
        guard admit(what: "audio") else { return }
        let b64 = pcm16k.base64EncodedString()
        unanswered += 1
        webView.evaluateJavaScript("window.spacetermNativeMicrophone && window.spacetermNativeMicrophone.audio('\(b64)'), 0") { _, _ in
            MainActor.assumeIsolated { self.unanswered = max(0, self.unanswered - 1) }
        }
    }

    func engine(_ e: VoiceAudioEngine, state: [String: Any]) {
        guard let json = try? JSONSerialization.data(withJSONObject: state), let text = String(data: json, encoding: .utf8) else { return }
        webView?.evaluateJavaScript("window.spacetermNativeMicrophone && window.spacetermNativeMicrophone.state(\(text)), 0", completionHandler: nil)
    }

    func engine(_ e: VoiceAudioEngine, speech: [String: Any]) {
        guard let json = try? JSONSerialization.data(withJSONObject: speech), let text = String(data: json, encoding: .utf8) else { return }
        webView?.evaluateJavaScript("window.spacetermNativeMicrophone && window.spacetermNativeMicrophone.speech && window.spacetermNativeMicrophone.speech(\(text)), 0", completionHandler: nil)
    }

    /// To the server's log through the page, as the page's own lines go.
    func engine(_ e: VoiceAudioEngine, log message: String) {
        log(message)
    }

    func engine(_ e: VoiceAudioEngine, record kind: String, detail: [String: Any]) {
        events.record(kind, detail)
    }

    var pageMicrophoneCaptureIdle: Bool {
        guard let webView else { return true }
        return webView.microphoneCaptureState == .none
    }

    var pageMicrophoneState: String {
        webView.map { NativeEvents.describe($0.microphoneCaptureState) } ?? "no page"
    }

    // MARK: - Hands-free's transport

    /// A line for Voice Operator. Audio is dropped, as the page's own is, while the page answers nothing;
    /// Voice Operator takes the hole as one. The stream's other lines always go.
    private func sendHandsFreeLine(_ line: String) {
        guard let webView else { return }
        if line.contains("\"type\":\"audio\""), !admit(what: "hands-free audio") { return }
        guard let json = try? JSONSerialization.data(withJSONObject: ["kind": "line", "line": line]),
              let text = String(data: json, encoding: .utf8) else { return }
        unanswered += 1
        webView.evaluateJavaScript("window.spacetermNativeMicrophone && window.spacetermNativeMicrophone.handsFree && window.spacetermNativeMicrophone.handsFree(\(text)), 0") { _, _ in
            MainActor.assumeIsolated { self.unanswered = max(0, self.unanswered - 1) }
        }
    }

    /// One of Voice Operator's events, its JSON passed to the page unchanged.
    private func sendHandsFreeEvent(_ line: String) {
        // Embedded as it came, so only once it is known to be a JSON object.
        guard let data = line.data(using: .utf8), (try? JSONSerialization.jsonObject(with: data)) is [String: Any] else { return }
        webView?.evaluateJavaScript("window.spacetermNativeMicrophone && window.spacetermNativeMicrophone.handsFree && window.spacetermNativeMicrophone.handsFree({\"kind\":\"event\",\"event\":\(line)}), 0", completionHandler: nil)
    }

    /// Whether the page is taking audio: past `maxUnanswered` unanswered calls, it is dropped until it does.
    private func admit(what: String) -> Bool {
        if unanswered >= Self.maxUnanswered {
            if !dropping {
                log("the page is not taking audio (suspended?) — dropping it until it does")
                events.record("native-mic-page-not-taking-audio", ["what": what])
            }
            dropping = true
            return false
        }
        if dropping {
            dropping = false
            log("the page is taking audio again")
            events.record("native-mic-page-taking-audio")
        }
        return true
    }

    private func log(_ message: String) {
        guard let data = try? JSONSerialization.data(withJSONObject: ["[native-mic] \(message)"]),
              let array = String(data: data, encoding: .utf8) else { return }
        webView?.evaluateJavaScript("window.api && window.api.log(\(array)[0]), 0", completionHandler: nil)
    }
}
