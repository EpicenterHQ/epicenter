# 0298. The authority is byte-blind and a cursor is a log position

- **Status:** Superseded
- **Superseded by:** [ADR-0534](0534-data-folders-are-the-only-data-model.md), which removes the Yjs store.
- **Date:** 2026-08-29
- **Supersedes:** [ADR-0277](0277-the-authority-reads-the-bytes-and-sync-becomes-the-yjs-protocol.md) entirely.
- **Restores:** [ADR-0217](0217-the-authority-appends-opaque-bytes-and-the-client-owns-every-merge.md) and [ADR-0218](0218-the-authority-reads-nothing-and-a-poison-entry-is-repaired-rather-than-prevented.md), whose model never actually left the tree.
- **Relates:** [ADR-0295](0295-a-database-is-one-yjs-document-and-a-row-holds-its-rich-content.md), which removed the reason ADR-0277 existed; [ADR-0292](0292-a-database-opens-an-exact-generation-cache-first-and-bootstraps-account-misses.md), which puts generation identity in the address; [ADR-0004](0004-trust-the-relay-reject-zero-knowledge.md), which this does not reopen.

- **Amended by:** [ADR-0301](0301-owed-updates-collapse-into-one-resendable-row-and-the-fold-stops-asking-whether-a-store-syncs.md) at owed appends staying individually addressable. They collapse into one resendable row above every existing id; the derived cursor and derived outbox are untouched.

## Context

ADR-0277 decided that the authority holds Yjs documents and speaks
`y-protocols/sync`. Its argument was not that reading bytes is good in itself;
it was that blindness had a bill nobody had added up, and that bill was
itemized: the log position, the cursor, the outbox, gap detection, the resync
path, and the snapshot-offer dance. It bought two things with them. Validation
at the door, and a transport with three messages instead of a positional log.

The reason it could afford either was the split. A database was N documents, so
the server needed one object per document anyway, and a device that opened one
note wanted exactly that note's bytes, which is a request, not a position in a
shared stream.

ADR-0295 deleted the split. A database is one Yjs document, one socket, one
object. What ADR-0277 priced as the cost of blindness has to be re-read against
that, and most of it does not survive the re-reading:

- **The state-vector transport bought nothing here.** With N documents, a state
  vector was how a device asked for one document without knowing what it held.
  With one document and one socket held open for the page's whole life, a
  position is strictly cheaper: an integer against a per-connection encode.
- **The bill was already paid.** The log position, the cursor, and the outbox
  are written, tested, and deployed. `readCursor` is `MAX(authoritySeq)` over
  the update chain, so the cursor is not a stored fact that can disagree with
  the bytes; there is no cursor table and nothing about a cursor is in Yjs.
- **Validation at the door was measured and it is the most expensive thing on
  the object.** `evidence/bench/validate.ts`: 112 MB of heap and 34 ms to
  hydrate a 27.7 MB update, against 0.3 MB and 9 ms to hash it. ADR-0218's
  finding stands, and ADR-0295's authority ceiling is now a measured number
  rather than a derived one, which makes hydration-per-submission the binding
  constraint rather than a line item.
- **Two implementations were built.** `sync/authority.ts` (byte-blind,
  positional) is what deploys. `sync/document-authority.ts` (y-protocols-shaped,
  holding a live `Y.Doc`) was written, tested, and wired to nothing. Carrying
  both is the actual cost being paid today, and it is paid every time either is
  touched.

## Decision

**The authority is byte-blind.** It stores and forwards opaque updates. It
makes no Yjs call, holds no document, and never learns what a row is.

**A cursor is a position in the authority's append-only log**, not a
server-side Yjs state vector. Catch-up is "everything after your cursor", and a
live relay is the same sentence with a cursor one behind the head, so there is
one delivery path rather than two that can disagree.

**The client owns application, cursor advancement, and snapshot creation.** It
applies bytes, decides when its cursor moves, and offers its own state when the
authority asks to fold. The authority verifies only that the connection was
sent through the offered position; it never proves an offer covers what it
replaces, because that proof needs semantics it does not have.

**A cursor is derived from the acknowledged update rows in the local durable
record.** `MAX(authoritySeq)` over the chain, computed at open. There is no
cursor table, and no cursor metadata lives in Yjs. A derived cursor cannot
outrun the bytes it accounts for; it can only lag, and a lagging cursor
re-receives, which is free because an update is idempotent.

**`sync/authority.ts` and its client path are canonical, and the
document-aware implementation is deleted** rather than kept as a second
opinion: `document-authority.ts`, `document-hub.ts`, `document-handle.ts`,
`document-frames.ts`, `sync/fold.ts`, `sync/chunks.ts`, `store/record.ts`,
`store/record-memory.ts`, and their suites. No compatibility alias survives.

## Consequences

- ADR-0218's poison-entry repair is the recovery story again: a bad entry is
  overwritten with the 13-byte empty update, a valid no-op that keeps the
  sequence contiguous, and `SyncClientError.Unapplyable` names the position.
  Both halves are pinned in `sync/transport.test.ts`.
- End-to-end encryption stays possible, which it is exactly as long as the
  authority never reads the bytes. ADR-0004 decided the relay is trusted and
  this does not reopen that; it declines to foreclose the option for free.
- The authority is coupled to no Yjs version, so a format change cannot make
  the server refuse a valid client's writes.
- A replica keeps an outbox, a cursor, and gap detection. That is real
  machinery and ADR-0277 was right that it is not free; what changed is that
  it is written and the alternative is not.
- Roughly 2,600 lines leave the tree with the second implementation, and every
  future change to sync has one place to happen.
- `y-protocols` stops being a dependency of the sync path.

## Considered alternatives

- **Keep both and let each serve a case.** Refused, and it is the alternative
  this record exists to refuse. Two implementations of one contract stay green
  while they disagree, which is the same failure `port-conformance.test.ts` was
  written to catch between two durable ports. Nothing was routing between them.
- **Keep the document-aware path for a future collaborative-editing feature.**
  Refused on the same ground ADR-0295 refuses subdocuments: the shape is
  recoverable from git, and carrying an unrouted implementation to hold a place
  for an unscheduled feature is paying maintenance now for optionality later.
- **Read the bytes only to validate, without holding the document.** Refused,
  and measured: it is a filter rather than a proof (44 poison pills survived a
  full-update sweep in `evidence/validation.test.ts`) and it costs more than
  hydrating the document it was chosen to avoid hydrating.
