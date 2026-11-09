# 0619. Repository data has one content history in Git

- **Status:** Accepted
- **Date:** 2026-10-19
- **Amends:** [ADR-0592](0592-a-folders-gitignore-decides-what-stays-on-one-machine.md) at "Every repository Epicenter creates or clones gets `info/attributes` unsetting each attribute that changes bytes before anything is checked out": Epicenter writes no `info/attributes`.
- **Amended by:** [ADR-0628](0628-browser-sync-uses-transactions-and-git-updates-instead-of-cross-tab-ownership.md) at the exhaustive browser inventory: Git boundary metadata and a local publication revision are allowed operational bookkeeping, not another record of content or history. [ADR-0634](0634-hosted-inference-is-independent-of-repository-sync.md) at scope: the four-kind inventory governs repository data, not hosted inference usage and billing records.
- **Amended by:** [ADR-0700](0700-apps-share-data-through-a-file-contract-recorded-in-git.md) at the browser's unsent-edit map and publication bookkeeping: a browser holds only its own files and capture sidecars.
- **Relates:** [ADR-0611](0611-epicenter-is-only-the-data-layer-its-apps-reach-over-git.md) (the Git service, the CLI, and the library), [ADR-0612](0612-a-repository-is-shared-by-the-people-on-its-access-list.md) (the access list), [ADR-0623](0623-every-browser-app-keeps-its-own-git-clone-of-a-repository.md) (what a browser clone holds).
- **Unbuilt:** all of it: the deletion of `refs/epicenter/publishing`, `refs/epicenter/builds`, and `neutralizeAttributes`; and an `epicenter sync` that recovers an interrupted checkout on disk from the working files and Git alone.

Retired source files below use their last tracked Git snapshot (`commit:path`);
inspect one with `git show commit:path`.

## Context

Epicenter keeps state Git cannot read. Sync points
`refs/epicenter/publishing` at a commit naming the two sides of a publish it
has begun, and the next commit finishes that publish before recording
anything
([ADR-0576](0576-a-folder-has-one-write-a-merge-by-unit-where-the-writer-acting-wins.md);
`c87a47f8783f:packages/folder/src/git/backend.ts`,
`9d13dd25854e:packages/folder/src/git/browser-backend.ts`). The installed-app layout
names each build's tree `refs/epicenter/builds/<commit>`
(`f16c69134b49:packages/cli/src/installed-apps.ts`). Every repository Epicenter creates
or clones gets a line in `info/attributes` that unsets each attribute that
changes bytes (`neutralizeAttributes`,
`c87a47f8783f:packages/folder/src/git/neutral-attributes.ts`;
[ADR-0592](0592-a-folders-gitignore-decides-what-stays-on-one-machine.md)).
Plain `git` either ignores each of these or behaves differently because of
it, so a repository Epicenter touched is not the repository a person sees
with Git.

## Decision

**Repository content has one committed history: Git.**
Locally saved changes newer than a commit remain working content. On disk
that content is working files; in the browser it is the durable unsent-edit
map. Neither is a second edit history or a disposable cache.

| State | Meaning |
| --- | --- |
| Git objects and refs | Commits, trees, blobs, and the pointers selecting retained snapshots |
| Working content | Acknowledged local text or deletions awaiting incorporation into commits |
| Operational metadata | Revision checks, retained-history boundaries, and sync bookkeeping under ADR-0628 |
| Access records | Hosted repository membership, grants, and token records |
| Cache | Derived data that can be rebuilt without losing saved or unsent content |

**Operational bookkeeping does not introduce another content authority.**
The browser stores enough information to publish atomically and settle
uncertain pushes. Collection retains the snapshots that still own content.
A pending commit and unsent edits cannot be discarded on the assumption
that the server can restore them.

**Device credentials and hosted inference accounting have separate lifetimes.**
Provider keys and device tokens stay outside synchronized data. Inference
usage and billing records follow ADR-0634; they are not forced into Git
merely because repository content uses Git.

**Epicenter writes no private Git history or attributes for app publication.**
The old publishing/build refs and attribute neutralization are retired.
Ordinary repository attributes apply to native Git checkouts. Recovery of
an interrupted disk checkout still needs implementation evidence; it is not
solved by calling its state a cache.

## Consequences

- A query projection can be rebuilt. An unsent edit might hold the only
  copy of a successful save.
- A browser snapshot need not retain all parent history, but sync can
  fetch ancestry when required under ADR-0628.
- Copying ordinary Git history preserves its commits; copying a live
  client's complete saved state also requires its working content.
