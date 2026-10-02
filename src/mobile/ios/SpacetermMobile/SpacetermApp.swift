import SwiftUI

/// Spaceterm on the phone: the mobile web app (`src/mobile`), full screen in a
/// web view, with none of a browser's chrome.
///
/// Everything the app does lives in the web app the Spaceterm server serves.
/// This wrapper exists for what a browser tab cannot do: own the whole screen,
/// keep its microphone permission, and take the form bar off the keyboard.
@main
struct SpacetermApp: App {
    var body: some Scene {
        WindowGroup {
            SpacetermWebView()
                .ignoresSafeArea()
                .preferredColorScheme(.dark)
                .background(Color(red: 0x11 / 255, green: 0x11 / 255, blue: 0x1b / 255))
        }
    }
}

struct SpacetermWebView: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> WebViewController { WebViewController() }
    func updateUIViewController(_ controller: WebViewController, context: Context) {}
}
