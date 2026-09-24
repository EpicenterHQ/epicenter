# 0183. Epicenter mediates the effects it owns and names the rest unmediated

- **Status:** Accepted
- **Date:** 2026-07-27
- **Amends:** [ADR-0179](0179-an-installed-app-is-an-inert-built-folder-admitted-through-one-static-artifact-boundary.md) at one bounded clause: the native command surface reachable from an app window is no longer unrestricted HTTP and HTTPS through the Tauri HTTP plugin. Its static-artifact admission boundary, its full-trust ceremony, and its refusal of per-app permissions and prompts are unchanged and restated as still governing.
- **Amended by:** [ADR-0185](0185-trusted-app-http-uses-tauris-standard-transport-without-observation.md), which withdraws the "ordinary external network egress is host-mediated and audited" target below and restores ADR-0179's unrestricted Tauri HTTP grant. The reason was that Tauri exposes no supported hook to attribute a request to the invoking webview, so the gateway would have meant forking the plugin's fetch, streaming, cancellation, and cookie behavior for the sake of optional visibility. **Read that target as withdrawn, not pending.** What survives unchanged is the first rule: a host-owned `epicenter.*` capability still derives application identity at its own boundary, and the named limit below (same-origin HTTP cannot carry that identity today) still stands as a limit rather than a loophole. And by [ADR-0402](0402-a-window-label-is-identity-never-authority-and-the-capability-is-a-host-constant.md) at the target step that edits `capabilities/trusted-app-windows-*.json`: that file is replaced by one constant capability for every window, so the step, already withdrawn by ADR-0185, has no target.
- **Relates:** [ADR-0118](0118-epicenter-is-one-trusted-bun-hosted-spa-origin.md), [ADR-0181](0181-every-app-receives-one-portable-epicenter-capability-handle.md), [ADR-0180](0180-epicenter-has-one-host-owned-active-local-transcription-model.md)

## Context

ADR-0179 settled the trust model: an admitted app runs as Epicenter, admission
is the protection, and there is no per-app sandbox. It also granted app windows
unrestricted outbound HTTP through the Tauri HTTP plugin, on the reasoning that
a full-trust app could reach the network anyway.

Two facts discovered since pull in opposite directions, and both are verified in
this repository.

Direct browser egress from an app window is already closed. `apps/epicenter/src/server.ts`
sets a Content-Security-Policy on every response whose `connect-src` is
`'self' ipc: http://ipc.localhost`, which covers `fetch`, `XMLHttpRequest`,
`WebSocket`, `EventSource`, and `sendBeacon`. Navigation and new windows are
separately fenced to the exact loopback origin. So the wildcard HTTP plugin grant
is not one channel among many; it is the one unattributed way out, and the window
label that reaches a Tauri command is assigned by Rust and cannot be forged from
JavaScript. Attribution of ordinary network egress is close at hand.

A complete audit is not. On macOS the webview grants microphone and camera
capture unconditionally inside a dependency (`wry-0.55.1`'s
`requestMediaCapturePermissionForOrigin` calls the decision handler with
`Grant`, with no hook for the host), and `RTCPeerConnection` is outside what
`connect-src` governs, so WebKit platforms retain a live egress channel that CSP
cannot reach. Separately, every app shares one browser origin, so a request to a
host HTTP route carries the shared session and no application identity.

Without a decision the project drifts one of two ways: claiming an audit that
leaks, or leaving nearly free attribution unclaimed because the audit cannot be
total.

## Decision

Epicenter mediates the effects it owns, attributes them to the app that caused
them, and names the effects it does not mediate rather than implying it does.
The three parts hold at different strengths, and the difference is the decision.

### Guaranteed: Epicenter-owned capabilities are mediated and attributable

Every `epicenter.*` operation crosses a boundary Epicenter owns. That boundary
derives the application's identity from the invoking window or runtime, never
from anything the caller supplies, and it can append a durable audit entry.

The capability handle of ADR-0181 does not exist yet, so this governs how it is
built rather than describing what ships today. A capability whose transport
cannot carry host-derived identity does not satisfy this rule and is not a
finished capability. Tauri IPC carries it today, because the window label is
Rust-assigned. Same-origin HTTP does not, which is a named limit below and not a
loophole to build through.

Trusted admission decides what code may run. It does not mean that code's
effects bypass the host boundary. Those are separate questions, and ADR-0179
answers only the first.

### Target: ordinary external network egress is host-mediated and audited

Ordinary external HTTP and HTTPS from an installed desktop app should be
transparently host-mediated and logged with the same attribution.

**This does not exist today, and this record does not claim it does.** It names
the target and the clean break it requires:

- Remove the `http:default` wildcard from
  `capabilities/trusted-app-windows-{development,production}.json`. That grant is
  the amended clause of ADR-0179 and does not survive alongside this decision.
- Add one host gateway command that derives the app identity from the invoking
  window, forwards the request, and records it.

Enforcement is the Content-Security-Policy; ergonomics is a plain
fetch-compatible shim so app code keeps writing ordinary `fetch`. The order
matters and is not interchangeable. An app that defeats the shim, which it can,
recovers a function the CSP still blocks. The shim is a convenience over a
boundary that holds without it, never the boundary itself. Because the shim is
transparent rather than a new verb, this needs no `epicenter.net` namespace and
leaves ADR-0181's namespace-admission rule untouched.

There are no per-invocation prompts and no destination allowlists or denylists.
Both would reintroduce per-app permission, which ADR-0179 rejected for the good
reason that it advertises a boundary that does not exist. The rule is to record,
not to gate.

### Refused: the phrase complete effect audit

Epicenter does not claim that all application effects, or all network channels,
are mediated. The following are limits, not omissions, and they are named here
so that no later record has to discover them:

- **Browser media capture.** On macOS an app window's `getUserMedia` is granted
  by the webview with no host involvement. Windows prompts per origin and Linux
  most likely refuses, so the behavior is three different answers and none of
  them is Epicenter's. `epicenter.recording.*` over the host's own capture path
  is the supported and audited route; the browser path is neither.
- **WebRTC on WebKit platforms.** `RTCPeerConnection` is outside `connect-src`,
  so it remains reachable where the platform does not honor a blocking
  directive. Microphone capture plus a peer connection is therefore a live,
  unaudited path on the platform Epicenter primarily targets.
- **Same-origin host routes.** Apps share one origin and one session, so a
  request to a host route is attributable to Epicenter and not to the app that
  made it. Making it attributable would require a per-app origin, which reopens
  ADR-0118 and is deliberately not decided here.

Any claim of the form "everything an app does goes through Epicenter" is false
and must not be made. The honest claim is the two guarantees above, each with
its scope stated.

### What an audit entry records

Illustrative, to fix the shape of the promise rather than a storage schema:
application id, operation, timestamp, and outcome; for a network request also the
method, the destination origin and path, the response status, and byte counts
where known. Headers, bodies, and query strings are excluded by default, because
secrets travel in query strings and a log that captures them is a new hazard
rather than a record.

The append path is host-owned. App-visible inspection most likely belongs to
Home, which already owns administration surfaces. Storage format, retention,
export, and whether audit data participates in sync are all deferred; this record
deliberately chooses none of them.

## Consequences

- The wildcard HTTP grant is now a stated debt with a named replacement, rather
  than a settled property of full trust.
- Epicenter can describe its network behavior in one sentence a user can check,
  at the cost of that sentence carrying a printed exception for WebRTC.
- The capability handle acquires an admission test it did not have: a capability
  is not finished until its boundary can attribute it.
- Refusing per-invocation prompts and destination gates means an admitted app
  can still reach any destination it likes. What changes is that the reach is
  recorded and attributable, not that it is narrower.
- Recording through the host path and recording through the browser now differ in
  a way that is visible in the record: one is audited, the other is not. That
  asymmetry is a reason to keep the host path primary.
- Naming the macOS media-capture limit creates an upstream target. Routing wry's
  media-capture decision through a host-supplied handler would convert that limit
  from permanent to fixed, and it belongs upstream rather than in a fork.
- `apps/epicenter/AGENTS.md` currently states that there is no per-app device
  prompt. That is a per-platform claim, not a universal one, and it needs
  qualifying when the implementation wave lands.

## Considered alternatives

- **Log only `epicenter.*` and call it a capability activity log.** Rejected: it
  is complete only because it logs an API rather than effects, and it leaves the
  one real egress hole unattributed when closing it costs one grant and one
  command.
- **Claim a complete effect audit.** Rejected: refuted by a microphone capture
  plus a peer connection on macOS, which is three lines of app code and entirely
  outside anything Epicenter can observe.
- **Add an `epicenter.net.fetch` namespace.** Rejected: a transparent `fetch`
  shim keeps app code portable, which is what ADR-0181 promises, and avoids
  reopening its rule that implementation categories do not become namespaces.
- **Gate destinations with an allowlist.** Rejected: per-app permission wearing a
  different hat, and ADR-0179 already rejected that with reasoning this record
  has no cause to revisit.
- **Give each app its own loopback port and origin.** Rejected here, not
  forever: it is the only shape that makes same-origin host calls attributable,
  and it would make the existing CSP a per-app boundary for free, but it reopens
  the one-trusted-origin decision of ADR-0118 and the full-trust model of
  ADR-0179. It deserves its own record rather than a clause in this one.
- **Delete the shim and expose only a host command.** Rejected: app code would
  encode a desktop-only seam, and the CSP already fails closed without the shim,
  so the ergonomic loss buys no enforcement.
