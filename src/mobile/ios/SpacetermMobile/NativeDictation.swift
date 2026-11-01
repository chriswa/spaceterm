import UIKit
import WebKit

/// The last "dictate …" said hands-free on this phone, kept for the Action
/// button (src/mobile/native-dictation.ts).
///
///   page → app:  `{text}`
///
/// iOS lets no app set the clipboard from the background: a write from a
/// backgrounded app is dropped without an error, and `changeCount` reads 0
/// (tried on an iPhone 17, iOS 26, November 1 2026, with the audio engine
/// running), and from an App Intent the Action button runs. So the words are
/// kept here, and a shortcut the Mac signs puts them on the clipboard with
/// Shortcuts' own Copy to Clipboard (DictationIntents.swift). In front, the
/// app copies them at once as well.
@MainActor
final class NativeDictation: NSObject, WKScriptMessageHandler {
    private let events: NativeEvents

    init(events: NativeEvents) {
        self.events = events
        super.init()
    }

    nonisolated func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        MainActor.assumeIsolated {
            guard let body = message.body as? [String: Any], let text = body["text"] as? String else { return }
            LastDictation.keep(text)
            let inFront = UIApplication.shared.applicationState == .active
            let copied = inFront && LastDictation.copy(text)
            events.record("dictation-kept", ["chars": text.count, "inFront": inFront, "copied": copied])
        }
    }
}

/// Where the last dictation is kept: the app's defaults, which the shortcut's
/// Get Last Dictation reads with the app in the background, or not running at all.
enum LastDictation {
    private static let key = "spaceterm.lastDictation"

    static func keep(_ text: String) {
        UserDefaults.standard.set(text, forKey: key)
    }

    static var text: String? {
        UserDefaults.standard.string(forKey: key).flatMap { $0.isEmpty ? nil : $0 }
    }

    /// Put `text` on the clipboard, and say whether iOS let it: from the
    /// background the write is dropped and the change count does not move.
    /// Only ever tried in front.
    @MainActor
    static func copy(_ text: String) -> Bool {
        let before = UIPasteboard.general.changeCount
        UIPasteboard.general.string = text
        return UIPasteboard.general.changeCount != before
    }
}
