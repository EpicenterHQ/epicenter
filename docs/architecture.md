# Epicenter architecture

Epicenter is a local-first workspace platform. Apps define stable workspace
families, clients keep complete local data, and a hosted or self-hosted star
keeps devices synchronized while they sleep.

This page is the five-minute map. Durable decisions live in
[`docs/adr`](adr/README.md). Shared vocabulary lives in
[`docs/CONTEXT.md`](CONTEXT.md). Package-owned current behavior belongs in
package READMEs and code.

## The stack

Apps compose middleware and core packages. Dependencies point downward; product
policy stays in the app that can name it.

```text
+----------------------------------------------------------------------------+
| APPS                                                                       |
|                                                                            |
| whispering   honeycrisp   epicenter   tab-manager   api   self-host        |
| landing      local-books  local-mail  opensidian    todos                  |
+----------------------------------------------------------------------------+
                                      |
                                      v
+----------------------------------------------------------------------------+
| MIDDLEWARE                                                                 |
|                                                                            |
| @epicenter/svelte      @epicenter/filesystem                               |
| @epicenter/skills      app-owned runtime composition per environment       |
+----------------------------------------------------------------------------+
                                      |
                                      v
+----------------------------------------------------------------------------+
| CORE                                                                       |
|                                                                            |
| @epicenter/workspace   @epicenter/row-sync   @epicenter/sync               |
| @epicenter/field       @epicenter/constants  @epicenter/ui                 |
+----------------------------------------------------------------------------+
```

`@epicenter/workspace` owns the app-facing data contract and runtime handles.
`@epicenter/field` supplies the release-local projection vocabulary.
`@epicenter/row-sync` owns the portable scalar row protocol: row intent folding,
exact retry, current-state paging, transport compaction, and complete-state
acquisition. The Proposed two-plane replacement removes document bytes from
that protocol. Row-addressed Yjs 14 connections synchronize lazy row documents
independently.

## Workspace definitions are app contracts

A workspace definition is pure. It names release-local table and KV lenses
without opening storage or a network connection. Every ordinary row owns one
latent Yjs document; document roots remain application-owned.

```text
defineWorkspace({ id, tables, kv })
        |
        | pure app contract
        v
runtime.open(definition)             Browser, Bun, desktop, or hosted runtime
```

Definitions are not storage schemas. A new release may change its lens
immediately. Nonconforming rows remain stored and visible to repair code.

An Account workspace synchronizes scalar rows automatically. Scalar
`sync.settle()` waits for the scalar work present at invocation and the
authority state that confirms it. Each open document persists automatically;
its `whenDurable()` covers only the local Yjs provider and its connection status
reports document-network progress. Neither barrier impersonates the other.

Device and Account storage are independent owners. Account `open()` never reads
Device data. Products implement consent with Device `capture()` and `delete()`,
Account `add()`, or no call for Keep.

Runtime openers supply the resources that cannot travel with the definition:
browser storage, desktop storage, row synchronization, materializers, auth, and
platform APIs. App-facing code should enter through the workspace definition
instead of rebuilding addresses or storage topology itself.

The client planes meet only at the workspace handle and the server authority:

```text
Browser page: live Yjs 14 docs  ------ socket per open document --------+
Browser Worker: OPFS SQLite                                             |
  (scalar rows + document log)  ------ scalar row HTTP protocol --------+-- workspace authority

Native host: live Yjs 14 docs  ------- socket per open document --------+
Native host: SQLite
  (scalar rows + document log)  ------ scalar row HTTP protocol --------+
```

One `store.sqlite3` per workspace holds both scalar rows and the document
update log (ADR-0156), but co-location is not a cross-plane transaction
contract: the planes stay independently synchronized.

## The scalar row plane is the ordered queryable core

Workspace table fields and workspace KV reduce to scalar row intents. Document
updates never cross this boundary.

```text
workspace scalar runtime
  create/update/delete row fields and kv
        |
        v
row-sync protocol
  RowIntent, sealed rounds, receipts, current-state pages
        |
        v
workspace authority
  SQLite-backed fold, receipts, paging, compaction, acquisition
```

The workspace authority is schema-blind. It orders semantically valid row
intents and folds them into deterministic outcomes. It does not rename fields,
apply defaults, heal application data, or synchronize a device SQLite file as
the wire format.

Each synchronized client tracks:

```text
retired receipt  exact outgoing round already installed locally
checkpoint       authority state this client installed
open intents     compactable local work not yet sent
sealed intents   immutable exact-retry payload
```

The authority receipt contains the accepted round, request digest, and the
sequence through which that round changed current state. The client retires its
sealed overlay only after pull installs state through that sequence. The digest
is the safety witness that stops a restored or copied private database from
silently retiring different content under the same round.

For protocol details and executable coverage, read
[`packages/row-sync/README.md`](../packages/row-sync/README.md) and
[`packages/row-sync/src/current-state-protocol.test.ts`](../packages/row-sync/src/current-state-protocol.test.ts).

## Documents are a lazy Yjs 14 plane

Documents remain the right representation for merge-sensitive content. Every
ordinary row owns latent Yjs state under the same identity and lifecycle as its
fields. The workspace API exposes that state through the row's singular
document handle.

Opening a document hydrates its durable update log before networking. Every
runtime persists documents in the workspace's own SQLite store: the records
Worker owns it in the browser, the Bun host owns it natively, and renderer
surfaces reach it through a narrow asynchronous load/append seam (ADR-0156).
Releasing the last handle unloads live state without deleting it. Deleting the
row revokes its handles and deletes its durable log in the same transaction.

Each currently open row document uses one Yjs 14 WebSocket. Every such
connection and the scalar HTTP protocol terminate at the same account
authority actor, which owns exact row liveness and deletion without putting
document updates in `RowIntent`. Closed documents use no socket, and the
server retains no live document state: it hydrates disposable committed state
per admission and per accepted update. Yjs supplies merge semantics inside a
row, but it is not a second public identity or lifecycle.

Document admission has three facts and one surface. The upgrade credential
authenticates a principal. The authority address derives deterministically
from that principal alone (ADR-0092: the principal is the partition, and here
also the actor), so a workspace id is a name inside the requester's own
partition and no request can address another principal's state; there is no
catalog, grant, or per-request authorization lookup. Finally, the authority
checks whether the route's `(table, rowId)` is live. A not-live row closes
retryably with no reserved code; the client's own scalar plane knows whether
its row is still awaiting admission, and scalar synchronization installing a
deletion is what revokes the open document. There is no terminal document
verdict on the wire: the authority enforces the compound document bound
(bytes and struct count of the canonical post-candidate state, ADR-0146)
exactly inside the append transaction, clients estimate the same bound and
suppress sending while over it, and close 1009 is only a defensive backstop
against a stale estimate. The row address is not a
capability. Every update rechecks liveness in its SQLite transaction. Row
deletion removes the row, records a bounded deletion marker, and removes the
server document snapshot and update log in one transaction, then closes the
row's sockets. A crash before those closes cannot resurrect bytes because
acceptance rechecks liveness against committed state.

On Cloudflare, each hibernating socket stores its one fixed structured address
within the platform's 16,384 byte attachment limit. Fanout enumerates the
actor's sockets and compares complete attachment addresses; open documents are
few by product premise, so no tag index ships until measured socket counts
earn one. This uses the platform's per-socket recovery instead of persisting a
mutable multiplex subscription set. The platform permits at most 32,768
hibernating sockets per actor. Multiplexing remains refused until measured
open-document socket pressure earns its additional protocol state.

This document plane uses `@y/y` 14 only. It provides no Yjs 13 dependency,
persisted-state reader, alias, migration path, dual wire, or fallback.

## Lens evolution never migrates user data implicitly

Definitions are views over durable JSON. A release may add a required field,
remove a field, or change validation. Rows that no longer conform remain
preserved as invalid data. The runtime does not copy a database, execute an
upcaster, add fallback keys, or reinterpret old writes.

When product semantics require conversion, the application owns a normal,
explicit repair loop. It may recognize an old shape, compute the new value, and
issue bounded typed patches. Mixed releases may disagree until the repair
converges; that is honest application behavior rather than a platform migration
protocol.

```text
durable JSON stays unchanged
        |
        +-- old release lens -> one interpretation
        `-- new release lens -> valid rows plus explicit invalid rows
```

## The star owns availability, not application meaning

A star is the runnable deployment that holds a person's synchronized data. The
hosted Cloud app and the self-hosted instance use the same shared server library
but resolve principals differently.

The workspace authority backend owns scalar ordering, receipts, current rows,
complete-state acquisition, and the separate row-document connections.
Application releases own field validation, document roots, and explicit repair
code. Blob storage holds large binaries by reference.

This separation keeps the privacy question concrete. Epicenter can run the
star, or the user can run it. In either topology, apps keep their schema meaning
and product policy at the client boundary.

## Current transition

The Proposed clean break is queryable SQLite scalars plus runtime-native Yjs 14
document providers, terminating at one workspace authority through separate
protocols. Current code still contains the combined row/document replica,
per-document Yjs 13 rooms, and root-Y.Doc-era paths. Treat all three as
transition surfaces, not ownership boundaries.

During the transition, use accepted ADRs, package READMEs, executable tests, and
code as current implementation truth. Use this architecture page to judge
conversions, delete legacy branches, and prevent root-Y.Doc topology from
leaking back into the selected vocabulary.
