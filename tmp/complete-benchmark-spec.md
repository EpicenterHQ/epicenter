# Complete wide-versus-split replica benchmark: workload spec (working draft)

Both candidates are driven through the same store API (`openReplicaStore` for
wide, `openSplitReplicaStore` for split), so identical data and transitions
hold by construction. The scalar fixture generator (1,000,000 final-present
records, exact 536,870,912-byte V1 proxy) is reused unchanged from
`replica-layout.bench.ts`.

## Fixture extensions beyond the scalar run (identical for both layouts)

- Documents: every 20th record (50,000) carries a chain: one baseline plus a
  small tail of real Yjs V2 updates generated deterministically (seeded text
  edits; no Math.random/Date).
- Document inflight: a deterministic subset (5,000) hold active frozen
  publication images.
- Blobs: every 25th record (40,000) owns a digest (deterministic 64-hex from
  the index); half pending, half accepted; a small parked set.
- Pending intents: every 50th record (20,000) holds a pending patch.
- Parked intents: 1,000 records parked `fact-too-large`.
- Seeding goes through each candidate's production write path where a write
  path exists (installFacts pages, localWrite, appendLocal, blob membership
  writes), so seeding is itself a fairness surface; any benchmark-only insert
  shortcut must be identical for both candidates and disclosed in the report.

## Metrics (each: 3 repetitions, alternating candidate order, p50/p95 + raw)

1. pointRead — full-lane `record()` per address over a mixed batch
   (confirmed-only / with intents / with docs / with blobs).
2. traversal — classified collection traversal in one namespace+collection.
3. laneWrite — `localWrite` batches: fresh addresses and existing addresses.
4. seal — full seal transactions at the 64-address ceiling.
5. factInstall — `installFacts` pages of 64 facts (mix of new and updates).
6. docAppend — `appendLocalDocumentUpdate` of one real update to sampled
   existing chains.
7. docDrainScan — enumerate dirty documents (publication drain candidates).
8. blobDrainScan — enumerate pending blob obligations.
9. tombstoneCleanup — installFacts tombstone pages over records that own
   documents + blobs + intents (measures the cascade).
10. reopen — close, reopen, one point read.

Recorded per candidate run: database live/file bytes, `PRAGMA
integrity_check` (Bun; browser where authorized), semantic row counts after
reopen, statement counts per metric via a counting adapter, `EXPLAIN QUERY
PLAN` for every hot statement, schema SHA-256 fingerprints, source SHA-256,
runtime versions, parameters, commit.

Rows read/written: SQLite embedded APIs do not expose DO-style row counters;
statement counts and query plans are the measurable proxies. State this limit
in the report rather than approximating.

## Owners

- Bun/native: `packages/data/src/__benchmarks__/replica-layout-complete.bench.ts`
  (new maintained source; the scalar bench remains as historical evidence).
- Browser OPFS: extend `browser-evidence/` with a complete-layout worker and
  runner; Chromium and WebKit via Playwright. Physical iOS Safari and Android
  Chrome remain explicitly open.
