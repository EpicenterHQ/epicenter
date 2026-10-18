# 0623. Every browser app keeps its own Git clone of a repository

- **Status:** Accepted
- **Date:** 2026-10-19
- **Amends:** [ADR-0529](0529-commits-happen-only-on-sync-or-when-a-person-saves-a-version.md) at "only": a browser clone commits at each sync, and sync runs on its own once edits settle.
- **Relates:** [ADR-0619](0619-every-byte-epicenter-keeps-is-a-git-object-a-working-file-an-access-list-row-or-a-cache.md) (a browser clone's unsent edits are its working files, and it holds no cache), [ADR-0620](0620-history-in-a-repository-only-grows.md) (history only grows), [ADR-0622](0622-a-losing-edit-stays-a-parent-of-the-merge-commit.md) (the merge a sync and a save make), [ADR-0624](0624-a-repository-reports-synced-pending-disconnected-or-stuck.md) (the causes of `stuck`).
- **Unbuilt:** all of it: objects, refs, and unsent edits in IndexedDB; reads, `list()`, and commits over them; push from individual objects; the open check; the two network fixes; the sync lock's lease; moving existing clones; the deletion of the OPFS clone; and the sync schedule. Every measurement below is from headless desktop engines on macOS; a real iPhone still has to show IndexedDB under `navigator.storage.persist()` as a home-screen web app, eviction, and a tab killed mid-transaction.

## Context

The browser backend runs isomorphic-git over a folder's `.git` and working
tree in the origin private file system (OPFS), keeps a Git index, and holds
a Web Lock for index and branch work
(`packages/folder/src/git/browser-backend.ts`,
`packages/folder/src/git/opfs-git.ts`,
`packages/folder/src/git/index-file.ts`,
`packages/folder/src/opfs-store.ts`). A commit happens at sync or when a
person saves a version
([ADR-0529](0529-commits-happen-only-on-sync-or-when-a-person-saves-a-version.md)),
and it captures the whole folder, reading every file
(`packages/folder/src/git/history.ts`). A benchmark at 10,000 rows on
commit `7a05d60556` measured a browser clone at 110 s and a native sync at
47 s; one shared Git object cache brought them to 43 s and 3.1 s.

Branch `claude/v1-gate-tests` tested OPFS in each engine. The engine probes
(`da595a524a:packages/folder/evidence/engine-probes/RESULTS.md`) found that
WebKit 26.5 returns zeros, empty, or mixed bytes for a `File` read after or
during its file's replacement, and treats `A.md` and `a.md` as one entry,
the second create silently overwriting the first. Chromium refuses such a
stale read with `NotReadableError`; Firefox aborts it with `AbortError` or
reads whole bytes. The OPFS acceptance page
(`d69769885b:packages/folder/evidence/opfs/ACCEPTANCE.md`) passed 21 of 21
checks in Chromium and Firefox and failed one or two in WebKit.

The same branch benchmarked four storage designs in three engines at 300
and 5,000 rows (`4628a55c6c:packages/folder/evidence/storage-bench/RESULTS.md`):
the OPFS working tree above; packs at rest in OPFS or in IndexedDB, each
with a row cache; and every object inflated in IndexedDB, one record per
object id, with no pack and no row cache. During a 5,000-file checkout,
WebKit's OPFS refused writes from about the 4,840th file, and the first two
files written then read 0 bytes for good, in every run.

## Decision

**Each app origin keeps a real Git clone of each repository it opens, in
IndexedDB.** The clone is kept under `navigator.storage.persist()`, and the
tabs of one origin share it. The server stays a plain Git host plus the
access list.

**A browser clone holds Git objects, refs, and its unsent edits, and
nothing else.**

```txt
objects        one record per Git object, keyed by oid, held inflated;
               a fetched pack is unpacked once, and no pack is kept
refs           each ref's name and the oid it points at
unsent edits   path → { bytes, base }: a path's bytes saved since the last commit,
               or null for a deleted path, and base, the blob id the edit
               started from
```

There is no pack at rest, no row cache, no working tree, no checkout, and
no Git index. A save, a ref's compare-and-swap, and clearing committed
edits are each an IndexedDB transaction. Unsent edits keep the one job of
Git's index a commit needs, what changed and from which blob, and drop the
rest of it: the listing of every file and the timestamp cache.

**A read returns a path's unsent bytes, or else the blob HEAD's tree
names.** `list()` reads its table's tree and the blobs it names, with the
unsent edits over them, and parses every row each time.

**A commit writes the changed blobs, the trees along the changed paths, and
the commit, then compare-and-swaps the ref.** An unsent edit whose `base`
is not the blob HEAD's tree names for its path is merged first, with
`base` as the base, HEAD's blob as `current`, and its bytes as `change`
([ADR-0622](0622-a-losing-edit-stays-a-parent-of-the-merge-commit.md)).
After the swap the commit clears the edits it committed; a path saved again
since the commit read it keeps its newer edit.

**A commit copies every tree entry off the changed paths by oid.** A
browser clone therefore carries untouched any entry it cannot represent,
such as a symlink, an executable, or a submodule, anywhere in the tree. No
path becomes a name in a file system: paths are IndexedDB keys, compared as
exact strings, so two names that differ only by case stay two paths in
every engine.

**Fetch unpacks once, and push packs.** A fetch writes each object of the
pack it receives as its own record, and a push builds a pack from
individual objects. Fetch negotiation sends the remote-tracking ref as a
have, and a push stops at what the server already has.

**A browser clone is full in v1:** it holds every commit of `main`. A
shallow clone returns later, behind a size trigger.

**On open, a clone checks that HEAD's commit and its root tree exist, and
fetches again when either is missing.** A clone that has never fetched
fetches before its first commit. No garbage collection runs in v1: a
clone's unreachable objects stay until the clone is deleted and cloned
again.

**Reads and saves take no lock; only sync does.** The origin's Web Lock
keeps two tabs from syncing at once, and it is held as a lease, so a tab
suspended mid-sync cannot stall sync forever: once the lease lapses,
another tab takes the lock.

**Commits happen at sync.** Sync commits the unsent edits, fetches, makes a
merge commit when `main` moved
([ADR-0622](0622-a-losing-edit-stays-a-parent-of-the-merge-commit.md)),
and pushes a fast-forward.

**A clone syncs on its own schedule.**

```txt
unsent edits   syncs once edits settle: about 10 s after the last edit, 60 s at most,
               and at once when the tab hides
no edits       checks the server when the tab becomes visible, comes online, or every 60 s
               while visible, with a cheap ref check first and a fetch only when a ref moved
```

**An existing OPFS clone moves by one sync, then a new clone.** It syncs
its working files once; the origin then deletes it and clones the
repository into IndexedDB. Deleted: the OPFS working tree and `.git`
(`packages/folder/src/git/opfs-git.ts`), the write protocol of
`packages/folder/src/opfs-store.ts`,
`packages/folder/src/git/index-file.ts` with every write of a browser
index, and `reconcileIndex` and the `MERGE_HEAD` path in
`packages/folder/src/git/browser-backend.ts`.

## Consequences

- At 300 rows, p50 in ms, Chromium / WebKit / Firefox
  (`4628a55c6c:packages/folder/evidence/storage-bench/RESULTS.md`):

  ```txt
                              objects in IndexedDB     OPFS working tree
  clone                       183 / 295 / 288          303 / 365 / 966
  list, cold                  19 / 33 / 45             33 / 88 / 59
  save                        0.1 or less              1 / 1 / 4, and 8 in Firefox at 5,000 rows
  commit                      1.3 / 2 / 1              11 / 11 / 23
  apply 50 incoming changes   123 / 197 / 195          44 / 45 / 192
  ```

- Incoming changes cost more, because each object is unpacked and written
  as its own record: 50 of them take about 1 s at 5,000 rows (874 / 1,159 /
  1,171 ms). A clone takes about three times the storage of packed objects
  (6.9 MB against 2.2 MB at 5,000 rows in Chromium), and grows until it is
  cloned again.
- Native `git fsck --full` passed on every branch the benchmark pushed, and
  all 120 runs, across the four designs, three engines, and two sizes,
  pushed the content they committed.
- Every `list()` reads and parses every row of its table, since nothing is
  cached.
- Each origin downloads every commit of `main`, so a repository an app
  opens stays small enough for a tab, and a large archive is its own
  repository used through the CLI.
- Two apps open on one repository hold two clones that meet only through
  the Git service.
- An edit is an unsent edit for up to a minute before it is a commit, and a
  tab closed before its sync leaves it for the next one.
- A symlink, an executable, or a submodule anywhere in the tree is
  invisible to a browser app and survives its commits unchanged.
- A read never waits for another tab.
- Every app pays for Git in the browser: its library size and its storage
  quota.

## Considered alternatives

- **Server-side commits.** Each client holds the files and its unsent
  changes, and the service commits them. It moves Git out of the browser at
  the cost of a service that writes history for its clients. Epicenter
  switches to it only on one of these triggers:
  - the first open of a repository on an iPhone, at the row count the app
    expects, takes over about 10 s at p95;
  - a browser clone passes about 25% of the storage quota, or eviction is
    observed;
  - a commit takes over 1 s at p95;
  - an app needs one table of a repository too large to clone;
  - a WebKit storage defect cannot be worked around.
- **An OPFS working tree with a Git index.** WebKit hands a reader zeroed
  or torn bytes while a file is replaced, folds names that differ only by
  case into one file, and left files permanently empty during a 5,000-file
  checkout; living with it takes a lock on every read, a refusal of
  case-only names, a retry of Firefox's `AbortError`, and a rule for a save
  during sync's checkout.
- **Packs at rest, with a row cache.** Packs in OPFS or IndexedDB clone two
  to four times faster and apply incoming changes in about 1 ms, but list
  cold more slowly, because isomorphic-git looks for a loose object and
  lists the packs before each blob, and the row cache is a second copy of
  every row to keep in step with its blob.
- **A shallow clone in v1.** isomorphic-git's merge-base lookup returns
  nothing for a commit the clone lacks, and a push from a shallow clone to
  Cloudflare Artifacts is not verified.
- **A commit on every save.** Every save hashes and writes objects, and
  history fills with one commit per keystroke burst.
