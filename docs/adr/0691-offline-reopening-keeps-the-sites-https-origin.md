# 0691. Offline reopening keeps the site's HTTPS origin

- **Status:** Proposed
- **Date:** 2026-10-24
- **Renumbered from:** ADR-0689 after the trunk's local-write ADR took that number.
- **Revisits:** [ADR-0687](0687-opening-a-site-url-opens-its-derived-folder.md)'s publisher service-worker requirement.
- **Evidence:** [macOS native and Tauri integration probes](../../apps/epicenter/evidence/offline-proxy/RESULTS.md).
- **Unbuilt:** Maintained Wry trust hook; production proxy and response store; non-macOS behavior.

## Context

Opening a URL already chooses both the code publisher and the folder the site
can edit. Requiring a second Epicenter release archive or registry makes the
website use two distribution paths. Requiring every publisher to implement a
service worker keeps distribution ordinary, but makes offline reopening the
publisher's work. The desired desktop behavior is for Epicenter to retain code
that a site actually loaded, so the site can reopen without network access.

An ordinary website may load code only after a particular action and may need
an online service to start or do work. Epicenter cannot infer code it has never
seen or invent a server response. The narrower goal is to reopen previously
loaded site resources needed for startup. Once the page starts, local Folder
operations can remain available. It cannot promise that every page or operation of any website works
offline. A site that needs unobserved lazy modules or online server responses
may still fail to start or work offline.

## Proposed direction

Keep the site's `https://` URL as the WebView's actual origin online and
offline. Keep the existing `remote(site.origin())` Folder permission, window
binding, and same-origin navigation rule. Keep captured website responses in
Epicenter's application storage, separate from the Git-backed authored folder.
The publisher need not serve an Epicenter file, manifest, archive, or worker.
A standard service worker remains optional for the ordinary browser.

On macOS, investigate one app-local HTTPS recording and replaying proxy per
open site. A site-specific WebView data store uses that proxy. It terminates
TLS only for its site's hostname; other hosts use ordinary TLS tunnels online.
That initial boundary does not capture third-party modules or CDN assets for
offline use. Whether and how to capture those hosts remains a separate design
decision.
The site WebView accepts only that proxy's short-lived, exact certificate for
that hostname. The proxy validates the publisher's certificate upstream using
normal trust rules. It records eligible response bytes **with their HTTP
headers** and can replay them when the upstream cannot be reached. An invalid
upstream certificate must never supply new response bytes. The probe returns
an error in that case; whether a previously validated recording may be replayed
is a separate product decision. It does not
install a certificate authority into the system trust store. The exact
eligibility, freshness, privacy, and atomic replacement rules require a
separate design and tests before product use.

The certificate and upstream validation are part of the Folder security
boundary: a mistake in either could let other code run with the site's folder
permission. A proxy is a browser networking subsystem, not a small cache
helper. The macOS native and Tauri probes establish a fixed-host path with
preserved CSP, a module Worker, real Folder IPC, exact-origin denial, and
navigation restrictions. They do not establish a maintainable trust hook or
general website capture. Product wiring waits for those pieces.

## Alternatives tested

- WebKit's ordinary HTTP cache did not cold-open a no-store document. Its
  contents also follow publisher cache headers and WebKit's eviction policy,
  so it cannot supply a host-owned reopening promise.
- `loadSimulatedRequest` supplied the top-level HTML at the original URL, but
  did not supply its external script offline.
- WebArchive replayed a module after replacing the archive's mutated DOM with
  source HTML, but the tested archive did not capture its Worker and discarded
  the site's HTTP CSP. It ran an inline script that the publisher forbade
  online while keeping the original origin. That is the origin to which
  Epicenter would grant Folder access; the Swift probe did not test Folder IPC.
  The CSP failure alone rules this archive path out as general replay.
- Serving a saved copy from an Epicenter scheme changes origin, cookies,
  IndexedDB, CSP `self`, absolute URLs, and the Folder permission match. That
  would be a different product contract.
- A standard PWA is simpler and works in browsers as well. It meets the goal
  of no **Epicenter-specific** publishing protocol, but makes the publisher
  responsible for offline code. It remains the smaller alternative if the
  host-owned requirement changes.

## Gate and consequences

The fixed-host Tauri integration gate passed on macOS 26.5.2 with Wry 0.57:
a site-specific persistent WebView store used the proxy, while Epicenter's
built-in window kept its default unproxied store. Cold offline reopening
preserved the original HTTPS origin, CSP, a module Worker, Folder read/write,
and `localStorage`. The protected window refused navigation to a controlled
foreign page. An example-only window then loaded that page with the same label,
Folder binding, and origin-limited runtime capability; Tauri denied its Folder
read and write calls from that foreign top-level origin. Cross-origin subframe
IPC remains untested. A wrong proxy certificate was rejected. The
separate native probe rejected an invalid upstream certificate.

This ADR remains Proposed. The gate adds a method to Wry's Objective-C delegate
class at runtime, which is suitable only for an experiment. Product use needs
a maintained trust hook, an explicit capture policy for redirects, cookies,
authentication, WebSockets, cross-origin assets, and service workers; a
response store with freshness and atomic replacement rules; network-failure
fallback; and a decision about existing WebView storage when moving a site to
a dedicated store. The fixture only records three same-origin GET resources
and explicitly switches to replay mode. It cannot establish that an arbitrary
website or unobserved route works offline.

The host must not silently switch to a second origin or weaken certificate
validation. Publisher-owned PWA offline support remains the smaller
alternative if the host-owned requirement changes.
