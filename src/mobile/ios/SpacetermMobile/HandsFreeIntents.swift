import AppIntents
import WebKit

/// "Hey Siri, Space term": opens the app — launching it if it is not running —
/// and turns hands-free on (src/mobile/native-hands-free-request.ts).
///
/// The app has to come to the front for it: iOS lets no app open its
/// microphone from the background, so the intent opens the app, and on a
/// locked phone Siri asks for it to be unlocked first.
///
/// Siri hears the app as "Space" as well as "Spaceterm" (`INAlternativeAppNames`
/// in Info.plist), so the phrase `\(.applicationName) term` is "Space term".
struct StartHandsFreeIntent: AppIntent {
    static let title: LocalizedStringResource = "Start Hands-Free"
    static let description = IntentDescription("Opens Spaceterm and turns hands-free on, listening for “Control”.")
    static let openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult {
        HandsFreeRequest.shared.ask()
        return .result()
    }
}

struct SpacetermShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: StartHandsFreeIntent(),
            phrases: [
                "\(.applicationName) term",
                // Should Siri not take "Space term": the conventional form, which it reliably does.
                "Start hands-free in \(.applicationName)",
            ],
            shortTitle: "Hands-Free",
            systemImageName: "ear")
    }
}

/// Siri's request, held until the page can take it.
///
///   page → app:  `{ready: true}`, once the page can start hands-free
///   app → page:  `spacetermHandsFreeRequest.start()`
///
/// On a cold launch Siri asks before the web view exists, and the page then
/// takes a moment more to come from the Mac, so the request waits — but not
/// for ever: a page that turned up minutes later (the Mac asleep, then found)
/// should not start listening out of the blue.
@MainActor
final class HandsFreeRequest: NSObject, WKScriptMessageHandler {
    static let shared = HandsFreeRequest()

    weak var webView: WKWebView?
    var events: NativeEvents?
    /// When Siri asked, while the page has not yet taken it.
    private var askedAt: Date?
    private static let patience: TimeInterval = 90

    func ask() {
        askedAt = Date()
        events?.record("hands-free-requested", ["page": webView != nil])
        deliver()
    }

    nonisolated func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        MainActor.assumeIsolated { deliver() }
    }

    private func deliver() {
        guard let asked = askedAt else { return }
        guard Date().timeIntervalSince(asked) < Self.patience else {
            askedAt = nil
            events?.record("hands-free-request-expired", [:])
            return
        }
        guard let webView else { return }
        // False until the page has installed its taker; the page's `ready` then tries again.
        webView.evaluateJavaScript(
            "window.spacetermHandsFreeRequest ? (window.spacetermHandsFreeRequest.start(), true) : false"
        ) { [weak self] result, _ in
            MainActor.assumeIsolated {
                guard let self, result as? Bool == true, self.askedAt == asked else { return }
                self.askedAt = nil
                self.events?.record("hands-free-request-delivered", [:])
            }
        }
    }
}
