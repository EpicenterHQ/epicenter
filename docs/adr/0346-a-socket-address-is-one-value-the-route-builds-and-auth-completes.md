# 0346. A socket address is one value the route builds and auth completes

- **Status:** Proposed
- **Date:** 2026-09-04
- **Unbuilt:** nothing. Built in `packages/sync/src/transport.ts`, `packages/sync/src/store-route.ts`, `packages/data/src/sync/attach.ts`, `packages/auth`, and `packages/server/src/store-sync/browser-dial.test.ts`.
- **Relates:** [ADR-0095](0095-websocket-room-auth-uses-route-owned-subprotocol-bearers.md) (why the bearer is a subprotocol at all), [ADR-0222](0222-a-host-owns-how-to-make-a-socket-and-the-library-owns-everything-done-with-one.md) (the host supplies the dial, the library owns what is done with the socket), [ADR-0340](0340-an-opened-store-knows-its-own-address-and-its-own-connection.md) (where `dataId`, `generation`, and `baseURL` are read from), [ADR-0092](0092-identity-is-the-partition.md) (why no partition ever reaches the query string)

## Context

The client-side dial was two values that had to agree, built in two places.
`STORE_SYNC_ROUTE.url(baseURL, { dataId, generation, cursor })` built the URL.
`STORE_SYNC_ROUTE.subprotocols(bearer)` built the list
`[MAIN_SUBPROTOCOL, 'bearer.<token>']`. `AuthClient.openWebSocket(url, protocols?)`
took both as parameters and appended the bearer itself.

`packages/data/src/sync/attach.ts` then declared its own structural port,
`StoreSocketTransport { openWebSocket(url: string | URL): Promise<WebSocket> }`,
with one parameter. It called that port with the URL alone. `strict` was on,
and it did not help: a function with an extra optional parameter is assignable
to one without it under any variance rule, so `AuthClient` satisfied the
narrower type and the second parameter disappeared with no error anywhere. The
parameter was optional in syntax and required in meaning, and no compiler
setting tells those apart.

Honeycrisp signed in and never synced. `packages/server/src/store-sync/mount.ts`
refuses an upgrade that offers subprotocols but does not include `epicenter`,
with a 400. The browser offered `bearer.<token>` and nothing else, so every
socket the app opened was refused before it reached the authority.

`subprotocols(bearer)` had exactly one caller, the workerd test replica in
`packages/server/workers/replica.ts`. The function whose job was to build the
offered list was never on the browser path at all.

The tests could not have caught this, because none of them ran the code that
builds the boundary. `packages/server/workers/e2e.test.ts` hand-wrote the
`Sec-WebSocket-Protocol` header string. `packages/data/src/sync/attach.test.ts`
faked the transport with a function that ignored protocols. Both constructed a
correct handshake instead of observing the one the app produces.

No prior ADR owned who assembles the dial. ADR-0095 decided the bearer travels
as a subprotocol, ADR-0222 decided the host supplies the dial, and ADR-0340
decided the store states its own address, and the gap between them is the
assembly step that dropped a value.

## Decision

**`@epicenter/sync` owns the client transport contract, and no consumer
redeclares it.** It lives in `packages/sync/src/transport.ts`, exported at the
subpath `@epicenter/sync/transport`:

```ts
type WebSocketAddress = {
	url: string;
	protocols: readonly [string, ...string[]];
};
type SocketTransport = {
	openWebSocket(address: WebSocketAddress): Promise<WebSocket>;
};
```

`protocols` is non-empty by TYPE. Bundling the list with the URL is what stops
a caller from dropping it; requiring a first entry is what stops an empty one
from reproducing the same refusal by a different route. An upgrade offering no
protocols is answered with the same 400 a page cannot see, so `[]` is not a
weaker dial, it is the bug again.

`OpenWebSocketDenial`, `SyncRefusal`, and `isOpenWebSocketDenial` move beside
them, because they are the failure half of the same contract. Their shape is
[ADR-0350](0350-a-data-session-is-a-value-the-tree-owns-and-sync-runs-for-the-life-of-the-store.md)'s:
a refusal carries a `SyncRefusal` code and nothing else, and the driver keeps
dialling. There is no `permanence`, because there is no stop to decide.

**The route builds the whole address and never knows a credential.**
`STORE_SYNC_ROUTE.address(baseURL, { dataId, generation, cursor })` returns the
`WebSocketAddress`, with `protocols: [MAIN_SUBPROTOCOL]`. `STORE_SYNC_ROUTE.url`
and `STORE_SYNC_ROUTE.subprotocols` are deleted. A route knows its own protocol
name; it has no token to put beside it.

**Auth completes the address.** `openWebSocket(address)` opens
`new WebSocket(address.url, [...address.protocols, bearerSubprotocol(token)])`.
`bearerSubprotocol(token)` and `formatSubprotocols(list)`, the inverse of
`parseSubprotocols`, live in `packages/sync/src/auth-subprotocol.ts` beside the
constants the server parses with.

**One parameter, one imported type.** `AuthClient.openWebSocket` is typed from
`SocketTransport`, and `attachStoreSync` takes a `SocketTransport`.
`StoreSocketTransport` is deleted. A narrower port is still expressible: a
method-shorthand port declaring `{ url }` alone accepts a real `SocketTransport`
under `strict`. What changes is the failure mode. Dropping an optional
parameter defaulted to an empty list and synced nothing, silently, forever.
Dropping a required property throws at the first dial. The guarantee comes
from both halves importing the type rather than writing it, and the object
makes the remaining mistake loud instead of silent.

**A test of this seam dials it rather than describes it.**
`packages/server/src/store-sync/browser-dial.test.ts` runs a real `AuthClient`
through `attachStoreSync`, records the list the constructor was offered, and
feeds that list to the real `mountStoreSyncApp` gate. The workerd two-device
test in `packages/server/workers/` runs `attachStoreSync` itself, over a
`SocketTransport` on `env.SELF.fetch`, so the convergence test takes the
browser's path rather than a second dial. No hand-written
`Sec-WebSocket-Protocol` string exists in the repository: that transport and
`e2e.test.ts` build the header with `formatSubprotocols` over the same
helpers.

Three invariants are unchanged and constrain everything above.

- The bearer travels as a subprotocol because a browser upgrade cannot set
  `Authorization` and a query string is captured whole by access logs
  (ADR-0095, restated in the `auth-subprotocol.ts` docstring).
- The server echoes only `epicenter` on the 101, never a protocol the client
  did not offer, and never the bearer (`mount.ts`).
- The query carries `dataId`, `generation`, and `cursor` and nothing that names
  a partition, because whose data it is comes from the resolved bearer
  (ADR-0092). Those three values are read off the opened store (ADR-0340), and
  the cursor is the replica's durably applied position so a reconnect is a
  catch-up (ADR-0222).

None of the three records is amended or superseded here. They decided the
credential's carrier, the socket's ownership, and the address's fields; this
decides who assembles them into one value.

## Consequences

A new socket route returns a `WebSocketAddress`, including its `protocols`. It
does not get to return a URL and leave the protocol list to whoever dials it.

An `AuthClient` implementation appends its bearer entry to `address.protocols`
and never replaces the list. Replacing it reproduces the 400 exactly, with the
same silence.

A test of this seam may not type a `Sec-WebSocket-Protocol` value. It builds
the header from `formatSubprotocols`, or it runs the transport and reads what
the constructor was handed. That is the difference between a test that agreed
with the bug and one that fails on it.

The cost is one import edge: `packages/data` and `packages/auth` both depend on
`@epicenter/sync/transport` for a type they previously wrote locally. Both
already depend on `@epicenter/sync`.

## Considered alternatives

**Widen `StoreSocketTransport.openWebSocket` to `(url, protocols?)` and have
`attach.ts` pass `[MAIN_SUBPROTOCOL]`.** It keeps two values that must agree
and builds them in two places, and an optional second parameter is exactly the
parameter a narrowed port drops without complaint. Property function syntax
would not catch it either, because the optional parameter is ignored for
assignability. That is the failure, spelled one layer higher.

**Keep `STORE_SYNC_ROUTE.subprotocols(bearer)` and have auth call it.** Auth
would have to know which route it is dialing to know which protocol list to
build. The bearer is auth's and the protocol name is the route's, and neither
side should hold the other's value.

**`openWebSocket(route, params)`, taking the route descriptor and the query
params so the transport builds everything.** The same coupling inverted: every
socket route in the system would have to fit one descriptor shape that the
transport knows how to expand, and auth would own URL construction it has no
reason to.

**A server that admits an offer without `epicenter`.** The mount already
admits an EMPTY offer, because a non-browser client carries its bearer in
`Authorization` and offers nothing, and that stays. What it refuses is a
non-empty offer that lacks `epicenter`, and admitting that would help nobody:
the server may echo only what was offered and never the bearer, so it would
answer such a handshake with no subprotocol, and a browser fails a handshake
whose offer went unanswered. The 400 is the same failure, reported earlier.