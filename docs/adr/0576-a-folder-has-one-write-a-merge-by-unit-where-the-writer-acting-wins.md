# 0576. A folder has one write: a merge by unit where the writer acting wins

- **Status:** Proposed
- **Date:** 2026-10-16
- **Supersedes:** [ADR-0554](0554-a-field-edit-sets-fields-on-the-file-as-it-is-now.md) (a field edit as its own verb, `table.update`)
- **Amends:** [ADR-0548](0548-a-view-is-a-cache-of-files-with-one-write-path-one-read-path-and-one-channel-of-change.md), withdrawing "Sync: decided by the person": an overlap in Sync is decided by the device syncing. That files are the truth, with one read path and one channel of change, remains.
- **Amends:** [ADR-0551](0551-every-write-to-a-folder-file-is-one-save-that-merges-by-the-files-kind-and-sync-settles-with-the-same-merge.md), replacing `mergeFile`'s settle and pick with one merge that returns `{ content, overridden }`, adding a union for insertions at one place, and giving Save and Sync the same tiebreaker. That every write merges by the file's kind remains.
- **Relates:** [ADR-0503](0503-file-authoritative-workflows-preserve-information-and-tolerate-repairable-states.md), [ADR-0529](0529-commits-happen-only-on-sync-or-when-a-person-saves-a-version.md), [ADR-0566](0566-plain-git-merges-an-epicenter-folders-files-by-kind-through-a-merge-driver-every-connect-and-clone-configures.md), [ADR-0572](0572-a-row-body-is-read-and-written-with-line-feeds-and-storable-text.md), [ADR-0575](0575-a-control-binds-one-part-of-a-row-fields-are-patched-and-the-body-is-opened.md)
- **Replaces, as Proposed records:** ADR-0514 and ADR-0516 (Sync's captured attempts, choices, and review) and ADR-0522 (settings as `kv.json` keys). Each carries a note pointing here and is deleted when this is built.
- **Unbuilt:** Sync and the merge driver on `merge`; the `settings` table and deleting `kv.json`'s machinery.

## Context

A folder is written through many verbs: `table.create` (refused as `Exists`),
`table.save`, `table.update`, `table.setBody` with its frontmatter splice and
`ifUnchanged`, the guarded `table.delete` and `table.rename`, `kv.set`, and
`files.save`. Each has its own error union. `mergeFile` returns competing
units and a `settle(pick)` that each caller drives. Sync stops when units
compete: `run()` answers `NeedsChoices` with a `SyncAttempt`, the page shows
`sync-review.svelte`, and `resolve(attempt, choices)` finishes it, with
`InvalidChoices`, `Stale`, and held paths around it. Settings live in a
second model, `kv.json`, with `folder.kv`, `kv-merge.ts`, a `kv.json` special
case in `git/merge.ts`, and a `kv` section in every declaration. Concurrent
insertions at one place compete in `mergeLines`, so one of two appended
sections is lost. `createBodyEditor`'s draft carries a revision counter and
re-merges typed text after a save that merged.

Checked before this record was written:

- **Sync publishes differently per host.** The desktop
  (`git/native-backend.ts`, `publishIncoming`) applies the planned changes,
  each with its own file condition, then the index, then the branch. The
  browser (`git/opfs-git.ts`, `publish`) first requires the whole folder
  unchanged under its files lock (every file's hash, the index, and the
  branch) and refuses, writing nothing, when anything moved. Neither
  publishes each file through the write a page uses.
- **Nothing outside the engine reads `kv.json` at runtime.** Rust names it
  only in tests, as an ordinary path. The CLI reads it through the engine:
  `check` and `query` through `readFolder`, and the merge driver through
  `mergeFile`. Whispering reads an earlier build's endpoint from it and never
  writes it; Honeycrisp's first open writes a default `{}`.
- **The draft's revision counter and re-merge are not load-bearing once its
  base advances to what a save sent.** The counter answers whether typing
  happened during a save, which comparing the typed text with the sent text
  also answers. The re-merge exists because the base advances to what the
  file holds, which can include another writer's lines the typed text lacks.
  A base that advances to the sent text lets the next write merge them in.
  The base must still advance: kept at the first keystroke, a later edit of
  text already saved would be a second insertion at one place, and the union
  would keep both versions.

## Decision

**A folder is Markdown files and Git.** A table is a directory of rows, a row
is frontmatter keys and a body, and settings are rows too.

**There is one write: `folder.write(path, from, to)`.** It reads the file as
it is now and merges the change from `from` to `to` into it, by unit:

| File | Unit |
| --- | --- |
| a row, `<table>/<stem>.md` | one frontmatter key; one region of body lines |
| other UTF-8 text | one region of lines |
| binary, or a side absent | the whole file |

- Units only one side changed all survive.
- On a unit both changed differently, the writer acting wins.
- Two insertions at the same place both survive, the other side's first,
  then the writer's. Two identical insertions are one, and where one holds
  the other at its start or end, the longer stands alone, so an insertion
  sent again after it landed is not doubled.
- Lines compare without their line feeds, so appending to text that ends
  without one is an insertion. A result ends with a line feed as the version
  its last line came from ends.
- A delete beats an edit it never saw. Whether a file exists is decided by
  the delete; what it holds, by the writer acting. Only a write from no file
  (`from` of `null`, a create) brings a file into existence: an edit of a
  file deleted since its `from` writes nothing and answers that no file is
  there, which is not a failure to retry. The writer's delete removes an
  edit it never saw, too.
- A version that does not read as its kind merges as text. A result that
  does not read is left for repair (ADR-0503).
- Every write parses, merges, and formats canonically. A row's frontmatter is
  always written in the standard form; there is no splice.
- `from` is content, or `null` for no file, and is always given. A delete
  needs no base: the deleter wins whatever `from` is, which only names the
  file as overridden when it differs from what was there.
- Any `to` is written, whether or not it reads as its kind; a typed view
  refuses a row it cannot write before it calls the write.
- The write reads, merges, and puts guarded by the hash it read, again on a
  lost race, at most `WRITE_ATTEMPTS` times. Storage is `read` and
  `put(path, bytes | null, ifMatch)`, where `ifMatch` is the SHA-256 the path
  must hold or `null` for no file, answering `'landed'` or `'stale'`.
- Every failure is one `WriteError`: `KeptChanging`, `InvalidValues`, `Io`,
  `Closed`, or `InvalidPath`.

The merge is `merge(kind, { base, ours, theirs })`, with `ours` the writer
acting. It returns `{ content, overridden }`: the file, `null` for none, and
each unit where the writer replaced another writer's change. A unit is named,
never its losing content, which stays in whatever version held it:

```ts
type Overridden =
  | { kind: 'field'; field: string }
  | { kind: 'setting'; key: string } // until settings are a table
  | { kind: 'lines'; part: 'body' | 'text'; line: number; count: number }
  | { kind: 'file'; lost: 'ours' | 'theirs' };
```

`line` is where the writer's `count` lines stand in the result, 1-based
within the body or the file. `file` names the side whose edit of the whole
file did not stand: the other's under the writer acting, or either side's
under a delete. A write logs what it overrode; Sync's commit message lists
it.

**A table is a typed view.** It is a codec over `<table>/<stem>.md` with
`get(stem)`, `list()`, and `write(stem, from, to)`. Helpers build the change
and call the one write:

| Helper | `from` |
| --- | --- |
| `set(stem, fields)` | the file as it is now; a row that is not there is not made |
| `create(row)` | no file, at a new stem |
| `delete(stem)` | none; the deleter wins |
| `rename(stem, next)` | its bytes put at `next` only where nothing is, then `stem` removed only while it holds them |
| the body editor | the row at the first keystroke, then what each save sent |

`files.move` stays for large binary files.

**The query layer offers one mutation per helper.**
`folder.<table>.get(stem)` and `.list()` give `queryOptions()`, and
`.set`, `.create`, `.rename`, `.delete`, and the body editor's `.write` give
`mutationOptions()`. There is no mutation shared across controls, so each
control owns its pending and error state.
A query is named for its data and a mutation for its verb and noun:

```ts
const todo = createQuery(() => folder.todos.get.queryOptions(stem));
const setTodo = createMutation(() => folder.todos.set.mutationOptions());
const deleteTodo = createMutation(() => folder.todos.delete.mutationOptions());
```

A delete is never named `remove`.

**What writes a folder:** a click (`set`), a typed body (the body editor), a
create, a delete, a Sync, and `git pull` through the merge driver.

**Sync never stops for a person.** Save and Sync merge the same units with the
same tiebreaker: the device syncing is the writer acting, and its side wins
every unit both changed. The merge commit's message lists each unit it
overrode, and the losing side stays reachable as the merge's other parent.
Sync publishes each changed file with the same `merge` and `put`, on every
host. The device's side of that publish is its file as it is at the put, not
the merge Sync computed, so text typed while Sync runs, which no commit
holds, wins over what arrived. A delete wins over an edit the deleting side
never saw; the edit stays in the other parent, and the merge commit lists it
as overridden.

**Epicenter owns how a file merges; Git owns how histories merge.** There is
one merge driver, `epicenter merge-driver` (`merge-driver.ts`), which is this
merge exposed to Git, in two modes. Under Epicenter's Sync
(`EPICENTER_SYNC=1`), the writer acting wins competing units, and the driver
writes the units it overrode to a file Sync names, for the merge commit's
message. Run by hand, it keeps Git's conflicts, below. The desktop's Sync
merges histories with `git merge-tree --write-tree` under Sync's mode, which
writes no working file; the browser's with isomorphic-git's `merge` given the
same merge as its driver. Git's merge reports some conflicts outside any one file's content, without
calling the driver, and Sync settles each without stopping, listing what lost
as overridden:

| Git's conflict | Sync keeps |
| --- | --- |
| a modify against a delete, or a rename against a delete | no file: the delete beats an edit it never saw |
| one file renamed to two names | the device's name: the writer acting |
| a file against a directory at one path | the directory, and the file beside it under the name Git gives it, to repair |

Then each changed file is published by a loop of `merge` and `put` in Sync:
`merge(kind, { base: committed, ours: liveFile, theirs: merged })`, put
guarded by the live file's hash and done again when it is stale. The device's
file as it is at the put is the writer acting, so text typed while Sync runs
stands. The merge commit is made with both parents. Epicenter's own history merge goes, with its merge bases,
its tree walk, and its refusal of a criss-cross history.

**Plain Git keeps its conflicts.** The merge driver that `git merge`, `git
pull`, `git rebase`, `git cherry-pick`, and `git stash pop` run uses the same
`merge`: units only one side changed merge by field or line, and insertions
at one place are a union. Where both sides replaced one unit differently, it
writes Git's conflict markers and exits non-zero, so Git stops. In a rebase
or a stash pop, Git's `ours` is not the local work, so "the writer acting
wins" would silently drop replayed commits or stashed edits. Only Epicenter's
Sync, which never runs `git merge`, applies the writer acting. A file with
markers shows as one to repair.

**`createBodyEditor` holds `from`, `typed`, and one write.** The first change
takes the row as the cache holds it as `from`. A save that lands with nothing
typed since clears both. A save that lands while typing continued makes `from`
the text it sent. A failed save keeps both. A save that finds the row deleted
writes nothing and keeps what is typed, which the control offers until the
person copies or discards it (`gone`). Saves of one file run one at a
time (`inTurn`). It has no revision counter, no re-merge, and no `onSaved`.

**Settings are a declared `settings` table.** Its fields are all optional, and
its stems are named by concern, such as `settings/display.md` and
`settings/transcription.md`. No stem is named `app`.

**Deleted:**

- `table.save`, `table.update`, `table.setBody` with its splice and
  `ifUnchanged`, `create`'s `Exists`, the guarded `delete` and `rename`,
  `RowUpdate`, `SavedRow.merged`, and the per-verb error unions
- the Sync choices layer: `NeedsChoices`, `resolve`, `SyncAttempt`,
  `SyncChoices`, `InvalidChoices`, `Stale`, held paths, and
  `sync-review.svelte`
- `mergeFile`'s `settle` and pick, in favor of `merge` returning
  `{ text, overridden }`
- `mergeIncoming` and `FolderGitSteps`, the `kv.json` case in `git/merge.ts`,
  and `mergeKv`
- batch `apply` and its `Partial` result
- `folder.kv`, `kv.json`, `kv.ts`, `kv-merge.ts`, `KV_ROOT`, `InvalidKv`, and
  the `kv` section of `epicenter.json` and `defineFolder`

## Consequences

- One write and one error type replace five verbs and five error unions, and
  every app's controls write the same way.
- Sync always finishes. What it overrode is in its commit message and in
  history, so nothing is lost that a version held; an override of work in no
  version is gone, as with any save (ADR-0529).
- Two writers who add different text at one place both keep it, so a body
  can hold both versions of an addition. A writer that fills a body once,
  such as Whispering's answers, needs no guard against another fill:
  identical answers are one.
- A delete stands against every edit that never saw it, so an autosave, a
  retried fill, or a stale click never brings a row back; such a writer needs
  no check of its own. Text typed into a row deleted elsewhere is not saved,
  and is offered to the person instead.
- A write's `to` that does not read as its kind is written, so a raw edit of
  a row can leave a row to repair, as a hand edit can.
- A body edit rewrites its row's frontmatter in the standard form, so a
  hand-written file loses comments and custom quoting on its first edit from
  an app.
- The browser's whole-folder check before publishing goes, and the browser
  publishes as the desktop does.
- `kv.json` becomes an ordinary file. Each app moves its settings into
  `settings/<concern>.md` rows; Whispering keeps reading an earlier build's
  endpoint as a file.

## Considered alternatives

- **Sync asks the person when units compete** (ADR-0514, ADR-0516). It stops
  Sync on a choice, needs a modal and its own state, and Save already settles
  the same overlap without asking.
- **Keeping the frontmatter's bytes on a body edit** (`table.setBody`'s
  splice). It is a second write path, and the standard form is the spelling.
- **One shared `write` mutation** (`write.mutate(folder.todos.set(...))`).
  Every control would share one pending and error state.
- **A guarded fill** (`ifUnchanged`). With a union, two fills of one empty body
  keep both, and identical fills are one.
- **No merge driver.** Sync would need its own merge again, and `git pull` by
  hand would merge rows as plain text.
- **A line merge of the whole row instead of a field merge.** A union of
  insertions at one place in the frontmatter would write a key twice.
- **Settings as `kv.json` keys** (ADR-0522). A second data model with its own
  merge, special cases in Git merging, and its own section in every
  declaration.
