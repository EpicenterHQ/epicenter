# 0623. Every browser app keeps its own Git clone of a repository

- **Status:** Accepted
- **Date:** 2026-10-19
- **Amends:** [ADR-0529](0529-commits-happen-only-on-sync-or-when-a-person-saves-a-version.md) at "only": a browser clone commits at each sync, and sync runs on its own once edits settle.
- **Amended by:** [ADR-0628](0628-browser-sync-uses-transactions-and-git-updates-instead-of-cross-tab-ownership.md) at snapshot retention and shallow boundaries, synchronous-only saves, publication checks, uncertain-push reconciliation, collection, fetch depth, the sync lease, and commit timing: local saves remain offline, while history incorporation may wait for editing to settle and connectivity to return.
- **Relates:** [ADR-0619](0619-every-byte-epicenter-keeps-is-a-git-object-a-working-file-an-access-list-row-or-a-cache.md) (a browser clone's unsent edits are its working files, and it holds no cache), [ADR-0620](0620-history-in-a-repository-only-grows.md) (history only grows), [ADR-0622](0622-a-losing-edit-stays-a-parent-of-the-merge-commit.md) (the merge a sync and a save make), [ADR-0624](0624-a-repository-reports-synced-pending-disconnected-or-stuck.md) (the causes of `stuck`).
- **Unbuilt:** all of it: objects, the two refs, and unsent edits in IndexedDB; reads, `list()`, saves, commits, and the rebase over them; the sweep; push from individual objects; the open check; the sync lock's lease; moving existing clones; the deletion of the OPFS clone; and the sync schedule. Cloudflare Artifacts must still show a depth-1 fetch, a fetch whose deltas resolve from what a clone keeps, and a push of a one-parent commit onto a commit the clone holds without its history. Every measurement below is from headless desktop engines on macOS; a real iPhone still has to show IndexedDB under `navigator.storage.persist()` as a home-screen web app, eviction, a tab killed mid-transaction, and whether a committed transaction survives the phone restarting at once.

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

**A browser clone holds the objects its two refs reach, the two refs, and
its unsent edits, and nothing else.**

```txt
objects        one record per Git object, keyed by oid, held inflated: the commits, trees,
               and blobs that main and origin/main reach, and no older history
refs           origin/main: the last commit the clone knows the server holds
               main: origin/main, or one commit ahead of it waiting to be pushed
unsent edits   path → text, or null for a deleted path: what saves wrote since main's commit
```

There is no pack at rest, no row cache, no working tree, no checkout, no
Git index, and no history. The app API reads no history
([ADR-0626](0626-an-app-reaches-a-repository-only-through-open.md)), and a
merge needs none: the server takes only fast-forwards
([ADR-0620](0620-history-in-a-repository-only-grows.md)), so every commit it
will hold descends from `origin/main`, and `origin/main` is the base of
every merge the clone makes. Unsent edits keep the one job of Git's index a
commit needs, what changed, and drop the rest of it.

**A read returns a path's unsent text, or else the blob `main`'s tree
names.** `list()` reads its table's tree and the blobs it names in one
readonly transaction, with the unsent edits over them, and parses every row
each time.

**A save is one IndexedDB transaction.** It reads the path's current text,
merges `merge(path, { base: from, current, change })`
([ADR-0622](0622-a-losing-edit-stays-a-parent-of-the-merge-commit.md))
synchronously, and writes the unsent edit. It awaits nothing but IndexedDB
requests and hashes nothing, so two tabs saving one path take turns.

**A commit copies every tree entry off the changed paths by oid.** A
browser clone therefore carries untouched any entry it cannot represent,
such as a symlink, an executable, or a submodule, anywhere in the tree. No
path becomes a name in a file system: paths are IndexedDB keys, compared as
exact strings, so two names that differ only by case stay two paths in
every engine. Where an edit's path and a path the server changed are a file
and a directory, the edit wins the path, as ADR-0622 says.

**Sync commits, pushes, and, when the server moved, rebases onto it.**

```txt
commit   when main is origin/main and edits wait: hash the edits' blobs, the trees along
         their paths, and the commit; then in one transaction check that main and those
         edits are unchanged, write the objects, set main to the commit, and clear the
         edits it holds. A changed edit or ref means computing it again.
push     main as a fast-forward of origin/main; when the server takes it,
         origin/main = main
fetch    when the push is refused or its answer never came, and on the schedule below.
         If the server's main T descends from main, main landed: origin/main = main.
         Otherwise main's commit returns to the edits, each path it changed becoming an
         edit unless one is already there, and main = origin/main. When T is not
         origin/main, the edits rebase onto T: each edit on a path T changed becomes
         merge(path, { base: origin/main's blob, current: T's blob, change: the edit }),
         and they are committed on T with an Overrode: trailer for each unit an edit won,
         plus the trailers of a commit that returned. One transaction checks the edits,
         writes the objects, moves origin/main to T and main to that commit, and clears
         the edits it holds; with no edits, both refs move to T. Then push again.
```

Every commit a browser clone makes has one parent, a commit the server
holds, so no browser makes a merge commit or looks for a merge base. A push
whose answer is lost is settled by the next fetch: its commit has landed or
returns to the edits, so an edit is never replayed over a change made after
it landed.

**After each sync the clone deletes every object neither ref reaches.**
Only the objects along the paths a sync changed can become unreachable, so
the sweep walks those paths.

**A fetch keeps what the refs reach.** A clone's first fetch asks for depth
1 where the server offers it; otherwise it takes the whole pack and keeps
only what `main` reaches. A fetch resolves every delta from its pack or
from objects the clone keeps.

**On open, a clone checks that `main`'s commit and its root tree exist, and
fetches again when either is missing.** A clone that has never fetched
fetches before its first commit.

**Reads and saves take no lock; only sync does.** The origin's Web Lock
keeps two tabs from doing a sync's network work at once, and it is held as
a lease, so a tab suspended mid-sync cannot stall sync forever. The
transactions, not the lock, keep a clone correct: a second sync that runs
anyway finds its check failed or its push refused.

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

- Held inflated, a full history grows with rows times commits: every commit
  that touches a table stores that table's whole tree. Measured with native
  Git at 1,000 rows and 500 one-row commits, trees take 25.8 MB inflated,
  against 0.32 MB for the packed history and about 0.2 MB for the current
  rows and tree. A clone that keeps only what its refs reach stays at the
  current rows' size, whatever the repository's age.
- Incoming changes cost more, because each object is unpacked and written
  as its own record: 50 of them take about 1 s at 5,000 rows (874 / 1,159 /
  1,171 ms). A clone takes 2.6 to 5.5 times the storage of packed
  objects: at 5,000 rows, 6.9 MB against 2.2 MB in Chromium, 7.3 against
  2.8 in Firefox, and 12 against 2.2 in WebKit, whose storage estimate is
  coarse.
- Native `git fsck --full` passed on every branch the benchmark pushed, and
  all 120 runs, across the four designs, three engines, and two sizes,
  pushed the content they committed.
- Every `list()` reads and parses every row of its table, since nothing is
  cached.
- Each origin downloads `main`'s current rows, and the whole packed
  history once where the server offers no depth-1 fetch; a large archive is
  its own repository used through the CLI.
- A browser app shows no history; the CLI and agents read it.
- A week offline becomes one commit, made when the clone next reaches the
  server.
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
- **A full clone, held inflated.** A first open downloads and unpacks every
  commit, and storage grows with rows times commits (above): at 5,000 rows
  each commit to a table adds its whole tree of about 260 KB.
- **One ref, with no commit before the push.** A push whose answer is lost,
  as when iOS suspends a tab that synced on hiding, leaves its edits
  unsent; after another writer changes the same field, the next sync
  replays the stale value over theirs.
- **A record of the push in flight beside the clone.** Sync state Git
  cannot read
  ([ADR-0619](0619-every-byte-epicenter-keeps-is-a-git-object-a-working-file-an-access-list-row-or-a-cache.md));
  `main` one commit ahead of `origin/main` records the same in Git's nouns.
- **A merge commit when `main` moved.** It needs a merge-base search through
  history the clone does not keep; a rebase onto the server's `main` uses
  `origin/main` as the base and keeps every commit's parent on the server.
- **An unsent edit holding its base blob id.** An edit is always relative
  to `main`'s tree: every move of `main` commits the edits or rebases them
  in the same transaction.
- **A commit on every save.** Every save hashes and writes objects, and
  history fills with one commit per keystroke burst.
