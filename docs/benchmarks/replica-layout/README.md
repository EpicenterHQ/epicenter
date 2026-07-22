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
| Point read, ms per address | 0.0094 | 0.0107 | 0.0100 | 0.0124 | Wide faster; p95 difference is material |
| Collection traversal, ms | 1.4992 | 0.4578 | 1.6509 | 0.5448 | Split materially faster |
| Lane write, ms per address | 0.0128 | 0.0057 | 0.2580 | 0.0176 | Split materially faster |
| Feed install, ms per fact | 0.0103 | 0.0148 | 0.3936 | 0.1148 | Wide wins the median; split wins the tail |
| Reopen plus one point read, ms | 0.1364 | 0.1098 | 0.3646 | 0.2987 | Split materially faster |

Every run contained 1,000,000 records, passed `PRAGMA integrity_check`, used
indexed query plans, and reopened successfully. The wide database occupied
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

The report embeds the maintained source SHA-256
`f2259b959b0c0b9db8849c5697c9d5b111aa4495f9ec290fc3ef046863829b15`.
The older four-layout report under `docs/benchmarks/scalar-facts-layout/` is
historical evidence for a retired matrix and is not combined with this run.
