# 0945. An app may answer web requests at its address with `fetch`

- **Status:** Proposed
- **Date:** 2026-11-17
- **Unbuilt:** all of it. The first thing to exist is a request under `/apps/<app>/` that `packages/app/src/command/http.ts` hands to the app's `fetch`.
- **Relates:** [ADR-0966](0966-serve-keeps-action-calls-outside-an-apps-address-which-is-apps-name.md) (an app's address is `/apps/<app>/`), [ADR-0960](0960-an-app-is-a-function-of-its-folder-and-a-call-has-no-hidden-context.md) (an app is a function of its folder), [ADR-0959](0959-serve-loads-each-app-once-and-an-apps-code-changes-when-serve-restarts.md) (when an app is loaded), [ADR-0927](0927-serve-listens-only-on-this-computer.md) (who reaches serve), [ADR-0860](0860-an-interface-is-a-view-over-an-apps-actions-and-never-knows-where-they-run.md) (a page calls actions).

## Context

An app could only offer actions. An action takes JSON and answers JSON,
which covers what a person, an agent or a page asks of most apps. It cannot
carry a protocol someone else defined: an OAuth redirect that arrives as a
`GET` with a query string, a file download with `Range`, a feed a reader
polls, or a form upload.

A first draft of this record gave an app `fetch`, `websocket` and a
`publish(topic, message)` under `/<app>/.http/`. `publish` existed because
serve loads an app again for each call, so nothing in an app outlives one
call; it also missed every writer that edits a file directly. No app needs a
socket. ADR-0966 moved action calls out of the app's address, so nothing in
it is reserved.

Serve refused a request whose `Origin` was not its own `Host`. A browser
sends no `Origin` on a plain cross-site `GET`, such as an `<img>` on another
site the owner visits, so that request reached serve. Every action is a
`POST`, so no such request could change anything. A `fetch` that answers
`GET` changes that.

## Decision

**The function `defineApp` takes may return `fetch` beside `description`,
`data` and `actions`. Serve hands it every request under `/apps/<app>/` that
no built file answers.**

```ts
import { defineApp } from '@epicenter/app';
import { Hono } from 'hono';

export default defineApp(({ folder }) => {
  const web = new Hono();
  web.get('/oauth/callback', async (c) => {
    await folder.write('local/token.json', JSON.stringify({ code: c.req.query('code') }));
    return c.redirect('../');
  });

  return { description: 'Mail', actions: {}, fetch: web.fetch };
});
```

- **`fetch` is `(request: Request) => Response | Promise<Response>`.** The web
  standard shape, so a Hono or Elysia app's `fetch` passes as it is. It
  reaches the folder by closing over `folder`; the library exports nothing
  for it to import. `appProblems` in `packages/app/src/app.ts` refuses a
  `fetch` that is not a function.
- **Files first, then `fetch`, then 404.** For a `GET` or `HEAD`, serve
  answers a file in `code/ui/dist/` when there is one (ADR-0944). Any other
  request under `/apps/<app>/`, of any method, goes to the app's `fetch`, and
  an app without one answers 404. A path part that starts with `.` is never a
  file, so `/apps/<app>/.well-known/...` reaches `fetch`.
- **The app sees its own path.** Serve removes `/apps/<app>` from the URL it
  hands over, so `/apps/mail/oauth/callback` arrives as `/oauth/callback` and
  the app keeps working after its folder is renamed. Serve sets
  `X-Forwarded-Prefix: /apps/<app>`, replacing any the client sent, for an
  app that writes absolute links. The method, headers and body pass
  unchanged.
- **The body limit is serve's.** Bun refuses any request body over 25 MB
  (`MAX_INPUT_BYTES` in `packages/app/src/command/http.ts`) with 413, for
  `fetch` as for actions.
- **A failure is a 500.** A `fetch` that throws, or returns something that is
  not a `Response`, answers 500, and serve logs one line naming the app. An
  app that does not load answers 500 with its problems, for a path no file
  answers.
- **`fetch` is loaded like an action.** Serve loads the app for each request
  that reaches `fetch`, as it does for each call, until ADR-0959 loads each
  app once.

**`fetch` is for protocols someone else defined. Anything a person or an
agent should be able to do is an action.** The command line and MCP do not
list `fetch` routes, their input is not checked, and their answers are not
Results. Bare `epicenter` marks an app that has `fetch` with `(answers web
requests)`, and `--json` carries `fetch: true` on it.

**The launcher lists an app with a built `code/ui/dist/index.html` or a
`fetch`.** An app with no build step can answer its page from `fetch`.

**Serve refuses a cross-site request unless it opens a page.** Before any
route, serve reads the `Sec-Fetch-*` headers a browser sends (Fetch
Metadata):

| `Sec-Fetch-Site` | Answer |
| --- | --- |
| absent (curl, the command, an agent) | allowed |
| `same-origin`, `same-site`, `none` (typed, a bookmark) | allowed |
| `cross-site`, with `Sec-Fetch-Mode: navigate`, `Sec-Fetch-Dest: document` and method `GET` | allowed: a link or redirect that opens a page |
| `cross-site`, anything else | 403 |

The `Origin` and `Host` checks stay. An OAuth provider's redirect back is a
top-level `GET` navigation, so it is allowed. A cross-site `<img>`, `<script>`,
`fetch()` or `<iframe>` is refused.

## Consequences

- An app can take an OAuth redirect, serve a download or a feed, or accept an
  upload, and answer its own page. Serve knows none of these protocols.
- Live updates are a response that streams, such as server-sent events from a
  `fetch` that watches the app's `data/` folder. That sees every writer,
  including a person, an editor and Git, which `publish` did not.
- Loading per request costs an import of the app's files and a call of its
  function, about 0.2 ms for the Tasks example, plus whatever `fetch` builds,
  such as a Hono router. Each load also leaves memory behind, about 15 KB for
  Tasks (ADR-0880 measured 8 MB over 300 reloads of a larger app). A page of
  fifty images is fifty loads. An app that serves many requests, such as
  media, waits for ADR-0959. Nothing an app keeps in memory survives from one
  request to the next until then.
- A cross-site `POST` navigation is refused, by the `Origin` check as before.
  An OAuth provider that answers with `response_mode=form_post` cannot reach
  an app.
- A browser sends `Sec-Fetch-*` only to a potentially trustworthy URL:
  `127.0.0.1`, `localhost`, or `https`. Over `tailscale serve` the address is
  `https://<machine>.<tailnet>.ts.net`, so the headers arrive. A device that
  reaches serve over plain `http` at a tailnet IP sends none, and the policy
  then allows a cross-site `GET`. Use the `ts.net` address.
- Browsers before Chrome 76, Firefox 90 and Safari 16.4 send no
  `Sec-Fetch-*`, with the same result.
- Another site can no longer frame an app's page or load its icon.
- `websocket` can be added later as one more optional key, beside `fetch`.

## Considered alternatives

- **`fetch`, `websocket` and `publish` under `/<app>/.http/` (this record's
  first draft).** A reserved name with a period inside the app's address, and
  `publish` worked around per-call loading while missing direct file writes.
- **`fetch` sees the full path, `/apps/<app>/oauth/callback`.** No rewrite, and
  `request.url` is the address the browser used. Every route then names the
  folder, and renaming the folder breaks the app.
- **Only the `Origin` check, as before.** A cross-site `<img>` reaches a `GET`
  route with no `Origin`, and the route runs.
- **The web.dev policy as written, which also allows a cross-site `<iframe>`
  navigation.** Another site could then frame an app's page and trick the
  owner into a click that calls an action.
- **Hono or Elysia as the app's foundation.** Every app would depend on one
  framework's behavior and version, including apps that only have actions,
  and the command line and MCP would dig the actions back out of a route
  tree. `fetch` lets an app use either.
- **Wait for ADR-0959 before building `fetch`.** Per-request loading is
  correct, and cheap for the requests a callback or a download makes.
