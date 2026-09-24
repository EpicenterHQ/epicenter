# 0304. Application persistence is runtime-selected and scoped by its owning app

- **Status:** Accepted
- **Date:** 2026-08-31
- **Built.** The runtime is selected by the `#platform/binding` build condition rather than by a runtime test, because a desktop build runs in a WebView and nothing observable there tells it apart from a browser tab.
- **Amended by:** [ADR-0324](0324-a-database-address-is-its-data-id-and-generation-and-the-definition-declares-its-authority.md) at the desktop spelling only: `data/<data-id>/` gains a format-version segment above the data id and a generation below it, so the path reads `data/v4/<data-id>/<n>.sqlite`. The per-app scoping and the logical identity this record fixed are unchanged.
- **Amended by:** [ADR-0314](0314-an-app-is-one-directory-and-installation-is-a-rename.md), which extends the per-app layout to the app's bundle and its blobs. The `data/<data-id>/` and `sqlite/<store-name>` paths this record fixed are unchanged.
- **Amended by:** [ADR-0312](0312-a-sqlite-handle-is-all-run-and-batch-and-a-transaction-never-crosses-a-process-boundary.md) at two bounded points. Withdrawn: the citation of ADR-0275 as the intended browser SQLite medium, which is superseded; Epicenter Data's browser medium is IndexedDB. Narrowed: the platform's role in browser SQLite is opening only. The address layout stands. (ADR-0308 held this amendment first; ADR-0312 supersedes it and carries it forward.). And by [ADR-0403](0403-the-package-selects-its-platform-leaves-at-runtime-and-a-consumers-build-passes-no-condition.md) at the built line's claim that nothing observable tells a WebView apart from a tab: `isTauri()` is observable in every window Tauri creates. The per-app scoping and the logical identity this record fixed are unchanged; the selection mechanism for `@epicenter/app` is now a runtime check inside the package.
- **Relates:** [ADR-0233](0233-a-browser-application-keeps-a-private-document-and-one-workspace-replica-per-account.md) (browser replicas are origin-local), [ADR-0247](0247-an-app-that-keeps-a-local-copy-of-a-providers-data-owns-its-file-lifecycle.md) (provider copies remain app-owned), [ADR-0275](0275-a-browser-stores-durable-record-is-sqlite-over-opfs-in-a-worker.md) (Superseded through ADR-0280 to ADR-0298: Epicenter Data's browser medium is IndexedDB, and SQLite over OPFS in a worker survives only as app-owned SQLite, decided by [ADR-0308](0308-an-application-opens-its-own-sqlite-inside-its-own-worker-and-the-handle-is-synchronous.md)), and [ADR-0303](0303-an-application-opens-epicenter-data-and-app-owned-sqlite-through-one-scoped-client.md) (the application API)

> **2026-09-05 amendment:** The `## Consequences` line below, "The platform can
> use SQLite WASM over OPFS in the browser", reads as app-owned SQLite only. It
> is `packages/app/src/browser-sqlite.worker.ts`, whose OPFS synchronous access
> handles are why that database lives in a worker (ADR-0308). Epicenter Data's
> browser record has no SQLite, no worker, and no OPFS: it is IndexedDB in the
> page (`packages/app/src/data/store/browser.ts`), keyed by the address
> [ADR-0348](0348-the-local-address-carries-the-principal-and-a-database-needs-no-binding-to-know-whose-it-is.md)
> spells.

## Context

Epicenter targets two deployment environments: a web app on its own origin and
an app running in an Epicenter Tauri WebView. The web origin already provides
browser storage isolation. The desktop host provides a filesystem boundary and
can choose native persistence. Application code should not branch on either
environment or carry physical paths in its configuration.

Epicenter Data and app-owned SQLite also have different identity rules. Data IDs
can intentionally identify one logical synchronized model across applications;
SQLite names are private to their owning application and must never collide by
accident.

## Decision

`openData(definition)` and `openSqlite(name)` resolve storage through the current
runtime while preserving one application composition API. They do not imply
that Epicenter Data's IndexedDB record and an app-owned SQLite file share an
implementation or lifecycle.

On the web, a dedicated application origin is the outer isolation boundary:

```text
<origin-local-storage>/
├── data/<data-id>/
└── sqlite/<store-name>
```

Inside the Tauri desktop runtime, the host-backed persistence is app-scoped:

```text
<platform Epicenter data root>/so.epicenter/apps/<app-id>/
├── data/<data-id>/
└── sqlite/<store-name>.sqlite
```

The exact browser keys and desktop paths are implementation details. The
logical identity is stable in both cases:

```text
Epicenter Data:  data ID
SQLite:          app ID + store name
```

Two applications never share a SQLite file. Two applications may use the same
Epicenter Data ID, but each keeps its own local replica and converges through
the authority. Same-app windows may share local persistence when the selected
runtime provides safe coordination.

Tauri does not imply native storage by itself. The Tauri binding explicitly
selects native file-backed persistence; a browser build uses browser storage.

## Consequences

- A dedicated web deployment does not need a redundant physical app-ID folder.
- A shared-origin host can add the app ID to its physical browser namespace without changing application code.
- Moving a web app to another origin moves it to another browser storage partition; the stable app ID does not silently migrate those bytes.
- The platform can use SQLite WASM over OPFS in the browser and native or Bun SQLite on desktop while sharing the asynchronous `AppSqliteDatabase` contract. The synchronous SQLite contract remains for derived in-memory projections until those consumers migrate.
- Local Mail's mailbox is `sqlite/mail` within its dedicated origin or
  `apps/<app-id>/sqlite/mail` on desktop, while an intentionally shared
  Epicenter Data model remains identified by one `data-id`.
- Cross-app SQLite sharing is not a supported default. A shared provider surface needs an explicit API or a shared Epicenter Data model.

## Considered alternatives

- **Use one global `data/` and `sqlite/` namespace.** Rejected for SQLite because equal names from different applications would become accidental shared state.
- **Always repeat the app ID in browser storage.** Rejected as redundant for dedicated origins, though the logical identity remains app-scoped.
- **Use the Tauri WebView's IndexedDB by default.** Rejected for the desktop target because the desktop runtime should be able to provide ordinary durable files and native SQLite without changing the app.
