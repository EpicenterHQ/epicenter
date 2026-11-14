# 0747. Git runs only as Git, on the desktop

<!-- doc-path-check: ignore-file (cites the waiting folder sync product (ADR-0840), kept at tag folder-sync-product) -->

- **Status:** Accepted (2026-11-04)
- **Date:** 2026-11-04
- **Amended by:** [ADR-0751](0751-every-native-app-carries-one-sync-core.md) at "the `git` and `git-lfs` programs, run by `epicenter sync`": a round runs in a sync core linked into each native app, over libgit2, and leaves a repository stock `git` reads; the three refusals stand.
- **Relates:** [ADR-0623](0623-every-browser-app-keeps-its-own-git-clone-of-a-repository.md) (the browser Git clone), [ADR-0700](0700-apps-share-data-through-a-file-contract-recorded-in-git.md) (which retired it), [ADR-0337](0337-the-folder-is-a-working-copy-and-pull-and-push-are-the-whole-cycle.md) and [ADR-0418](0418-push-translates-file-differences-into-ordinary-edits.md) (a Markdown working copy of a Yjs store), [ADR-0450](0450-current-files-own-portable-document-data.md) and [ADR-0534](0534-data-folders-are-the-only-data-model.md) (files own the data), [ADR-0744](0744-sync-diffs-state-because-agents-edit-state.md) (sync diffs state), [ADR-0746](0746-the-web-is-online-offline-needs-an-installed-app.md) (the web is online), [ADR-0748](0748-epicenter-ships-a-portable-git-inside-the-app.md) (the Git the app ships).

## Context

Three designs keep coming back. Each was tried or tested and refused, and
the reasons are spread across records or held nowhere in the tree.

**Desktop sync through the server's write path.** The desktop would send
each changed item to `POST <repo>.git/epicenter/writes`, as the online web
variant does, instead of running Git. A stress test of the move on
2026-11-04 found it would lose a device's offline history and each device's
own committed version. The write path also lacks what a syncing client needs
(`packages/server/src/routes/files.ts`):

| A syncing client needs | The write path has |
| --- | --- |
| the changes since a commit | `head`, `files?root=` listing every file under a root, and `file?path=` |
| a result per item | outcomes only when every file lands; one refused file refuses the request with 409 |
| a check that a write landed | none: it keeps nothing about a request, and a device that lost the reply resends |
| bulk download | one file per request |

**A Git engine in TypeScript.** Each web origin kept an isomorphic-git clone
in the browser
([ADR-0623](0623-every-browser-app-keeps-its-own-git-clone-of-a-repository.md)).
[ADR-0700](0700-apps-share-data-through-a-file-contract-recorded-in-git.md)
retired it for four reasons: two writers of history per person, binary files
with no path into the repository, a browser copy of every repository it
touched, and stock `git`, `git-lfs`, and agents unable to take part. No
package depends on `isomorphic-git` now.

**A Yjs authority with a Markdown working copy.** The folder was a working
copy of a Yjs store, with pull and push as the whole cycle
([ADR-0337](0337-the-folder-is-a-working-copy-and-pull-and-push-are-the-whole-cycle.md)),
and push translated file differences into CRDT edits
([ADR-0418](0418-push-translates-file-differences-into-ordinary-edits.md)).
[ADR-0450](0450-current-files-own-portable-document-data.md) set out that
current files own the data and that a file must not become a temporary
representation imported into another authority.
[ADR-0534](0534-data-folders-are-the-only-data-model.md) made data folders
the only data model and removed the Yjs store.

## Decision

**On the desktop, Epicenter syncs by running Git itself:** the `git` and
`git-lfs` programs, run by `epicenter sync`.

| Refused | Tried in | Retired by |
| --- | --- | --- |
| desktop sync through the server's write path | the 2026-11-04 stress test | ADR-0747 |
| a Git engine in TypeScript, in the browser or on the desktop | ADR-0623 | ADR-0700 |
| a Yjs document as the authority for what a folder holds, with Markdown as its working copy | ADR-0337, ADR-0418 | ADR-0450, ADR-0534 |

**The web reaches a repository only through the server, online**
([ADR-0746](0746-the-web-is-online-offline-needs-an-installed-app.md)).

A proposal to bring one of these back starts from the reasons above and
names what has changed since.

## Consequences

- Every desktop sync is a stock Git operation that a person or an agent can
  inspect and repeat with `git`.
- The desktop needs Git; the app carries it
  ([ADR-0748](0748-epicenter-ships-a-portable-git-inside-the-app.md)).
- The write path stays small: one commit per request, with no change lists,
  receipts, or bulk transfer for syncing clients.
- Kept data is never a CRDT, so agents edit items as files
  ([ADR-0742](0742-items-are-what-you-keep-documents-are-whats-live.md)).

## Considered alternatives

- **Leave the reasons in the records that retired each design.** They are
  spread across four records, and the stress test's findings were in no
  record at all.
