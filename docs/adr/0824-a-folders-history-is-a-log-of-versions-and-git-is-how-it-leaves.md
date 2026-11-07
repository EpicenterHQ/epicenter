# 0824. A folder's history is a log of versions, and Git is how it leaves

- **Status:** Accepted (2026-11-06)
- **Date:** 2026-11-06
- **Amends:** [ADR-0762](0762-epicenter-is-made-of-standards-and-places.md) at "history | Git" and "stock `git` … works with Epicenter unchanged": history leaves Epicenter as Git, and stock Git reads an export but writes nothing; [ADR-0808](0808-a-files-version-is-its-git-blob-id-on-every-store.md) at a file's version being its Git blob id: it is the SHA-256 of its bytes, for every path; [ADR-0734](0734-every-file-other-than-a-note-is-kept-whole-in-git-lfs.md) at files other than notes kept in Git LFS: every file's bytes are kept by their SHA-256, inline or in the blob store by size; [ADR-0803](0803-clients-sync-only-with-epicenter-servers-and-sync-is-a-function-of-two-stores.md) and [ADR-0811](0811-folders-are-shared-directly-and-an-app-reaches-the-folders-attached-to-it.md) at cloning a folder's repository and pushing to it: there is no Git remote; [ADR-0809](0809-a-repository-is-a-spaces-app-and-bytes-nothing-needs-are-collected-or-purged.md) at the upload ledger and purge: one table of a folder's bytes records pending, kept, and purged.
- **Relates:** [ADR-0804](0804-a-computer-keeps-a-plain-folder-and-every-surface-syncs-with-one-typescript-function.md) (no client Git), [ADR-0822](0822-only-epicenter-syncs-on-a-computer-and-a-folder-holds-only-its-content.md) (Epicenter never syncs a Git working tree), [ADR-0823](0823-on-the-web-the-folder-on-the-server-is-the-apps-store.md) (a web app's save is a commit), [ADR-0795](0795-git-merges-a-notes-body-and-epicenter-merges-its-front-matter-by-key.md) (the merge, which stays).
- **Amended by:** [ADR-0826](0826-history-enters-and-leaves-epicenter-as-git.md) at Git being how history leaves: it is also how history enters, and a person can name a moment.
- **Amended by:** [ADR-0827](0827-the-cli-and-mcp-render-one-table-of-operations.md) at notes as blobs and other files as LFS objects: the folder's `epicenter.json` is a blob too (projection v2).
- **Amended by:** [ADR-0829](0829-a-restore-never-deletes-on-a-device-and-historys-chain-covers-what-changed-not-who.md) at the digest and at conflicts only on the same file: the chain covers what changed and when, never who; every commit to a folder waits its turn.
- **Amended by:** [ADR-0831](0831-a-git-branch-lands-in-a-folder-as-one-change-through-the-cli.md) at no Git client writing to a folder: a Git branch lands through the CLI as ordinary changes.
- **Amended by:** [ADR-0833](0833-a-folders-present-lives-in-one-shared-database-and-its-past-in-its-own-archive.md) at text up to 16 KiB stored inline: text up to about 2 KiB is stored inline, and older changes move to the folder's archive.
- **Unbuilt:** a deployment's schedule for the pending-upload sweep and for purges, and a scheduled export kept as a copy. Nothing thins history.

## Context

Each folder's history on the server is a Git repository, a choice made when
every computer kept a `.git` in each folder. ADR-0804 removed Git from
computers, and clients speak Epicenter's own commit API in Git's vocabulary,
which no Git client speaks. ADR-0822 keeps Git working trees out of Epicenter's
sync, so a stock `git push` is the only Git writer left, and it writes around
Epicenter's rules: it merges front matter line by line, can land conflict
markers inside it, and lets any member replace `main`, whose deletions every
member's Epicenter then pulls.

Three reviewers measured what Git storage costs. Every poll walks objects (on
the hosted server, a receive-pack advertisement and a tree diff); a folder's
title takes four reads; a file's history has no route; writes to unrelated
files contend on `main` through a retry loop; listing a folder reads one object
per attachment and per directory, which a folder of ten thousand recordings
exceeds; and each commit rewrites the directory's whole tree, so a year of
recordings in one directory stores gigabytes of trees beside its audio. Two
hashes, LFS pointers whose versions hash the pointer, and a path-based storage
rule run through every store, and the rule's exception for `epicenter.json`
already disagrees between Rust and TypeScript. Hosted Git answers 503 until its
R2 key pair is set.

## Decision

**A folder's history is an append-only log of changes.** Postgres holds it, and
the blob store holds bytes:

| Table | Holds |
| --- | --- |
| `folder` | its id and last sequence number, locked by each commit so changes are numbered densely in commit order |
| `change` | sequence, time, account, the author as written then, the program, and `digest = sha256(previous digest, change)` |
| `change_file` | each path a change wrote, its version or null for a deletion, and size |
| `file` | each path's current version, unique by folded name, with the file-or-directory and case rules |
| `blob` | each SHA-256 the folder holds, its size, inline bytes or none, and whether it is pending, kept, or purged |

**A file's version is the SHA-256 of its bytes**, for every path, and is the
bytes' address. Text up to about 16 KiB is stored inline; larger bytes live in
the blob store, chosen by size. A listing says which kind of version each entry
carries.

**A commit is one statement**: it checks each path's expected version against
`file`, refuses with every path that moved, and otherwise records the change.
A write may name a version the folder already holds, so a restore moves no
bytes. `changes?since=<epoch>.<seq>` answers each changed path with its
version, within its own limit, and answers "compare every path" for a gap past
it. A file's history, and a folder as of any change or time, are queries.

**Git is how history leaves.** `epicenter export --git` writes a deterministic,
incremental Git history, one commit per change, notes as blobs and other files
as LFS objects named by their versions, tested by `git fsck` and by checking out
the folder as it was. No Git client writes to a folder, because Git's writes
carry neither a per-path expected version nor the merge by key; a read-only
`git clone`, if wanted, is a mirror fed from the export, never the store.

**History is read through Epicenter first**: `epicenter history <path>`,
`log --path`, `show`, `diff`, and `at <time>`. Retention is a policy: web
saves are debounced, any byte can be purged while its rows stay, and versions
an offline computer may still merge against are kept.

**This is a clean break**, once production is confirmed never to have held its
R2 key pair: hosted Git answers 503 without it, so no hosted history would
exist. Repositories a self-hosted server holds are dropped, or re-imported by
hand.

## Consequences

- Polling, folder heads, and titles are each one query, and writes conflict
  only on the same file.
- A person sees each file's versions, who wrote them, and the folder at any
  time, and can take it all away as a Git repository.
- Stock `git push` and a live `git clone` no longer exist.
- Each version of a note is stored whole, which debounced saves and later
  compression keep small.
- The operator backs history up with Postgres point-in-time recovery and blob
  versioning, and a scheduled export doubles as a copy.
