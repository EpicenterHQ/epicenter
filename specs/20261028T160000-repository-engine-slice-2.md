# Repository engine, slice 2: the browser, a live connection, and Todos

In-flight spec for ADR-0692. Builds on slice 1 (`packages/repository`, branch `claude/repository-engine`). Slice 3 adds the Durable Object, Artifacts, read endpoints and the CLI.

## 1. One client API for every host

Slice 1's engine reads synchronously because Bun's SQLite runs in the same thread. In the browser, SQLite in OPFS runs only in a dedicated worker, so the public API must not promise synchronous list reads. Settle one client API used by every host:

- `repo.<name>.get(params)` and `list(filter?)` return Promises; `repo.live(sql)` and `repo.<name>.live(filter?)` are subscriptions that re-run on any change and emit only when results differ.
- `await repo.<name>.open(params)` returns an open handle whose `text`, `fields` and `body` are read synchronously and update live; writes through it are synchronous to the caller and resolve to outcomes.
- Writes (`create`, `write`, `move`, `delete`, `set`, `append`, `put`, `batch`) keep their slice-1 shapes.
- The Bun host implements the same API over the in-process engine (Promises that resolve at once).

## 2. Browser host (`packages/repository/src/browser/`, export `./browser`)

- `@sqlite.org/sqlite-wasm` with the `opfs-sahpool` VFS (no cross-origin isolation headers) inside a dedicated worker that runs the whole engine; one SQLite file per repository.
- One leader per repository per origin, elected with Web Locks; the leader's worker owns SQLite and the connection to the server. Other tabs are followers: they send every call to the leader over a `BroadcastChannel` (or MessagePorts brokered through it) with a stable command id; on leader loss a follower takes the lock, opens the database, and retries its unanswered commands by id. The command id is stored with the outbox row in the same transaction, so a retried command is found, not repeated.
- Registered functions where `sqlite-wasm` supports them (the stored `fields` column), per the ADR.
- Live queries and open handles in followers are fed by the leader's change notifications.

## 3. A live connection (`./ws`)

- A WebSocket transport carrying slice 1's protocol messages, client side for browsers and Bun, and a Bun server side that hosts `RepositoryServer` with the local Git store, so two browsers can sync through a server running on this machine. Reconnect with backoff; batches are resent from the outbox.
- A dev script (`bun packages/repository/scripts/serve.ts <repo-dir>`) that serves one repository over WebSocket on localhost.

## 4. Svelte adapter (`./svelte`)

- `live(repo, query)` returns a reactive getter (`.current`) built on `createSubscriber`; `opened(repo, handle)` makes an open handle's fields reactive. Follow the repository's `svelte` skill.

## 5. Todos on the engine

- Replace `openFolder`/`<OpenFolder>` in `apps/todos` with `defineApp({ todos: { path: 'todos/{stem}.md', schema } })` and the browser host, plus an optional server URL for live sync. Keep the UI; adapt lists to `live` and the detail view to an open handle. Leave the old folder code in place for other apps; this slice moves only Todos.

## Tests that define done
- Unit: the client API over the Bun host (the slice-1 end-to-end scenarios still pass through the async API).
- Playwright (Chromium and WebKit, persistent profiles): reload keeps data and unsent edits; two tabs share one leader and see each other's edits; closing the leader tab mid-command hands over without losing or repeating the command; two browser profiles sync through the local WebSocket server, including an offline edit merged on reconnect.
- Todos: typecheck, its tests adapted, and a Playwright smoke test of create, edit, complete and delete.

## Verify and report
Package typecheck and tests, Todos typecheck and tests, Playwright runs. Report deviations from the ADR and open questions. Standalone commits on `claude/repository-engine`; stage specific files; no attribution; no push.
