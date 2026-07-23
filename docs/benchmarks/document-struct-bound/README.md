# Document struct-bound Workerd evidence

This retained run exercises the production `DataAuthority` Durable Object under
the repository's pinned Miniflare and Workerd versions. It tests the document
limit with real Yjs 14 states, not mocked measurements.

The workload contains:

- a Honeycrisp-shaped rich-text document with typing, formatting, undo, and
  deletion;
- four offline clients and all 24 application orders;
- dense valid states at 131,071, 131,072, and 131,073 decoded structs;
- a pre-existing accepted document before the above-bound attempt;
- a Workerd dispose and reopen against the same Durable Object SQLite.

The 2026-07-22 run proves:

- every offline-client order converges to one canonical digest;
- 131,071 and exactly 131,072 structs are accepted;
- 131,073 structs are refused as `document-bound`;
- refusal leaves accepted bytes, chain entries, record capture revision, and
  the authority's next capture revision unchanged;
- all accepted and preserved states survive process reopen.

The exact fixture stays well below the independent 1 MiB byte limit, so this
run isolates the struct-count boundary. The current 131,072 limit therefore
stands.

Reproduce from the repository root:

```sh
bun packages/server/src/epicenter-sync/__benchmarks__/document-struct-bound.bench.ts \
  --output docs/benchmarks/document-struct-bound/2026-07-22-workerd.json
```

The report records environment versions, timings, measurements, input digests,
and source and bundle hashes. A rerun intentionally changes runtime-specific
fields. Review the new result, then update `provenance.json` rather than
silently overwriting accepted evidence.

Verify retained evidence:

```sh
bun run check:evidence
```
