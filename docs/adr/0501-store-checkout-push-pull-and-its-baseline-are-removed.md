# 0501. Store checkout Pull/Push and its baseline are removed

- **Status:** Superseded
- **Date:** 2026-10-03
- **Superseded by:** [ADR-0899](0899-the-folder-sync-product-is-retired.md): the folder sync product is retired, and this record is its history.
- **Supersedes:** [ADR-0337](0337-the-folder-is-a-working-copy-and-pull-and-push-are-the-whole-cycle.md), the Yjs store working-copy workflow. Later checkout refinements remain historical evidence, not a replacement workflow.
- **Relates:** [ADR-0494](0494-file-folders-reserve-epicenter-for-rebuildable-caches.md) defines transient folder queries; [ADR-0463](0463-queryable-exports-contain-completed-sqlite-snapshots.md) defers SQL export.
- **Implementation:** store checkout API, baseline/manifest code, NDJSON wire format, host checkout route, checkout tests, and checkout benchmark are removed.
- **Removal commit:** `5984d2cbde20068062c1cd09e80ce5049501c589` (`refactor: remove store checkout push and pull`).
- **Unbuilt:** generic file-folder query sessions remain unbuilt under ADR-0494. No replacement store checkout, automatic manifest conversion, or SQL export is planned.

## Context

The legacy workflow rendered a Yjs store into a filesystem working copy, recorded
`.epicenter/manifest.json`, and compared files against that baseline before
applying Pull or Push. It had no product application caller of `createWorkingCopy`;
tests and a benchmark exercised the API. The desktop host still exposed its
filesystem half through `/api/checkout/:dataId`.

File-authoritative folders save current files directly. They do not need a
second saved representation and a comparison manifest to return edits to a store.
Retaining the old workflow adds an unused public API and a host filesystem route.

## Decision

**Remove store checkout Pull/Push, its baseline, and its manifest machinery completely.**

Delete `@epicenter/app/artifact/checkout`, `createWorkingCopy`, its wire helpers,
and the host's checkout filesystem implementation and GET/PUT route. Remove
workflow-specific tests and benchmarks. Keep a route regression proving the
retired endpoint returns 404 for an authenticated request.

Existing authored folders and old `.epicenter/manifest.json` files are not deleted,
rewritten, or converted. There is no compatibility reader, migration service,
or substitute baseline. Old files can be inspected and selected explicitly;
the removed workflow no longer applies their differences to a Yjs store.

Store Markdown rendering and whole-document import remain conversion APIs.
They neither maintain a filesystem working copy nor read its old manifest.
Yjs replication remains independent. File-authoritative folders retain conditional
file saves and ordinary Git history and transfer. Git push/pull and a file's
conditional-save hash are different mechanisms from the removed store workflow.

**Withdraw planned SQLite query export.** No generator or product caller exists.
Internal folder queries use transient in-memory projections without a saved
snapshot, default export filename, or output destination. A future export feature
needs its own consumer and decision; it is not unfinished work from ADR-0463.

## Consequences

No live code generates or consumes a store checkout manifest. The host no longer
reads or replaces store working-copy directories through HTTP. Products using
the file-authoritative model edit their current source files directly.

The removed workflow is unavailable. Existing files remain recoverable source
material, but editing an old checkout no longer updates its store. Restoring the
workflow would restore a competing saved representation and its reconciliation
obligations; Git history preserves the implementation for investigation.

## Considered alternatives

- Retain an unused compatibility entrypoint and host route: preserves a public
  promise with no application caller and requires baseline ownership indefinitely.
- Delete old folders or manifests on startup: removes user bytes without a
  product requirement. Removing execution does not require deleting files.
- Build SQL export alongside queries: adds external schema and publication
  contracts before a reader requests them.

## Find the removed implementation

The removal commit's parent contains the implementation and tests. Inspect them
without changing the working tree:

```sh
git show 5984d2cbde^:packages/app/src/data/artifact/checkout.ts
git show 5984d2cbde^:packages/app/src/data/artifact/checkout.test.ts
git show 5984d2cbde^:apps/epicenter/src/checkout.ts
git show 5984d2cbde --stat
```

Restoring this code would also require restoring its package export, wire helpers,
host routes, and ownership contract. The historical source is recoverable; it
is not an active compatibility path.
