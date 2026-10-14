# 0489. Folder transfers happen only when a person syncs

- **Status:** Proposed
- **Date:** 2026-10-02
- **Relates:** [ADR-0521](0521-a-folder-syncs-over-plain-git-with-a-token-to-a-server-the-person-chooses.md) chooses the server and the credential; [ADR-0532](0532-a-folder-is-the-directory-its-id-names-with-its-remote-in-git-configuration.md) sets the remote and combines histories on Connect; [ADR-0529](0529-commits-happen-only-on-sync-or-when-a-person-saves-a-version.md) decides when commits happen; [ADR-0516](0516-the-sync-review-is-modal-and-its-choices-live-only-while-it-shows.md) is the review a conflict opens.
- **Unbuilt:** refreshing only the views an incoming change touched; until then an app reloads after incoming changes.

## Context

This record used to also choose where a folder lived from the signed-in
account (`~/Epicenter/accounts/<account-key>/<folder-id>/`), download an
account's folder into a staging directory before opening it, and discover a
folder's repository through a server-side pairing.
[ADR-0532](0532-a-folder-is-the-directory-its-id-names-with-its-remote-in-git-configuration.md)
removed the account from a folder's address, and Connect into an empty folder
takes the remote's history in place of a download.
[ADR-0521](0521-a-folder-syncs-over-plain-git-with-a-token-to-a-server-the-person-chooses.md)
replaced pairings with the folder's own `remote.origin.url`. What remains is
when transfers happen and what one Sync does.

## Decision

**A folder transfers content only when a person syncs.** Signing in, opening,
saving, and recording a version transfer nothing. A configured remote never
turns on automatic pushing. There is no enrollment, background retry, or
second synchronization baseline beside Git's own refs.

**One Sync saves, records, fetches, combines, and pushes, in that order.**

```text
Sync
  -> pause new edits and finish saving input
  -> commit portable authored changes (ADR-0529)
  -> fetch origin
  -> fast-forward, or merge (an unrelated history only with the person's agreement, ADR-0532)
       -> conflict: keep both versions and open the review (ADR-0516)
       -> clean: push the result
  -> refresh what the incoming change touched
```

- If saving or committing fails, Sync stops before taking anything in, and the
  editor stays usable.
- A push rejected because another device advanced the remote keeps local
  history and reports that another Sync is needed. Nothing retries on its own.
- Saved, recorded, and uploaded outcomes are reported separately. When
  incoming files changed and the push then failed, the app refreshes those
  files and reports the failed upload.
- Incoming files never overwrite ignored or untracked local files.
- A clean Git merge is not proof the application data is valid; a merge can
  keep duplicate items or produce data the schema rejects.

**A reload is an allowed refresh boundary.** An upload with no incoming change
reloads nothing. After incoming changes, an app may reload the open item's
editor, the list, or the whole page. Saved content survives; cursor, selection,
and undo history need not. Edits pause while Sync saves and takes changes in,
so a reload cannot drop input typed in between.

## Consequences

- An unpushed commit stays on its device until the next Sync. A configured
  remote says where a folder syncs, not that it has.
- Each folder syncs on its own: one folder's conflict does not stop another.
- An app with no Sync control never touches the network for its folder.

## Considered alternatives

- **Push after every automatic commit.** Fewer forgotten pushes, at the cost of
  enrollment, retry, cancellation, and a policy for restored copies.
- **Download before the first opening.** It made the remote a prerequisite for
  local editing; Connect into an empty folder now takes the remote's history.
- **A local registry of destinations beside `remote.origin.url`.** A second
  record of what Git configuration already says.
