# Yjs 14 container replacement experiment

Keep ordinary folding automatic. Prototype deliberate reconstruction before
choosing its production mechanism. Replacing a nested parent reclaims much of
the deletion overhead in this workload, but it loses stale edits and retains
writer metadata. It does not establish bounded storage for one lineage forever.

The product proposal is [ADR-0379](../../adr/0379-reconstruction-is-an-explicit-destructive-library-operation.md).

The follow-up [push/pull benchmark](checkout.md) separates authored update volume,
offline backlog, actual persisted log size, and fully folded state. It identifies
large body rewrites and the count-based fold interval as nearer maintenance work
than document replacement.

## Reproduce

From the repository root:

```sh
bun run --filter @epicenter/app/store bench
bun test packages/app/src/data/__benchmarks__/root-rotation.test.ts
```

For machine-readable output without Bun's workspace output prefix:

```sh
bun packages/app/src/data/__benchmarks__/root-rotation.bench.ts > /tmp/root-rotation.json
```

The runner verifies the installed package is **`@y/y` 14.0.0-rc.24** before
measuring. Revalidate the experiment when upgrading. These measurements do not
come from the Yjs 13 `yjs` package.

## Method

Each corpus contains 100 surviving rows and 10,000 created-then-deleted rows.
Every row uses the current store's row constructor, two scalar fields, and a
128-character plain-text content node. Independent writing sessions receive the
same initial seed and create disjoint deleted row IDs. The session count varies
from 1 to 10,000. These are simulated writer identities, not physical devices or
a replay of production editing sessions.

The current-layout control holds rows under a named table root. The proposed
layout holds the same rows under a replaceable nested container:

```txt
Current control                 Experimental control
Y.Doc                           Y.Doc
`-- named tables:notes          `-- named application
    `-- rows                        `-- data: nested Y.Type
                                        `-- rows
```

The four representations are:

- `current-fold`: encode the current-layout corpus as one V2 state update.
- `wrapped-fold`: encode the nested-layout corpus without replacing its parent.
- `replace-container`: manually copy the wrapped corpus's visible fields and
  plain text into a new parent in the same document, then encode it.
- `fresh-document`: copy that same visible state into a new document, removing
  the old causal lineage. This is a size reference, not a safe sync protocol.

Every representation is opened in three fresh Bun processes. Open time measures
document construction and `applyUpdateV2`, excluding file reads and process
startup. RSS is the difference before hydration and after forced GC; it includes
runtime allocation and is noisy. It is neither isolated Yjs heap size nor peak
reconstruction memory. Bun's `heapUsed` reported no useful delta in the initial
run and is omitted.

The JSON also reports one parent-process reconstruction duration and encoding
duration per case. `operationMs: 0` on fold controls means no reconstruction was
performed; `encodeMs` reports the encoding cost. These are not end-to-end SQLite
fold, backup, server, browser, or network benchmarks. The corpus uses `gc: true`
without an undo manager. Random Yjs client IDs can change encoded lengths slightly.

## Recorded results

[Raw samples](2026-09-09-bun.json), Apple M4 Max, macOS arm64, Bun 1.3.1.
Times and RSS are medians of three cold processes. Sizes are bytes, not compressed
archive sizes.

| Writing sessions | Representation | Bytes | Structs | Open ms | RSS delta MiB |
| ---: | --- | ---: | ---: | ---: | ---: |
| 1 | current-fold | 308836 | 20500 | 12.97 | 8.31 |
| 1 | wrapped-fold | 167365 | 20501 | 13.27 | 7.30 |
| 1 | replace-container | 18506 | 504 | 3.66 | 0.53 |
| 1 | fresh-document | 18429 | 501 | 3.53 | 0.56 |
| 100 | current-fold | 311104 | 20500 | 15.35 | 8.83 |
| 100 | wrapped-fold | 170920 | 20501 | 14.95 | 8.05 |
| 100 | replace-container | 20682 | 603 | 4.39 | 0.77 |
| 100 | fresh-document | 18430 | 501 | 3.60 | 0.55 |
| 1000 | current-fold | 329726 | 20500 | 18.11 | 12.16 |
| 1000 | wrapped-fold | 200224 | 20501 | 16.32 | 7.50 |
| 1000 | replace-container | 39391 | 1503 | 5.89 | 1.14 |
| 1000 | fresh-document | 18430 | 501 | 3.66 | 0.61 |
| 10000 | current-fold | 517912 | 20500 | 23.49 | 17.42 |
| 10000 | wrapped-fold | 459142 | 20501 | 25.62 | 14.55 |
| 10000 | replace-container | 227609 | 10503 | 16.76 | 10.66 |
| 10000 | fresh-document | 18430 | 501 | 3.82 | 0.67 |

Changing the container layout alone changes encoding size, so compare replacement
with `wrapped-fold` to isolate the operation's benefit. Replacement cuts that
size by about 89% with one writing session and 50% with 10,000. It retains every
historical writer ID. The fresh document returns to approximately 18.4 KB in all
four cases. None of these small synthetic corpora establishes a product need or
an automatic reconstruction threshold.

## Behavior and next proof

Five tests cover fixture fidelity after reopening, folding versus replacement
with an offline edit and insertion, concurrent replacement, historical writer
retention, and undo retention. Two concurrent replacements converge by keeping
one whole subtree. An old offline insertion disappears along with edits to old
rows. A root-scoped undo manager keeps the removed subtree alive.

The implementation manually copies plain text. It does not validate copying
marked text, keyed or nested rich content, blobs, settings, multiple tables,
unknown schema fields across application versions, or relative positions.
Earlier exploratory probes also found nested `Y.Type.clone()` attachment fails
in this pinned release; this experiment makes no claim to fix that path.

The source-level explanation is Yjs's recursive collection of a deleted parent's
descendants (`Item.gc` and nested content GC), followed by compatible GC-range
merging. GC ranges still carry client clocks. Replacing a parent therefore
removes many objects without forgetting all historical writers.

The independent Codex review and isolated Claude Fable 5.1 consultation both
identified this parent-replacement option. Claude's runtime was unable to run
Bun; the reproducible runtime evidence here was gathered in the live workspace.
The recommendation to use one lineage forever was not adopted: the writer-count
measurements leave a concrete reason to keep private identity replacement open.

The next experiment should freeze and back up one complete application state,
build its replacement, and attempt installation against the captured authority
head. Test accepted writes during capture, competing requests, crashes around
commit, retry after a lost response, stale replicas, and editor shutdown before
reload. A head check protects already accepted writes; it cannot protect work an
offline device has never sent. Only after those proofs should this become a
server action. Backup browsing remains a separate read-only operation.
