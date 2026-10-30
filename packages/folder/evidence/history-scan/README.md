# Git history scan measurements

Keep the final inspection and select source paths before reading their payloads.
Each capture lists the folder, captures its `.gitignore` bytes, asks Git which
untracked paths to exclude, and reads every remaining file. Tracked files bypass
ignore rules. The captured rule bytes also enter the checkpoint, so a concurrent
rule edit cannot change the selection without changing the recorded rules.

## Measurements

These measurements use disposable repositories on an Apple M4 Max, macOS,
Bun 1.4.3, and Git 2.50.1 (Apple Git-155). Each note contains 2,160 bytes. Audio
fixtures contain 512 MiB of allocated bytes matching `*.wav`: either four
128 MiB files or 8,192 files of 64 KiB. Files are grouped into directories of
at most 100 entries. There is no remote transfer.

The table reports medians of three measured requests after one warmup per
operation and fixture. `status` calls the same inspection function as a
mutation's final scan; its timing also includes native request setup and sync
metadata inspection. `saveVersion` is an unchanged checkpoint and includes
protection checks, the history lock, checkpoint capture, index reconciliation,
and final inspection. The latter does not measure only the final scan.

| Folder | Inspection before | Inspection after | Full save before | Full save after |
| --- | ---: | ---: | ---: | ---: |
| 1,000 notes | 202 ms | 205 ms | 480 ms | 472 ms |
| 1,000 notes + four audio files | 493 ms | 216 ms | 1,026 ms | 537 ms |
| 10,000 notes | 2,043 ms | 1,987 ms | 4,406 ms | 4,839 ms |
| 10,000 notes + four audio files | 2,323 ms | 2,132 ms | 5,260 ms | 4,704 ms |
| 1,000 notes + 8,192 audio files | 2,151 ms | 632 ms | 4,660 ms | 1,724 ms |

Every optimized scan reads **zero audio bytes** in these fixtures, compared
with 512 MiB before. An unchanged save captures twice, so it avoids 1 GiB of
logical payload reads. Source-file reads remain: 1,001 reads for 1,000 notes and
the root rule file, or 10,001 reads for 10,000 notes and the rule file.

The no-audio save difference prompted a second experiment. Alternating the
reconstructed previous capture and the optimized implementation against the
same 10,000-note repository produced full-save medians of **4,600 ms before and
4,546 ms after**, with five measured requests and one warmup per variant.
The initial slowdown did not repeat. Status timings in that experiment varied
substantially; they do not establish an additional speedup.

These are warm-cache measurements on a shared machine. The experiments do not
flush filesystem caches, isolate competing work, measure physical disk traffic,
or establish cold-storage latency. Read counters measure logical bytes returned
by the storage boundary, including reads that compute its SHA-256. Byte
elimination is deterministic; elapsed times vary with the machine's load.

Raw samples are in [before.json](before.json), [after.json](after.json), and
[paired-no-audio.json](paired-no-audio.json). The first baseline is the
request-owned implementation before early filtering, not the former long-lived
history object. The paired reference restores only that earlier capture and
filtering sequence; the rest of the implementation is shared.

To repeat the optimized matrix from the repository root:

```sh
bun packages/folder/src/__benchmarks__/history-scan.bench.ts --output=/tmp/history-scan.json
```

For the 10,000-note control alone, add `--case=10k-notes`. The benchmark removes
its disposable repositories when it finishes.

## Preserved information

The final scan still reads every source payload afresh. It does not reuse
checkpoint bytes or infer cleanliness from file size, timestamps, or watcher
events. A regression test changes a file to different bytes of the same length
and restores its timestamp after checkpointing; final inspection reports it.
Every inspection compares against its pinned head; this is not an atomic
snapshot of arbitrary concurrent external Git and file writers.

Final inspection failures omit the optional observation and retain the completed
operation receipt. `changedSince` remains the event recorded by publication's
kept-content outcomes, including stale removals; a clean or failed final scan
cannot erase it. A later successful checkpoint absorbs the event. The scan
change does not modify locks, conditional publication, repair markers, branch
compare-and-swap, index reconciliation, cancellation, or credential acquisition.

## Remaining cost

Directory enumeration and metadata reads remain proportional to file count,
including ignored files. The many-audio fixture still spends about 400 ms
listing during its final scan. At 10,000 notes, reading source content remains
the larger cost.

Pruning an ignored directory could avoid enumerating its descendants, but must
preserve tracked descendants, nested rule snapshots, and native excludes.
The `*.wav` fixture does not establish that a directory is entirely ignored.
That further optimization needs a separate directory-exclusion experiment and
does not justify dropping the final scan or introducing a stat cache.

A save also walks the folder for Git protection checks. Sharing metadata with
capture could reduce that work, but would need to retain entry kinds, modes,
and the rule snapshot used by those checks. This experiment does not isolate
that phase or change it. Large tracked-audio time and peak memory, deeply nested
rule trees, and remote transfers remain unmeasured.

## Verification

The broad folder and selected CLI suite passed 732 tests. After independent
adversarial reviews found no blocker, additional regressions
covered external branch movement during inspection, failed final ignore
evaluation, and a stale deletion whose kept file is ignored by the final tree.
All 30 tests in the focused scan, ordering, and source-scope run passed.
Ignored symlinks are also excluded without reading; tracked and re-included
audio remain readable source. Folder and CLI typechecks passed.
