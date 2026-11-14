# 0771. Plain files let Epicenter refuse renames, attachment conflict copies, and a second store

- **Status:** Superseded
- **Date:** 2026-11-05
- **Superseded by:** [ADR-0899](0899-the-folder-sync-product-is-retired.md): the folder sync product is retired, and this record is its history.
- **Amends:** [ADR-0612](0612-a-repository-is-shared-by-the-people-on-its-access-list.md) at "a repository's name changes freely": a repository is never renamed; [ADR-0734](0734-every-file-other-than-a-note-is-kept-whole-in-git-lfs.md) at conflict copies: when two writes to one attached file race, the later one wins; [ADR-0770](0770-teams-own-repositories-and-sharing-is-membership.md) at "clone, then push into the other team's repository" and "owners also rename": a copy is one commit of files, and owners rename a team, never a repository; [ADR-0705](0705-an-apps-data-lives-in-two-kinds-of-store.md), [ADR-0742](0742-items-are-what-you-keep-documents-are-whats-live.md), [ADR-0707](0707-an-app-that-needs-co-editing-is-a-document-app.md), [ADR-0708](0708-a-namespace-holds-documents-beside-repositories-under-one-resource-grant.md), [ADR-0709](0709-a-document-is-rebuilt-into-a-fresh-generation-by-copying-its-current-state.md), [ADR-0715](0715-the-epicenter-app-browses-every-folder-and-document-a-person-has.md), [ADR-0716](0716-agents-edit-a-document-through-one-shot-cli-commands.md), and [ADR-0739](0739-a-document-body-uses-a-standard-codec-until-an-app-needs-its-own.md) at the document store: there is one kind of store, the folder.
- **Relates:** [ADR-0735](0735-sync-gives-files-a-history-it-never-merges-two.md) (a folder's first sync adds its files as one commit), [ADR-0761](0761-sync-never-merges-two-unrelated-histories.md) (two unrelated histories never merge), [ADR-0593](0593-the-hosted-git-service-stores-data-repositories-and-offers-no-rename-or-move.md) (no rename or move, which this restores), [ADR-0700](0700-apps-share-data-through-a-file-contract-recorded-in-git.md) (an owner may replace `main`, which this keeps).
- **Unbuilt:** deleting `renameRepository`, the move, the `repository_alias` table and its lookups in `packages/server`; deleting the conflict copy for attached files in `packages/definition/src/merge/settle.ts`, `packages/server/src/routes/files.ts`, `packages/epicenter-core/src/merge.rs`, and the `conflict-copy` outcome on the wire.

## Context

Every app's data is Markdown notes and attached files in a folder, with
history in Git. A repository's current state is those files: any program
can read them, and any of them can be put into another repository as one
commit, the way a folder's first sync adds its files (ADR-0735). Several
promises were built or planned as if that were not so: renaming and moving
repositories behind aliases, a copy of a conflicting attachment beside the
winner, and a second kind of store, Yjs documents, for live co-editing. No
app edits an attachment in place, no app co-edits live, and no repository
exists outside an app.

## Decision

**Adding files to a repository is one act: one commit of the files as they
are.** A copy into another team's repository, keeping your files when you
leave a team, and starting a history fresh are all that act: put the files
into a clone of the target and sync it. Pushing one repository's history
into another is never the way, since two unrelated histories never merge
(ADR-0761).

**A repository is never renamed or moved.** Its address, `<team>/<name>`,
is fixed for its life; a different name is a copy. Owners rename a team,
whose id is in the address and whose name is only shown.

**When two writes to one attached file race, the later one wins.** The
version that lost stays in history, as a losing field value already does
(ADR-0622). No conflict copy is made beside it.

**The folder is the only kind of store.** Nothing live is stored apart from
the files. An app that needs live co-editing reopens this with a design of
its own.

**An owner may still replace `main`** (ADR-0700): a force push from a clone
rewrites the history, and other clones stop with the message ADR-0741
gives.

## Consequences

- Rename, move, aliases, and their lookups go from the server; three records
  that disagreed on renames agree.
- One merge rule fewer, built today twice (TypeScript and Rust).
- Six records about documents no longer describe anything Epicenter will
  build; the Epicenter app browses folders.
- Two devices editing one attachment at once keep only the later version in
  the folder; the other is in history.
- A person who wants another name for a repository makes a copy and loses
  its history there.
