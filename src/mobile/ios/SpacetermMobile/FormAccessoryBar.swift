import ObjectiveC
import UIKit
import WebKit

extension WKWebView {
    /// Take the form bar off the keyboard — the strip of AutoFill buttons
    /// (passwords, cards, addresses) and ⌃ ⌄ Done that WebKit puts above it for
    /// every text field. None of it applies to a terminal or a prompt, and the
    /// page has its own key row and its own way to dismiss the keyboard.
    ///
    /// WebKit has no setting for this. The bar is the `inputAccessoryView` of
    /// its private content view, so that one view is given a subclass, made at
    /// runtime, whose `inputAccessoryView` is nil. This is the approach
    /// Capacitor's keyboard plugin ships; if a WebKit update renames the
    /// content view it fails quietly and the bar simply comes back.
    func removeFormAccessoryBar() {
        guard let content = scrollView.subviews.first(where: {
            String(describing: type(of: $0)).hasPrefix("WKContent")
        }), let base = object_getClass(content) else { return }

        let name = "\(NSStringFromClass(base))_SpacetermNoAccessoryBar"
        var subclass: AnyClass? = NSClassFromString(name)
        if subclass == nil, let created = objc_allocateClassPair(base, name, 0) {
            let noBar: @convention(block) (AnyObject) -> UIView? = { _ in nil }
            class_addMethod(created, #selector(getter: UIResponder.inputAccessoryView),
                            imp_implementationWithBlock(noBar), "@@:")
            objc_registerClassPair(created)
            subclass = created
        }
        if let subclass { object_setClass(content, subclass) }
    }
}
