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

| Hot metric | Wide p50 | Split p50 | Wide p95 | Split p95 | Read |
| --- | ---: | ---: | ---: | ---: | --- |
| Point read, ms per address | 0.0108 | 0.0119 | 0.0121 | 0.0139 | Wide faster; neither difference is material |
| Collection traversal, ms | 1.7632 | 0.4947 | 1.8893 | 0.5190 | Split materially faster |
| Lane write, ms per address | 0.0135 | 0.0058 | 0.2323 | 0.0172 | Split materially faster |
| Feed install, ms per fact | 0.0124 | 0.0157 | 0.4034 | 0.0988 | Wide wins the median; split wins the tail |
| Reopen plus one point read, ms | 0.1397 | 0.1292 | 0.3526 | 0.3625 | Equivalent under the stop rule |

Every run contained 1,000,000 records, passed `PRAGMA integrity_check`, and
reopened successfully. Every reported read and update plan used the expected
index; SQLite emitted no plan rows for the split UPSERT. The wide database occupied
588,574,720 live bytes; split occupied 568,897,536. Wide was 3.46% larger.

The ADR-0177 stop rule fired because several hot metrics differed by more than
20%. The direction is mixed rather than a uniform winner. In particular, feed
install reverses between p50 and p95 while production-style automatic WAL
checkpointing remains active. The report retains every raw sample; this Bun
slice does not attribute that reversal to a specific mechanism.

This run completes only the Bun slice of the charter. It neither accepts
ADR-0177 nor silently reverses the selected wide candidate. Browser OPFS and
Durable Object evidence remain owned by W1C and W2, after which the mixed Bun
result must be reconciled explicitly before ADR-0177 can become Accepted.

The report embeds SHA-256 fingerprints for the maintained benchmark source and
both installed SQLite schemas, so a later production-schema change cannot be
mistaken for the DDL measured here. The maintained source fingerprint is
`4716be7302e3627459a2db82531fff101696260abd8423229f844dab56ef5ac7`,
the installed wide-schema fingerprint is
`9b7521d1aef9a63515262ba73cef361844ad6d3c0f5548edd07811beb7716a5b`, and
the installed split-schema fingerprint is
`9f3bd1eb8da64c6c533ec416da1e9264be3245de787507f8f8dbd6bba387c8f4`.
The older four-layout report under `docs/benchmarks/scalar-facts-layout/` is
historical evidence for a retired matrix and is not combined with this run.
