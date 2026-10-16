# 0576. A folder has one write: a merge by unit where the writer acting wins

- **Status:** Proposed
- **Date:** 2026-10-16
- **Supersedes:** [ADR-0554](0554-a-field-edit-sets-fields-on-the-file-as-it-is-now.md) (a field edit as its own verb, `table.update`)
- **Amends:** [ADR-0548](0548-a-view-is-a-cache-of-files-with-one-write-path-one-read-path-and-one-channel-of-change.md), withdrawing "Sync: decided by the person": an overlap in Sync is decided by the device syncing. That files are the truth, with one read path and one channel of change, remains.
- **Amends:** [ADR-0551](0551-every-write-to-a-folder-file-is-one-save-that-merges-by-the-files-kind-and-sync-settles-with-the-same-merge.md), replacing `mergeFile`'s settle and pick with one merge that returns `{ text, overridden }`, adding a union for insertions at one place, and giving Save and Sync the same tiebreaker. That every write merges by the file's kind remains.
- **Relates:** [ADR-0503](0503-file-authoritative-workflows-preserve-information-and-tolerate-repairable-states.md), [ADR-0529](0529-commits-happen-only-on-sync-or-when-a-person-saves-a-version.md), [ADR-0566](0566-plain-git-merges-an-epicenter-folders-files-by-kind-through-a-merge-driver-every-connect-and-clone-configures.md), [ADR-0572](0572-a-row-body-is-read-and-written-with-line-feeds-and-storable-text.md), [ADR-0575](0575-a-control-binds-one-part-of-a-row-fields-are-patched-and-the-body-is-opened.md)
- **Replaces, as Proposed records:** ADR-0514 and ADR-0516 (Sync's captured attempts, choices, and review), ADR-0522 (settings as `kv.json` keys), and ADR-0575's write verbs (`table.update`, `table.setBody`, `ifUnchanged`). Each carries a note pointing here and is deleted when this is built.
- **Unbuilt:** all of the Decision below.

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
- Two insertions at the same place both survive, and two identical
  insertions are one.
- A version that does not read as its kind merges as text. A result that
  does not read is left for repair (ADR-0503).
- Every write parses, merges, and formats canonically. A row's frontmatter is
  always written in the standard form; there is no splice.
- `from` is content, or no file for a create. A delete needs no `from`: the
  deleter wins.
- The write reads, merges, and puts guarded by the hash it read, again on a
  lost race, at most `WRITE_ATTEMPTS` times. Storage is `read` and
  `put(path, bytes | null, ifMatch)`.
- Every failure is one `WriteError`: `KeptChanging`, `InvalidValues`, `Io`,
  `Closed`, or `InvalidPath`.

**A table is a typed view.** It is a codec over `<table>/<stem>.md` with
`get(stem)`, `list()`, and `write(stem, from, to)`. Helpers build the change
and call the one write:

| Helper | `from` |
| --- | --- |
| `set(stem, fields)` | the file as it is now |
| `create(row)` | no file, at a new stem |
| `delete(stem)` | none; the deleter wins |
| `rename(stem, next)` | `create` at `next`, then `delete` of `stem` |
| the body editor | the row at the first keystroke, then what each save sent |

`files.move` stays for large binary files.

**The query layer offers one mutation per helper.**
`folder.<table>.get(stem)` and `.list()` give `queryOptions()`, and
`.set`, `.create`, `.rename`, and `.delete` give `mutationOptions()`. There is
no shared `write` mutation, so each control owns its pending and error state.
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
Sync publishes each changed file through the one write, on every host. In a
`git pull`, the merge driver treats the local checkout as the writer acting
and writes no conflict markers.

**`createBodyEditor` holds `from`, `typed`, and one write.** The first change
takes the row as the cache holds it as `from`. A save that lands with nothing
typed since clears both. A save that lands while typing continued makes `from`
the text it sent. A failed save keeps both. Saves of one file run one at a
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
  such as Whispering's answers, needs no guard: identical answers are one.
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
- **Settings as `kv.json` keys** (ADR-0522). A second data model with its own
  merge, special cases in Git merging, and its own section in every
  declaration.
