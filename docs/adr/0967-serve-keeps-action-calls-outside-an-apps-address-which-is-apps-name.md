# 0967. Serve keeps action calls outside an app's address, which is `/apps/<app>/`

- **Status:** Proposed
- **Date:** 2026-11-18
- **Amends:** [ADR-0930](0930-an-action-call-is-a-function-call-and-serve-keeps-nothing-about-it.md) at "One route per action": the route is `POST /actions/<app>/<action>`, and the UI is at `/apps/<app>/`; its considered alternative "Move the UI and calls under `/apps/<app>/`" is taken. [ADR-0936](0936-one-serve-per-home-runs-every-action.md) at the route the command posts to. [ADR-0953](0953-an-actions-answer-is-data-or-error-and-its-input-is-one-json-schema.md) at the HTTP row of its answer table: a refusal is a 200 with one answer line. [ADR-0961](0961-the-command-sends-an-actions-input-to-serve-and-serve-alone-reads-it.md) at the listing's address, now `GET /actions/`. ADR-0860, ADR-0864, ADR-0880 and ADR-0945 are Proposed and were edited in place.
- **Amended:** 2026-11-18 by [ADR-0961](0961-the-command-sends-an-actions-input-to-serve-and-serve-alone-reads-it.md): `GET /` is no page; `/` answers only MCP's `POST`, and any other method 405.
- **Relates:** [ADR-0945](0945-an-app-may-answer-web-requests-at-its-address-with-fetch.md) (an app's `fetch` answers under its address), [ADR-0944](0944-an-app-builds-its-own-ui-and-serve-only-serves-it.md) (serve serves `code/ui/dist/` as built), [ADR-0910](0910-an-epicenter-is-one-private-repository-and-each-app-keeps-its-code-beside-its-data.md) (an app is the folder `apps/<app>/`).

## Context

`epicenter serve` answered six kinds of request
(`packages/app/src/command/serve.ts`):

```txt
POST /                MCP
GET  /                the launcher, or the listing as JSON
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
POST /                          MCP; any other method 405
GET  /actions/                  the listing as JSON
POST /actions/<app>/<action>    an action call
ANY  /apps/<app>/<path>         the app: a file in code/ui/dist/, else its fetch, else 404
GET  /apps/<app>                308 to /apps/<app>/
```

- **An action has one name, and the address has one segment for it.**
  Groups are gone: `actions` is `{ [name]: Action }`, and `defineApp` refuses
  a nested object. `epicenter vocab create-word` is
  `POST /actions/vocab/create-word`, and its MCP tool is `vocab_create-word`.
  A name (`isName` in `packages/app/src/app.ts`) never holds `/` or `.`.
- **Every 200 ends in one answer line, and any other status means serve did
  not take the call.** A call refused before it runs (an unknown app or
  action, an address that is not `/actions/<app>/<action>`, an app that does
  not load, an input that does not fit) answers 200 with one line,
  `{"answer": {"data": null, "error": {"name": "NotStarted", ...}}}`. A
  reader no longer parses an error body: `readAnswer` reads any status but
  200 as `Unreachable`. A method other than `POST` under `/actions/<app>/`
  answers 405, and so does one other than `GET` at `/actions/`.
- **The listing is `GET /actions/`.** `/` answers only MCP, so no `Accept`
  header decides what `/` answers.
- **`/apps/<app>/` matches the folder `apps/<app>/`.** The address has no
  period and no name the app cannot use. ADR-0945 says what serve does with
  a path under it that is not a file.
- **A page calls an action by its name.** `connect` in
  `packages/app/src/client.ts` reads its app from the second segment of a page
  at `/apps/<app>/` and returns `{ call, action }`: `app.call('add', input)`
  posts to `<url>actions/<app>/add`, and `app.action('add')` is that call as a
  function, for a query or a mutation. The name is typed as one of the app's
  action names. The client has no Proxy, so an action may be named `then`.
  `callAction` in `packages/app/src/command/send.ts` posts to the same route.
- **No old address is answered.** `/<app>/` and `POST /<app>/<action>`
  answer 404. Nothing redirects.
- **A folder in `apps/` that did not load answers 500 with its problems
  for every path under `/apps/<app>/`,** whether it has no
  `code/epicenter.ts` or its code threw (amended 2026-11-18 with
  ADR-0959: serve loads every entry once, when it starts). A name with no
  folder answers 404.

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
- Every grouped action is renamed. An app that grouped `publish record`
  names it `publish-record`, and the scripts, routines and playbooks that
  name it change. TypeScript flags a group in `actions`, and `defineApp`
  refuses one at load.
- A data key's generated verbs share names across keys:
  `data.words.actions('list')` and `data.notes.actions('list')` both give
  `list`. An app with two keys names one key's verbs apart, such as
  `'list-notes': notes.list`.
- A script that read a refusal from a 400 body reads it from the answer line
  of a 200.

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
- **Groups as path segments, `POST /actions/<app>/<word>/<word>`.** This
  record's first draft. It kept nesting, at the cost of a recursive path type
  in the client (`'words.create'`), a word-splitting step on the command line,
  and tool names that join words. The owner chose one flat name everywhere.
- **MCP as the only way in.** One protocol for pages, the command and agents.
  Serve's MCP is stateless JSON, so it cannot stream an action's updates; a
  page would carry an MCP client; and an action marked `mcp: false` would
  have no way in. MCP stays a second view over the same `runAction`.
- **A refusal as a 400 with `NotStarted` in its body.** The first build. A
  reader had to parse error bodies and tell a refusal from a proxy's error
  page; with every 200 ending in one answer line, the status alone says
  whether serve took the call.
- **Redirect the old addresses for one release.** Bookmarks keep working. It
  keeps the old routing alive with nothing to say when it ends, and the pages
  that would use it must be rebuilt anyway.
