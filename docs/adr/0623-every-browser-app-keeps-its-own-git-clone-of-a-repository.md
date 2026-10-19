# 0623. Each web origin keeps local data in IndexedDB

- **Status:** Accepted
- **Date:** 2026-10-19
- **Amends:** [ADR-0529](0529-commits-happen-only-on-sync-or-when-a-person-saves-a-version.md) at "only": a browser clone commits at each sync, and sync runs on its own once edits settle.
- **Amended by:** [ADR-0628](0628-browser-sync-uses-transactions-and-git-updates-instead-of-cross-tab-ownership.md) at snapshot retention and shallow boundaries, synchronous-only saves, publication checks, uncertain-push reconciliation, collection, fetch depth, the sync lease, and commit timing: local saves remain offline, while history incorporation may wait for editing to settle and connectivity to return. [ADR-0633](0633-apps-open-local-data-before-connecting-services.md) at unconnected browser datasets: local saves precede first sign-in and synchronization is optional.
- **Relates:** [ADR-0619](0619-every-byte-epicenter-keeps-is-a-git-object-a-working-file-an-access-list-row-or-a-cache.md) (a browser clone's unsent edits are its working files, and it holds no cache), [ADR-0620](0620-history-in-a-repository-only-grows.md) (history only grows), [ADR-0622](0622-a-losing-edit-stays-a-parent-of-the-merge-commit.md) (the merge a sync and a save make), [ADR-0624](0624-a-repository-reports-synced-pending-disconnected-or-stuck.md) (the causes of `stuck`).
- **Unbuilt:** the public local opening API, automatic sync scheduling, safe object collection, migration from OPFS, and hosted and phone verification.

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

**Each web app origin keeps its local datasets in IndexedDB.**
Tabs of one origin share the selected dataset's database. Different origins
hold independent local copies. Local data opens and saves before consent
or a remote is selected (ADR-0633). Request persistent browser storage;
phone eviction and termination behavior still require verification.

**Connected local data holds Git objects and newer unsent changes.**
The Git service exchanges ordinary Git. The browser needs no disk checkout,
filesystem working tree, Git index, or separate persisted row database.
Rows are views of Markdown file content.

```text
objects       retained commits, trees, and file blobs
meta          incorporated/pending refs, retained boundaries, publication revision
edits         path to newer saved text, or a deletion
```

The browser keeps the active files available offline. Retained history and
ancestry recovery follow ADR-0628; a snapshot of current files is not all
history. A clone names an actual independent copy, rather than a mandatory
identity for data before connection.

When an existing connected clone opens, check that its referenced `main`
commit and root tree exist. Fetch missing objects before using that committed
snapshot. Preserve unsent changes during recovery. This check does not gate
opening unconnected local data or require sign-in before local saves.

**Reads combine the current committed snapshot with unsent edits.**
Saves capture the necessary source, compute their content merge, and publish
under a revision check. They acknowledge durable local publication without
requiring a network round trip. Newer saves remain separate from the exact
commit a network request is pushing.

**Sync preserves exact pending work until its outcome is known.**
Fetch, adoption, push acknowledgement, and retention follow ADR-0628. A
push's missing reply is not proof that its commit failed. Browser commits
use the incorporated server commit as their parent under the accepted
contract. Bootstrap clarification remains separate from this terminology.

**Pages do not hold a cross-tab synchronization lease.**
Transactions own publication. Each page coalesces its own concurrent
attempts; separate pages can overlap. Sync can wait for a pause in editing.
No lock owner, lease expiration, or takeover protocol is required.

**Connected data synchronizes automatically.** After unsent edits settle for
about ten seconds, attempt sync; also attempt it when the tab hides. Check
the server when the tab becomes visible, when connectivity returns, and every
sixty seconds while visible. Check the remote ref before fetching unchanged
content. ADR-0628 removes the maximum wait during continuous editing: history
incorporation may wait until editing settles.

**Migration preserves existing saved and unsent work.**
Existing apps still use OPFS through the folder package. New local identity
and connection metadata must preserve that work before old storage is
removed. Starting an unrelated empty dataset is not a migration.

## Consequences

- Same repository does not mean same local saved state across origins.
- A browser database is not a physical data folder accessible to desktop
  editors or other web origins.
- Automatic triggers, hosted transport checks, collection, and phone
  durability remain implementation work.

## Reconsidering browser Git

Server-side commits would move Git out of the browser, but require a service
that writes history for its clients. Reconsider that architecture only if one
of the following occurs:

- First open on an iPhone at the app's expected row count exceeds about ten
  seconds at p95.
- A browser clone exceeds about 25% of its storage quota, or eviction is observed.
- A commit exceeds one second at p95.
- An app needs one table from a repository too large to clone.
- A WebKit storage defect cannot be worked around.

These are decision triggers, not automatic runtime switches. Phone measurements
and hosted verification remain necessary before judging the tradeoff.
