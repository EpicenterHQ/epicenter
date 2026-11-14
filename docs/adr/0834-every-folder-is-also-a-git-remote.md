# 0834. Every folder is also a Git remote

- **Status:** Superseded
- **Date:** 2026-11-07
- **Superseded by:** [ADR-0899](0899-the-folder-sync-product-is-retired.md): the folder sync product is retired, and this record is its history.
- **Amends:** [ADR-0831](0831-a-git-branch-lands-in-a-folder-as-one-change-through-the-cli.md) at a server endpoint for `git push` waiting for a Git-only sandbox: the Git remote is the destination, and the CLI's commands are its present form.
- **Relates:** [ADR-0824](0824-a-folders-history-is-a-log-of-versions-and-git-is-how-it-leaves.md) (the log is the storage), [ADR-0826](0826-history-enters-and-leaves-epicenter-as-git.md) (history enters and leaves as Git), [ADR-0828](0828-names-say-folders-and-changes-and-history-is-package-functions-the-epicenter-app-shows.md) (the folders address).
- **Amended by:** [ADR-0838](0838-git-speaks-to-a-folder-through-a-remote-helper-and-the-cli-speaks-a-persons-verbs.md) at a remote served by the server: Git reaches a folder through `git-remote-epicenter` on the computer; the server's remote waits for a Git-only sandbox.
- **Unbuilt:** all of it: a Git view of each folder's log, cached in the blob store; clone and fetch over Git's HTTP protocol; a push translated into a change; tokens scoped to one folder for Git clients.

## Context

A folder's history is Epicenter's own log, because Git's writes carry neither a
per-path expected version nor a merge by key, and its whole-tree snapshots,
large-file pointers, and rewritable branches cost more than they gave. Git still
reaches a folder through three commands of the CLI: export, import, and landing
a branch. Each exists only because a Git client cannot speak to the folder
itself, and an agent with nothing but `git` needs the CLI or a person to reach
it.

## Decision

**Every folder is also a Git remote**, at its folders address with `.git`. A
clone or fetch reads a Git view of the folder's log: one commit per change with
its author and time, notes as files, other files through Git LFS, marks as
tags, generated deterministically and cached. A push is translated, never
stored as Git: it lands as one change whose expected versions are the files at
the change it started from, merged by key and by line, and refused like Git's
"fetch first" on a true conflict; a push that rewrites history is refused.

**The log stays the only truth.** Every write, from a device, a web app, an
agent's tools, or a Git push, is a change through one door.

**Until the remote is built, the CLI is its present form**: `export --git`,
`import --git`, and `git land` do what clone, a first push, and a push will.

## Consequences

- To anything outside Epicenter, a folder is a Git repository; inside, it is a
  ledger.
- An agent needs only `git` and a token for one folder.
- The server again speaks Git's transfer protocol and keeps a Git view per
  folder, as a cache of the log.
