# 0966. Serve keeps action calls outside an app's address, which is `/apps/<app>/`

- **Status:** Proposed
- **Date:** 2026-11-18
- **Amends:** [ADR-0930](0930-an-action-call-is-a-function-call-and-serve-keeps-nothing-about-it.md) at "One route per action": the route is `POST /actions/<app>/<word>/<word>`, and the UI is at `/apps/<app>/`; its considered alternative "Move the UI and calls under `/apps/<app>/`" is taken. [ADR-0936](0936-one-serve-per-home-runs-every-action.md) at the route the command posts to. [ADR-0953](0953-an-actions-answer-is-data-or-error-and-its-input-is-one-json-schema.md) at the HTTP row of its answer table. ADR-0860, ADR-0864, ADR-0880 and ADR-0945 are Proposed and were edited in place.
- **Relates:** [ADR-0945](0945-an-app-may-answer-web-requests-at-its-address-with-fetch.md) (an app's `fetch` answers under its address), [ADR-0944](0944-an-app-builds-its-own-ui-and-serve-only-serves-it.md) (serve serves `code/ui/dist/` as built), [ADR-0910](0910-an-epicenter-is-one-private-repository-and-each-app-keeps-its-code-beside-its-data.md) (an app is the folder `apps/<app>/`).

## Context

`epicenter serve` answered five kinds of request
(`packages/app/src/command/http.ts`):

```txt
POST /                MCP
GET  /                the launcher
GET  /<app>/<path>    the app's built UI, code/ui/dist/
GET  /<app>           308 to /<app>/
POST /<app>/<action>  an action call; the action's words joined by "."
```

An app and its actions shared one address space. A `POST` under `/<app>/`
was an action call and a `GET` was a file. ADR-0945 wanted to hand the rest
of an app's requests to the app's own `fetch`, and had to reserve a name
inside the app's space for it, `/<app>/.http/`. The owner refused that
address: a period in a URL, and a name the app cannot use.

ADR-0930 had considered moving everything under `/apps/<app>/` and declined,
because nothing collided once runs were gone and the move broke bookmarks.
The app's own `fetch` is the collision it did not have.

## Decision

**Serve's own routes are marked by their first segment, and everything under
`/apps/<app>/` belongs to the app.**

```txt
GET  /                               the launcher
POST /                               MCP
POST /actions/<app>/<word>/<word>    an action call
ANY  /apps/<app>/<path>              the app: a file in code/ui/dist/, else its fetch, else 404
GET  /apps/<app>                     308 to /apps/<app>/
```

- **An action's words are path segments.** `epicenter vocab words create`
  is `POST /actions/vocab/words/create`. A word is a name (`isName` in
  `packages/app/src/app.ts`), so it never holds `/` or `.`, and a segment is
  one word. A group's words come before its action's word, as on the command
  line.
- **Every refusal under `/actions/` is a `NotStarted` in the body of a 400.**
  An unknown app, an unknown action, a group named in place of an action, and
  a segment that is not a name each answer `NotStarted` with `cause: 'usage'`,
  as an unknown action did before. A method other than `POST` answers 405.
- **`/apps/<app>/` matches the folder `apps/<app>/`.** The address has no
  period and no name the app cannot use. ADR-0945 says what serve does with
  a path under it that is not a file.
- **The page client and the command build the new address.**
  `connect` in `packages/app/src/client.ts` reads its app from the second
  segment of a page at `/apps/<app>/` and calls
  `<url>actions/<app>/<words>`. `sendToServe` in
  `packages/app/src/command/serve-call.ts` posts to the same route.
- **The launcher links to `/apps/<app>/`.**
- **No old address is answered.** `/<app>/` and `POST /<app>/<action>`
  answer 404. Nothing redirects.

## Consequences

- Every app's page is rebuilt after the upgrade. A page bundles
  `@epicenter/app/client`, and an old bundle posts to `/<app>/<action>`, which
  now answers 404; `bun run build` at the top of the Epicenter rebuilds every
  page. Bookmarks to `/<app>/` break.
- A page's own files keep relative URLs. A page built with relative URLs
  works at `/apps/<app>/` with no change to its source.
- An app's address is one segment longer. A future route of serve's own takes
  a new first segment beside `actions` and `apps`; an app name cannot collide
  with it, because apps live one level down.
- A redirect from `/<app>/` to `/apps/<app>/` would keep bookmarks, and would
  also keep every app name reserved at the top level. The owner accepted the
  clean break.

## Considered alternatives

- **`/<app>/.http/` for the app's own routes (ADR-0945 as first written).** No
  move. A period in the address, and a name inside the app's space that only
  serve may answer.
- **Keep calls under the app, `POST /apps/<app>/<words>`.** One prefix
  instead of two. A `POST` to any path under the app would then be an action
  call, so the app's `fetch` could not take a `POST`, and an app could not own
  its address.
- **Words joined by `.` in one segment.** The old form. A period in a URL,
  and two spellings of one nesting: `.` here and `/` on disk.
- **Redirect the old addresses for one release.** Bookmarks keep working. It
  keeps the old routing alive with nothing to say when it ends, and the pages
  that would use it must be rebuilt anyway.
