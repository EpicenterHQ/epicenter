# 0690. Merges happen only where history records the common ancestor

- **Status:** Proposed
- **Date:** 2026-10-27
- **Amends:** [ADR-0622](0622-a-losing-edit-stays-a-parent-of-the-merge-commit.md) at its `a save` role: a local save no longer merges; the sync role is unchanged.
- **Relates:** [ADR-0689](0689-an-edit-shows-what-you-typed-the-queue-carries-it-the-folder-shows-what-landed.md) for the local write queue; [ADR-0534](0534-data-folders-are-the-only-data-model.md) for folders as the only data model; [ADR-0529](0529-commits-happen-only-on-sync-or-when-a-person-saves-a-version.md) and [ADR-0530](0530-applications-record-a-version-at-natural-moments.md) for when commits happen.
- **Unbuilt:** no app commits automatically or turns on sync; no merge notice reaches an editor; no live body session or capture-only client exists; browser sync does not yet honor `.gitignore` patterns.

## Context

> **Epicenter keeps your whole life's writing in one place, as plain text you own.** Journals, notes, transcripts and contacts live as readable files that open in the browser and on the desktop, survive any app, and keep their history. Apps are views over those files; agents edit the same files; indexes such as SQLite are rebuilt from them. Collaboration, if it comes, is a session layered on top, never the place your data lives.

Before this record, two merge designs were tried and removed. The Yjs store
was the authority and Markdown files were a read-only projection of it
(removed in commit `9f75a9bd51`); agents edit files, so every file edit needed a
custom import back into Yjs. A local based-write merge then had each whole-file
write in `packages/folder/src/folder.ts` carry the text it was based on and
three-way merge at its queue turn (removed in commit `9d1611c67f`). Its base was
inferred from editor state, and every review round found a new way for that
inference to drop or duplicate typed text.

Writers reach one person's files at three distances in time. On one device,
the app's editors, other tabs, and agents write milliseconds apart through or
beside one Folder queue. Across that person's devices (desktop folder, browser
replica, phone replica), edits diverge for minutes or days while offline.
People typing in one note together would diverge continuously. Only the second
case has a recorded common ancestor: the last commit both replicas share.

## Decision

**A merge runs only where history records the common ancestor.** Each distance
has one rule, and every rule uses the same units: a frontmatter field, the
body, a whole file.

```txt
distance            writers                       rule                                  base
one device          editors, tabs, agents         last write wins per unit              none
across devices      desktop, browser, phone       three-way merge per file at sync      the last shared commit
together, live      people in one note            a session over the body (Unbuilt)     the session
```

**On one device, the later write wins per unit.** `Folder.update(path, { fields })`
sets those fields on the file as storage holds it at its turn;
`Folder.update(path, { body })` sets the body and keeps every field from
storage; `Folder.replace(path, data)` replaces an existing file and answers
`NothingToUpdate` when it is gone; `Folder.write(path, data)` creates or
replaces. Updates are checked and answer `WriteRefusal.KeptChanging` after three
changed attempts. `absorb` in `packages/folder/src/folder.ts` folds a waiting
write into a newer one of the same kind for the same path; create, delete, and
move keep their order. No local write merges text.

**Across devices, sync three-way merges against the last shared commit.** A
commit happens when sync checkpoints or a person saves a version (ADR-0529),
at the natural moments ADR-0530 names; sync then exchanges commits with a Git
remote: Epicenter's hosted Git at
`git.epicenter.so/<namespace>/<name>.git` (`mountGitHost` in
`apps/api/worker/index.ts`, stored by `apps/api/worker/git-repositories.ts`) or a
server the person chooses. `merge` in `packages/folder/src/shared/merge.ts`
merges frontmatter by field and the body by line; where both sides changed the
same field or line, the edit that reaches `main` last wins and the losing edit
stays a parent of the merge commit (ADR-0622). History keeps
every committed state, so a value replaced on any device stays recoverable.

**A live collaboration layer is a session over the body only.** It persists
through `Folder.update(path, { body })` like any editor. Fields are never
collaborative. No layer writes files except through the Folder.

**Every device holds a full replica; the hosted remote is the durable copy.**
The desktop folder is a directory; the browser replica is the Git working tree
in `packages/folder/src/browser/` ([ADR-0650](0650-a-browsers-current-folder-is-one-immutable-tree.md)), whose storage the browser may
evict. A client that only adds entries may append through the remote instead
of holding a replica. Agents edit desktop files directly or issue the same
Folder instructions through `epicenter`; browser data reaches them through sync.

**Device-only data is whatever the area's `.gitignore` names.** Apps never ask
the host for a path; an app lists device-only patterns in its area's
`.gitignore`, like any other file, and a person or agent may edit them. Desktop
Git leaves ignored paths out of commits under
[ADR-0592](0592-a-folders-gitignore-decides-what-stays-on-one-machine.md);
browser sync leaves the same paths out of what it sends.

## Consequences

The local write path holds no merge state: no inferred bases, no failure
chains, and no editor identity. A concurrent change to the same unit within one
device is replaced by the later write; it survives only in history, and only if
a commit captured it first. The window is the change-notice delay, typically
tens of milliseconds on desktop.

Sync becomes the one place conflicts are reconciled, by the same units the
editors use, and the one place a person is told about them (an overridden
region). Automatic commits make the commit cadence the recovery granularity:
text that lived less than one quiet period between overwrites cannot be
recovered.

The hosted remote is a Git repository behind a serverless Worker, so no machine
of the person's runs continuously. It stores plain text without end-to-end
encryption. A browser replica can be evicted and rebuilt from the remote.

Real-time co-editing of fields, merging of local whole-file writes, and a
CRDT as the source of truth are foreclosed; a body session is the only
collaboration layer this permits.

## Considered alternatives

- **Yjs as the authority, files projected from it.** Agents write files, so each
  edit needs a Markdown and YAML import back into the document.
- **Local three-way merge of based writes.** The base must be inferred from
  editor state; retries, failures, and unconfirmed puts each broke it.
- **A CRDT per open file over plain files.** Every disk change must be diffed
  back into the CRDT, which is the local merge again, run continuously.
- **Thin clients linked to a home device.** The home device must stay on, or a
  relay must stand in for it.
