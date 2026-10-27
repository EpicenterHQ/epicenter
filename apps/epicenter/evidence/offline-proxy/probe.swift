import AppKit
import Network
import Security
import WebKit

final class Probe: NSObject, WKNavigationDelegate {
    let url = URL(string: "https://probe.epicenter.test/")!
    let expectedCertificate: Data
    let window = NSWindow(contentRect: NSRect(x: 80, y: 80, width: 600, height: 400), styleMask: [.titled, .closable], backing: .buffered, defer: false)
    var webview: WKWebView!

    override init() {
        let certName = ProcessInfo.processInfo.environment["PROBE_BAD_PIN"] == "1" ? "upstream-cert.pem" : "cert.pem"
        let pem = try! String(contentsOfFile: "\(CommandLine.arguments[1])/\(certName)", encoding: .utf8)
        let base64 = pem.replacingOccurrences(of: "-----BEGIN CERTIFICATE-----", with: "").replacingOccurrences(of: "-----END CERTIFICATE-----", with: "").filter { !$0.isWhitespace }
        expectedCertificate = Data(base64Encoded: base64)!
        super.init()
    }

    func start() {
        let config = WKWebViewConfiguration()
        let store = WKWebsiteDataStore.nonPersistent()
        store.proxyConfigurations = [ProxyConfiguration(httpCONNECTProxy: .hostPort(host: "127.0.0.1", port: 38474))]
        config.websiteDataStore = store
        webview = WKWebView(frame: window.contentView!.bounds, configuration: config)
        webview.navigationDelegate = self
        window.contentView = webview
        window.title = "Proxy probe"
        window.makeKeyAndOrderFront(nil)
        webview.load(URLRequest(url: url))
        DispatchQueue.main.asyncAfter(deadline: .now() + 15) { print("TIMEOUT"); exit(2) }
    }

    func webView(_ webView: WKWebView, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.host == url.host else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust,
              let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
              let leaf = chain.first,
              SecCertificateCopyData(leaf) as Data == expectedCertificate else {
            print("TRUST REJECTED", challenge.protectionSpace.host, challenge.protectionSpace.authenticationMethod)
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        print("TRUST PIN MATCHED", challenge.protectionSpace.host)
        completionHandler(.useCredential, URLCredential(trust: trust))
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        checkPage(webView, attemptsLeft: 40)
    }

    func checkPage(_ webView: WKWebView, attemptsLeft: Int) {
        webView.evaluateJavaScript("JSON.stringify({origin:location.origin,body:document.body.innerText,ran:window.__ran||0,ready:!!window.__ready,inline:window.__inline||0})") { value, error in
            guard let json = value as? String,
                  let data = json.data(using: .utf8),
                  let state = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                print("PAGE EVALUATION FAILED", error?.localizedDescription ?? "unknown")
                exit(1)
            }
            let valid = state["origin"] as? String == "https://probe.epicenter.test"
                && state["body"] as? String == "WORKER READY"
                && state["ran"] as? Int == 1
                && state["ready"] as? Bool == true
                && state["inline"] as? Int == 0
            if valid || attemptsLeft == 0 {
                print("PAGE", json)
                exit(valid ? 0 : 1)
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                self.checkPage(webView, attemptsLeft: attemptsLeft - 1)
            }
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        print("LOAD FAILED", error)
        exit(1)
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let probe = Probe()
probe.start()
app.run()
