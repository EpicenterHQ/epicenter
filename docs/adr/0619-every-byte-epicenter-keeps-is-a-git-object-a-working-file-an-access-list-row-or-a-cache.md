# 0619. Every byte Epicenter keeps is a Git object, a working file, an access-list row, or a cache

- **Status:** Accepted
- **Date:** 2026-10-19
- **Amends:** [ADR-0592](0592-a-folders-gitignore-decides-what-stays-on-one-machine.md) at "Every repository Epicenter creates or clones gets `info/attributes` unsetting each attribute that changes bytes before anything is checked out": Epicenter writes no `info/attributes`.
- **Relates:** [ADR-0611](0611-epicenter-is-only-the-data-layer-its-apps-reach-over-git.md) (the Git service, the CLI, and the library), [ADR-0612](0612-a-repository-is-shared-by-the-people-on-its-access-list.md) (the access list).
- **Unbuilt:** all of it: the deletion of `refs/epicenter/publishing`, `refs/epicenter/builds`, and `neutralizeAttributes`; and a sync that recovers an interrupted checkout from the working files and Git alone.

## Context

Epicenter keeps state Git cannot read. Sync points
`refs/epicenter/publishing` at a commit naming the two sides of a publish it
has begun, and the next commit finishes that publish before recording
anything
([ADR-0576](0576-a-folder-has-one-write-a-merge-by-unit-where-the-writer-acting-wins.md);
`packages/folder/src/git/backend.ts`,
`packages/folder/src/git/browser-backend.ts`). The installed-app layout
names each build's tree `refs/epicenter/builds/<commit>`
(`packages/cli/src/installed-apps.ts`). Every repository Epicenter creates
or clones gets a line in `info/attributes` that unsets each attribute that
changes bytes (`neutralizeAttributes`,
`packages/folder/src/git/neutral-attributes.ts`;
[ADR-0592](0592-a-folders-gitignore-decides-what-stays-on-one-machine.md)).
Plain `git` either ignores each of these or behaves differently because of
it, so a repository Epicenter touched is not the repository a person sees
with Git.

## Decision

**Every byte Epicenter keeps is one of four things:**

```txt
Git object        commits, trees, and blobs, in a clone or on the Git service
working file      a file in a clone's working tree, committed or not
access-list row   accounts, repositories, members, grants, and token rows on the Git service
cache             anything rebuilt from the three above, and lost without loss of data
```

The four kinds cover what Epicenter keeps for a repository. Credentials
held on a device, such as an access token or a bring-your-own provider key
in the keychain
([ADR-0618](0618-epicenter-hosts-no-ai-service.md)), are caches of
access-list rows or the person's own secrets, outside any repository.

**Nothing records history Git cannot read.** A client's unsent changes are
working files awaiting commit, never a second record of edits. Deleted:
`refs/epicenter/publishing`, which sync points at an unfinished publish, and
the rule that the next commit finishes that publish first;
`refs/epicenter/builds`; and `neutralizeAttributes` with the
`info/attributes` line it writes.

## Consequences

- A clone that plain `git` opens holds everything Epicenter knows about its
  history; a clone copied with ordinary tools loses nothing but caches.
- A repository's `.gitattributes` applies to Epicenter's checkouts as it
  does to Git's, so an attribute that changes bytes can make a checked-out
  file differ from its blob.
- A checkout cut off partway has no ref recording it. How the next sync
  tells such a file from an edit, from the working files and Git alone, is
  not decided.

## Considered alternatives

- **A ref naming an unfinished publish (ADR-0576).** History that plain
  Git shows as a stray ref and cannot interpret.
- **A private database of sync state beside the clone.** A second record
  that can disagree with the working files and that no other tool reads.
