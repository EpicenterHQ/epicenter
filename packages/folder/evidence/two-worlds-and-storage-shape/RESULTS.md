<!-- doc-path-check: ignore-file (frozen historical record) -->

# Two-worlds prototype and browser storage shape

Recorded 2026-10-27; archived 2026-11-01. The source is commit `0bac9e6cea`
(tag `archive/hosted-sites-wip`). This file keeps the text and numbers; the
prototype code, harnesses and raw JSON stay at that commit. Inspect one with
`git show commit:path`:

- `0bac9e6cea:packages/folder/PROTOTYPE-two-worlds-v2/RESULTS.md`
- `0bac9e6cea:packages/folder/evidence/storage-shape-benchmark/RESULTS.md`
- `0bac9e6cea:packages/folder/evidence/whispering-storage-benchmark/RESULTS.md`

Both experiments tested designs this branch does not use. The prototype tested
ADR-0692 as revised on 2026-10-27, a record that is not on this branch; the
file contract (ADR-0700) took a different direction. The benchmarks measured the old
IndexedDB Git engine, which is also retired. The current browser store is OPFS
(`packages/folder/src/device/opfs-store.ts`), and nothing here measures it.

## 1. Two-worlds prototype v2

A throwaway, in-process prototype of one permanent document (no epochs): rows
keyed by a stable id with the path as an attribute, settings as one map written
to `kv.json`, LFS pointers, deterministic materialization, a Git tree parsed
with an id repair rule, and pushes merged by structure. Agents edited Markdown
in a clone. 16 tests, all passing.

| Claim | Result |
|---|---|
| First checkpoint writes `id` as every row's first key; formatting is `id`, declared order, then unknown keys sorted | Holds |
| A rename in an app, or `git mv` by an agent, keeps another device's typing | Holds. Control: keyed by path, the same rename loses the typing |
| Id repair: a copied file gets a new id, a deleted `id` line keeps its id by path, a new file gets one | Holds; the merge commit writes each back |
| A push merges by field; `kv.json` merges by key | Holds. The same field changed both ways is rejected (`notes/ideas.md: field title`); unknown `kv.json` keys are kept |
| Schema-blind pushes and invalid files | Hold: a row breaking the schema is accepted and shown as an issue; an invalid file is kept byte for byte and gets an id once fixed |
| Paths outside the layout | Kept across commits, never loaded |
| A device back after a long time offline | Merges like a live peer |
| One text merge rule for people | Holds; two rewrites of one paragraph concatenate in a varying order, and every device converges |
| LFS pointers; idempotent migrations | Hold. A non-idempotent migration applies twice |

What it found that the ADR did not yet say:

- The server cannot know which folders an app declares, because it reads no
  schema. It loads the whole canonical layout, and each app shows the tables it
  declares. Only paths outside the layout are kept and not loaded.
- Key order needs the schema, and the server writes the files. The prototype
  had the app write each table's declared order into the document; the
  alternative is always sorting, which needs nothing.
- An invalid file has no readable id, so its identity is its path; renaming one
  in a clone makes it a new row.

Limits: in-process and synchronous; frontmatter writing handled single values and
JSON-style lists only; files outside the layout merged as whole files; no real
LFS server.

## 2. Browser storage benchmarks

Headless Chromium 151 on an Apple M4 Max, Bun 1.4.3. Whispering's five table
schemas with synthetic rows (3 KB transcripts, 5 KB runs); every table holds the
stated row count. Times are data-layer completion, not first paint. Memory is
retained JS heap plus backing stores after forced GC, not process RSS.

### Whispering storage benchmark (startup and refresh, ms)

| Rows per table | Variant | Startup median | Retained MiB | Warm refresh, all tables | Durable edit | Edit through refresh |
|---|---|---|---|---|---|---|
| 1,000 | IndexedDB Git engine, one Markdown file per row | 224.0 | 21.3 | 190.5 | 8.5 | 51.0 |
| 1,000 | Same, batched reads + parsed-row cache | 217.9 | 21.8 | 23.6 | 8.6 | 11.7 |
| 1,000 | One Yjs document | 68.8 | 26.3 | 2.0 | 7.1 | 7.4 |
| 10,000 | IndexedDB Git engine, one Markdown file per row | 2,113.4 | 206.2 | 1,896.0 | 59.6 | 548.9 |
| 10,000 | Same, batched reads + parsed-row cache | 1,898.2 | 210.9 | 259.3 | 63.2 | 96.5 |
| 10,000 | One Yjs document | 485.3 | 249.0 | 16.7 | 2.1 | 3.7 |

Three fresh-browser startups per cell, nine warm refreshes, fifteen edits. All
checksums and the 18 durable-reopen checks matched across variants. The Yjs case
stores logical typed data and does not keep each row's Markdown formatting or
invalid source, so it is not a drop-in replacement.

### Storage-shape benchmark (cold start to all five tables)

| Design | 1,000 per table | 10,000 per table | Retained MiB at 10k | One durable edit at 10k |
|---|---|---|---|---|
| IndexedDB Git engine | 0.21 to 0.26 s | 1.93 s | 206 | 58 ms, then ~500 ms relist |
| Batched reads + parse cache | | 1.69 to 1.80 s | 210 | 57 ms, then ~130 ms relist |
| Packed Markdown, one record | 0.13 to 0.16 s | 1.06 s (33 ms read, 1,038 ms parse) | 207 | 0.8 ms p50 |
| One Yjs document | 0.04 to 0.07 s | 0.33 to 0.52 s | 247 to 259 | 0.7 ms p50 |
| Markdown + parsed-row cache record | 0.011 to 0.012 s | 0.065 s (55 ms read, 10 ms index) | 144 | 0.4 ms p50 |

Where the time went: reading 147 MB as one IndexedDB record took about 33 ms, so
storage was not the bottleneck. The old engine paid for one request per blob and
for parsing Markdown, about 31 µs per 5.5 KB row in Bun.

### Conclusion

One Markdown file per row cost about 2.1 s of startup at 10,000 rows per table
in the old IndexedDB engine. Batched reads plus a parsed-row cache cut warm
refresh about 7 to 8 times (190.5 to 23.6 ms at 1k, 1,896 to 259 ms at 10k) but
barely moved cold startup. One Yjs document started about 4 times faster. A
parsed-row cache kept as one record started in 65 ms, because parsing, not
storage, was the cost. The measured engine is retired; the current OPFS store is
untested at this scale.
