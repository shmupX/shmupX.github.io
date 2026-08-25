import UIKit
import WebKit
import UniformTypeIdentifiers

/**
 * iOS Share Extension view controller for Sprite Share.
 *
 * Receives a shared image via the iOS share sheet, hosts a WKWebView
 * with the sprite picker UI (same HTML/CSS/JS as Android), and bridges
 * between JavaScript and Swift via WKScriptMessageHandler.
 *
 * Atlas data is stored in an App Group shared container so the main
 * app can read repacked atlases.
 */
class ShareViewController: UIViewController, WKScriptMessageHandler, WKNavigationDelegate {

    private var webView: WKWebView?
    private var webDir: URL?
    private var pendingImagePath: String?
    private var pageLoaded = false

    private let appGroupId = "group.com.easierbycode.game2028"

    // MARK: - Lifecycle

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0.1, green: 0.1, blue: 0.18, alpha: 1)

        guard let dir = prepareWebAssets() else {
            closeExtension()
            return
        }
        webDir = dir

        setupWebView(webDir: dir)
        loadSharedImage()
    }

    // MARK: - Web assets

    /// Copy bundled web files to a temp directory so WKWebView can access
    /// both the HTML assets and the shared image from the same root.
    private func prepareWebAssets() -> URL? {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("sprite-share-web")

        try? FileManager.default.removeItem(at: dir)

        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        } catch {
            return nil
        }

        let resources: [(String, String)] = [
            ("sprite-picker", "html"),
            ("sprite-picker", "css"),
            ("sprite-picker-app", "js"),
            ("sprite-detect", "js"),
        ]

        for (name, ext) in resources {
            guard let src = Bundle.main.url(forResource: name, withExtension: ext) else {
                continue
            }
            let dst = dir.appendingPathComponent("\(name).\(ext)")
            try? FileManager.default.copyItem(at: src, to: dst)
        }

        return dir
    }

    // MARK: - WebView setup

    private func setupWebView(webDir: URL) {
        let config = WKWebViewConfiguration()
        let userCtrl = WKUserContentController()
        userCtrl.add(self, name: "spriteBridge")
        config.userContentController = userCtrl

        let wv = WKWebView(frame: view.bounds, configuration: config)
        wv.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        wv.scrollView.bounces = false
        wv.navigationDelegate = self
        view.addSubview(wv)
        webView = wv

        let htmlURL = webDir.appendingPathComponent("sprite-picker.html")
        wv.loadFileURL(htmlURL, allowingReadAccessTo: webDir)
    }

    // MARK: - Shared image handling

    private func loadSharedImage() {
        guard let items = extensionContext?.inputItems as? [NSExtensionItem] else {
            closeExtension()
            return
        }

        for item in items {
            guard let attachments = item.attachments else { continue }
            for provider in attachments {
                if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
                    provider.loadItem(forTypeIdentifier: UTType.image.identifier,
                                      options: nil) { [weak self] data, _ in
                        if let url = data as? URL {
                            self?.processImage(UIImage(contentsOfFile: url.path))
                        } else if let img = data as? UIImage {
                            self?.processImage(img)
                        } else if let d = data as? Data {
                            self?.processImage(UIImage(data: d))
                        } else {
                            DispatchQueue.main.async { self?.closeExtension() }
                        }
                    }
                    return
                }
            }
        }

        closeExtension()
    }

    private func processImage(_ image: UIImage?) {
        guard let image = image,
              let dir = webDir,
              let pngData = image.pngData() else {
            DispatchQueue.main.async { [weak self] in self?.closeExtension() }
            return
        }

        let imgFile = dir.appendingPathComponent("shared_input.png")
        do {
            try pngData.write(to: imgFile)
        } catch {
            DispatchQueue.main.async { [weak self] in self?.closeExtension() }
            return
        }

        let path = imgFile.absoluteString
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "'", with: "\\'")

        DispatchQueue.main.async { [weak self] in
            self?.pendingImagePath = path
            self?.sendImageIfReady()
        }
    }

    /// Only inject the receiveSharedImage call once both the page has loaded
    /// and the shared image has been written to disk.
    private func sendImageIfReady() {
        guard pageLoaded, let path = pendingImagePath else { return }
        pendingImagePath = nil

        let js = "if(typeof receiveSharedImage==='function')receiveSharedImage('\(path)')"
        webView?.evaluateJavaScript(js, completionHandler: nil)
    }

    // MARK: - WKNavigationDelegate

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        pageLoaded = true
        sendImageIfReady()
    }

    // MARK: - WKScriptMessageHandler

    func userContentController(_ userContentController: WKUserContentController,
                                didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let callId = body["id"] as? Int,
              let method = body["method"] as? String else { return }

        let args = body["args"] as? [Any] ?? []

        switch method {
        case "getAtlasJson":
            let result = getAtlasJson(args.first as? String ?? "")
            respondString(callId: callId, value: result)

        case "getAtlasImageBase64":
            let result = getAtlasImageBase64(args.first as? String ?? "")
            respondString(callId: callId, value: result)

        case "saveAtlas":
            let name = args.count > 0 ? (args[0] as? String ?? "") : ""
            let png  = args.count > 1 ? (args[1] as? String ?? "") : ""
            let json = args.count > 2 ? (args[2] as? String ?? "") : ""
            let ok = saveAtlas(name: name, pngBase64: png, jsonString: json)
            respondBool(callId: callId, value: ok)

        case "hasRepackedAtlas":
            let result = hasRepackedAtlas(args.first as? String ?? "")
            respondBool(callId: callId, value: result)

        case "close":
            closeExtension()

        default:
            break
        }
    }

    // MARK: - JS response helpers

    /// Respond with a string value, using JSON encoding for safe transport.
    private func respondString(callId: Int, value: String) {
        // Wrap in an array and JSON-encode to get safe escaping of all
        // special characters (quotes, backslashes, newlines, unicode, etc.)
        guard let data = try? JSONSerialization.data(
                    withJSONObject: [value], options: .fragmentsAllowed),
              let json = String(data: data, encoding: .utf8) else {
            let js = "window._bridgeCallback(\(callId),'')"
            evaluateOnMain(js)
            return
        }
        // json is ["the value"] — extract just the quoted string
        let escaped = String(json.dropFirst(1).dropLast(1))
        let js = "window._bridgeCallback(\(callId),\(escaped))"
        evaluateOnMain(js)
    }

    private func respondBool(callId: Int, value: Bool) {
        let js = "window._bridgeCallback(\(callId),\(value ? "true" : "false"))"
        evaluateOnMain(js)
    }

    private func evaluateOnMain(_ js: String) {
        DispatchQueue.main.async { [weak self] in
            self?.webView?.evaluateJavaScript(js, completionHandler: nil)
        }
    }

    // MARK: - Atlas bridge methods

    private var containerURL: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupId)
    }

    private func getAtlasJson(_ atlasName: String) -> String {
        // Check App Group container for repacked atlas first
        if let container = containerURL {
            let repacked = container.appendingPathComponent("assets/_\(atlasName).json")
            if let data = try? Data(contentsOf: repacked),
               let str = String(data: data, encoding: .utf8) {
                return str
            }
        }

        // Fall back to atlas bundled in the extension
        if let url = Bundle.main.url(forResource: atlasName, withExtension: "json",
                                      subdirectory: "assets"),
           let data = try? Data(contentsOf: url),
           let str = String(data: data, encoding: .utf8) {
            return str
        }

        return "{\"frames\":{},\"meta\":{}}"
    }

    private func getAtlasImageBase64(_ atlasName: String) -> String {
        // Check App Group container for repacked atlas image
        if let container = containerURL {
            let repacked = container.appendingPathComponent("assets/img/_\(atlasName).png")
            if let data = try? Data(contentsOf: repacked) {
                return "data:image/png;base64,\(data.base64EncodedString())"
            }
        }

        // Fall back to atlas image bundled in the extension
        if let url = Bundle.main.url(forResource: atlasName, withExtension: "png",
                                      subdirectory: "assets/img"),
           let data = try? Data(contentsOf: url) {
            return "data:image/png;base64,\(data.base64EncodedString())"
        }

        return ""
    }

    private func saveAtlas(name: String, pngBase64: String, jsonString: String) -> Bool {
        guard let container = containerURL else { return false }

        do {
            let imgDir = container.appendingPathComponent("assets/img")
            try FileManager.default.createDirectory(at: imgDir, withIntermediateDirectories: true)

            let base64 = pngBase64.components(separatedBy: "base64,").last ?? pngBase64
            guard let pngData = Data(base64Encoded: base64) else { return false }

            try pngData.write(to: imgDir.appendingPathComponent("_\(name).png"))

            let assetsDir = container.appendingPathComponent("assets")
            try FileManager.default.createDirectory(at: assetsDir, withIntermediateDirectories: true)
            try jsonString.write(to: assetsDir.appendingPathComponent("_\(name).json"),
                                  atomically: true, encoding: .utf8)
            return true
        } catch {
            return false
        }
    }

    private func hasRepackedAtlas(_ atlasName: String) -> Bool {
        guard let container = containerURL else { return false }
        let json = container.appendingPathComponent("assets/_\(atlasName).json")
        let png = container.appendingPathComponent("assets/img/_\(atlasName).png")
        return FileManager.default.fileExists(atPath: json.path) &&
               FileManager.default.fileExists(atPath: png.path)
    }

    // MARK: - Cleanup

    private func closeExtension() {
        extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
    }

    deinit {
        if let dir = webDir {
            try? FileManager.default.removeItem(at: dir)
        }
    }
}
