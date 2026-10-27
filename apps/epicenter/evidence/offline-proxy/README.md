# Offline site transport probe

This is a macOS WebKit experiment, not an Epicenter proxy implementation. It
tests whether the desktop host can record and replay an ordinary HTTPS page
without changing the page's origin or asking the publisher for a release file
or service worker.

Run from the repository root on macOS 14 or later:

```sh
bun apps/epicenter/evidence/offline-proxy/run.ts
bun apps/epicenter/evidence/offline-proxy/run-archive.ts
```

`run.ts` generates two unrelated, short-lived certificates under the ignored
`.tmp/` directory, starts a local HTTPS fixture and a local HTTP CONNECT proxy,
then launches a fresh `WKWebView` process for each case. The fixture requests
three GET resources, which the proxy records. The proxy is deliberately limited to one hostname,
one HTTP request per connection, and a path-keyed JSON store. Do not reuse it
for application traffic. The offline phase stops the upstream and refuses all
other hosts. The final cases reject an incorrect proxy certificate and an
incorrect upstream certificate.

`run-archive.ts` passes its Bun executable to `archive-probe.swift`, which
runs the contrasting WebArchive experiment: source HTML
repair makes a module start, but the same-origin Worker fails and the archive
runs an inline script forbidden by the publisher's HTTP CSP.

## Tauri gate

```sh
bun apps/epicenter/evidence/offline-proxy/run-tauri.ts
```

This runs the same fixture through a real Tauri site window. It builds the
`hosted_site_offline` example of `apps/epicenter/src-tauri` with the
experiment-only `hosted-site-offline-gate` feature, which enables
`tauri/macos-proxy`. The example opens the site through the production
`hosted_sites::open`, so the window gets the exact-origin Folder grant,
same-origin navigation, refused new windows, and refused permissions. With the
feature and a gate `Transport`, `open` also gives the window
`proxy_url(http://127.0.0.1:38474)` and a `data_store_identifier` derived from
the hostname and a per-run salt.

Wry has no hook for authentication challenges. The feature adds
`webView:didReceiveAuthenticationChallenge:completionHandler:` with
`class_addMethod` to Wry's existing delegate class. It finds that class from
the built-in window's live `WKWebView`: `navigationDelegate`, then
`object_getClass`, skipping any KVO subclass. It requires the delegate to
decide navigation policy, and installs before the site WebView is built. It
refuses to install if that class already implements the method. Each report
names the class and whether the site's delegate answers challenges.
For a pinned store and host, it accepts only a server-trust challenge whose
leaf certificate DER equals the pin. It cancels anything else for that host,
and leaves every other store and host to WebKit's default handling. It adds no
system trust and does not replace Wry's delegate. A product proxy needs a real
Wry hook.

The driver runs the example three times, each in a fresh process:

| Phase | Proxy | Asserts |
| --- | --- | --- |
| `online` | records from the upstream | page at `https://probe.epicenter.test`, Worker ready, inline script blocked; pin matched; exact Folder read of a host-seeded file and an `absent` write; `../` escape, `plugin:app` and `plugin:webview` refused; navigation to `about:blank` and to the foreign URL keeps the page, and the foreign URL is never requested; `window.open` returns `null` and no window is created; same-origin reload loads; site store has the derived identifier and one proxy; built-in window stays on the default store without a proxy; then the foreign-origin control |
| `offline` | replay only, upstream stopped | the same, from replayed responses only, including the control; it reads the file the online page wrote, and reads back the online page's `localStorage` from the persistent store |
| `wrong-pin` | replay only | the pin is the upstream certificate; WebKit's challenge is cancelled, the page never loads, the proxy serves nothing, and the area is unchanged; the run's WebKit store is then removed |

The foreign URL is `http://127.0.0.1:38476/foreign`, served by `foreign.ts`,
which logs every TCP connection it accepts. If the site's navigation were
allowed, WebKit would reach it either directly, which `foreign.ts` would log,
or as a tunnel `proxy.ts` refuses and logs. The driver fails on either. That
separates a policy refusal from a load that merely failed or stalled.

The foreign-origin control is example-only code. After the site window closes
and its binding is released, the example builds a window through
`open_folder_window` with the same `site` label and folder directory. So it
gets the same binding, and the site's runtime `remote(https://probe.epicenter.test)`
capability, which Tauri never removes. It skips the production navigation
filter and loads the foreign URL. The control must load that page with a
page-load `finished` callback and a new connection to `foreign.ts`. It must
see `location.origin` as `http://127.0.0.1:38476` and have Tauri's `invoke`.
Its `read_folder_file("seed.txt")` and `put_folder_file("foreign.txt")` calls
must each fail with Tauri's ACL refusal for that command and label. Tauri
reports the calling origin's URL (`http://127.0.0.1:38476/`) and an `allowed
on` list holding only the site's grant:
`epicenter-folder.<command> not allowed on window "<label>", webview
"<label>", URL: http://127.0.0.1:38476/` followed by `allowed on: [windows:
"<label>", URL: https://probe.epicenter.test]`. A missing bridge, plugin,
command, or binding answers differently and fails the check. The file must not appear. The popup check observes only the
page's `null` and Tauri's window count, not the production new-window
callback.

Each phase writes `.tmp/tauri-<phase>.json`. The folder area and WebKit data
live under `.tmp/tauri/` and in this run's WebKit store, which the last phase
deletes.

See [RESULTS.md](RESULTS.md) for the observed results and the Tauri integration
checks that remain.
