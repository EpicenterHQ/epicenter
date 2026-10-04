# Complete split replica candidate: working design draft (v2, post-challenge)

Working draft for the ADR-0177 replica-layout evidence run. Not committed
truth. Base: `aea2965018` on `codex/replica-layout-evidence`.

## v2 corrections (from the adversarial challenge)

1. Existence law corrected: document and blob state SURVIVES `unset`
   (confirmed or pending/sealed). Only append, capture, publication,
   settlement, and read require live visibility. Only the terminal tombstone
   and erase reap document/blob state.
2. Tombstone rules split by origin:
   - LOCAL tombstone (composed into pending): the pending tombstone REMAINS in
     `local_intents` to be sealed; document/blob state is reaped.
   - CONFIRMED tombstone (installFact): clears pending + parked, PRESERVES a
     pre-existing sealed lane (the exact retry image must survive), reaps
     document/blob state.
3. Settlement and confirmed-tombstone statement plans are explicit
   DELETE-versus-UPDATE partitions so no statement ever leaves an empty
   `local_intents` row (CHECK is per-statement):
   - settle sealed-clear: `DELETE FROM local_intents WHERE sealed_op IS NOT
     NULL AND pending_op IS NULL` then `UPDATE local_intents SET sealed_op =
     NULL, sealed_args = NULL WHERE sealed_op IS NOT NULL` (survivors hold
     pending; parked cannot coexist with sealed by CHECK). Parked plans are
     captured BEFORE these statements and re-inserted afterward (INSERT; the
     sealed-only row was deleted) or composed into surviving pending
     (UPDATE), skipping addresses whose confirmed state became tombstone.
   - confirmed-tombstone intent-clear: `DELETE ... WHERE triple AND sealed_op
     IS NULL` else `UPDATE ... SET pending_op = NULL, pending_args = NULL,
     parked_* = NULL WHERE triple AND sealed_op IS NOT NULL`.
4. Document cascade order: capture `doc_id` first; delete `document_chains`
   and `document_inflight` children BEFORE deleting the `record_documents`
   owner row. Erase deletes children before owners too.
5. `record_documents.revision` carries the wide range CHECK
   (`0..9007199254740991`).
6. WITHOUT ROWID on `confirmed_records`/`local_intents` and the absence of
   secondary drain indexes are retained as the candidate's defining measured
   shape (continuous with the earlier scalar candidate); both are explicitly
   measured risks (payload-sized rows vs SQLite's ~1/20-page guidance;
   drain-scan selectivity under accumulated accepted/clean rows), not assumed
   wins. `record_documents` keeps only its required unique address index.

## Production wide layout (format 2), as measured from `packages/data/src/store/replica/schema.ts`

```
meta (singleton)
  format_version, replica_id,
  attached_deployment, attached_principal,        -- attachment pair (both-or-neither)
  authority_lifetime, erased_authority_lifetime,  -- lifetime binding + erase fence
  after_sequence,                                 -- facts watermark
  sealed_submission, sealed_request, sealed_request_hash,  -- exact sealed witness
  next_submission                                 -- submission fencing

records (record_id INTEGER PK)
  namespace, collection, record_key               -- UNIQUE records_address
  confirmed_state, confirmed_payload, confirmed_sequence   -- confirmed lane
  sealed_op, sealed_args                          -- sealed lane
  pending_op, pending_args                        -- pending lane
  parked_op, parked_args, parked_code, parked_measured, parked_limit  -- parked lane
  doc_revision, doc_dirty                         -- document watermark
  blob_sha256, blob_pending, blob_parked_code     -- blob watermark
  CHECK: lane shapes; parked excludes pending+sealed; at-least-one-lane;
         blob_pending=>digest; blob_parked=>pending
  partial indexes: pending, sealed, doc_dirty, blob_pending

record_documents (chain_id PK, record_id, seq, kind, bytes, UNIQUE(record_id, seq))
document_inflight (record_id PK, payload, digest, captured_revision,
                   parked_code, measured_bytes, measured_structs,
                   limit_bytes, limit_structs)
```

Transactions in the wide store (owner: `replica-store.ts`, `document-store.ts`,
`blob-store.ts`):

1. `localWrite` — read row, compose, update pending (+ tombstone cascade:
   reset doc/blob columns, delete chains + inflight).
2. `seal` — scan pending via partial index, admit, move pending->sealed for
   selected rowids, write sealed witness to meta.
3. `installFacts` — per-fact upsert of confirmed lane (+ tombstone cascade),
   advance meta watermark/lifetime.
4. `settle` — verify persisted witness bytes+hash, install facts, clear all
   sealed lanes, re-park or re-compose refused intents, advance
   next_submission, clear witness.
5. `erase` — delete records, chains, inflight; fence erased lifetime; reset
   sync state.
6. document `append` (local/accepted) — hydrate chain, append or compact to
   baseline, bump revision+dirty (local), drop parked inflight.
7. document `publication` — freeze exact payload+digest+captured_revision into
   inflight, or park with measured bounds.
8. document `settle` — receipt/refusal against exact inflight digest; clear
   dirty only when revision unmoved.
9. blob `capture`/`settle` — stage/promote files outside SQLite, then one
   membership transaction on the blob columns.

## Complete split candidate (draft to be challenged)

Same semantic model, same API, same meta table. Role-owned relations:

```sql
CREATE TABLE meta ( ... identical to wide ... ) STRICT;

-- Confirmed facts: a row exists exactly when a confirmed fact exists.
CREATE TABLE confirmed_records (
  namespace   TEXT NOT NULL,
  collection  TEXT NOT NULL,
  record_key  TEXT NOT NULL,
  state       TEXT NOT NULL CHECK (state IN ('live', 'tombstone', 'unset')),
  payload     TEXT,
  sequence    INTEGER NOT NULL CHECK (sequence BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY (namespace, collection, record_key),
  CHECK ((state = 'live') = (payload IS NOT NULL)),
  CHECK (payload IS NULL OR json_valid(payload))
) WITHOUT ROWID, STRICT;

-- Sparse scalar work: a row exists exactly when any of sealed/pending/parked
-- lanes exists (enforced by the final CHECK; emptying transactions DELETE).
CREATE TABLE local_intents (
  namespace, collection, record_key,
  sealed_op, sealed_args,
  pending_op, pending_args,
  parked_op, parked_args, parked_code, parked_measured, parked_limit,
  PRIMARY KEY (namespace, collection, record_key),
  -- identical lane-shape CHECKs to wide, plus:
  CHECK (sealed_op IS NOT NULL OR pending_op IS NOT NULL OR parked_op IS NOT NULL)
) WITHOUT ROWID, STRICT;

-- Document identity + watermark: a row exists exactly when a chain exists.
CREATE TABLE record_documents (
  doc_id      INTEGER PRIMARY KEY,
  namespace, collection, record_key,   -- UNIQUE index
  revision    INTEGER NOT NULL DEFAULT 0,
  dirty       INTEGER NOT NULL DEFAULT 0 CHECK (dirty IN (0, 1))
) STRICT;
CREATE UNIQUE INDEX record_documents_address ON record_documents(namespace, collection, record_key);

-- Bounded baseline-plus-tail chain entries (payload-sized: rowid table).
CREATE TABLE document_chains (
  entry_id  INTEGER PRIMARY KEY,
  doc_id    INTEGER NOT NULL,
  seq       INTEGER NOT NULL CHECK (seq >= 1),
  kind      TEXT NOT NULL CHECK (kind IN ('baseline', 'update')),
  bytes     BLOB NOT NULL CHECK (length(bytes) > 0),
  CHECK (kind = 'update' OR seq = 1),
  UNIQUE (doc_id, seq)
) STRICT;

-- Exact frozen publication image or compact refusal measurements.
CREATE TABLE document_inflight (
  doc_id PRIMARY KEY, payload, digest, captured_revision,
  parked_code, measured_bytes, measured_structs, limit_bytes, limit_structs
  -- identical CHECKs to wide
) STRICT;

-- Blob watermark: a row exists exactly when a digest is owned.
CREATE TABLE blob_state (
  namespace, collection, record_key,
  sha256    TEXT NOT NULL CHECK (64 lowercase hex),
  pending   INTEGER NOT NULL CHECK (pending IN (0, 1)),
  parked_code TEXT CHECK (parked_code IS NULL OR
    (pending = 1 AND parked_code IN ('blob-conflict', 'record-not-live'))),
  PRIMARY KEY (namespace, collection, record_key)
) WITHOUT ROWID, STRICT;
```

No partial lane indexes: `local_intents` and `blob_state` are already sparse
relations; seal scans `local_intents WHERE pending_op IS NOT NULL` over the
sparse table; document/blob drains scan `record_documents WHERE dirty = 1` and
`blob_state WHERE pending = 1`. Whether `dirty` needs a partial index is a
measured question (document rows are also sparse relative to records).

## New cross-table invariants introduced by split, with owning transactions

| # | Invariant | Owner |
|---|-----------|-------|
| 1 | A record "exists" iff any role table holds its triple; there is no row with no lanes (per-table at-least-one CHECK + delete-when-empty) | `settle`, `localWrite` |
| 2 | Tombstone (confirmed or local) deletes `local_intents` pending/parked, `blob_state`, `record_documents`, `document_chains`, `document_inflight` for the triple in the same transaction | `installFacts`, `settle`, `localWrite` |
| 3 | Document/blob rows may exist only at live-visible records; liveness now reads `confirmed_records` + `local_intents` (two point reads) | document `append`/`publication`/`settle`, blob membership |
| 4 | `document_chains`/`document_inflight` rows require their `record_documents` owner; deleting the owner deletes both (no FK cascade — explicit) | tombstone cascade, `erase`, compaction |
| 5 | Sealed-lane reconstruction joins `local_intents` only (same-table; no new invariant) | `seal`, `settle`, `reconstructSealedRequest` |
| 6 | Erase deletes all six relations + meta fence in one transaction | `erase` |
| 7 | A parked `local_intents` row excludes pending+sealed (same CHECK as wide, now on the sparse table) | `settle` |
| 8 | Point read of full lanes is now up to 4 point lookups (confirmed, intents, doc watermark, blob) or a 3-way LEFT JOIN from `confirmed_records`... except records absent from `confirmed_records` require anchoring the read on the union | `record()` observation |

Invariant 8 is the honest hot-path cost: `record()` in wide is one index seek;
in split it is a union/left-join across sparse relations.

## Semantics that must be preserved exactly (mission checklist)

address identity + confirmed fact; sealed/pending lanes; parked scalar work;
exact sealed request bytes+hash; lifetime + sequence fencing; baseline+tail
chains; local + accepted document revisions; compact document refusal
measurements; local + accepted blob digests; blob refusal; terminal tombstone
cleanup; erase/reopen/reacquisition/attachment; browser single-owner laws.
