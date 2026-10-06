import UIKit
import WebKit

/// The web view, configured for an app that is a web page and nothing else.
final class WebViewController: UIViewController, WKUIDelegate, WKNavigationDelegate {
    private var webView: WKWebView!
    /// Times iOS has ended the page's process since launch; see below.
    private var processRestarts = 0
    /// The app's life and its audio session, for the page's audio and lifecycle record.
    private let events = NativeEvents()
    /// The app's own microphone, which the page asks for: hands-free mode.
    private lazy var microphone = NativeMicrophone(events: events)

    /// `SpacetermURLs` from Info.plist, written at build time by install.sh:
    /// one pairing URL per Mac, for a phone that is on one tailnet at a time.
    private let candidates: [URL] = {
        guard let raw = Bundle.main.object(forInfoDictionaryKey: "SpacetermURLs") as? String else { return [] }
        return raw.split(whereSeparator: \.isWhitespace).compactMap { URL(string: String($0)) }
    }()
    /// The candidate that answered first, and so the page this view holds.
    private var activeURL: URL?
    private var race: AddressRace?

    override func loadView() {
        let config = WKWebViewConfiguration()
        // Persistent storage: the pairing token, drafts and the open surface
        // survive relaunches, as they would in a browser.
        config.websiteDataStore = .default()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        // Lets the page tell it is running inside the app, should it need to.
        config.applicationNameForUserAgent = "SpacetermApp/1"

        // Which build of this app is running, for the page to compare with the
        // newest source (native-version.mjs) and ask for an update when behind.
        if let version = Bundle.main.object(forInfoDictionaryKey: "SpacetermNativeVersion") as? String,
           !version.isEmpty {
            config.userContentController.addUserScript(WKUserScript(
                source: "window.spacetermNativeVersion = '\(version)'",
                injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        // The screen's corner radius, which a page cannot read: the canvas's
        // corner buttons sit as low and as far out as the curve allows.
        if let radius = Self.displayCornerRadius {
            config.userContentController.addUserScript(WKUserScript(
                source: "document.documentElement.style.setProperty('--m-corner-radius', '\(radius)px')",
                injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }

        // `window.webkit.messageHandlers.nativeMicrophone` is also how the
        // page knows it can hold a microphone without AirPods.
        config.userContentController.add(microphone, name: "nativeMicrophone")
        // The page's word that the server has the app's events, so it can forget them.
        config.userContentController.add(events, name: "nativeEvents")

        webView = WKWebView(frame: .zero, configuration: config)
        microphone.webView = webView
        events.webView = webView
        webView.uiDelegate = self
        webView.navigationDelegate = self
        webView.isOpaque = false
        webView.backgroundColor = UIColor(red: 0x11 / 255, green: 0x11 / 255, blue: 0x1b / 255, alpha: 1)
        webView.scrollView.backgroundColor = webView.backgroundColor
        // The page lays itself out against env(safe-area-inset-*) and handles
        // every touch itself; the scroll view must neither inset nor scroll it.
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.bounces = false
        webView.allowsBackForwardNavigationGestures = false
        webView.allowsLinkPreview = false
        // Safari's Web Inspector can attach over USB/Wi-Fi: this is a personal tool.
        webView.isInspectable = true
        webView.removeFormAccessoryBar()
        view = webView
    }

    /// UIKit knows it but does not publish it; a personal app may ask anyway.
    /// Nil when the key is missing, and the page falls back to its default.
    private static var displayCornerRadius: Double? {
        (UIScreen.main.value(forKey: "_displayCornerRadius") as? NSNumber)?.doubleValue
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        load()
    }

    /// Ask every Mac at once; the page comes from whichever answers first.
    private func load() {
        guard !candidates.isEmpty else {
            showProblem("This build has no Spaceterm address. Rebuild it with <code>src/mobile/ios/install.sh</code> on your Mac.")
            return
        }
        race?.cancel()
        race = AddressRace(candidates) { [weak self] winner in
            guard let self else { return }
            self.race = nil
            guard let winner else {
                self.showProblem(self.unreachableMessage())
                return
            }
            self.activeURL = winner
            self.webView.load(URLRequest(url: winner))
        }
    }

    private func isSpaceterm(_ host: String?) -> Bool {
        guard let host else { return false }
        return candidates.contains { $0.host == host }
    }

    private func unreachableMessage() -> String {
        let hosts = candidates.compactMap(\.host).map { "<code>\($0)</code>" }.joined(separator: "<br>")
        return "Could not connect to any of these:<br>\(hosts)<br><br>Is the Mac awake, and Tailscale connected on both and on the same tailnet?"
    }

    // MARK: - Microphone

    /// Grant the microphone to Spaceterm's own page without asking each time.
    /// iOS still asks once, for the app, using NSMicrophoneUsageDescription.
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(isSpaceterm(origin.host) ? .grant : .deny)
    }

    // MARK: - Navigation

    /// Spaceterm's own pages stay here; anything else opens in the browser.
    /// `spaceterm://retry` is the problem page's way back: another race.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.cancel) }
        if url.scheme == Self.retryScheme {
            decisionHandler(.cancel)
            load()
        } else if url.scheme == "about" || isSpaceterm(url.host) {
            decisionHandler(.allow)
        } else {
            UIApplication.shared.open(url)
            decisionHandler(.cancel)
        }
    }

    /// A page that has just loaded can take what the app kept for it.
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        events.record("page-loaded", ["host": webView.url?.host ?? ""])
        events.pageChanged()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        events.record("page-load-failed", ["error": error.localizedDescription])
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        events.record("page-load-failed", ["error": error.localizedDescription, "host": activeURL?.host ?? ""])
        let host = activeURL?.host.map { "<code>\($0)</code>" } ?? "Spaceterm"
        showProblem("Could not reach \(host): \(error.localizedDescription).<br>Is the Mac awake, and Tailscale connected on both?")
    }

    /// iOS kills a page's process when it uses too much memory; without this
    /// the app would sit on a blank screen.
    /// The reloaded page is told how many times, so its log says why it reloaded.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        processRestarts += 1
        events.record("page-process-terminated", ["restarts": processRestarts])
        webView.configuration.userContentController.addUserScript(WKUserScript(
            source: "window.spacetermProcessRestarts = \(processRestarts)",
            injectionTime: .atDocumentStart, forMainFrameOnly: true))
        load()
    }

    private static let retryScheme = "spaceterm"

    /// No browser to show an error page, so a minimal one with a way back.
    private func showProblem(_ message: String) {
        let retry = candidates.isEmpty ? "" :
            "<p><a href=\"\(Self.retryScheme)://retry\" style=\"color:#cba6f7\">Try again</a></p>"
        let html = """
        <!doctype html><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
        <body style="margin:0;padding:calc(48px + env(safe-area-inset-top)) 24px;background:#11111b;color:#cdd6f4;
          font:17px/1.45 -apple-system,system-ui">
        <h2 style="margin-top:0">Spaceterm</h2><p>\(message)</p>\(retry)
        """
        webView.loadHTMLString(html, baseURL: nil)
    }
}

/// Fetch every address's page at once. The first to answer wins and the rest
/// are cancelled; once all have failed, the answer is nil. One shot: the
/// completion runs once, on the main queue.
private final class AddressRace {
    private let session: URLSession
    private let completion: (URL?) -> Void
    private var pending: Int
    private var settled = false

    init(_ urls: [URL], completion: @escaping (URL?) -> Void) {
        let config = URLSessionConfiguration.ephemeral
        // A Mac whose name resolves but which is asleep or on the other tailnet
        // answers nothing; this is how long the other one has to win.
        config.timeoutIntervalForRequest = 15
        config.waitsForConnectivity = false
        session = URLSession(configuration: config)
        self.completion = completion
        pending = urls.count
        for url in urls {
            session.dataTask(with: Self.probe(url)) { [weak self] _, response, error in
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                let reached = error == nil && (200..<400).contains(status)
                DispatchQueue.main.async { self?.settle(url, reached: reached) }
            }.resume()
        }
    }

    func cancel() {
        settled = true
        session.invalidateAndCancel()
    }

    private func settle(_ url: URL, reached: Bool) {
        guard !settled else { return }
        pending -= 1
        if reached {
            settled = true
            session.invalidateAndCancel()
            completion(url)
        } else if pending == 0 {
            settled = true
            session.invalidateAndCancel()
            completion(nil)
        }
    }

    /// The page without its fragment: the token never travels, as in a browser.
    private static func probe(_ url: URL) -> URL {
        var parts = URLComponents(url: url, resolvingAgainstBaseURL: false)
        parts?.fragment = nil
        return parts?.url ?? url
    }
}
