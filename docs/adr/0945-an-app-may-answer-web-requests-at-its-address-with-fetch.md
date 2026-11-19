# 0945. An app may answer web requests at its address with `fetch`

- **Status:** Accepted
- **Date:** 2026-11-17
- **Amended:** 2026-11-18 by [ADR-0961](0961-the-command-sends-an-actions-input-to-serve-and-serve-alone-reads-it.md): the launcher is deleted; serve's start message names each app with a built page.
- **Relates:** [ADR-0967](0967-serve-keeps-action-calls-outside-an-apps-address-which-is-apps-name.md) (an app's address is `/apps/<app>/`), [ADR-0960](0960-an-app-is-a-function-of-its-folder-and-a-call-has-no-hidden-context.md) (an app is a function of its folder), [ADR-0959](0959-serve-loads-each-app-once-and-an-apps-code-changes-when-serve-restarts.md) (when an app is loaded), [ADR-0927](0927-serve-listens-only-on-this-computer.md) (who reaches serve), [ADR-0860](0860-an-interface-is-a-view-over-an-apps-actions-and-never-knows-where-they-run.md) (a page calls actions).

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
socket. ADR-0967 moved action calls out of the app's address, so nothing in
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
  const web = new Hono({ strict: false }).basePath('/apps/mail');
  web.get('/oauth/callback', async (c) => {
    // Check c.req.query('state') against the one /oauth/start wrote to a
    // file in local/; the packages/app README shows the whole flow.
    await folder.write('local/token.json', JSON.stringify({ code: c.req.query('code') }));
    return c.redirect('../');
  });

  return { description: 'Mail', actions: {}, fetch: web.fetch };
});
```

- **`fetch` is `(request: Request) => Response | Promise<Response>`.** The web
  standard shape, so a Hono or Elysia app's `fetch` passes as it is. It
  reaches the folder by closing over `folder`; the library exports nothing
  for it to import. `appProblems` in `packages/app-old/src/app.ts` refuses a
  `fetch` that is not a function.
- **Files first, then `fetch`, then 404.** For a `GET` or `HEAD`, serve
  answers a file in `code/ui/dist/` when there is one (ADR-0944). Any other
  request under `/apps/<app>/`, of any method, goes to the app's `fetch`, and
  an app without one answers 404. A path part that starts with `.` is never a
  file, so `/apps/<app>/.well-known/...` reaches `fetch`.
- **The app gets the request unchanged.** Its URL, method, headers and body
  are what the browser sent, so `/apps/mail/oauth/callback` arrives as
  itself. An app knows its address because its name is its folder's: a Hono
  app is `new Hono({ strict: false }).basePath('/apps/mail')`; serve
  redirects `/apps/mail` to `/apps/mail/`, and `strict: false` lets a page
  route `'/'` match it.
- **The body limit is serve's.** Bun refuses any request body over 25 MiB
  (`MAX_BODY_BYTES` in `packages/app-old/src/command/serve.ts`) with 413, for
  `fetch` as for actions.
- **A failure is a 500.** A `fetch` that throws, or returns something that is
  not a `Response`, answers 500, and serve logs one line naming the app. An
  app that does not load answers 500 with its problems for every path under
  its address, its built files included.
- **`fetch` is loaded like an action.** Serve loads each app once, when it
  starts (ADR-0959), and every request that reaches `fetch` calls the
  function that load returned.

**`fetch` is for protocols someone else defined. Anything a person or an
agent should be able to do is an action.** The command line and MCP do not
list `fetch` routes, their input is not checked, and their answers are not
Results, and the listing does not say which apps have `fetch`.

**Serve names only apps with a built page.** Its start message lists each app
with a `code/ui/dist/index.html`. An app with no build step can still answer
its page from `fetch` at `/apps/<app>/`; serve does not guess that it does.
(The launcher is deleted, per ADR-0961.)

**Serve refuses a request from another origin unless it opens a page.**
Before any route, serve reads the `Sec-Fetch-*` headers a browser sends
(Fetch Metadata):

| `Sec-Fetch-Site` | Answer |
| --- | --- |
| absent (curl, the command, an agent) | allowed |
| `same-origin`, `none` (typed, a bookmark) | allowed |
| `same-site` or `cross-site`, with `Sec-Fetch-Mode: navigate`, `Sec-Fetch-Dest: document` and method `GET` | allowed: a link or redirect that opens a page |
| `same-site` or `cross-site`, anything else | 403 |

`same-site` is another origin: a site ignores the port, so a page on
`http://127.0.0.1:3000` is same-site with serve on 4747. The `Origin` and `Host` checks stay. An OAuth
provider's redirect back is a top-level `GET` navigation, so it is allowed.
Another origin's `<img>`, `<script>`, `fetch()` or `<iframe>` is refused.

**Every app shares serve's origin.** A page or a `fetch` answer from one app
can call any app's actions and MCP at `POST /`; serve does not ask which
app's page made a call. An app whose `fetch` renders outside content, such
as an email, escapes it, since one injected script in one app reaches every
action. A `fetch` that serves a service worker with
`Service-Worker-Allowed: /` lets it answer for every app's pages until it is
removed, so an app does not send that header. Giving each app its own origin would need a host name per app, which
`tailscale serve` and a bookmark on `127.0.0.1` do not give.

**An OAuth callback checks `state`.** Serve allows any site's top-level
`GET`, so another site can send the browser to a callback with its own
`code`. The app writes `state` to a file when it starts the sign-in and
compares it in the callback; memory does not last past a restart of serve.

## Consequences

- An app can take an OAuth redirect, serve a download or a feed, or accept an
  upload, and answer its own page. Serve knows none of these protocols.
- Live updates are a response that streams, such as server-sent events from a
  `fetch` that watches the app's `data/` folder. That sees every writer,
  including a person, an editor and Git, which `publish` did not.
- Serve loads each app once, when it starts (ADR-0959), so `fetch` is the
  loaded app's and what an app keeps in memory lasts until serve stops.
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
- **Serve removes `/apps/<app>` and sets `X-Forwarded-Prefix`.** Routes then
  survive a rename of the app's folder. A rename already changes the app's
  address, and with it every callback URL registered with a provider, so the
  rewrite saves little; it costs a rewritten `request.url` that differs from
  what the browser sent, and a header to trust. No app read the header.
- **The listing marks an app that has `fetch`.** Bare `epicenter` printed
  `(answers web requests)`. It told a person nothing they could act on, and
  the launcher used it to guess that the app answers a page.
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
