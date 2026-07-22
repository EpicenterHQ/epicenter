# Authority physical-layout evidence

This directory records the Durable Object slices of ADR-0177's bounded
physical evidence. The reports are evidence, not current architecture truth.
ADR-0177 and the active clean-break spec remain authoritative.

## 2026-07-22 Durable Object wide-versus-split runs

Reports:

- `2026-07-22-do-wide-vs-split-wide-first.json`
- `2026-07-22-do-wide-vs-split-split-first.json`

Maintained sources:

- `packages/server/src/epicenter-sync/__benchmarks__/authority-layout.bench.ts`
- `packages/server/src/epicenter-sync/__benchmarks__/authority-layout-worker.ts`

Invocations:

```sh
bun packages/server/src/epicenter-sync/__benchmarks__/authority-layout.bench.ts \
  --profile full \
  --order wide-first \
  --output docs/benchmarks/authority-layout/2026-07-22-do-wide-vs-split-wide-first.json

bun packages/server/src/epicenter-sync/__benchmarks__/authority-layout.bench.ts \
  --profile full \
  --order split-first \
  --output docs/benchmarks/authority-layout/2026-07-22-do-wide-vs-split-split-first.json
```

The wide candidate imports the production schema statements from
`authority-v1-schema.ts`; it is not a copied approximation. The split
candidate exists only inside the benchmark. Both candidates hold the same
semantic fact, accepted-blob, metadata, and retry-witness state.

Each run contains exactly 1,000,000 final-present records at the exact
536,870,912-byte V1 proxy. Each candidate executes 128 batches of 64
addresses. The two runs reverse candidate order, so the aggregates below cover
256 batches per candidate without a fixed first-candidate advantage.

Environment:

- Bun 1.3.1
- Miniflare 4.20260401.0
- workerd 1.20260401.1
- Darwin 25.5.0
- Apple M4 Max

Aggregate means across both orderings:

| Operation | Wide | Split | Unit |
| --- | ---: | ---: | --- |
| Point read | 0.00684 | 0.00616 | ms per address |
| Facts feed | 0.00067 | 0.00378 | ms per returned fact |
| Fact write | 0.00500 | 0.00751 | ms per address |
| Accepted-blob write | 0.00562 | 0.00458 | ms per address |
| Settlement | 0.762 | 1.375 | ms per 64-address submission |
| Fixture construction | 9,794 | 16,420 | ms per 1,000,000 records |
| Database size | 602,787,840 | 644,837,376 | bytes |

Wide used 6.52% less database space. It was materially faster for feed reads,
fact writes, and whole submissions in both candidate orders. Point reads were
close. Split was faster only for the isolated
accepted-blob write. The hot-path stop rule therefore fired in favor of wide
for the authority owner.

Fixture construction uses a benchmark-only insert loop, not the production
authority write path. Its timing is retained for reproducibility and does not
participate in the layout decision.

The billing counters found a real tradeoff. Wide averaged 195.984 rows read
per 64-address settlement versus split's 131.984 because the wide UPSERT
probes its secondary address index. Both averaged 130.008 rows written. Point
and facts-feed reads had identical counters. A wide fact or accepted-blob write
read one more row than split; write counts remained identical.

At Cloudflare's 2026-06-19 published rates, one million maximal submissions
from a fresh monthly allowance produce about 130 million writes: about 80
million are billable after the 50-million-row allowance, for about $80. Both
layouts remain below the 25-billion-row read allowance. After both allowances
are exhausted, each additional million maximal submissions costs about $130 in
shared writes, while wide's extra 64 million reads add $0.064. On the free
plan, the 100,000-row daily write limit binds long before the 5-million-row
read limit. Wide also saves about 42 MB of stored data per full fixture. The
extra read is measurable but does not reverse the authority choice under
current billing. See Cloudflare's
[Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).

Both reports stopped and recreated the workerd process against persisted
storage. Every candidate reopened with exactly 1,000,000 fact rows and the same
database size it had before shutdown. Durable Object SQLite does not authorize
`PRAGMA integrity_check`; reopen plus semantic row-count verification is the
available physical witness.

Miniflare executes the pinned workerd runtime and exposes the real
`SqlStorageCursor.rowsRead` and `rowsWritten` counters. It does not reproduce
production network latency, scheduler contention, or account billing. The
runtime clock is millisecond-quantized, so the absolute sub-millisecond
latencies are not service-level claims. Batching, 256 observations, reversed
candidate order, storage bytes, and row counters make the relative direction
useful.

Both retained runs used runner SHA-256
`30833f79c39ff825471e9fb89b6bccd564b9d9bafa153fbdc3b61772b91a017a`, worker
SHA-256 `59520a469ba88334a4fa95034c0e9839c5b4adabc91127606dbe3fe1110a9f58`,
bundle SHA-256 `ff56966351f208fc1313a841ce8c667df6f33b689a301346203fc3c9590f2e22`,
and authority-schema SHA-256
`2640122f84b8a7061808ddcfc876d699a8d27b77de44ed91ea72e7d50e127f8d`.

## Two-megabyte row-ceiling proof

The V1 semantic limits keep every wide row below Durable Object SQLite's
2,000,000-byte string, BLOB, and row ceiling without relying on the benchmark
fixture:

- An authority record contains one fact capped at 4,096 canonical bytes, plus
  its integer key and an optional 64-byte digest.
- An authority retry witness stores a parked array bounded by the 1,048,576-byte
  submission response, plus a 24-byte replica ID, a 64-byte hash, and integers.
- A replica metadata row stores one sealed request capped at 262,144 bytes.
- A replica record can hold a 4,096-byte confirmed fact and one sealed plus one
  pending operation. Each operation comes from a request capped at 262,144
  bytes. The parked shape is mutually exclusive with sealed and pending. Even
  the deliberately loose sum remains below 530,000 bytes before small SQLite
  framing overhead.

Document-chain bytes, frozen document publication images, and raw blob bytes
do not share these rows. W3 owns their separate bounded relations and raw-file
rules. This proof closes W2's scalar-row ceiling; it does not pre-approve W3's
document bounds.
