# 0488. Each synced folder is an independent Git repository

- **Status:** Proposed
- **Date:** 2026-10-02
- **Relates:** [ADR-0521](0521-a-folder-syncs-over-plain-git-with-a-token-to-a-server-the-person-chooses.md) chooses the server and how a folder reaches it; [ADR-0489](0489-folder-transfers-happen-only-when-a-person-syncs.md) keeps transfers explicit.
- **Unbuilt:** a measurement of Whispering's audio history in a remote repository.

## Context

A file-authoritative data folder stores ordinary files with Git history beside
them. The engine fetches, pushes, fast-forwards, and merges diverged histories
([ADR-0474](0474-incoming-git-adoption-retains-a-recoverable-plan.md)). A
folder is a dataset, not an installed application: several applications can
open one folder, and one application can open several folders. Ownership locks,
scans, and incoming adoption already operate on one directory.

An earlier version of this record also chose GitHub as the remote and an
Epicenter pairing of each folder ID with a GitHub repository ID. ADR-0521
replaces that choice: the remote is any Git server the person chooses, named
only by `remote.origin.url`.

## Decision

**Each synced folder has its own Git repository.** Its committed `main` tree is
the remote counterpart of the folder. Independent folders never share a
repository or merge their histories. A folder can exist without a remote.

**A folder ID names a dataset, not a repository.** `so.epicenter.whispering`
is the normal application default, not a globally unique repository identity,
and a repository name need not equal it.

Managed folder IDs use two or more dot-separated lowercase ASCII labels, each
beginning and ending with a letter or digit and containing only letters,
digits, and interior hyphens. The complete name is at most 128 bytes. Excluded
are platform-reserved directory names, including Windows device basenames
before the first dot: `con`, `prn`, `aux`, `nul`, `com1` through `com9`, and
`lpt1` through `lpt9`. Creation and native setup enforce the same rule, with no
escaping, case folding, aliases, or silent renaming.

**Git owns history exchange.** Transfers are ordinary non-forced pushes and
explicit fetches on `main`. Independently started devices can have unrelated
roots; the app's Sync combines them only with the person's agreement
([ADR-0532](0532-a-folder-is-the-directory-its-id-names-with-its-remote-in-git-configuration.md)).

**Remote content is the committed `main` tree.** Saved but uncommitted files,
ignored files, and files absent from the pushed commit are not on the remote.

**The remote is trusted hosting, not encrypted storage.** Files stay readable on
every device and on the server. No client folder key or encrypted Git
representation is introduced.

## Consequences

- One folder's divergence does not block another. No commit spans folders, so a
  link into a sibling folder can point at an older revision.
- Git computes ahead, behind, and divergence after a fetch. File meaning and
  schema validity still need checking after a merge.
- Full clones carry the whole history, so a growing binary history, such as
  Whispering's audio, grows every clone. ADR-0521 moves such files to Git LFS.

## Considered alternatives

- **One account-wide repository, or one per application.** Both couple
  datasets beyond the directory boundary, and applications and datasets do not
  map one to one.
- **Encrypt every folder and Git blob on the client.** Server-recoverable keys
  keep operator trust while adding unlock, merge, and recovery obligations.
- **A per-path version service with optional local Git.** It allows paths to
  transfer during another path's conflict, at the cost of version baselines,
  deletion tombstones, and transfer bookkeeping.
