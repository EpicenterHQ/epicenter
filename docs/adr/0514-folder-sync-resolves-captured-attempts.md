# 0514. Folder sync resolves captured attempts

- **Status:** Proposed
- **Date:** 2026-10-11
- **Relates:** [ADR-0516](0516-the-sync-review-is-modal-and-its-choices-live-only-while-it-shows.md) (the review that answers an attempt), [ADR-0518](0518-a-row-is-read-through-one-pipeline-and-repaired-as-text.md) (rows read through `parseRow`), [ADR-0519](0519-row-frontmatter-is-yaml-every-common-reader-reads-identically.md) (the one row writer), [ADR-0521](0521-a-folder-syncs-over-plain-git-with-a-token-to-a-server-the-person-chooses.md) (the remote a folder syncs with), [ADR-0522](0522-settings-are-independent-keys-set-one-at-a-time.md) (settings as keys), [ADR-0523](0523-applications-own-drafts-in-edit-sessions-and-leave-one-open-item.md) (open edit sessions)
- **Unbuilt:** sync in the desktop app's Rust owner (`folder.sync` answers `Unsupported` there), and sync in Vocab, Capture, Honeycrisp, and Whispering.

## Context

`folder.git` exposes each step separately: `commit()`, `fetch()`,
`pullFastForward()`, `mergeIncoming()`, and `push()`. `mergeIncoming()` merges
root `kv.json` by key (`mergeKv`) and every other path by Git's line rules.
A competing change refuses the whole merge (`MergeError.Conflicted`), or, in
manual history only, leaves conflict markers in the files. Markers in a row
file make it read as `InvalidRow`, so two devices that changed one todo's
title leave the person a text repair of the whole file.

Rows are documents now: `parseRow` reads them and `formatRow` writes the one
standard text (ADR-0518, ADR-0519). Settings are independent keys
(ADR-0522). A row merge can therefore compare decoded fields instead of
lines, and a merged row can be written by the same writer as any save.

## Decision

**`folder.sync` synchronizes with the remote through `run()` and
`resolve(attempt, choices)`, and nothing conflicted is written until the
choices arrive.**

```ts
const { data: ran, error } = await folder.sync.run();
// ran: SyncOutcome ({ kind: 'synced' | 'saved', ... }) or SyncAttempt ({ kind: 'needsChoices', ... })
const { data: done } = await folder.sync.resolve(ran, choices); // SyncOutcome
```

`run()` commits saved files, fetches the remote branch, merges it, and pushes
without force. One-sided and compatible changes merge without choices. The
merge splits a path both sides changed into units:

| Path | Unit | `kind` | Version holds |
| --- | --- | --- | --- |
| root `kv.json` | one root key | `setting` | its JSON value |
| `<table>/<stem>.md` of a declared table | one frontmatter field | `field` | its JSON value |
| the same row | the body | `body` | its text |
| any other UTF-8 text file, when lines compete | the whole file | `file` | its text |
| any of these, when a version is deleted or does not read | the whole file | `file` | its text |

- Rows merge through `parseRow` against their table. For each field, equal
  values agree and a side unchanged from the base yields; values compare as
  JSON, so key order and quoting never conflict. The body merges by line.
  Every merged row is `formatRow` text, the standard form.
- A row that does not read as a row on any side, or that one side deleted
  while the other changed it, is one `file` unit. The text the person
  chooses is written as it is; if it is not a valid row, the table reads it
  as `InvalidRow` and the app opens it for repair as text (ADR-0518).
  `kv.json` deleted on one side or not one JSON object is a `file` unit too.
- A folder whose first commit the run made adopts the remote's history
  by merging over an empty base, so a fresh copy can join a remote it did
  not clone.
- Any other text file merges by line, so a README both sides edited is one
  `file` unit only when their lines compete.
- A binary file, a link, executable, or submodule, and a file against a
  directory are `SyncError.Unreviewable`, listing every conflict. Nothing is
  written or sent; the person repairs them with Git outside the app, since
  `git merge` in the folder terminal needs manual history.

A conflict is reported as `SyncAttempt`:

```ts
type SyncAttempt = { kind: 'needsChoices'; id: string; local: string; incoming: string; conflicts: SyncConflict[] };
type SyncConflict = {
	id: string; kind: 'setting' | 'field' | 'body' | 'file'; path: string; key?: string; field?: string;
	base: SyncVersion; local: SyncVersion; incoming: SyncVersion; // { present: false } | { present: true; value }
};
type SyncChoice = { kind: 'take'; side: 'local' | 'incoming' } | { kind: 'replace'; value: unknown } | { kind: 'remove' };
type SyncChoices = Partial<Record<string, SyncChoice>>; // keyed by conflict id
```

- `take` selects what the owner captured, so a setting keeps its exact JSON
  text. Taking an absent side removes the unit. `replace` is a JSON value
  for `setting` and `field`, and a string for `body` and `file`. `remove`
  applies to every kind except `body`.
- `resolve` reads the choices once, before its first await. Every problem is
  reported at once as `SyncError.InvalidChoices`: an unanswered or unknown
  conflict, a disallowed operation, or a value the folder refuses. A
  replacement setting is refused as `kv.set` would refuse it, and a resolved
  row is refused unless it reads back through `parseRow`. Invalid choices
  write nothing and keep the attempt current.
- Valid choices spend the attempt. `resolve` merges the captured commits
  again, never fetching, with the chosen units, and publishes the two-parent
  merge through the same incoming publication as `mergeIncoming`.
- An attempt is current until the next `run()`, a `resolve` that got past
  validation, or closing. `resolve` refuses an attempt that is not current,
  a branch that moved, and saved files that changed since, as
  `SyncError.Stale`, writing nothing.
- `SyncOutcome` is `synced` only when the push confirmed the merged head and
  no save landed after the files were captured; otherwise `saved`, with the
  push's own outcome.

## Consequences

- Applications get one Sync action. Pull, merge, and commit-and-push remain
  on `folder.git`, and an app offers them only where `folder.sync.supported`
  is false.
- A conflict is never left in the files. `mergeIncoming({ conflicts: 'leave' })`,
  its published merge with markers and unmerged index stages, and the
  `MERGE_HEAD`, `MERGE_MSG`, and `ORIG_HEAD` it wrote are removed, in the
  browser, Bun, and desktop owners alike, with the staged commit that
  finished such a merge. A conflicted `git merge` in the folder terminal
  refuses in both history modes and points to Sync (`CONFLICTS_NEED_SYNC`).
  A merge another Git program began still blocks commits and incoming
  updates until it is finished with Git.
- A row both sides changed is rewritten in the standard form, even when the
  changes were compatible, as the first save of a hand-edited row already is.
- Open edit sessions are not told: an idle session adopts the new file when
  the person returns, and a session with unsaved input meets the existing
  `Conflict` prompt at its next save (ADR-0523).
- Binary conflicts still need Git outside the app.
- `prepareMerge` offers each path both sides changed to an optional
  `mergePath` (`syncMerge` in `packages/folder/src/git/sync.ts`); a second
  `syncMerge` given the chosen text merges the same commits again.
  `mergeIncoming` passes none and behaves as before.

## Considered alternatives

- **Source-preserving Markdown merge.** Merged frontmatter by transplanting
  YAML source, kept comments and quoting, refused aliases and reordering as
  `Unreviewable`, and took replacements as one-line YAML flow values. It was
  748 lines beside the one row parser, and it is unnecessary once every row
  is written by `formatRow`.
- **Replacement as source text in a grammar per unit.** Callers would encode
  JSON and YAML by hand; with one writer, a value is enough.
- **Keep leaving markers in the files, as `mergeIncoming({ conflicts: 'leave' })`
  did.** Writes conflicted candidates into files apps read, needs manual
  history, and kept a second merge-state machine in three owners (about
  5,700 lines removed with its tests, Rust included) for what Sync now
  settles.
- **Fetch again inside `resolve`.** Changes the inputs the person reviewed.
- **Whole-file choices only.** A person settling one title would discard the
  other side's independent field changes.

## Verification

`packages/folder/src/row-merge.test.ts` covers independent field and body
changes, spelling that is not a change, two edits of one field, a removed
field against a changed one, competing body lines, added rows with no base,
and deleted or unreadable versions. `packages/folder/src/sync.test.ts` runs a
browser folder against `git http-backend` and covers merges without
choices in the standard form, captured units with nothing written or sent,
settled units with the captured commits as parents, a deleted row and an
invalid row as whole files, every kind of invalid choice, stale attempts,
a text file outside a table merged by line or held whole, and an
unreviewable binary conflict. `packages/folder/src/git/merge-lines.test.ts`
pins that a line merge keeps lone carriage returns, U+2028, and U+2029. `apps/todos/src/lib/sync.test.ts` covers
the open item afterwards.
