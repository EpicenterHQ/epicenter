# 0407. App owns the declaration and data engine

- **Status:** Accepted
- **Date:** 2026-09-18
- **Amends:** [ADR-0405](0405-one-flat-application-declaration-opens-the-live-app.md) at opening and package ownership: the flat declaration remains; its `.open()` method and the separate data package are removed.
- **Amends:** [ADR-0292](0292-a-database-opens-an-exact-generation-cache-first-and-bootstraps-account-misses.md) at client opening and [ADR-0293](0293-a-generation-is-created-by-importing-a-folder-and-the-ledger-row-is-its-existence.md) at client generation helpers: applications open the current library; historical numbered-cache APIs are retired without changing stored history.
- **Relates:** [ADR-0391](0391-the-build-selects-every-implementation-and-an-application-declares-only-its-id-and-data.md), whose build selection and refusal of public implementation overrides remain.

## Decision

`@epicenter/app` owns declaration, application lifetime, and the data engine.
Its root exports the platform-free `defineApp`, `defineTable`, `field`, codecs,
and inferred schema vocabulary. `defineApp` is the only full declaration
constructor. The former `@epicenter/data` package and `defineData` constructor
are removed.

The declaration contains `id`, optional `title`, `kv`, and `tables`. It has no
opening method or runtime configuration. Eager validation, literal inference,
table branding, and declaration-identity compilation caching remain at this
boundary. Schema tools and Worker probes can import a declaration without
loading App resources or browser/native implementations.

`@epicenter/app/open` exports `openApp(definition, account?)` and the `App`,
`AppStore`, `AppSqlite`, and `AppBlobs` types. Opening returns a synchronous App
handle; `app.ready` reports acquisition and `app.close()` owns shutdown. The
optional Account fixes resource ownership for that lifetime. Existing account
namespaces, readiness, retirement, and closure behavior remain.

The package selects resources and AI through its existing build conditions.
There is no public `runtime` or `ai` override, `/browser` runtime export, or
`/epicenter-host` runtime export. `compose.ts` privately coordinates resources.
ADR-0403's runtime selector is separate and remains unbuilt.

`@epicenter/app/data` exports `openData(definition, sqlite)` and `syncEngineOf`.
The caller supplies and owns SQLite. Disposing the returned data document
flushes and closes its document resources without closing that connection.
This replaces `/direct`. `@epicenter/app/memory` keeps `openMemory` and
`createMemoryRecord`: Bun test support that owns a fresh connection or borrows
a supplied reusable record. Neither data opener constructs an App.

Public `/store` is a type facade. Construction and persistence composition stay
private, including browser acquisition with no `/store/browser` export. `/definition`, `/field`, `/sync`, and artifact entrypoints keep their
independent consumers. Unused `canonicalJson` serialization is removed.

The historical browser APIs `openDatabase`, `resolveGeneration`,
`createGeneration`, and `eraseGenerations` are retired. Skills' account-taking
adapter uses `openApp`; its route retains its refusal pending a product/auth
model. Browser persistence evidence exercises current App acquisition.
Historical bytes are neither migrated nor deleted. The server keeps its HTTP
409 refusal when admitted historical Personal generations would be hidden by
fresh current-library initialization.

## Consequences

One declaration works for App opening, SQLite data opening, memory tests, and
artifact operations. A schema import carries no platform dependency. A caller
can choose an ownership boundary without injecting a second implementation
path into application declarations.

App callers import one additional function. Custom SQLite callers must close
their own connection after disposing the data document. Tests exercise data
behavior through memory or caller-owned SQLite; private App composition tests
remain inside the App package.

This changes APIs and module ownership. It changes no persisted identifier,
namespace, wire frame, artifact format, or historical record. The
[architecture map](../../packages/app/ARCHITECTURE.md) shows current source and
runtime boundaries.

## Considered alternatives

- Keep `.open()` on the declaration. This couples schema-only consumers to
  App/platform modules, even when construction performs no I/O.
- Retain both data and App packages or both full declaration constructors.
  These create competing owners for the same schema.
- Add runtime overrides to `openApp`. No production caller needs a second
  resource composition policy; test injection remains private.
- Make `openData` own a caller's SQLite connection. A supplied connection can
  serve other data documents or outlive a reopen; its caller owns that lifetime.
- Keep historical helpers for possible migration. Their remote routes are no
  longer current startup, and retaining writable client paths does not recover
  historical bytes. A future migration requires its own explicit decision.
