# 0945. An app may answer HTTP and WebSocket requests under its address

- **Status:** Proposed
- **Date:** 2026-11-17
- **Relates:** [ADR-0880](0880-an-epicenter-runs-its-apps-as-they-sit-on-disk.md) (code runs as it sits on disk), [ADR-0930](0930-an-action-call-is-a-function-call-and-serve-keeps-nothing-about-it.md) (serve keeps nothing about a call), [ADR-0936](0936-one-serve-per-home-runs-every-action.md) (one serve runs every action), [ADR-0927](0927-serve-listens-only-on-this-computer.md) (who reaches serve), [ADR-0860](0860-an-interface-is-a-view-over-an-apps-actions-and-never-knows-where-they-run.md) (a view calls actions).
- **Unbuilt:** all of it. The first thing to exist is a request to `/<app>/.http/` that `packages/cli/src/http.ts` hands to the app's `fetch`; today that path answers 404.

## Context

`epicenter serve` answers five kinds of request (`packages/cli/src/http.ts`):

```txt
POST /                MCP
GET  /                the launcher
GET  /<app>/<path>    the app's built UI, ui/dist/
GET  /<app>           308 to /<app>/
POST /<app>/<action>  an action call, answered as JSON lines
```

An app can only offer actions. An action takes JSON and answers JSON, which
covers what a person, an agent, or a page asks of most apps. It cannot carry
a protocol someone else defined: an OAuth redirect that arrives as a `GET`
with a query string, a file download with `Range`, or a WebSocket that stays
open and hears from other connections.

`Bun.serve` already takes a `fetch` function and a `websocket` object of
handlers, and keeps topics: a socket calls `subscribe(topic)` and the server
calls `publish(topic, data)`. Serve uses only `fetch` today.

## Decision

**An app's `defineApp` may add `fetch` and `websocket` in the shapes
`Bun.serve` takes them, and serve hands them every request under
`/<app>/.http/`.**

```ts
import { defineApp, publish } from '@epicenter/app';

export default defineApp({
  description: 'Shared notes',
  data,
  actions,
  fetch(request) {
    return new Response('ok');
  },
  websocket: {
    open(ws) { ws.subscribe(ws.data.url.pathname); },
    message(ws, message) { publish(ws.data.url.pathname, message); },
  },
});
```

- `fetch(request)` takes a web `Request` and returns a `Response` or a promise
  of one. The app reads its own path after `/<app>/.http`.
- `websocket` holds Bun's handler functions: `open`, `message`, `close` and
  `drain`. Each receives Bun's own `ServerWebSocket`, with `subscribe`,
  `unsubscribe`, `send` and `close`. `ws.data.url` is the URL the socket
  opened with. Serve performs the upgrade for a request under `/<app>/.http/`
  that asks for one.
- `publish(topic, message)` is exported from `@epicenter/app` beside `folder`.
  It sends to every socket subscribed to `topic`, the sender included, and
  works in any run: an action, `fetch`, or a `websocket` handler.
- `.http` cannot collide with what an app already has: an action's words
  start with a letter (`isName`), and the UI never serves a path part that
  starts with `.`.

**An app holds nothing between calls; the topics are serve's.** Each `fetch`
call and each `websocket` handler call loads the app's code as it is on disk
(ADR-0880) and runs in the same run an action gets, so `folder` and the app's
data work. `publish` is how one call reaches the sockets another call opened.

**`fetch` and `websocket` are HTTP only.** The command line and MCP do not
list them, their input is not checked, and their answers are not Results.
What a person or an agent should be able to do is an action.

**The guards in front of every request apply unchanged.** A request with a
tunnel header, a `Host` that is not private, or an `Origin` that is not its
own `Host` is refused before it reaches an app. A browser sends `Origin` on a
WebSocket upgrade, so another site cannot open a socket to the home.

## Consequences

- What an app builds on these is its own: server-sent events, a download, a
  callback, or a sync protocol. Serve knows none of them.
- An author who wants Elysia or Hono passes that app's `fetch`.
- Topics are not scoped to an app. Any app can publish to any topic, as any
  app can already read any app's files; an app names its topics so they do
  not meet another's.
- Bun's `websocket` settings (`maxPayloadLength`, `idleTimeout`,
  `publishToSelf`) belong to the one listener, so serve sets them and an app
  cannot.
- Loading the app for each WebSocket message has a cost that is unmeasured.
  Serve can skip the reload while no file under the app's `code/` has
  changed, with no change to any app.
- Topics end with serve. A client reconnects once serve is running again
  (ADR-0941).

## Considered alternatives

- **Elysia as the app's foundation**, as the object `defineApp` returns or as
  `new Elysia().use(epicenter({ data, actions }))`. Every app would depend on
  one framework's behavior and version, including apps that only have
  actions, and the command line and MCP would have to dig the action
  declaration back out of a route tree.
- **Epicenter's own socket and room names** (`socket.join`, `rooms.send`,
  scoped to an app). A second vocabulary over the one Bun has, which every
  Bun example and library already uses.
- **Apps hold memory between calls, and serve restarts when code changes.**
  Every code edit would interrupt every app's sockets, running actions would
  need a grace period, and serve would need a file watcher. Topics held by
  serve give apps the one thing that must stay in memory, the list of open
  sockets.
- **A decided sync design for shared documents.** No app needs one yet, and
  `fetch`, `websocket` and `publish` leave every such design open.
