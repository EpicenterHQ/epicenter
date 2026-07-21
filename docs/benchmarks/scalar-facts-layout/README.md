# Scalar facts physical-layout evidence

This directory retains decision evidence for the four scalar-fact SQLite
layouts. The report is evidence, not current architecture truth. ADRs and the
active clean-break spec remain authoritative.

## 2026-07-21 Bun/native full run

Artifact:
`2026-07-21-bun-native-full-schema-v3.json.gz`

Source commit: `670309550e` (`fix(data): refuse unstable layout evidence`)

Command:

```sh
bun scripts/benchmarks/scalar-facts-layout.ts \
  --profile full \
  --output <temporary-directory>/report.json
```

Environment:

- Bun 1.3.1
- SQLite 3.51.0
- macOS 25.5.0, arm64
- Apple M4 Max, 16 logical CPUs
- Started `2026-07-21T11:54:54.153Z`
- Finished `2026-07-21T12:41:54.968Z`

Checksums:

- Uncompressed JSON SHA-256:
  `a97bf03f8f4d659dc88bed21d076c215e81d3ea65e5b65989c1449ceabd102c5`
- Compressed artifact SHA-256:
  `9b6f7ee1822d158303ad9409d1987e292cf50e61a512c4e581bbc96c0b1b213f`

The report and captured stdout were byte-identical. All 40
owner-by-candidate-by-seed cells were correct, every applicable proof boolean
passed, retained plans used indexed searches, split feeds passed their automated
merge and no-temporary-B-tree gate, and integrity and reopened semantic hashes
matched. The overall run completed without a leaked temporary database
directory.

Normalized coordinates used about 631 MiB of live pages versus about 782 to
788 MiB for inline coordinates. The report establishes this roughly 20%
storage reduction for its one-million-fact, approximately 512 MiB payload
envelope.

The report does not establish a latency ranking and does not recommend or
freeze a layout. Several critical p95 values were maxima of only 16 samples,
warm reopen had one observation, candidate position was not balanced, and
sub-millisecond calls lacked explicit warmup and batching. The active spec
defines the measurement-method pilot required before another decision run.

The exact reusable workload trace in commit `ccabb87f38` landed after this run
began, while it was still executing, and was not part of source commit
`670309550e`; this report did not use it. Future evidence must name and use that
trace rather than combining its samples with this report.
