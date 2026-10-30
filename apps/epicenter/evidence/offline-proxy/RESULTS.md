# Results: host-owned offline transport on macOS

Observed on macOS 26.5.2 with the fixture in this directory. All three commands in
[README.md](README.md) returned zero. The files in `.tmp/` are generated and
ignored by Git.

## Native HTTPS proxy

The online WebView loaded `https://probe.epicenter.test/` through a dedicated
`WKWebsiteDataStore`. The proxy validated a different upstream certificate,
recorded `/`, `/app.js`, and `/worker.js`, and kept their HTTP headers. After
stopping both processes, a newly started proxy replayed the files with the
upstream stopped. A fresh Swift process used an empty, nonpersistent WebView
store, so WebKit's own cache could not supply the result.

| Case | Observed result |
| --- | --- |
| Online | `origin=https://probe.epicenter.test`, `WORKER READY`, `ready=true`, `inline=0` |
| Cold offline replay | Same result from the three recorded responses |
| Wrong proxy certificate pin | WebView rejected server trust; navigation failed |
| Wrong upstream certificate | Proxy reported `DEPTH_ZERO_SELF_SIGNED_CERT`; app did not start |

The inline script was blocked by the fixture's HTTP
`Content-Security-Policy: script-src 'self'`. The module Worker started online
and after cold replay. A separate `curl` check of an online blind CONNECT to
`https://example.com/` returned HTTP 200 with ordinary certificate validation;
the offline probe does not permit that tunnel.

This native probe proves one fixed-host transport path. The handwritten proxy does not
implement general HTTP, cookies, redirects, WebSockets, response variation,
range requests, authenticated traffic, or safe cache replacement. It does not
itself prove Tauri Folder IPC or navigation. The Tauri gate below tests those
separately. Neither probe covers offline third-party assets.

## WebArchive counterexample

The separate WebArchive probe served HTML and JavaScript with `Cache-Control:
no-store`. The original URL failed after the server stopped. An archive whose
main resource was repaired to the original HTML did run the module script at
the original `location.origin`, but its Worker failed. It also lost the HTTP
CSP: the forbidden inline script ran offline (`inline=1`), although it was
blocked online (`inline=0`). Plain `loadSimulatedRequest` did not load the
external JavaScript offline and also lacked the CSP header.

The tested archive therefore cannot be Epicenter's general replay mechanism
while that origin receives Folder access. The Swift probe did not exercise
Folder IPC. Repairing its serialized DOM did not preserve the publisher's CSP;
the failed Worker shows a further resource gap in this archive.

## Tauri integration gate

`bun apps/epicenter/evidence/offline-proxy/run-tauri.ts` built the
`hosted_site_offline` example and passed all three phases on this machine. The
driver saves detailed reports under ignored `.tmp/tauri-<phase>.json`. It used
the real `hosted_sites::open` path and a feature-gated transport hook; the hook
is experiment-only and does not run in the normal host build.

| Phase | Observed result |
| --- | --- |
| Online | The original HTTPS origin loaded with Worker ready and inline script blocked by CSP. The page read a host-seeded Folder file, wrote another file, and reloaded on its own origin. Its persistent WebView store had one proxy; the built-in Folders window used the default store without one. |
| Cold offline | A new Tauri process loaded the same page and Worker from recorded responses while the upstream was stopped. It read the file written online, wrote another, and recovered its online `localStorage` value. The proxy logged replay of `/`, `/app.js`, and `/worker.js` for both initial load and reload. |
| Wrong pin | The certificate challenge was rejected, the page did not load, the proxy served no recorded page, and the Folder area stayed unchanged. |

Online and offline, the protected site stayed at its origin when it attempted
to navigate to a controlled foreign URL. The foreign server received no request
from that site. After the site window closed, an example-only window reused its
label and bound Folder but loaded the same foreign URL successfully. Its IPC
bridge was present. Both Folder read and write returned Tauri's native ACL
denial, naming the foreign URL and the sole allowed HTTPS origin; the attempted
file did not appear. This separates top-level origin permission from navigation
policy. Cross-origin subframe IPC remains untested.

The test modified Wry's existing delegate class at runtime to add certificate
pinning without replacing its navigation callbacks. That is sufficient for the
fixture and unsuitable as a product integration point. The product needs a
maintained Wry hook and must rerun this gate through it. The proxy is also a
fixture: it switches explicitly between recording and replay, has no automatic
network-failure fallback, and does not support ordinary authenticated HTTP,
CDN resources, redirects, range requests, streaming, WebSockets, or atomic
release replacement. The built-in window's separate configuration was observed;
default TLS handling in a newly opened unpinned window was not exercised.
The popup check observes only that `window.open` returned `null` and no new
window appeared; it does not observe which native callback made that decision.
