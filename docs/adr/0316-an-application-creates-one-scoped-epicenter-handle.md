# 0316. An application creates one scoped Epicenter handle

- **Status:** Accepted
- **Date:** 2026-08-31
- **Built.** The binding is required rather than sniffed, and the composition is `openData`, `openSqlite`, and `secrets`, with no `durable` flag: a browser answers `null` from `secrets.get` after a reload, which is the same answer a new desktop device gives.
- **Amends:** [ADR-0303](0303-an-application-opens-epicenter-data-and-app-owned-sqlite-through-one-scoped-client.md) at the constructor name and the meaning of the application-facing handle. The two openers, their scoping, and their storage refusals stand.
- **Relates:** [ADR-0181](0181-every-app-receives-one-portable-epicenter-capability-handle.md) (one portable handle), [ADR-0310](0310-an-applications-provider-credential-is-a-labeled-secret-and-the-browser-keeps-none.md) (the secret capability), ADR-0312 (the SQLite handle), and [ADR-0313](0313-a-data-definition-ships-as-typescript-and-a-host-that-needs-one-imports-it.md) (the typed definition)

## Context

The storage records established one scoped application client, but left its
constructor named after an implementation detail. `createAppRuntime` would make
the runtime visible in application code, while `createEpicenterClient` is
already the HTTP client in `packages/client` and has a different owner and
lifecycle.

An application needs one obvious handle through which it opens its own data and
relational stores and, when the capability is available, uses its application-
scoped secrets. The handle must look the same in a desktop WebView and a
standalone browser build; runtime differences are typed capability failures,
not branches or missing namespaces.

## Decision

**An application creates one scoped handle named `epicenter` with
`createEpicenter`.**

```ts
const epicenter = createEpicenter({
	appId: 'so.epicenter.local-mail',
});

const data = await epicenter.openData(database);
const mail = await epicenter.openSqlite('mail');

await epicenter.secrets.put(accountId, refreshToken);
```

`createEpicenter` is the application capability factory. It is not the
existing HTTP client in `packages/client`, which remains a separate server
transport concern and must not be overloaded with this meaning.

The handle owns the application scope and presents the stable application
surface. `openData` and `openSqlite` are the core persistence openers. The
secret capability uses the same handle when the application needs it, with
unavailable environments reported as typed failures. The application never
selects IndexedDB, OPFS, Bun SQLite, a native path, a keychain, or a host IPC
mechanism directly.

The application owns composition above the handle: definitions, SQLite schema,
provider workflows, account records, mirror attachment, and lifecycle. The
host owns only the binding that makes those capabilities possible in its
runtime.

## Consequences

- Application code has one entry point and one name to learn: `epicenter`.
- `createAppRuntime` is not introduced; runtime is an implementation boundary,
  not application vocabulary.
- The existing `createEpicenterClient` HTTP client is not renamed as part of
  this record. The implementation must keep the two concerns distinct, and a
  later package-boundary decision can rename the HTTP client if that becomes
  necessary.
- A browser and desktop build share the same application workflow. A missing
  host capability becomes a typed result the application handles.
- This record settles the public composition point. It does not make any of the
  openers, secret leaves, or Local Mail workflow built; ADR-0303, ADR-0310,
  ADR-0312, and ADR-0313 retain their own unbuilt obligations.

## Considered alternatives

- **`createAppRuntime`.** Refused because it names the platform mechanism rather
  than the capability the application receives.
- **`createEpicenterClient`.** Refused for this handle because the existing
  HTTP client already owns that name and has a different scope.
- **Several independent factories.** Refused because separate constructors
  would repeat application identity and recreate the path and capability drift
  this client is meant to remove.
