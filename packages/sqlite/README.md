# `@epicenter/sqlite`

`@epicenter/sqlite` is the MIT contract for an embedded SQLite handle:
`run`, `all`, and a synchronous `transaction`, plus the value and row types
those agree on. It normalizes nothing else. It owns no application schema, no
synchronization state, and no storage lifecycle.

One adapter per runtime answers the contract:

| Entry point | Engine | Consumer |
| --- | --- | --- |
| `./bun` | `bun:sqlite` | `@epicenter/app/store`'s Bun store |
| `./durable-object` | a Durable Object's SQL storage | `@epicenter/server`'s replica and authority |
| `./browser` | sqlite.org's WASM build | `apps/sync-lab`, for now |

The browser adapter is the odd one, and deliberately so. The browser store
keeps its durable facts directly in IndexedDB and loads no SQLite at all
(ADR-0280), so nothing in `@epicenter/app/store` opens this adapter on its own, and
its only consumer today is a throwaway lab. Its intended consumer is an
application's derived index: in-memory, rebuilt on read, and initialized by the
application rather than by this package, so the WASM load stays where the
application can see it (ADR-0307).

Schema and transaction invariants belong to the consuming package. The client
store lives in `@epicenter/app/store`; server authority storage lives in
`@epicenter/server`. An app that keeps a local copy of a provider's data owns
its own file lifecycle: see `apps/local-mail/src/mailbox.ts` and
`apps/local-books/src/db-file.ts`.
