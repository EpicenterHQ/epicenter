# 0095. WebSocket room auth uses route-owned subprotocol bearers

- **Status:** Accepted
- **Date:** 2026-07-02
- **Amended by:** [ADR-0166](0166-data-document-sync-and-agent-replace-workspace.md) (route-owned bearer extraction survives for authenticated document and attach WebSockets; the deleted room route and RoomCore do not)
- **Relates:** [ADR-0053](0053-the-epicenter-bearer-is-an-audience-scoped-credential.md), [ADR-0075](0075-self-host-is-a-single-partition-instance-behind-one-operator-supplied-bearer.md), [ADR-0079](0079-cross-device-is-two-planes-epicenter-syncs-the-crdt-the-box-is-reached-directly.md), [ADR-0092](0092-identity-is-the-partition.md)

## Context

Browser WebSocket clients cannot attach an `Authorization` header through the
standard constructor, but Epicenter sync still needs one authenticated room
transport across browser, extension, Tauri, Bun, Cloudflare, hosted, and
self-hosted clients. The old normalization shape lifted a
`bearer.<token>` WebSocket subprotocol into `Authorization` by rebuilding
`c.req.raw`, which broke Bun's upgrade requirement that the original
runtime-minted `Request` reach `server.upgrade()`. Preserving that request with
an Env stash fixed the symptom while keeping the wrong owner: a middleware made
WebSocket auth look like HTTP auth even though rooms are the only WebSocket
surface and are bearer-only.

## Decision

Room WebSocket auth uses the `Sec-WebSocket-Protocol` bearer carrier, but the
rooms route owns extraction. Browser clients offer `epicenter` and
`bearer.<token>` through `auth.openWebSocket`; non-browser clients may send an
explicit `Authorization` header, which wins. If `Authorization` is absent, the
rooms route accepts exactly one non-empty `bearer.<token>` subprotocol and
passes the bare token to the deployment's bearer resolver.

The route does not rewrite `c.req.raw`, does not delete ambient headers, and
does not stash an original request in Env. Backends receive the untouched
runtime request and sanitize negotiation so every `101` response echoes only
the real `epicenter` subprotocol, never the bearer token. Reject paths also echo
`epicenter` when the client offered it, so browsers surface application close
codes such as `4401` and `4503` instead of failing the handshake before the
client can classify the error.

Auth at upgrade is not the revocation mechanism by itself. RoomCore bounds each
connection to 30 minutes and closes over-age sockets with `4408`, forcing a
fresh authenticated upgrade. With hosted OAuth's 10-minute access token TTL, the
post-revocation window is approximately token TTL plus the 30-minute connection
bound, plus idle sweep slop for quiet sockets.

## Consequences

`normalizeWebSocketAuth`, the request rewrite, the `wsUpgradeRequest` Env field,
and middleware-order coupling disappear. The WebSocket credential rule lives at
the one route that needs it, and the bearer resolver receives the credential as
data instead of re-reading headers. Bun and Cloudflare backends share the same
security contract: accept or reject with an `epicenter` echo and never reflect
`bearer.<token>`.

The trade-off is that `Sec-WebSocket-Protocol` can contain a bearer-equivalent
secret. This is still preferable to a URL query token because URLs are logged by
default in common proxies and edge logs, while WebSocket subprotocol headers
usually require explicit logging. Self-host deployments must document the
exception: some reverse proxies, including Caddy when access logging is enabled,
can log `Sec-WebSocket-Protocol` unless configured not to.

Revisit this decision if one of these facts changes:

- Epicenter's hosted or recommended self-host deployment path logs
  `Sec-WebSocket-Protocol` by default.
- The 30-minute connection lifetime bound becomes unacceptable.
- Hosted access token TTL grows materially.
- Bun or Cloudflare can no longer sanitize or echo subprotocols safely.
- One-use WebSocket ticket state becomes clearly cheaper than the current
  route-owned bearer design.

The daemon wake gap stays a follow-up. A daemon that parks because local auth
cannot attach a bearer may not wake when `epicenter auth login` rewrites the
machine auth file; fixing that is client wake policy, not a different WebSocket
credential carrier.

## Considered alternatives

- **Cookie-authenticated WebSockets.** Rejected: cookies fit same-origin
  dashboards but not extension, Tauri, CLI, daemon, and self-host token clients
  without introducing a second sync auth model.
- **Bearer token in the WebSocket URL query string.** Rejected: query strings are
  captured by default in access logs and monitoring systems.
- **First-message auth.** Rejected: the room principal and storage partition are
  resolved before backend handoff; accepting unauthenticated room sockets would
  add pre-auth state to the sync engine.
- **Short-lived one-use WebSocket tickets.** Deferred: tickets narrow replay
  after a leak, but every option still needs the connection lifetime bound for
  revocation. Tickets add minting and one-use state on both runtimes; build them
  only if the revisit triggers above fire.
