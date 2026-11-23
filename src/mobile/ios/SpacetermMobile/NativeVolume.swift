import AVFoundation
import MediaPlayer
import UIKit
import WebKit

/// The phone's system volume, for Control's device_volume tool while this
/// phone holds Control (src/mobile/native-volume.ts).
///
///   page → app:  `{}` to read, `{set: <0-100>}` to set and read back
///   app → page:  `{percent}` or `{error}`
///
/// Reading is public API: `AVAudioSession.outputVolume`. Setting is not — iOS
/// has no call for it — so it goes through the slider inside an
/// `MPVolumeView`, the system's own volume control, which is the one way an
/// app can move it. The view sits in the web view off-screen only while it
/// sets, since an `MPVolumeView` on screen hides the system's volume HUD for
/// the hardware buttons too. The answer is read back after iOS has applied it,
/// so a change iOS ignored is reported as an error, never as done.
@MainActor
final class NativeVolume: NSObject, WKScriptMessageHandlerWithReply {
    weak var webView: WKWebView?
    private let events: NativeEvents
    /// Time for iOS to apply the slider's value before reading it back.
    private static let settleSeconds = 0.6

    init(events: NativeEvents) {
        self.events = events
        super.init()
    }

    nonisolated func userContentController(
        _ controller: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void
    ) {
        MainActor.assumeIsolated {
            let body = message.body as? [String: Any] ?? [:]
            if let set = (body["set"] as? NSNumber)?.doubleValue {
                setVolume(percent: set, reply: replyHandler)
            } else {
                let percent = Self.current()
                events.record("native-volume-read", ["percent": percent])
                replyHandler(["percent": percent], nil)
            }
        }
    }

    private static func current() -> Int {
        Int((AVAudioSession.sharedInstance().outputVolume * 100).rounded())
    }

    private func setVolume(percent: Double, reply: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
        let target = Int(max(0, min(100, percent)).rounded())
        let before = Self.current()
        guard let host = webView else {
            reply(["error": "the iPhone app has no window to set the volume from"], nil)
            return
        }
        let volumeView = MPVolumeView(frame: CGRect(x: -1000, y: -1000, width: 100, height: 40))
        volumeView.alpha = 0.01
        host.addSubview(volumeView)
        guard let slider = volumeView.subviews.compactMap({ $0 as? UISlider }).first else {
            volumeView.removeFromSuperview()
            events.record("native-volume-set-failed", ["reason": "no slider"])
            reply(["error": "iOS gave the app no volume control to move"], nil)
            return
        }
        // A beat after the view joins the window, or iOS can ignore the value.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
            MainActor.assumeIsolated {
                slider.setValue(Float(target) / 100, animated: false)
                slider.sendActions(for: .valueChanged)
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05 + Self.settleSeconds) { [weak self] in
            MainActor.assumeIsolated {
                // The slider follows the system volume even when this app's
                // audio session is inactive, which outputVolume may not.
                let fromSession = Self.current()
                let fromSlider = Int((slider.value * 100).rounded())
                volumeView.removeFromSuperview()
                let landed = abs(fromSession - target) <= 1 ? fromSession : abs(fromSlider - target) <= 1 ? fromSlider : nil
                self?.events.record("native-volume-set", [
                    "before": before, "target": target, "session": fromSession, "slider": fromSlider,
                    "applied": landed != nil, "appState": UIApplication.shared.applicationState.rawValue,
                ])
                if let landed {
                    reply(["percent": landed], nil)
                } else {
                    reply(["error": "iOS did not change the volume; it is still at \(fromSession) percent"], nil)
                }
            }
        }
    }
}
