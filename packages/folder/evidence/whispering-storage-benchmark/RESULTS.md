# Whispering browser storage benchmark

Recorded October 27, 2026. Actual local Chromium runs on Apple M4 Max, 128 GiB RAM, macOS 26.5.2, Bun 1.4.3. Chromium 151.0.7922.34; `@y/y` 14.0.0-rc.26. Source baseline `ef0adda0aabedad4c062ceb599ae52fe6d043288`. No production storage code or vault files were changed.

## Measured results

All times below are milliseconds. Memory is retained JS heap plus external string/ArrayBuffer backing storage, relative to the loaded blank harness, after forced GC. This is not process RSS or full application memory.

| Rows per table | Variant | Startup median (range) | Retained MiB | Warm refresh, all tables | Durable edit | Refresh edited table | Edit through refresh |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1,000 | Current browser Folder | 224.0 (216.9 to 258.6) | 21.3 | 190.5 | 8.5 | 43.6 | 51.0 |
| 1,000 | Batched reads + hash cache | 217.9 (206.5 to 233.6) | 21.8 | 23.6 | 8.6 | 3.1 | 11.7 |
| 1,000 | Single Yjs document | 68.8 (68.0 to 75.1) | 26.3 | 2.0 | 7.1 | 0.2 | 7.4 |
| 10,000 | Current browser Folder | 2,113.4 (2,054.1 to 2,116.8) | 206.2 | 1,896.0 | 59.6 | 471.2 | 548.9 |
| 10,000 | Batched reads + hash cache | 1,898.2 (1,817.5 to 1,919.3) | 210.9 | 259.3 | 63.2 | 31.9 | 96.5 |
| 10,000 | Single Yjs document | 485.3 (478.2 to 513.8) | 249.0 | 16.7 | 2.1 | 1.1 | 3.7 |

Each startup/memory cell summarizes three fresh-browser-process runs. Warm refresh has nine samples per cell; edits have fifteen samples per cell. A one-row edit appends text to a transcription and refreshes its whole table. All five tables contain the stated row count: 5,000 and 50,000 total rows. Startup includes opening IndexedDB, hydrating/projecting all rows, validating typed fields, and listing files. It excludes browser process launch, JavaScript downloading/compilation, Svelte mounting and rendering, audio, and sync.

## What was compared

- **Current:** unchanged production `openRepository`, table listing and file writes. One Markdown file per row, stored as immutable Git blobs and trees in IndexedDB.
- **Batched/cache:** production sources transformed only in the benchmark bundle. Selected uncached blob reads are issued together. Table-local parsed rows are reused only when their content hash still matches; current hash witnesses allow storage capture to skip unchanged blobs. Deleted/replaced rows leave the cache. Cold caches start empty. Writes use the original production path. Exact replacements are in `optimized-replacements.json`; source drift aborts the build.
- **Yjs:** one document, five table roots, nested row nodes with individual metadata attributes and a shared text body child. IndexedDB stores one compacted state plus eager incremental V2 updates, in strict write transactions. Cached projections reuse unchanged rows. This compares logical typed data, not a drop-in Folder implementation: it does not retain or export each row’s Markdown formatting, comments, or invalid source.

Whispering’s actual five schemas are imported from `apps/whispering/src/lib/definition.ts`. Fixtures include recording metadata/notes, 3 KB transcripts, 600-byte recipes, transformation/text results and their copied prompt/input fields. They are deterministic synthetic data, not production voice notes. They include ASCII text and repeated prose; different body sizes, entropy, edit history and Unicode can change costs.

| Rows per table | Markdown input MiB | Git object payload MiB | Yjs state payload MiB |
| --- | --- | --- | --- |
| 1,000 | 13.92 | 14.18 | 14.00 |
| 10,000 | 139.28 | 141.81 | 140.03 |

Payload sizes exclude IndexedDB metadata, indexes, logs and filesystem allocation. Seeding is outside timed startup; Git objects/trees are built directly and published once rather than creating 50,000 sequential saves. All variants use the same fixtures and strict write transaction durability. There is no commit per save.

Profiles are disposable and seeded once per size/variant. Each measured startup launches a new browser process over the persistent profile, with empty in-memory caches. Variant order rotates and reverses across rounds. OS/disk caches are not flushed. The machine was an active development workstation. Baseline startup retains all projected rows and file paths; after-edit reload compares all typed fields and bodies. Every cross-variant initial and edited checksum matched, all counts matched, and all 18 durable-reopen checks passed.

The optimized case is one concrete implementation, not an upper bound on file-model performance. It still traverses/decodes directory trees and scans row hashes. Neither model supplies automatic relational indexes. Warm measurements explicitly request a data-layer refresh; they are not reads from an already-valid TanStack Query result.

### Interpretation limits identified in the methodology review

This is an implementation comparison, not an isolated measurement of CRDT overhead or benefit. The Yjs case changes the persistence granularity, canonical representation and in-memory read path together: one structured state update replaces many Markdown blobs that need YAML parsing. The warm-refresh comparison also includes different caching behavior. The missing controls are plain Markdown records in IndexedDB without Git trees, and plain structured records in IndexedDB without Yjs. Those controls would help separate file-object traversal, parsing, and CRDT costs before choosing an architecture.

Each reported Yjs startup reads one compacted state update. Seeding creates that state, and reset compacts again between trials; replay after the five edits is verified but not included in the reported startup samples. Large uncompacted update logs and long editing histories were not timed. The final comparison contains 18 startup measurements, 54 warm refreshes and 90 measured edits. These are data-layer completion times, not keystroke-to-paint or first-usable-screen measurements.

## Whole-vault Yjs experiment

Separate read-only snapshot of `~/Code/vault`; raw Markdown is stored as one shared text node per relative path in one document. No metadata table projection or UI is built. Only aggregate metrics/checksums are retained in this repository. All source text stayed in memory and disposable browser profiles, which were removed. Symlinks are not followed. Directory names `.git`, `node_modules`, `.obsidian`, `.trash`, `.claude`, `.codex` and `.agents` are excluded. Other hidden directories, archives and migration data are included.

| Corpus | Files | Markdown MiB | Encoded state MiB | Reopen median (range), ms | Retained MiB | Startup sample before GC, MiB |
| --- | --- | --- | --- | --- | --- | --- |
| pages/ | 3,048 | 11.99 | 12.23 | 28.0 (23.6 to 28.8) | 14.35 | 28.44 |
| Whole included vault | 48,831 | 117.10 | 121.51 | 176.8 (164.8 to 191.5) | 153.36 | 283.54 |

Each corpus has three complete browser-process reopen trials. Startup samples are single observations, not peak-memory measurements. Content validation covers every included path and all UTF-16 text, not just row counts. Twenty incremental insertions were durably stored and verified after reload; compacted state was also verified after reload. On the whole vault, the median small-edit durable time was 0.5 ms; one compaction (encode and strict persistence) took 502.1 ms. These are fresh-import and short-edit results, not years of CRDT history.

Raw vault text and typed Yjs tables are different representations. Importing raw Markdown does not eliminate YAML parsing when an app needs typed fields. A raw-text canonical document would need derived typed views; structured rows as canonical data would need a Markdown export/reconciliation design. Keeping both independently writable requires an explicit authority and merge contract.

## Reproduce

From the repository root, with Bun dependencies and the installed Playwright Chromium binary:

```sh
bun packages/folder/evidence/whispering-storage-benchmark/run.mjs
bun packages/folder/evidence/whispering-storage-benchmark/vault-run.mjs ~/Code/vault
```

`run.mjs` accepts `--sizes`, `--rounds`, `--variants`, `--browsers` and `--output`. Only Chromium was measured here; other browser choices have no memory instrument. Rerunning overwrites the corresponding aggregate JSON result file. Existing application databases and vault files are never written. The browser profiles and servers are temporary and loopback-only.

Raw results: [Whispering](results.json), [vault](vault-results.json). Results establish this desktop data-layer workload only. Shipping UI startup, phones, network sync, conflict semantics, browser eviction, forced termination, long-lived history, malformed Markdown and binary audio are unmeasured.

## Review

Reviewed the production read/write entrypoints, isolated source transformations, Yjs node/update APIs in the pinned installed source, memory accounting including backing stores, schema/count/checksum equivalence, cache refresh after edits, incremental reload and compaction reload. No production code was edited. The cached and Yjs variants are throwaway experiment implementations, not production-ready replacements.
