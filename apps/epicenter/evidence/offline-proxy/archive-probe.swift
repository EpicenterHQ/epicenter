import AppKit
import WebKit

final class Probe: NSObject, WKNavigationDelegate {
    let url = URL(string: "http://127.0.0.1:38473/")!
    let html = "<!doctype html><html><head><title>Probe</title></head><body><p id=\"status\">WAITING</p><script>window.__inline=1</script><script type=\"module\" src=\"/app.js\"></script></body></html>"
    let server = Process()
    let window = NSWindow(contentRect: NSRect(x: 80, y: 80, width: 600, height: 400), styleMask: [.titled, .closable], backing: .buffered, defer: false)
    var webview: WKWebView!
    var archive: Data?
    var stage = 0

    func finish(_ code: Int32) -> Never {
        if server.isRunning {
            server.terminate()
            server.waitUntilExit()
        }
        exit(code)
    }

    func start() {
        server.executableURL = URL(fileURLWithPath: ProcessInfo.processInfo.environment["EPICENTER_PROBE_BUN"]!)
        server.arguments = ["\(CommandLine.arguments[1])/archive-server.ts"]
        do { try server.run() } catch { print("SERVER ERROR", error); finish(1) }
        var listening = false
        for _ in 0..<50 {
            if (try? Data(contentsOf: url)) != nil { listening = true; break }
            Thread.sleep(forTimeInterval: 0.1)
        }
        if !listening { print("SERVER DID NOT START"); finish(1) }
        window.title = "Offline probe"
        window.makeKeyAndOrderFront(nil)
        nextWebview()
        print("ONLINE LOAD")
        webview.load(URLRequest(url: url))
        DispatchQueue.main.asyncAfter(deadline: .now() + 20) {
            print("TIMEOUT stage=\(self.stage)")
            self.finish(2)
        }
    }

    func nextWebview() {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = WKWebsiteDataStore.default()
        let view = WKWebView(frame: window.contentView!.bounds, configuration: config)
        view.navigationDelegate = self
        window.contentView = view
        webview = view
    }

    func printPage(_ label: String, then: @escaping () -> Void) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            self.webview.evaluateJavaScript("JSON.stringify({origin:location.origin,body:document.body.innerText,ran:window.__ran||0,ready:!!window.__ready,inline:window.__inline||0})") { value, error in
                print(label, value ?? "nil", error?.localizedDescription ?? "")
                guard let json = value as? String,
                      let data = json.data(using: .utf8),
                      let state = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      state["origin"] as? String == "http://127.0.0.1:38473" else { self.finish(1) }
                let body = state["body"] as? String
                let ran = state["ran"] as? Int
                let ready = state["ready"] as? Bool
                let inline = state["inline"] as? Int
                if label == "ONLINE" && !(body == "WORKER READY" && ran == 1 && ready == true && inline == 0) { self.finish(1) }
                if label == "SIMULATED" && !(body == "WAITING" && ran == 0 && ready == false && inline == 1) { self.finish(1) }
                if label == "WEBARCHIVE" && !(body == "WORKER FAILED" && ran == 1 && ready == false && inline == 1) { self.finish(1) }
                then()
            }
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if stage == 0 {
            printPage("ONLINE") {
                webView.createWebArchiveData { result in
                    switch result {
                    case .success(let data):
                        do {
                            let saved = WebArchive(data: data)!
                            let old = saved.mainResource!
                            let original = WebResource(data: self.html.data(using: .utf8)!, url: old.url, mimeType: old.mimeType, textEncodingName: old.textEncodingName, frameName: old.frameName)
                            let repaired = WebArchive(mainResource: original, subresources: saved.subresources, subframeArchives: saved.subframeArchives)!
                            self.archive = repaired.data
                            print("ARCHIVE BYTES", data.count, "REPAIRED BYTES", self.archive!.count, "SUBRESOURCES", saved.subresources.count)
                        } catch { print("ARCHIVE REPAIR ERROR", error) }
                    case .failure(let error): print("ARCHIVE ERROR", error)
                    }
                    self.server.terminate()
                    self.server.waitUntilExit()
                    self.stage = 1
                    self.nextWebview()
                    print("OFFLINE URL LOAD")
                    self.webview.load(URLRequest(url: self.url))
                }
            }
        } else if stage == 1 {
            print("UNEXPECTED OFFLINE URL SUCCESS")
            finish(1)
        } else if stage == 2 {
            printPage("SIMULATED") { self.loadArchive() }
        } else if stage == 3 {
            printPage("WEBARCHIVE") { self.finish(0) }
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        print("LOAD FAILED stage=\(stage)", error.localizedDescription)
        if stage == 1 { simulate() }
        else if stage == 2 { loadArchive() }
        else { finish(3) }
    }

    func simulate() {
        stage = 2
        nextWebview()
        print("SIMULATED LOAD")
        webview.loadSimulatedRequest(URLRequest(url: url), responseHTML: html)
    }

    func loadArchive() {
        stage = 3
        guard let archive else { print("NO ARCHIVE"); finish(4) }
        nextWebview()
        print("WEBARCHIVE LOAD")
        webview.load(archive, mimeType: "application/x-webarchive", characterEncodingName: "utf-8", baseURL: url)
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let probe = Probe()
probe.start()
app.run()
