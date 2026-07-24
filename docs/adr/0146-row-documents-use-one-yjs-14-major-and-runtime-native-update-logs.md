# 0146. Row documents use one Yjs 14 major and runtime-native update logs

- **Status:** Proposed
- **Date:** 2026-07-17
- **Amends:** [ADR-0135](0135-row-documents-have-application-owned-roots.md)
- **Amended by:** [ADR-0159](0159-row-documents-persist-in-one-owner-side-sqlite-update-log.md) (the per-runtime `DocumentStore` implementations collapse to one owner-side SQLite update log plus one shared attachment over a load/append seam; capture and deletion move to the owner), [ADR-0174](0174-row-documents-project-as-nullable-compact-cells-and-persist-as-bounded-live-chains.md) (every live owner stores a bounded baseline-plus-tail chain, logical artifacts project one compact document cell, and exceeding the authority bound refuses one revision, recorded as a single nullable `document_refused_revision` that the next local edit supersedes)

## Context

The repository currently contains both `yjs` 13 and `@y/y` 14 release-candidate
families. The available `y-indexeddb` package requires Yjs 13, while the new row
document API and editor path already target Yjs 14. Preserving both majors would
create duplicate providers, wire tests, persisted formats, and compatibility
policy before the new workspace runtime ships.

## Decision

Row documents use only the Yjs 14 line through `@y/y`. Epicenter provides no
Yjs 13 dependency, compatibility reader, dual wire, alias, migration lane, or
fallback. The exact release-candidate version is a build pin recorded in the
implementation spec and package manifests, not a permanent ADR claim.

Epicenter owns one update-log store and one per-open-document lease:

```ts
type DocumentStore = {
	attach(address: RowAddress, doc: Y.Doc): DocumentPersistenceLease;
	capture(address: RowAddress): Promise<Uint8Array | undefined>;
	delete(address: RowAddress): Promise<void>;
	deleteAll(): Promise<void>;
};

type DocumentPersistenceLease = {
	whenLoaded: Promise<void>;
	whenDurable(): Promise<void>;
	dispose(): Promise<void>;
};
```

Browser persistence implements it over one versioned IndexedDB database per
workspace with per-document indexed update logs. Native persistence implements
the same semantics over private SQLite. Both replay Yjs 14 updates, append every
observed update, compact to a complete update at bounded thresholds, expose an
invocation-time local durability barrier, and fail closed on storage corruption
or eviction. `attach()` installs update capture synchronously before replay
begins, and `document.open()` awaits `whenLoaded`. Destructive row or workspace
cleanup first disposes active leases and then calls the store; an active lease
does not expose `clear()`.

The document network protocol has its own explicit wire major and is implemented
only against `@y/y` 14 encoding. Existing Yjs 13 room and provider code is
algorithmic precedent, not a compatibility surface.

The authority bounds accepted document state with one compound bound owned by
`@epicenter/sync/document-v3` and computed identically on both endpoints from
one canonical encoded state: `stateBytes = 1_048_576` and
`stateStructs = 131_072` (`encodeStateAsUpdateV2` byte length and
`decodeUpdateV2` struct count). The authority enforces it exactly on the
post-candidate state inside the append transaction and never mutates committed
state on refusal. The current Yjs decoder materializes decoded structures; this
decision therefore claims no streaming precheck. Before this ADR becomes
Accepted, maximal valid and maliciously dense fixtures must prove a safe peak
decode-and-hydration memory envelope in workerd. The frame envelope derives
from the bound (`header + 2 x stateBytes`); measured diffs never exceeded
canonical state across sliced, delete-set-heavy, and pending shapes.

The struct ceiling is a resource pin, not a legitimacy judgment: it holds
worst-case authority hydration near 90 ms and tens of megabytes of transient
memory per append in workerd (measured ~0.7 microseconds and ~0.06 KiB per
struct). Every measured real producer shape stays under ~50 structs/KiB and
crosses the byte bound first; extremely format-dense text such as
per-character marks (~154 structs/KiB) can legitimately hit the structural
wall below the byte bound, so a structural refusal is never treated as abuse.
The exact 131,072 ceiling remains Proposed until the maintained rich-text
editor passes a durable workload covering typing, formatting, undo, deletion,
and several offline clients; the product refusal is bounded accepted structure,
not loyalty to an unverified constant.

If a locally valid document grows beyond the bound, local persistence and
logical export remain available. ADR-0174 records one refused revision for that
lineage and stops automatic publication of that revision. A later edit
supersedes it and republishes automatically: deleting the content that crossed
the byte bound demonstrably shrinks the same lineage back under it. Epicenter
does not promise that editing can repair accumulated CRDT structure, which is
the stickier structural case. The application still owns the honest exits when
repair in place fails: export, copy visible content into a fresh row document,
or another domain-specific split. Epicenter never reports unsynchronized
content as synchronized and never silently drops an oversized update.

The application still receives the restricted native-shaped `RowDocument` from
ADR-0144. It owns root names and interpretations. Epicenter owns Yjs document
construction, provider attachment, hydration, synchronization, revocation,
compaction, and destruction.

## Consequences

- `yjs`, `y-indexeddb`, their old `lib0` and protocol family, and the patched
  IndexedDB provider leave the final dependency graph at the production flip
  that deletes the old room path; until that flip they serve only the legacy
  rooms, never row documents.
- Browser and native providers share conformance semantics without sharing a
  storage implementation.
- Persisted Yjs 13 stores are abandoned under the authorized pre-user reset and
  are never opened by the new runtime.
- Export, revocation, Device Add, and workspace reset can address documents that
  are not currently open without inventing a second provider registry.
- Adopting a later Yjs 14 release is an ordinary deliberate dependency upgrade;
  an incompatible persisted or wire format requires a new explicit format
  decision, not a permanent previous-major branch.

## Considered alternatives

- **Peer-override `y-indexeddb`.** Rejected because its public package and
  implementation are tied to the Yjs 13 dependency family.
- **Wait for an official Yjs 14 IndexedDB provider.** Rejected because no such
  package currently exists and the required append/replay/durability contract
  is small and product-specific.
- **Retain Yjs 13 for providers only.** Rejected because two CRDT majors in one
  document lifecycle are not a simplification.
- **Put deletion on the active lease.** Rejected because destructive storage
  ownership must wait until every writer is disposed and belongs to the
  workspace-scoped store.
