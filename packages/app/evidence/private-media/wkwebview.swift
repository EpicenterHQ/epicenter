import Cocoa
import WebKit
class Probe: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
 var web: WKWebView!
 var window: NSWindow!
 func start() {
  let config = WKWebViewConfiguration()
  config.mediaTypesRequiringUserActionForPlayback = []
  config.userContentController.addUserScript(WKUserScript(source: "window.addEventListener('error',e=>webkit.messageHandlers.evidence.postMessage('ERROR: '+e.message));window.addEventListener('unhandledrejection',e=>webkit.messageHandlers.evidence.postMessage('REJECTION: '+e.reason))", injectionTime: .atDocumentStart, forMainFrameOnly: true))
  config.userContentController.add(self, name: "evidence")
  web = WKWebView(frame: NSRect(x: 0, y: 0, width: 500, height: 300), configuration: config)
  window = NSWindow(contentRect: web.frame, styleMask: [.titled], backing: .buffered, defer: false)
  window.contentView = web
  window.makeKeyAndOrderFront(nil)
  web.navigationDelegate = self
  let url = URL(string: CommandLine.arguments[1])!
  if CommandLine.arguments.count > 2 {
   let pair = CommandLine.arguments[2].split(separator: "=", maxSplits: 1)
   let cookie = HTTPCookie(properties: [.name: String(pair[0]), .value: String(pair[1]), .domain: url.host!, .path: "/"])!
   config.websiteDataStore.httpCookieStore.setCookie(cookie) { self.web.load(URLRequest(url: url)) }
  } else { web.load(URLRequest(url: url)) }
 }
 func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
  print(message.body); NSApplication.shared.terminate(nil)
 }
 func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
  webView.evaluateJavaScript("let probeTimer=setInterval(()=>{if(!globalThis.mediaEvidence)return;clearInterval(probeTimer);mediaEvidence.run().then(r=>webkit.messageHandlers.evidence.postMessage(JSON.stringify(r)),e=>webkit.messageHandlers.evidence.postMessage(String(e)))},100)") { _, error in if let error = error { print(error) } }
 }
}
let app = NSApplication.shared
let probe = Probe(); probe.start()
DispatchQueue.main.asyncAfter(deadline: .now() + 60) {
 probe.web.evaluateJavaScript("JSON.stringify({url:location.href,progress:globalThis.mediaProgress,ready:!!globalThis.mediaEvidence})") { value, error in
  print("WKWebView timeout: \(value ?? error as Any)"); app.terminate(nil)
 }
}
app.run()
