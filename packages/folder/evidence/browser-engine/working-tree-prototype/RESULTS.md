# Historical working-tree prototype: simpler representation, mixed performance

This report compares the previous overlay engine with a throwaway working-tree
prototype. The owner subsequently authorized the clean-break replacement with
zero users and no migration. Current implementation and acceptance evidence
live in the [working-tree validation](../working-tree/RESULTS.md). These historical
measurements show mixed speed results, not a universal performance improvement.

Recorded October 20, 2026 on an Apple M4 Max, macOS arm64, Bun 1.4.3. The run
used headless Chromium 151.0.7922.34, WebKit 26.5, and Firefox 153.0. Two trials
reversed model order. There were 126 cases and 20,520 measured saves. The host
was an active development machine, not a controlled performance lab. These are
observations, not latency guarantees. Some Firefox measurements varied sharply
between trials; both trials remain in the report.

[Summary and per-case metrics](results.json) retain the bundle hash and browser
versions. [Compressed raw samples](results.samples.json.gz) retain every save,
read, list, phase measurement, and collection. The throwaway comparison runners
were retired when working-tree storage replaced the overlay. Their exact source
is retained in [source.tar.gz](source.tar.gz), with repository-relative paths.
For historical reproduction, extract it in a checkout of the overlay engine
(for example `1f0af37e6aaed08fd3639d97fa9b4217f803fc1c`) and run the archived
`packages/folder/smoke/working-tree-prototype/run.ts` with Bun. Current production
behavior is covered by the [working-tree checks](../working-tree/RESULTS.md).

`--browser chromium`, `--trials 1`, and `--saves 120` narrow the run. Each run
creates and removes fresh browser profiles. Every database uses a
`PROTOTYPE-wipe-me-` name. Nothing opens an app profile, migrates saved app data,
contacts a Git server, or changes a production export.

## The model

Keep the folder received from the server, the exact folder being sent, and the
current working folder. All three share unchanged contents:

```text
received commit ----> its tree ---+
sending commit -----> its tree ---+--> shared directory and file objects
working tree --------------------+
```

A file object contains bytes. A directory object lists its children's names and
object hashes. A root hash therefore identifies a complete folder snapshot.
Saving a note writes its new bytes, rebuilds the directories above it, and
atomically updates the working-root pointer in IndexedDB. It creates no commit.
Unchanged files and directories reuse their existing objects.

The current engine derives files from `pendingCommit ?? remoteBase`, followed
by the `edits` overlay. The prototype reads the working root directly. It has
no persisted edit overlay, deletion markers, shadowing, or normalization against
the committed head. Deleting a file removes its directory entry; later sync
can compare snapshots to discover that deletion.

Old objects remain until collection. Collection keeps everything reachable
from the received, sending, and working roots, then deletes the rest. It stops
at commit parents: retaining current snapshots does not retain Git history.
All liveness checks and deletions share one IndexedDB write transaction.

## What was compared

- `overlay`: production `openRepository`, with its current capture behavior.
- `working-tree`: the prototype with a collector modeled on current storage,
  including reading each live object's value to verify its type.
- `working-tree-key-gc`: the same prototype with an IndexedDB index on the
  existing object `type` field. Blob keys from that index establish presence
  and type without loading opaque file contents. IndexedDB maintains the index
  atomically with the object; no reference counts or independent membership
  registry were added. Directory and commit bytes are still read and checked.

Both storage implementations use strict write transactions. The prototype
reuses production content merging, raw Git encoding, and tree rewriting. It
also matches the existing-path fast path, mutable input copying, and the path,
case-twin, and file/directory admission checks exercised by these valid fixtures.
It is not a complete implementation of the public Folder contract.

Collection starts after an 8 MiB upper bound on retired bytes. That counter is
persisted with the working root. It is conservative, not an exact garbage count
or a hard disk-usage bound. A forced final collection also measures cleanup in
cases too short to cross the threshold. Small and sharded cases did not trigger
automatic collection during their measured saves.

Each case warmed up with five saves. Timed operations ran back to back. Note
fixtures had roughly 5 KB of source each. Wide cases had 2,000 notes in one
directory; sharded cases placed 2,000 files across 40 directories. The checkpoint
case seeded an incorporated commit directly, then edited offline; it exercised
no network transport. Binary cases added eight or overwrote twelve synthetic
2 MiB buffers containing repeated bytes. Those are not representative audio
entropy or memory-pressure measurements.

## Save latency

Each cell is **production overlay -> working tree with key-based collection**,
in milliseconds. Ranges show the two trials' p95 values. The p95 is a bound on
95% of these sampled save cycles, not an average or a worst case.

| Offline workload | Chromium | WebKit | Firefox |
| --- | --- | --- | --- |
| 50 notes, one edited | 1.5-1.7 -> 1.6 | 2 -> 2-3 | 2-5 -> 2 |
| 2,000 notes, no incorporated snapshot | 25.4-26.4 -> 10.2-10.4 | 13 -> 14 | 21-22 -> 12 |
| 2,000 notes, incorporated snapshot, one edited | 4.7-4.8 -> 10.2-10.4 | 7-8 -> 13 | 8-9 -> 12 |
| 2,000 files across 40 directories | 26.6-27.7 -> 1.8-2.1 | 14 -> 4 | 19-20 -> 2 |
| Edits spread across 160 of 2,000 notes | 23.4-25.1 -> 10.3-10.4 | 13-14 -> 13 | 19-74 -> 11-14 |
| Add eight 2 MiB files | 10.4-11.7 -> 5.6-5.9 | 14 -> 11-12 | 49-55 -> 9-15 |
| Overwrite one 2 MiB file twelve times | 16.3-17 -> 20.1-20.2 | 17-18 -> 26-27 | 19-46 -> 38-43 |

Save-cycle timings include automatic collection after publication. The file
has already committed before that maintenance starts. A production opener
could acknowledge earlier, but collection still queues other storage work.
The raw samples separate collection duration and save phases.

With a small overlay after a checkpoint, production saves write the changed
file without rebuilding its directory tree. The prototype rewrites the wide
directory and hashes the changed objects on every save. That cost remains even
with the faster collector. With many saved offline files, production capture
loads all their contents on every operation; the working tree avoids that.
WebKit's wide local saves were about equal, rather than a working-tree win.

The sharded result demonstrates sensitivity to directory width. It is not a
recommendation to shard table rows: that would change the current table layout.

## Reads and lists

Point-read p95 after the wide local workload:

| Browser | Overlay | Working tree with key-based collection |
| --- | --- | --- |
| Chromium | 19-22.9 ms | 4-4.1 ms |
| WebKit | 9-10 ms | 4-6 ms |
| Firefox | 20-27 ms | 6-8 ms |

After a checkpoint with a small overlay, point reads were similar or slightly
slower with the working tree. With sharded local files, working-tree point-read
p95 was 0.4-1 ms versus 10-27 ms for the overlay. Lists avoid loading file bytes
in the working-tree model; per-case list samples are in the raw report.

A selective-overlay implementation could also eliminate the all-contents
capture cost. It was not implemented here. The measured read improvement alone
does not establish that a working tree is the fastest possible representation.

## Collection and storage growth

Largest automatic collection duration across the wide cases:

| Browser | Collector reading file values | Collector using blob type-index keys |
| --- | --- | --- |
| Chromium | 114.1 ms | 45.9 ms |
| WebKit | 188 ms | 39 ms |
| Firefox | 115 ms | 23 ms |

For a wide local snapshot, the original collector read 2,002 object values,
about 10.14 MB. The indexed collector read two directory values, about 70 KB,
plus blob keys and sweep keys. It verified the same live closure. Both removed
the same remaining garbage: 2,176,943 bytes at the final sample, leaving
10,140,924 bytes of live objects. Each 360-save wide case crossed the automatic
threshold three times. These byte counts exclude IndexedDB metadata, index
storage, filesystem overhead, and browser memory.

The improved wide cases still had full save cycles up to about 54 ms.
Back-to-back editing from two tabs, with a lower 1 MiB collection threshold and
explicit concurrent collections, produced waits up to 248 ms in Chromium,
195 ms in WebKit, and 265 ms in Firefox. These include revision retries and
transaction queueing, not just collector execution. The experiment establishes
finite workload convergence, not a bound on starvation during endless typing.

## What survived

All three browsers preserved independent fields and the note body while two
tabs saved during collection. Received and sending roots stayed unchanged
while newer work accumulated. Acknowledging the exact sending commit preserved
the newer working tree. Closing and reopening the whole persistent browser
profile preserved the final edits. A second reopen showed that an earlier
retirement budget contributed to the next threshold-triggered collection.

The experiment checks the expected note field/body and binary edge markers;
it does not prove every Folder behavior. It does not exercise network sync,
rejected-send reconciliation, every native/raw entry shape, storage eviction,
quota failure, failed-collection reporting, forced termination, mobile latency,
or migration from the current database.

## Decision

Prefer the working-tree explanation if phone measurements support its costs:
one saved folder snapshot and two optional sync checkpoints, all sharing one
representation. The prototype removes a real overlay model. Its additional
maintenance is a retirement budget, collection policy, and database-maintained
type index. No reference-count ledger or incremental collector was needed.

It is not the fastest design for every operation. Small-backlog writes in a
wide table and repeated binary overwrites remain disadvantages. Reads with a
large offline backlog and operations in smaller directories are advantages.
Making a commit from an existing W root should need less preparation work, but
sync performance was not measured.

Before replacement, measure the wide-table and multi-tab cases on phones,
exercise quota/collection failure behavior, then establish migration and full
Folder/sync equivalence. Keep conflict-policy changes separate. Retire the
throwaway code when that choice is settled; retain this evidence.

## Follow-up: roots can replace the publication revision

The later collapse pass tested a smaller metadata model without changing the
source files used by the timed experiment above. A Bun bundle transformation
replaced revision guards with working-root guards for saves and three-reference
guards for checkpoint preparation. Acknowledgement still checked the exact
received/sending pair. The transformation removed the persisted revision field.

[Focused results](root-guards.json) record the original source, transformed
source, and bundle hashes. Chromium, WebKit, and Firefox each completed 120
two-tab saves alongside automatic and three explicit collections. Both sync
checkpoints survived; acknowledging the pending commit preserved newer work;
reopening the full persistent profile retained it. The revision field was absent
before and after reopening. Retries occurred in all three browsers.

This is a correctness follow-up, not another timing comparison or proof of
complete network synchronization. The latency tables above still describe
the original revision-based prototype. Root equality permits A -> B -> A
because its immutable input bytes are identical; it deliberately forgets
uncheckpointed operation intent that leaves no net snapshot change.

The collapse pass also reproduced a semantic difference in the current overlay
engine: deleting and recreating a directory's file can leave a prefix deletion
marker even after its visible contents equal the pending tree. That marker can
cause current sync to overwrite an independent remote field. Net snapshot
merging preserves the remote field. The
[current flow review](../working-tree/REVIEW.md)
records the equal-snapshot rule. A later production implementation now covers
that sequence and two-generation rejection against native Git. Those results
are separate from this historical prototype and do not alter its timing data.
