# 0623. Every browser app keeps its own Git clone of a repository

- **Status:** Proposed
- **Date:** 2026-10-19
- **Amends:** [ADR-0529](0529-commits-happen-only-on-sync-or-when-a-person-saves-a-version.md) at "only": a browser clone commits at each sync, and sync runs on its own once edits settle.
- **Relates:** [ADR-0619](0619-every-byte-epicenter-keeps-is-a-git-object-a-working-file-an-access-list-row-or-a-cache.md) (a client's unsent changes are working files), [ADR-0622](0622-a-losing-edit-stays-a-parent-of-the-merge-commit.md) (the merge sync makes).
- **Unbuilt:** all of it. WebKit comes first: a clone in OPFS under `navigator.storage.persist()` on iPhone Safari is verified before anything else is built on it. Then the change log, the shared object cache, the two network fixes, the deletion of the browser Git index, and the sync schedule.

## Context

The browser backend already runs isomorphic-git over a folder's `.git` in
the origin private file system, keeps a Git index, and holds a Web Lock for
index and branch work (`packages/folder/src/git/browser-backend.ts`,
`packages/folder/src/git/opfs-git.ts`,
`packages/folder/src/git/index-file.ts`). A commit happens at sync or when
a person saves a version
([ADR-0529](0529-commits-happen-only-on-sync-or-when-a-person-saves-a-version.md)),
and it captures the whole folder, reading every file
(`packages/folder/src/git/history.ts`). A benchmark at 10,000 rows on
commit `7a05d60556` measured a browser clone at 110 s and a native sync at
47 s; one shared Git object cache brought them to 43 s and 3.1 s.

## Decision

**Each app origin keeps a real Git clone of each repository it opens, in
browser storage, with one writer at a time.** The clone is isomorphic-git
over OPFS, kept under `navigator.storage.persist()`. Tabs of one origin
share the clone, taking turns under a lock. The server stays a plain Git
host plus the access list.

**Commits happen at sync.** Sync commits the working files, fetches, makes
a merge commit when `main` moved
([ADR-0622](0622-a-losing-edit-stays-a-parent-of-the-merge-commit.md)),
and pushes a fast-forward.

```txt
no browser Git index      a commit builds its tree from HEAD's tree and the changed paths
a persisted change log    the paths written since the last commit, so a commit hashes only those;
                          a cache (ADR-0619): losing it costs one full hash of the working files
one shared object cache   objects read once per clone, not once per operation
fetch                     negotiation sends the remote-tracking ref as a have
push                      stops at what the server already has
```

Deleted: `packages/folder/src/git/index-file.ts` and every write of a
browser index.

**A clone syncs on its own schedule.**

```txt
unsent edits   syncs once edits settle: about 10 s after the last edit, 60 s at most,
               and at once when the tab hides
no edits       checks the server when the tab becomes visible, comes online, or every 60 s
               while visible, with a cheap ref check first and a fetch only when a ref moved
```

## Consequences

- Each origin downloads the whole repository, so a repository an app opens
  stays small enough for a tab, and a large archive is its own repository
  used through the CLI.
- Two apps open on one repository hold two clones that meet only through
  the Git service.
- An edit is a working file for up to a minute before it is a commit, and a
  tab closed before its sync leaves it as a working file for the next one.
- Every app pays for Git in the browser: its library size, its storage
  quota, and WebKit's storage behavior.

## Considered alternatives

- **Server-side commits.** Each client holds the files and its unsent
  changes, and the service commits them. It moves Git out of the browser at
  the cost of a service that writes history for its clients. Epicenter
  switches to it only on one of these triggers:
  - opening a repository on iPhone takes over about 10 s at p95 after a
    shallow clone and a warm cache;
  - a browser `.git` passes about 25% of the storage quota, or eviction is
    observed;
  - a commit takes over 1 s at p95 with the change log;
  - an app needs one table of a repository too large to clone;
  - a WebKit storage defect cannot be worked around.
- **A commit on every save.** Every save hashes and writes objects, and
  history fills with one commit per keystroke burst.
