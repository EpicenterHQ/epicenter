# 0174. Row documents project as nullable compact cells and persist as bounded live chains

- **Status:** Proposed
- **Date:** 2026-07-20 (revised 2026-07-24: HTTP publication, explicit pull, and terminal oversized lineages)
- **Supersedes:** the document socket, exact-byte retention, presence, and document-full recovery mechanics of [ADR-0145](0145-one-account-authority-owns-every-workspace-and-one-socket-per-open-row-document.md), plus [ADR-0159](0159-row-documents-persist-in-one-owner-side-sqlite-update-log.md)'s statement that remote authority mechanics remain unchanged
- **Amends:** [ADR-0146](0146-row-documents-use-one-yjs-14-major-and-runtime-native-update-logs.md), [ADR-0159](0159-row-documents-persist-in-one-owner-side-sqlite-update-log.md), [ADR-0171](0171-every-durable-local-write-leaves-an-automatic-authority-obligation.md), [ADR-0172](0172-sqlite-stores-convergent-facts-and-documents-raw-files-store-blob-bytes.md)

## Context

A row document belongs to its record, but its write mechanics differ from small
scalar facts. Yjs updates are binary, mergeable, and often much larger. Storing
the complete encoded state after every edit causes write amplification. Treating
the document as an independent resource creates another identity and lifecycle.

The durable representation and network transport are also different concerns.
A bounded update chain earns its place as a local write optimization. A
WebSocket, exact retry image, or receipt digest does not become necessary merely
because the chain exists.

## Decision

Every durable record universally owns one latent nullable Yjs document cell.
The cell has no identity or lifecycle outside its record. A Lens may expose a
typed document handle for a table interpretation, but it does not create the
document, choose its storage, or own synchronization.

```txt
record
|-- scalar fact
|-- nullable Yjs document
`-- nullable immutable blob
```

### Portable and inspection representations

A portable Backup projects one self-contained compact Yjs V2 update directly
on the record. `NULL` means no document state has ever been persisted for that
record. A Backup never exposes the private baseline-plus-tail chain.

Relational inspection exposes document metadata only: whether state exists,
encoded size, local revision, accepted revision, and any terminal sync issue.
Exporting one document is a typed operation, not a general SQL blob projection.

### Private durable representation

Every live owner stores the document in the same SQLite database as its scalar
record. A sparse sibling relation keyed by the private record ID contains:

```txt
seq = 0   complete baseline update
seq > 0   later incremental updates in commit order
```

The record row stores the local revision, accepted revision, optional terminal
issue, and optional internal not-live publication suppression. The chain is a
private write optimization, not document history, public protocol state, or
another collection.

Opening hydrates one local `Y.Doc` from the chain. Local updates append durably
and advance the revision in the same transaction. Compaction replaces the
chain with one complete baseline when entry or byte thresholds are crossed.
A crash exposes either the old committed chain or the new committed baseline,
never a partial rewrite.

Closing the final handle destroys its in-memory `Y.Doc`; it does not remove
durable state or its automatic publication obligation. Terminal record deletion
revokes every live handle and removes the chain, revisions, issue, and blob
membership atomically. Reversible unset preserves them.

### Authority representation and bounds

The authority stores the same logical document as a bounded baseline-plus-tail
chain and may compact it independently. It retains no live `Y.Doc` between
operations.

One atomic document acceptance operation:

1. rechecks record liveness;
2. hydrates committed authority state;
3. applies the submitted complete Yjs state;
4. measures canonical post-candidate state;
5. refuses an over-bound result without mutation; and
6. otherwise commits the joined state and advances its opaque document version.

The compound V1 bound remains:

```txt
stateBytes   <= 1,048,576
stateStructs <= 131,072
```

Both endpoints measure the same canonical `encodeStateAsUpdateV2` state and
decoded struct count. The exact constants remain Proposed until maintained
rich-text and workerd evidence proves their operational envelope.

Exceeding either limit is exceptional terminal state for that Yjs lineage.
Local persistence and export remain available, but Epicenter stops automatic
publication and reports:

```ts
type DocumentSyncIssue = { kind: 'too-large' } | null;
```

Epicenter does not distinguish recoverable byte fullness from non-recoverable
struct fullness in its durable product state. It does not retry on every edit
or promise that deleting content repairs accumulated CRDT structure. The
application owns recovery: export, copy visible content into a fresh row, split
the content, or flatten it. A later authority-limit change does not silently
resume a lineage already recorded as terminal.

### Transport

The runtime automatically publishes owed documents through the HTTP path
defined by ADR-0171. Publication reconstructs complete state from the chain and
settles only the captured local revision. It stores no exact retry image or
digest receipt.

An open handle may explicitly `pull()` accepted authority state. Pull is bound
to the active authority lifetime and conditional on an opaque authority
document version or equivalent HTTP validator, so unchanged state transfers no
document body. The runtime fences installation by handle generation, disposal,
and authority lifetime. Applying accepted inbound state is durable and creates
no outbound obligation.

There is no document WebSocket, presence state, server fanout session, live
authority cache, document subscription inventory, or background download for
closed documents.

## Consequences

- The record remains the only public address and lifecycle owner.
- Baseline-plus-tail storage limits local write amplification without leaking
  a log abstraction into APIs or Backups.
- Authority acceptance, bounds, commit, and version advancement have one
  implementation.
- Complete-state publication costs bytes proportional to the encoded document;
  state-vector-scoped HTTP diffs remain a measured future optimization.
- Document publication continues after every UI handle closes.
- Remote freshness is application-controlled and applies only to open handles.
- An oversized lineage becomes locally usable but unsynchronized until the
  application creates a fresh lineage.
- One oversized document does not block publication of other records.
- The authority can emit one compact accepted document for Backup without
  opening a long-lived document session.

## Acceptance evidence

Before this ADR becomes Accepted, maintained tests must prove:

- local append and revision advancement commit atomically;
- reopen reproduces identical Yjs state;
- compaction preserves semantic state, including delete-only updates;
- a crash during compaction leaves one valid committed chain;
- remote accepted installation creates no local publication obligation;
- delayed acceptance settles only its captured revision;
- terminal deletion reaps state and revokes handles while unset preserves it;
- authority acceptance checks liveness and bounds in the committing operation;
- authority storage failure is not converted into `too-large`;
- not-live publication records internal durable suppression and cannot spin;
- a too-large result mutates no accepted authority state;
- too-large remains durable and terminal for that lineage;
- conditional pull transfers no body when authority state is unchanged;
- pull after handle disposal cannot install state;
- pull from a replaced authority lifetime cannot install state; and
- Backup and Restore round-trip the nullable compact cell.

## Considered alternatives

- **Store one complete document after every local edit.** Rejected because it
  turns every keystroke into a full-state rewrite.
- **Expose the update chain as history.** Rejected because compaction may
  replace it at any time.
- **Give documents independent identities.** Rejected because record deletion
  would require a second revocation or garbage-collection protocol.
- **Keep a document WebSocket beside HTTP publication.** Rejected because it
  creates another candidate-production and lifecycle path.
- **Treat oversized state as automatically recoverable.** Rejected because
  struct-heavy Yjs history often cannot be repaired by ordinary editing, while
  retry and re-arm machinery affects every normal publication.
- **Hydrate every closed remote document.** Rejected because no active consumer
  needs those bytes and scalar state already owns row discovery.
