# 0744. Sync diffs state, because agents edit state

- **Status:** Accepted (2026-11-04)
- **Date:** 2026-11-04
- **Relates:** [ADR-0700](0700-apps-share-data-through-a-file-contract-recorded-in-git.md) (desktop sync and the server's write path), [ADR-0734](0734-every-file-other-than-a-note-is-kept-whole-in-git-lfs.md) (one merge rule), [ADR-0735](0735-sync-gives-files-a-history-it-never-merges-two.md) (the first sync), [ADR-0702](0702-a-data-folders-unfinished-writes-wait-in-epicenter-outside-its-data.md) (unfinished writes), [ADR-0327](0327-undelivered-work-is-an-outbox-and-that-is-where-a-failure-appears.md) (Local Mail's outbox to Gmail), [ADR-0747](0747-git-runs-only-as-git-on-the-desktop.md) (Git runs only as Git).
- **Amended by:** [ADR-0787](0787-records-that-assumed-a-running-engine-or-a-build-time-choice-follow-0750-and-0781.md) at the server settling a write against `main`: the page settles, and the server refuses a stale base.
- **Unbuilt:** on the web, each item's last agreed version kept as a cache, which exists only if a browser ever syncs offline ([ADR-0746](0746-the-web-is-online-offline-needs-an-installed-app.md) defers that).

## Context

A device knows what it has not sent in one of two ways. It records each
operation as it happens, in an outbox or event log, and sends the log. Or it
compares its current state with the last state both sides agreed on, and
sends the difference.

Epicenter has built the first kind and removed it. Row sync sent sealed
`RowIntent` rounds ([ADR-0131](0131-row-sync-folds-sealed-row-intent-rounds-without-refusal.md)).
The web's uploader kept an outbox with sidecars until
[ADR-0700](0700-apps-share-data-through-a-file-contract-recorded-in-git.md)
deleted it.

The second kind is what runs now. On the desktop, `epicenter sync` stages the
folder with `git add -A`, commits, fetches, and merges against the remote
`main` it last saw, `refs/epicenter/last-seen`
(`packages/cli/src/sync/sync.ts`). On the web, each file in a write to
`POST <repo>.git/epicenter/writes` carries `base`, the Git blob id the writer
read, and the server settles it against `main`
(`packages/server/src/routes/files.ts`). Both merge a note with `settle`
(`packages/definition/src/merge/settle.ts`): the translator calls it
directly, and Git calls it through `epicenter merge-driver`
(`packages/cli/src/sync/merge-driver.ts`).

People and agents edit an Epicenter folder with tools that record no
operations: an editor, `sed`, `git checkout`, a script. A log sees only the
writes made through Epicenter's own code.

## Decision

**Epicenter keeps no event log or outbox of operations for its data.** What
is unsent is derived: the difference between the current files and the last
version both sides agreed on.

| Where | Current state | Last agreed version |
| --- | --- | --- |
| Desktop | the folder's working tree and its commits | the remote `main` this clone last saw, at `refs/epicenter/last-seen` |
| Web, if a browser ever syncs offline | the browser's items | each item's last agreed Git blob id, kept as a cache |

**One model and one merge function, over two transports.** The model is
files as state and the last agreed version as the base. `settle(base,
current, incoming)` merges a note, and every other file is kept whole
([ADR-0734](0734-every-file-other-than-a-note-is-kept-whole-in-git-lfs.md)).
The transports are Git on the desktop (`epicenter sync`) and the server's
write path on the web.

**An edit applies to the files when it is made.** Sync reconciles files that
already hold every edit; nothing waits for sync to reach the files.

## Consequences

- An edit made by any tool syncs like an app's own edit, and nothing has to
  record it.
- Unsent work survives a crash with no extra state: it is the files.
- Sync carries states, not intents. "Add one" made on two devices is two
  edits to one field, which `settle` resolves by key, the later arrival
  winning. An app that counts keeps one item per event, as Whispering keeps
  one item per recording.
- `git log -p` shows what changed, not which action changed it.
- Two things that look like outboxes are outside the rule. Writes to a
  foreign authority, such as Local Mail's label changes for Gmail
  ([ADR-0318](0318-epicenter-data-is-what-epicenter-is-the-authority-for-and-a-foreign-write-is-a-command.md),
  ADR-0327), are commands an app delivers. A part in a folder's
  `.epicenter/` is one unfinished local write that finishes at its path or
  is removed (ADR-0702); sync never reads it.

## Considered alternatives

- **An operation log or outbox.** Sees only writes made through Epicenter's
  code; an agent's `sed` is invisible to it. Built and deleted once
  (ADR-0700's uploader).
- **Intents applied to files only after the server orders them
  (ADR-0131).** Files would lag their truth until sync, and offline a
  person's own edits would be missing from the files agents read.
- **A CRDT for every item.** The Yjs store
  [ADR-0534](0534-data-folders-are-the-only-data-model.md) removed.
