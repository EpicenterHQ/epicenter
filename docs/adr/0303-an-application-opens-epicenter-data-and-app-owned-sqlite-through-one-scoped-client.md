# 0303. An application opens Epicenter Data and app-owned SQLite through one scoped client

- **Status:** Accepted
- **Date:** 2026-08-31
- **Built**, with one clause read differently than written. The client, both openers, and both runtime leaves exist. `openData` is NOT host-owned in either leaf: the store is client-owned in every runtime (ADR-0226, ADR-0227), and what the desktop leaf asks the host for is admission of the definition identity (ADR-0313). "The host may inject the authoritative application ID and capabilities into the page" reads as a build-time condition rather than a `window` global.
- **Amended by:** [ADR-0307](0307-a-derived-index-is-in-memory-sqlite-rebuilt-on-read.md) at the projection. Withdrawn: the rename of `SqliteDatabase` to `SyncSqliteDatabase`. The projection's medium, trigger, and owner are decided there.
- **Amended by:** ADR-0312 at the application handle. Withdrawn: `AppSqliteDatabase`'s `transaction(run: (db) => Promise<T>)` and its `close()`. Its asynchronous `run` and `all` stand, joined by `batch`. `openSqlite(name)`, its scoping, and its refusals stand. (ADR-0308 held this amendment first and decided a synchronous handle instead; ADR-0312 supersedes it and carries the amendment forward.)
- **Amended by:** [ADR-0316](0316-an-application-creates-one-scoped-epicenter-handle.md) at the constructor name and application-facing handle. The storage openers, their scoping, and their refusals stand.
- **Relates:** [ADR-0226](0226-a-host-serves-bundles-and-brokers-credentials-it-owns-no-application-data.md) (the host brokers capabilities without owning application meaning), [ADR-0240](0240-an-application-declares-one-workspace-and-an-opened-runtime-holds-exactly-one-definition.md) (a definition is pure and opening is one call), [ADR-0247](0247-an-app-that-keeps-a-local-copy-of-a-providers-data-owns-its-file-lifecycle.md) (provider copies keep their application-owned schema and lifecycle), and [ADR-0304](0304-application-persistence-is-runtime-selected-and-scoped-by-its-owning-app.md) (the physical storage mappings)

## Context

An application needs one runtime-neutral way to reach the two persistence models
the platform supports. Epicenter Data is a declared, structured local-first
model; SQLite is an app-owned relational store such as a provider mirror or
search index. Their meanings and lifecycles differ, but application code should
not select IndexedDB, OPFS, Bun SQLite, or a native file.

SQLite also appears inside the current store implementation as an in-memory
projection of Yjs data. That projection is a separate concern from an
application-owned SQLite database: it is synchronous, derived, and disposable;
it is not the durable source of Epicenter Data.

The application also needs one stable identity for local storage. Repeating that
identity in every opener invites path and namespace drift, while inferring it
from a URL confuses deployment with application identity.

## Decision

An application creates one client with its declared application ID and opens
either persistence model through that client:

```ts
const epicenter = createEpicenterClient({
	appId: 'so.epicenter.local-mail',
});

const data = await epicenter.openData(definition);
const mail = await epicenter.openSqlite('mail');
```

`openData(definition)` opens the Epicenter Data API declared by the definition.
`openSqlite(name)` opens an `AppSqliteDatabase` private to the application. It
creates the database if it does not exist and opens it if it does. It does not
accept a schema, delete an existing database, or run an implicit migration. The
application bootstraps its schema and owns its migrations explicitly.

The application-owned handle is asynchronous and explicitly closable because a
browser implementation may run SQLite in a worker over OPFS:

```ts
type AppSqliteDatabase = {
	run(sql: string, parameters?: readonly SqliteValue[]): Promise<void>;
	all<TRow extends SqliteRow>(
		sql: string,
		parameters?: readonly SqliteValue[],
	): Promise<TRow[]>;
	transaction<TResult>(
		run: (database: AppSqliteDatabase) => Promise<TResult>,
	): Promise<TResult>;
	close(): Promise<void>;
};
```

The existing synchronous `SqliteDatabase` contract is renamed to
`SyncSqliteDatabase` when this clean break is implemented. It is currently used
by in-memory Yjs projections and historical Bun and server storage paths. The
target application surface does not depend on it. `AppSqliteDatabase` is not a
wrapper that turns a projection into durable storage; each runtime adapts its
own persistent database resource to the application contract.

The client verifies that the definition's ID agrees with the client identity
and derives every physical address from the scoped identity and logical name.

The public client contains these two openers only. Authentication and native
desktop capabilities remain separate opt-in packages, even when the host
implements them through the same injected binding.

The host may inject the authoritative application ID and capabilities into the
page. `createEpicenterClient` wraps and validates that binding; application code
does not reach through `window` directly. A standalone browser or native build
provides the same client with its build-time application ID and runtime
fallbacks.

## Consequences

- `defineData()` stays pure. It declares meaning; it does not open storage.
- Application code has one composition point and no runtime branches for storage.
- The client is scoped once, so `openSqlite('mail')` cannot accidentally open another app's database.
- A provider app still owns its schema, ingestion, versioning, readiness, and deletion policy. The platform supplies only the opening mechanism.
- Closing is explicit application lifecycle. `AsyncDisposable` may become convenience syntax later, but it is not required by the core contract.
- The API does not promise identical durability across runtimes. It promises one application-facing contract over runtime-specific adapters.
- Adding another host capability to this client requires evidence that it is universal. Auth and native APIs do not enter by default.

## Considered alternatives

- **Put `defineData` inside the client constructor.** Rejected because the definition is inert data and has a different lifetime from the runtime binding.
- **Pass a schema to `openSqlite`.** Rejected because the platform cannot know an app database's schema, migration policy, or rebuild safety.
- **Use one SQLite contract for projections and app databases.** Rejected because synchronous in-memory projection work and asynchronous persistent browser storage have different execution and lifecycle semantics.
- **Expose `auth` and `desktop` on every client.** Rejected because most applications do not need either capability and unused authority would become the default API.
- **Infer the app ID from the URL.** Rejected because URLs are deployment addresses, not stable application identities.
