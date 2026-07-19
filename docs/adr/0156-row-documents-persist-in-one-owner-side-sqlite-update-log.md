# 0156. Row documents persist in one owner-side SQLite update log

- **Status:** Accepted
- **Date:** 2026-07-19
- **Amends:** [ADR-0144](0144-scalar-rows-and-row-documents-synchronize-through-independent-client-planes.md) (the browser document owner is no longer IndexedDB), [ADR-0146](0146-row-documents-use-one-yjs-14-major-and-runtime-native-update-logs.md) (the per-runtime store contract collapses to one shared implementation over one seam)
- **Relates:** [ADR-0110](0110-edit-write-timing-follows-the-value-owner-there-is-no-debounce-tier.md), [ADR-0142](0142-bootstrap-history-gaps-and-lineage-mismatches-have-distinct-recovery.md), [ADR-0145](0145-one-account-authority-owns-every-workspace-and-one-socket-per-open-row-document.md), [ADR-0151](0151-local-workspace-stores-use-owner-first-directories.md)

## Context

Row-document persistence had accumulated three implementations of one job:
an IndexedDB store on the browser page, a native SQLite store in the Bun
runtime, and a second live-document runtime in the desktop WebView that
transported whole document states and relayed updates between windows over a
BroadcastChannel. The browser split let document writes keep succeeding after
scalar storage ownership moved to a newer tab, durable document deletion had
no owner on the synchronized path, and a new engineer had to learn different
semantics per runtime. A throwaway OPFS prototype proved that Worker-owned
SQLite passes the same correctness gates as IndexedDB while inheriting the
existing single-owner storage lease.

## Decision

One workspace lifecycle unit owns one `store.sqlite3`, and that file owns both
scalar state and the workspace's Yjs 14 V2 update log
(`workspace_document_updates`). The owner-side document log
(`createSqliteDocumentLog`) is the only durable document representation and
owns schema, append admission, compaction, capture, and durable deletion.

Renderer-facing code owns live `Y.Doc` objects through one shared runtime
(`createRowDocumentRuntime`) and one shared persistence attachment
(`createDocumentStore`). The renderer-facing persistence capability is exactly
`load(address)` and `append(address, updateV2)`; owner lifecycle is never
reachable through renderer persistence. Carriers differ per runtime and are
serialization only: in-process calls for Bun and native hosts, structured
Worker messages for the browser page, and base64 JSON over the same-origin
records route for the desktop WebView. There is no universal transport
framework.

Document death has one owner: the transaction that ends the row's scalar
life. Appends read row liveness inside the same SQLite transaction as their
insert, so a late append after deletion refuses with one named address-scoped
error instead of resurrecting content or poisoning the log. The log's rows are
deleted inside the local delete transaction, the replica transaction that
admits a visible local delete intent (covering rows that exist only as local
intents, which no foreign key can see), the transaction installing an
authority deletion marker, the acquisition-promotion transaction that removes
a confirmed row absent from the acquired set, the fresh-lineage reset, and
workspace deletion. Compaction replays a fixed covered prefix through a fresh
`gc: true` document (merging update blocks alone never garbage-collects) and
capture is one owner command taken after the renderer's durability barrier;
there is no page-side capture overlay.

Exactly one live local surface owns a workspace at a time, on both browser
and desktop, and the newest surface wins. The browser already enforced this
through the storage lease; co-locating documents in the Worker extends the
same displacement to document work. The desktop records route now carries a
per-runtime surface id: an `open` from a newer surface claims the workspace
and the displaced surface's operations fail with the shared
`WorkspaceStorageMovedError` name, so one guard and one blocking moved screen
serve both carriers. The desktop cross-window document and records relay is
deleted rather than preserved; in-process host consumers of owner-opened
handles (Home's conversation store) are not surfaces and are unaffected.

This is a greenfield cut with no migration: the IndexedDB row-document store,
the single-BLOB `documents` table, the desktop temp-open document bridge, and
every compatibility or fallback reader are deleted. Local Device storage is
version 3 and any other stored version fails loudly. Remote planes are
unchanged: the scalar row protocol and the `document-v3` wire, bounds, and
authority semantics of ADR-0145/0146 are untouched, and the two planes remain
remotely eventual, never atomic.

## Consequences

- A stolen or displaced surface can no longer keep writing documents after
  losing scalar ownership; document-lease loss is user-visible and fail-closed
  on both browser and desktop.
- Browser, desktop, Bun, and in-process runtimes share one attachment
  implementation, one live-document runtime, and one SQLite representation; a
  carrier is a few dozen lines of serialization.
- Deleting a row durably deletes its document log in the same transaction, so
  crash timing cannot leave resurrectable content, at the cost of document
  logs for authority-deleted rows dying even while a local update intent still
  overlays the row (matching existing handle revocation).
- `startFresh` clears every document log; unsynchronized document edits
  survive only through the explicit `captureRecovery` copy taken before the
  reset (ADR-0142), because addresses are never reused (ADR-0145).
- Chromium immediate append durability is slower than IndexedDB's relaxed
  writes (~3 ms vs ~0.4 ms measured); this is accepted, and batching is
  deliberately deferred until a measured need.
- Existing local IndexedDB document data and version-2 Device stores are
  abandoned under the authorized pre-user reset.

## Considered alternatives

- **Keep IndexedDB for browser documents.** Rejected: it is a second storage
  owner outside the storage lease, so document writes survive scalar
  displacement, and it forces a second implementation of every persistence
  semantic.
- **Preserve the desktop multi-window relay.** Rejected: newest-surface-wins
  makes same-workspace sibling windows impossible, and the relay was the last
  consumer of the duplicate desktop document runtime and the Yjs v1 update
  family.
- **A universal transport abstraction over the seam.** Rejected: three
  carriers with different envelopes (structured clone, base64 JSON, direct
  calls) do not earn a shared framework; the seam is two functions.
- **Foreign-key cascade for document deletion.** Rejected: account-created
  rows can be represented only by local intents, which no confirmed-row
  foreign key can see.
