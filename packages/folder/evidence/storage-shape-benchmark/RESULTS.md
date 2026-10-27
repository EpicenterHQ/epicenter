# Browser storage shape: Markdown, Yjs, and a parsed-row cache

Throwaway experiment, 2026-10-27. Headless Chromium (Playwright) on the owner's
Mac. Whispering's five table schemas, synthetic rows (3 KB transcripts, 5 KB
runs). Every run uses a disposable browser profile; no application database is
opened.

Two harnesses:

- `../whispering-storage-benchmark/` (Codex thread `01a17c04`): the current
  browser engine (`openRepository`, one IndexedDB read per Git blob, then
  Markdown parse), the same engine with batched reads and a parsed-row cache,
  and one Yjs document.
- `./` (this directory): the storage layout question that harness leaves open.
  `packed` keeps every file's Markdown in one IndexedDB record and parses it
  with `readRow`; `yjs` is one `Y.Doc` with fields as attributes and the body as
  text; `rows` keeps Markdown as the truth and stores a parsed-row cache
  (`[path, fields, body]`) as one structured-clone record. Edits append to a
  log; compaction folds the log. Run:
  `bun packages/folder/evidence/storage-shape-benchmark/run.mjs --sizes 1000,10000 --edits 2000`.

## Results at 10,000 rows per table (50,000 rows, about 147 MB of text)

| Design | Cold start to all five tables | Retained memory | One durable edit | Source |
|---|---|---|---|---|
| Current browser Git engine | 1.93 s | 206 MiB | 58 ms write, then ~500 ms relist | Codex |
| Batched reads + parse cache | 1.69 to 1.80 s | 210 MiB | 57 ms write, then ~130 ms relist | Codex |
| Packed Markdown, one record | 1.06 s (33 ms read, 1,038 ms parse) | 207 MiB | 0.8 ms p50, 2.0 ms p95 | here |
| One Yjs document | 0.33 to 0.52 s (32 ms read, 260 ms apply, 31 ms project) | 247 to 259 MiB | 0.7 ms p50, 2.0 ms p95 | both |
| Markdown + parsed-row cache record | 0.065 s (55 ms read, 10 ms index) | 144 MiB | 0.4 ms p50, 1.7 ms p95 | here |

At 1,000 rows per table (5,000 rows): current 0.21 to 0.26 s, packed 0.13 to
0.16 s, Yjs 0.04 to 0.07 s, parsed-row cache 0.011 to 0.012 s.

## Where the time goes

- IndexedDB is not the bottleneck when data is one record: reading 147 MB as
  one record takes about 33 ms. The current engine's cost is one request per
  blob plus parsing.
- Markdown parsing is: about 31 µs per 5.5 KB row in Bun (schema validation
  about 2 µs of it; the rest is `parseRowSource`). Bun's native YAML parser
  takes about 10 µs for the same frontmatter.
- Yjs is faster than parsing Markdown because its update is already structured,
  and slower than structured clone because it rebuilds CRDT items.

## Tombstones and history (2,000 single-character operations, every tenth a backspace, into one transcript)

| Size | Update log | Reopen with 2,000 uncompacted updates | Compacted doc vs fresh rebuild | Fresh rebuild time |
|---|---|---|---|---|
| 1,000/table | 77 KB | +14 ms | +7.6 KB | 65 ms |
| 10,000/table | 80 KB | +55 ms | +8.0 KB | 695 ms |

## Limits

- Sequential typing is Yjs's best case. Scattered edits from many devices
  (many client ids) grow the state more; not measured.
- A desktop Mac, not a phone. ADR-0294 measured Yjs hydration on an iPhone 15
  Pro at about 4.4 ms per 1,000 rows, excluding storage reads.
- The parsed-row cache trusts its record; it is rebuilt from validated text at
  each checkpoint and must name the tree it was built from.
- The Codex harness measures the engine at `c901011eb2`'s browser storage path;
  whether the trunk's browser path differs was not checked.
