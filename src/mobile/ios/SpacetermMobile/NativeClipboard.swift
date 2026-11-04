import UIKit
import WebKit

/// Text the page wants on the clipboard — a terminal's whole buffer
/// (src/mobile/native-clipboard.ts).
///
///   page → app:  `{text}`
///   app → page:  whether iOS took it
///
/// The page cannot do this itself: it is served over plain http on the
/// tailnet, which is not a secure context, so it has no `navigator.clipboard`.
@MainActor
final class NativeClipboard: NSObject, WKScriptMessageHandlerWithReply {
    private let events: NativeEvents

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
            guard let body = message.body as? [String: Any], let text = body["text"] as? String else {
                replyHandler(false, nil)
                return
            }
            let copied = LastDictation.copy(text)
            events.record("clipboard-copy", ["chars": text.count, "copied": copied])
            replyHandler(copied, nil)
        }
    }
}
