# Replica physical-layout evidence

This directory records the bounded physical evidence owned by ADR-0177. The
reports are evidence, not current architecture truth. ADR-0177 and the active
clean-break spec remain authoritative.

## 2026-07-22 Bun wide-versus-split run

Report:
`2026-07-22-bun-wide-vs-split-full.json`

Maintained source:
`packages/data/src/__benchmarks__/replica-layout.bench.ts`

Invocation:

```sh
bun packages/data/src/__benchmarks__/replica-layout.bench.ts \
  --profile full \
  --output docs/benchmarks/replica-layout/2026-07-22-bun-wide-vs-split-full.json
```

The run used the production wide DDL from
`packages/data/src/store/replica/schema.ts`. The split candidate exists only
inside the benchmark. It stores confirmed facts and sparse local intents in
separate relations under the same semantic model; no product caller imports or
writes that layout.

The V1 representative proxy is defined here for the first time as the UTF-8
byte length of RFC 8785 canonical `{ address, payload }` values. The full
fixture contains exactly 1,000,000 final-present records and totals exactly
536,870,912 proxy bytes. It includes structured addresses and scalar content;
it excludes synchronization lanes, documents, blob evidence, and SQLite
framing.

Environment:

- Bun 1.3.1
- SQLite 3.51.0
- Darwin 25.5.0, arm64
- Apple M4 Max, 16 logical CPUs
- Three repetitions with alternating candidate order
- WAL mode, `synchronous=NORMAL`, and `wal_autocheckpoint=1000`

Aggregate median-of-repetition timings:

| Hot metric                     | Wide p50 | Split p50 | Wide p95 | Split p95 | Read                                        |
| ------------------------------ | -------: | --------: | -------: | --------: | ------------------------------------------- |
| Point read, ms per address     |   0.0093 |    0.0107 |   0.0099 |    0.0117 | Wide faster; neither difference is material |
| Collection traversal, ms       |   1.5492 |    0.4721 |   1.6011 |    0.5400 | Split materially faster                     |
| Lane write, ms per address     |   0.0127 |    0.0063 |   0.2426 |    0.0250 | Split materially faster                     |
| Feed install, ms per fact      |   0.0103 |    0.0166 |   0.3519 |    0.1148 | Wide wins the median; split wins the tail   |
| Reopen plus one point read, ms |   0.1284 |    0.1242 |   0.3732 |    0.3436 | Equivalent under the stop rule              |

Every run contained 1,000,000 records, passed `PRAGMA integrity_check`, and
reopened successfully. Every reported read and update plan used the expected
index; SQLite emitted no plan rows for the split UPSERT. The wide database
occupied 588,574,720 live bytes; split occupied 568,897,536. Wide was 3.46%
larger.

The ADR-0177 stop rule fired because several hot metrics differed by more than
20%. The direction is mixed rather than a uniform winner. In particular, feed
install reverses between p50 and p95 while production-style automatic WAL
checkpointing remains active. The report retains every raw sample; this Bun
slice does not attribute that reversal to a specific mechanism.

This run completes only the scalar-shaped Bun slice of the charter. Later
browser evidence selected split as the replica target, while Durable Object
evidence selected wide for authorities. This artifact does not accept the
production replica schema: its split candidate predates document and blob
watermarks and must be rerun through ADR-0177's complete acceptance charter.

The report embeds SHA-256 fingerprints for the maintained benchmark source and
both installed SQLite schemas, so a later production-schema change cannot be
mistaken for the DDL measured here. The maintained source fingerprint is
`4716be7302e3627459a2db82531fff101696260abd8423229f844dab56ef5ac7`,
the installed wide-schema fingerprint is
`76e86c4c7c4dcc8f2a90aceae2c5a0ea296894ccaa35ba0dbf11dfd7bf965473`, and
the installed split-schema fingerprint is
`9f3bd1eb8da64c6c533ec416da1e9264be3245de787507f8f8dbd6bba387c8f4`.
The older four-layout report under `docs/benchmarks/scalar-facts-layout/` is
historical evidence for a retired matrix and is not combined with this run.

## 2026-07-22 browser wide-versus-split runs

The three browser reports retain the smoke run plus the full Chromium and
WebKit runs. Their contract test reads these JSON files directly and derives
each timing summary, aggregate comparison, stop rule, interpretation, and
overall status again from the retained raw samples.

Their historical source fingerprint has a narrower boundary. It covers the
files listed in each report, `packages/data/package.json`, and `bun.lock` at the
recorded commit. It does not cover bundled transitive modules such as the
production replica schema, canonical encoder, SQLite adapter, or installed
dependency bytes. The reports state this limit explicitly; do not use their
source fingerprint as proof that the entire browser bundle can be reproduced.
