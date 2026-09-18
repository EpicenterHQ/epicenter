# 0238. The live document is the truth while open, and persistence is a visible debt

- **Status:** Accepted
- **Built 2026-09-06, including the surface.** The title said persistence is a VISIBLE debt while `blocked` was reported to nobody. `PersistenceNotice` in `@epicenter/app-shell` is the surface, mounted by all three applications' shells: it renders only `blocked`, says that changes are not being saved on this device and that closing the window loses them, and offers `flush()` as a retry. Blocking the exit while blocked was considered and refused: the notice is
  always on screen, so a person signing out has already been told, and a rule
  that stops them leaving would trap somebody whose disk is genuinely full. The
  point of making the state visible is that no exit path needs its own rule.
- **Amended by:** [ADR-0298](0298-the-authority-is-byte-blind-and-a-cursor-is-a-log-position.md) at sync delivery. The authority is byte-blind and positional; a replica's owed suffix is still read from its durable update log.
- **Date:** 2026-08-12
- **Supersedes:** [ADR-0223](0223-a-page-holds-the-store-and-only-three-small-relations-have-to-survive.md). Its in-memory SQLite, the worker that mirrored it to an OPFS file, and the three relations are gone; IndexedDB owns the durable facts directly. "A page holds the store" survives through ADR-0227.
- **Amends:** [ADR-0190](0190-a-build-declares-which-epicenter-owns-its-data-not-which-window-it-runs-in.md) at its OPFS clause only: the store's browser record is IndexedDB at the ADR-0348 address. The keychain clause and the decision that a build declares its owner stand.
- **Amends:** [ADR-0237](0237-nonconformance-is-a-reads-only-error-and-a-disposed-store-throws.md)
  at the storage arm: the `storage-failed` poison is withdrawn, and an unusable
  store now means only a disposed one. `QueryFailed` widens by one cause: a
  stale read index whose rebuild failed refuses the statement through the same
  error, because "this statement got no trustworthy answer" is one outcome
  however it came about.
  [ADR-0231](0231-rebuilding-replaces-a-workspaces-current-yjs-document.md) at
  the mechanism of bytes-with-cursor: the update and its authority position are
  attempted by one ordered queue flushed whole, rather than by each verb owning
  its own SQLite transaction. The old document-identity stamp is retired by
  ADR-0292.
- **Relates:** [ADR-0233](0233-a-browser-application-keeps-a-private-document-and-one-workspace-replica-per-account.md)
- **Amended by:** [ADR-0280](0280-a-browser-stores-durable-record-is-a-chain-of-updates-in-indexeddb-folded-on-idle.md) at the browser layout. Its proposed whole-document write was not adopted; the current browser still keeps an update log, with authority positions read from its records.
- **Amended by:** [ADR-0300](0300-accepted-edits-are-live-immediately-and-persistence-and-sync-are-best-effort.md) at the sync gate, and restored at that gate by [ADR-0302](0302-a-local-edit-is-offered-to-the-authority-once-it-is-durable.md). Sync sends only durably recorded work again; what 0300 kept is that an edit is accepted live and neither path may throw through the editor.
  (which documents exist and where), [ADR-0227](0227-one-runtime-a-desktop-spa-in-a-webview-over-a-client-owned-store.md)
  (the client owns the store).

## Context

The store treated a refused durable commit as the death of the process's data
plane: the first failed SQLite transaction poisoned the store and every later
verb threw `StoreUnusableError('storage-failed')`. ADR-0237 gave that
discipline its honest channel, and in doing so made it policy.

That lifetime model is rejected. A live Yjs document does not become untrust-
worthy because a disk write failed; the person's edit is in memory, every read
serves it, and every other replica can still receive it. Poisoning the store
converted a storage problem into forced data loss: the one copy that was
certainly good, the live document, was made unreachable.

Meanwhile the two runtimes disagreed about what a write even was:

- The browser store was already write-behind. Verbs committed into an
  in-memory SQLite, and a checkpoint of the whole file was copied into
  IndexedDB after each commit. A failed checkpoint set a sticky
  `durability(): { healthy: false }` that no later success cleared, and
  nothing in any app rendered it.
- The Bun store made the durable write synchronously inside the verb, so a
  refusal had a call site to poison.

So the browser already lived the truth this record adopts, without admitting
it: an open client's reads came from the live document, durability was
best-effort behind it, and a persistence failure lost nothing until the page
closed. What it lacked was an honest status, recovery, and a durable layout
that was more than a snapshot of somebody else's file format.

The truth to make explicit:

```text
live process: Yjs state is authoritative now
restart:      only successfully persisted state is recovered
```

If persistence stays unavailable and the client closes, edits that existed
only in memory are lost. That is accepted. Hiding it is not.

## Decision

**Accepting an edit and recording it durably are two steps. Acceptance is
synchronous and cannot fail for storage reasons: the live Yjs document and its
declared data view update immediately. Durable recording is an ordered queue of
work the store owes its own storage, flushed whole and atomically, with one
observable status. Sync may deliver accepted work before durable recording
settles; a persistence failure is a visible debt rather than an acceptance
failure.**

### Two debts, never conflated

```text
local-persistence debt: has this client written the update durably?
  private in-memory queue -> durable update log

sync-delivery debt: has the authority accepted an accepted local update?
  transient delivery queue -> server acknowledgement
```

An accepted local edit may be offered to the authority before its durable write
finishes. A persistence failure leaves the live edit usable and visible as a
durability debt; a sync failure leaves it available for retry. Offline is a
sync fact; blocked is a persistence fact; the two statuses never share a
channel.

### The persistence surface

```ts
type PersistenceStatus = 'saved' | 'pending' | 'blocked';

store.persistence.get(): PersistenceStatus;
store.persistence.subscribe(listener: () => void): () => void;
store.persistence.flush(): Promise<void>;
```

`saved`: nothing accepted remains only in memory. `pending`: a flush is
requested or in flight. `blocked`: the latest flush failed and a restart would
lose the retained work. `flush()` requests one attempt over everything
outstanding and resolves when the controller settles, whatever the outcome;
the outcome is `get()`'s answer. `subscribe` fires on status change.

Deliberately absent: queued-update counts, a `retrying` state, raw causes, and
storage-engine detail. The cause of a failed flush goes to the store's logger.
The status is document-wide, not per table, because the queue is one ordered
sequence for the whole document. This surface replaces the browser store's
`durability()` and `whenDurable()`, which are deleted.

There is no autonomous retry loop. Every accepted edit requests one coalesced
flush attempt; a blocked store is retried by the next edit, by an explicit
`flush()`, or by whatever lifecycle moment an application chooses to wire.

### One queue, flushed whole

Each store owns a private controller: an ordered queue of durable operations
(append an update with its authority position, or acknowledge a submitted
range) and a mirror of what the durable engine has confirmed. A flush hands the
entire queue to the storage port as one atomic batch: all of it commits or none
of it does. On success the ops leave the queue and the mirror advances; on
failure everything stays queued, in order, and the status reports blocked. Ops
accepted during an in-flight flush join the next batch.

Whole-queue atomicity is what carries ADR-0231's two invariants without
per-verb transactions:

- **Bytes with cursor.** A remote entry's log append and its cursor advance
  are adjacent ops in one batch, so durable state never holds a cursor ahead
  of the bytes it accounts for. A remote update may be live before it is
  durable; a crash then simply re-receives it, and updates are idempotent.
- **Accepted work may precede durability.** The sender can offer an accepted
  local edit before its durable append succeeds. If the process ends first, the
  edit may be lost locally; if the authority accepted it, the next connection
  can download it again. ADR-0300 makes this independent failure boundary
  explicit.

On a synchronous storage port (Bun's file SQLite, a Durable Object's SQLite)
the flush attempt runs inside the accepting verb, so a successful write is
durable when the verb returns, exactly as before. On an asynchronous port
(IndexedDB) the attempt starts immediately and bursts coalesce into the next
batch. `onLocalWork` fires when an accepted local edit enters the transient
delivery queue. The transport may send it immediately; the durable log remains
the restart and resend path.

### Derived views

The declared data view reads the live Yjs document and updates with acceptance.
SQL is not a built-in store surface; an application may compose it as a
follower and rebuild it from the document (ADR-0241, ADR-0269). A follower's
failure does not fail the edit or change the persistence and sync debts.

### What still throws, what still returns

`StoreUnusableError` narrows to disposal: a use-after-dispose programmer
error. No storage outcome poisons a store or throws from a verb mid-life.
Boot stays fallible: an opener that cannot load or create durable storage
returns `StoreError.StorageFailed`, because a store that cannot READ its
durable record has nothing trustworthy to hydrate from. Reads keep ADR-0237's
surviving rule: a `Result`'s error arm is declaration conformance and nothing
else.
Write validation, absent rows, undecodable remote bytes and refused SQL keep
their caller-actionable `Result`s.

### Runtime storage

One logical durable record everywhere: the update log, with an authority
position on each record when the store syncs. The outbox and cursor are derived
from those records; generation identity is in the address (ADR-0292).

```text
Bun / desktop / Durable Object
  SQLite owns the durable facts directly in `_updates`, including the update
  id, bytes, and optional authority position. The port's commit is synchronous.

browser
  IndexedDB owns the durable facts directly in one `updates` object store,
  written in one transaction per flush. The whole-checkpoint snapshot of an
  in-memory SQLite file is deleted. On open, the durable updates hydrate the
  Yjs document.
```

y-indexeddb was evaluated and rejected for the browser engine: it exposes no
public way to participate in its transactions, so the outbox and cursor could
never commit atomically with the updates it stores, and its own debounce and
compaction make its update store unreadable as a stable log (verified against
the y-indexeddb source via DeepWiki, 2026-08-12). The existing `idb`
dependency talks to IndexedDB directly instead.

### Restart is honest

Reopening reconstructs exactly the last durable state: durable updates replay
into the document, the durable outbox is what remains to send, and the durable
cursor is where reading resumes. Work that was accepted but never flushed is
gone locally, although the authority may restore it if it accepted the edit.
Closing while `blocked` is the one way to lose the only local copy, and it is a
choice the application can surface (warn, retry, export) rather than a
corruption.

## Consequences

- The poison discipline, its `poisoned` state, the `read()` fail-closed helper
  in the client log, and the test pinning terminal storage failure are
  deleted. Their replacement is the failable-port test family: accept while
  blocked, retry preserves order and lands exactly once, restart recovers the
  durable prefix.
- The browser checkpoint (`BrowserCheckpoint`, `state`/`durable` record) is
  deleted; its data migrates into the new object stores in the IndexedDB
  upgrade transaction, so nothing already durable is wiped.
- `query()` no longer sees `_updates`, `_outbox`, `_cursor`, `_meta`. The one
  outside reader (the test-only server replica's wipe) owns its database
  handle and is unaffected as a wipe, but any diagnostic SQL over the log now
  belongs to the port, not the projection.
- The store constructors take the durable port and the projection database as
  separate things; the SQLite convenience path keeps one-database construction
  for the Durable Object replicas, whose synchronous port preserves their
  write-then-read test shape.
- Every commit notification (`onCommitted`, table and KV invalidations) fires
  at acceptance, after the projection write, no longer gated on durability.
  Boot gates that wait for the identity stamp via `onCommitted` are unchanged.
- Memory holds the retained queue while blocked. Unbounded in principle,
  bounded in practice by the person's editing rate; if it ever matters, the
  queue can merge adjacent appends without changing the contract.

## Considered alternatives

- **Keep the poison (status quo, ADR-0237's storage arm).** Rejected by the
  owner: it forces the loss of live, good data to punish a storage failure,
  and the browser runtime never actually lived under it.
- **Return storage failure from each verb.** Rejected in ADR-0237 for reasons
  that still hold: no call site can act on it, and it invites `?? []`
  mis-defaults. The channel for a storage problem is status, not a per-call
  error.
- **A process-wide persistence agent.** Rejected: each document's queue,
  mirror, retry lifecycle and disposal belong to its store; a shared agent
  adds a lifetime that owns nothing else.
- **Expose retry/queue detail in the status.** Rejected: no consumer acts on
  it, and three states name every decision an application can make (nothing,
  wait, warn/retry).
- **y-indexeddb as the browser engine.** Rejected above: no transaction
  surface for the outbox and cursor, private compaction.
- **Keep the checkpoint but fix its status.** Rejected: it snapshots one
  runtime's file format into another's storage, pays a whole-file write per
  commit, and leaves the stamp-before-push window open.
- **An autonomous backoff retry loop.** Rejected for now: the retry triggers
  that exist (next edit, explicit flush, app lifecycle) cover the real cases
  without a timer that can spin against a full disk; revisit only with
  evidence.
