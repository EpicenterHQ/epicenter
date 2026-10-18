# 0617. A capture reads only the files whose stat changed

- **Status:** Proposed
- **Date:** 2026-10-18

## Context

Every status and every commit, Sync's checkpoint included, captured the
folder with `captureSource` in `packages/folder/src/git/history.ts`: it
listed every file, read every source file's bytes, and hashed each one.
`boundary.read` also took each file's SHA-256, which a capture never uses.
After a commit, the browser's `reconcileIndex` reset each index entry that
differed from the head with isomorphic-git's `resetIndex`, which reads,
rewrites, and checksums the whole index once per path.

Measured with one changed row file among 2,000 and 5,000, on the in-memory
OPFS stand-in (`src/opfs.test-support.ts`) and on a native folder in Bun
(milliseconds; reads are `boundary.read` calls):

| | 2,000 rows | 5,000 rows |
| --- | --- | --- |
| browser status | 47, 2,000 reads | 131, 5,000 reads |
| browser commit | 75, 2,000 reads | 174, 5,000 reads |
| browser Sync | 149, 2,000 reads | 243, 5,000 reads |
| browser first commit | 3,224 (`reconcileIndex` 2,828) | 18,725 (`reconcileIndex` 16,870) |
| native status | 373, 2,000 reads | 828, 5,000 reads |
| native commit | 541, 2,000 reads | 1,353, 5,000 reads |
| native Sync | 652, 2,000 reads | 1,431, 5,000 reads |

A commit already wrote only four objects: isomorphic-git skips a tree it
has stored, and `writeFilesTree` skips a blob the parent tree names. The
cost was reading and hashing every file, and, for a commit that changes
many paths, the index. The in-memory stand-in reads far faster than a real
origin private file system, where each read is a `getFile` and an
`arrayBuffer` across a process boundary, so the browser figures understate
the reads' share.

## Decision

**A capture reads and hashes only a file whose listing differs from what
`.git/epicenter/capture-cache` recorded when its bytes were last read.** A
file whose size, modification time, and stamp still match is captured as the
blob ID recorded with them, and is not read.

```txt
FileListing.listedAt            the host's clock just before it listed
ListedFile.modified             modification time, ms, on that clock
ListedFile.stamp                Bun: `${dev}:${ino}:${ctimeMs}`; OPFS: none
.git/epicenter/capture-cache    `epicenter capture cache 1 <sha256 of body>\n`
                                then [path, size, modified, stamp, oid][] as JSON
```

- **The racy rule.** `entryFor` records a file only when `modified` is more
  than `RACY_MS` (3,000) older than `listedAt`. A write after the listing
  gets a time at or after `listedAt`, so a recorded stat can never match
  bytes written after the read; the margin covers file systems that keep
  times in steps of up to two seconds. The stat recorded is the listing's,
  taken before the read. Real engines differ: Chromium 151 times an origin
  private file system write in milliseconds, WebKit 26.5 in whole seconds,
  up to a second before the write (`packages/folder/evidence/opfs/ACCEPTANCE.md`,
  2026-10-18). A file timed at or before the epoch is never recorded.
- **A commit never names a blob it has not stored.** A cached blob ID the
  parent tree does not name is checked with `hasObject`; one that is not
  stored is read. A status trusts the cache without the check, since it
  writes no tree.
- **A commit stores the cache; a status keeps it in memory.** A status
  writes nothing. `GitBackend.captureCache` writes nothing while there is
  no repository.
- **The cache is no cache when anything about it is unexpected:** a missing
  file, another header, a checksum that does not match, or an entry of the
  wrong shape. A format change is a new header; nothing migrates.
- **The rule files are read every time.** The `.gitignore` bytes that
  choose the source are still the captured bytes (ADR-0592).
- **The browser writes its index from the head's tree in one pass**
  (`treeIndex` in `packages/folder/src/git/index-file.ts`), with zeroed
  stats, which its own index never trusted (`statsFor` in `opfs-git.ts`).
  The session stores it only when an entry differs.

## Consequences

The same measurements after the change, with the folder's files older than
`RACY_MS`:

| | 2,000 rows | 5,000 rows |
| --- | --- | --- |
| browser status | 4, 1 read | 10, 1 read |
| browser commit | 22, 1 read, 4 objects | 42, 1 read, 4 objects |
| browser Sync | 79, 2 reads | 110, 2 reads |
| browser first commit | 456 (`reconcileIndex` 4) | 1,897 (`reconcileIndex` 8) |
| native status | 101, 1 read | 213, 1 read |
| native commit | 341, 1 read | 741, 1 read |
| native Sync | 417, 2 reads | 861, 2 reads |

What a capture still costs for every file is the listing: one `getFile` in
a browser, an `lstat` and a `realpath` in Bun. A native commit also walks
the folder twice in `nativeCheckpointProblem` to refuse links and
executables, about 500 ms of the 741 at 5,000 rows, and a native folder's
first commit still stores each new blob with its own `git hash-object -w`
(22 s at 5,000 rows). Neither is changed here.

A file edited within three seconds of a capture is read by every capture
until it is older. A cache another tab or process wrote is read once per
handle; each handle's entries are facts about bytes, so whichever handle
stored last leaves a true cache.

The rule trusts that a file's modification time moves forward with the
host's clock. A file system whose clock runs behind the process's by more
than `RACY_MS`, written twice at the same size within one of its timestamps
around a capture, could be missed; in Bun the inode and change time in
`stamp` also have to repeat. A desktop page's own storage lists no stats,
and its history runs in the CLI, which does.

The random-sequence test in `packages/folder/src/git/capture-cache.test.ts`
compares a folder with the cache against one without, over edits, clock
steps, reopenings, and deleted and corrupted caches, on a one-millisecond
and a two-second clock; without the margin it fails on the two-second one.

## Considered alternatives

- **Git's own index as the stat cache.** The browser's index deliberately
  never trusts its stats, and the native one belongs to every Git program
  on the machine; ADR-0592 also keeps `git status` out of choosing the
  source.
- **Git's racy rule measured from the cache file's write time.** A file
  written after its read and before a slow cache write, in one timestamp
  step, keeps a stat the cache would trust. Measuring from the listing
  closes that window.
- **Reusing the parent's subtrees for unchanged directories.** A commit
  already wrote four objects; hashing the trees costs less than a file read.
- **An in-memory cache only.** Every new tab and every CLI run would read
  the whole folder once.
