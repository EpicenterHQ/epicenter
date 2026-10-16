# 0576. A folder has one write: a merge by unit where the writer acting wins

- **Status:** Proposed
- **Date:** 2026-10-16
- **Supersedes:** [ADR-0554](0554-a-field-edit-sets-fields-on-the-file-as-it-is-now.md) (a field edit as its own verb, `table.update`)
- **Amends:** [ADR-0548](0548-a-view-is-a-cache-of-files-with-one-write-path-one-read-path-and-one-channel-of-change.md), withdrawing "Sync: decided by the person": an overlap in Sync is decided by the device syncing. That files are the truth, with one read path and one channel of change, remains.
- **Amends:** [ADR-0551](0551-every-write-to-a-folder-file-is-one-save-that-merges-by-the-files-kind-and-sync-settles-with-the-same-merge.md), replacing `mergeFile`'s settle and pick with one merge that returns `{ content, overridden }`, adding a union for insertions at one place, and giving Save and Sync the same tiebreaker. That every write merges by the file's kind remains.
- **Relates:** [ADR-0545](0545-an-interrupted-incoming-update-is-ordinary-changed-files-and-the-next-sync-finishes-it.md), whose ordinary changed files after an interrupted update this keeps, now because every write lands whole and the next Sync merges them back to the same files; [ADR-0503](0503-file-authoritative-workflows-preserve-information-and-tolerate-repairable-states.md), [ADR-0529](0529-commits-happen-only-on-sync-or-when-a-person-saves-a-version.md), [ADR-0566](0566-plain-git-merges-an-epicenter-folders-files-by-kind-through-a-merge-driver-every-connect-and-clone-configures.md), [ADR-0572](0572-a-row-body-is-read-and-written-with-line-feeds-and-storable-text.md), [ADR-0575](0575-a-control-binds-one-part-of-a-row-fields-are-patched-and-the-body-is-opened.md)
- **Replaced:** ADR-0514 and ADR-0516 (Sync's captured attempts, choices, and review), deleted now that Sync is built; and ADR-0522 (settings as `kv.json` keys), deleted now that settings are a table.

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
  (`from` of `null`, a create) brings a file into existence, and only where
  none is: a create onto a file is `InvalidPath`, unless the file holds the
  same bytes, which is that create landed before. An edit of a
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
  lost race, at most `WRITE_ATTEMPTS` times. A put whose reply was lost is
  read back once: the bytes it sent are it landing.

**Storage is one port that every host implements natively:** `read`,
`list`, `children`, `put(path, bytes | null, ifMatch)`, `mkdir`, `rmdir`,
and `lock`. `ifMatch` is the SHA-256 the path must hold, or `null` for no
file; `put` answers `'landed'` or `'stale'` and lands whole, so a reader and
a crash see the old file or the new one, and a new file never appears empty
first, except in a browser whose file handles cannot move (Chrome before
102), where a new file is written in place and a cut write can leave it
empty. The host checks the condition where the bytes land, under the
folder's save lock: the browser's Web Lock over the origin private file
system, where a new file is written to `.git/epicenter/scratch` and moved
into place; a directory's save lock, which the desktop shell and Bun share
(ADR-0562), where every write is a scratch file renamed over its path.
`lock(work)` holds that lock across several changes, which go through the
same calls without asking for it again. Reads, a folder's capture, a move
(a create at the destination, then a guarded removal of the source), and
the file verbs are composed from these.
- Every failure is one `WriteError`: `KeptChanging`, `InvalidValues`, `Io`,
  `Closed`, or `InvalidPath`.

The merge is `merge(kind, { base, ours, theirs })`, with `ours` the writer
acting. It returns `{ content, overridden }`: the file, `null` for none, and
each unit where the writer replaced another writer's change. A unit is named,
never its losing content, which stays in whatever version held it:

```ts
type Overridden =
  | { kind: 'field'; field: string }
  | { kind: 'lines'; part: 'body' | 'text'; line: number; count: number }
  | { kind: 'file'; lost: 'ours' | 'theirs' };
```

`line` is where the writer's `count` lines stand in the result, 1-based
within the body or the file. `file` names the side whose edit of the whole
file did not stand: the other's under the writer acting, or either side's
under a delete. A write logs what it overrode; Sync's commit message lists
it.

**A table is a typed view.** It is a codec over `<table>/<stem>.md` with
`get(stem)`, `list()`, and `write(stem, from, to)`, which answers the row the
write left, the file when it no longer reads as a row, or `null` when no file
is there. Helpers build the change and call the one write:

| Helper | `from` |
| --- | --- |
| `set(stem, fields)` | the file as it is now; a row that is not there is not made |
| `create(row)` | no file, placed only where none is |
| `delete(stem)` | none; the deleter wins |
| the body editor | the row at the first keystroke, then what each save sent |

`rename(stem, next)` changes where a file is, not what it holds, so it is
not a write: its bytes are put at `next` only where nothing is, and `stem` is
removed only while it holds them, carrying a write that lands there meanwhile.

**Files take the same write.** `files.save`, `files.create`, `files.remove`,
and `files.move`, with `saveFile` and the text draft, go: a file's text or
bytes are written with `folder.write(path, from, to)`, any file is moved with
`folder.move(path, next)`, which is the move `rename` makes, and one text
editor holds `from` and `typed`, of which the body editor is the row case. A
delete of a file is then the deleter winning, as for a row.

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

**Sync never stops for a person, and the last device to sync wins.** Sync
makes one merge commit, computed by Epicenter on every host through the Git
object port (read blobs and trees; write blobs, trees, and commits;
compare-and-swap a ref; fetch; push), with no `git merge-tree` and no rebase:

1. It records saved files in a checkpoint commit (ADR-0529), so the local
   head is `L`, and fetches the remote head `R`.
2. When `R` descends from `L`, it publishes `R` (step 6). When `L` descends
   from `R`, it pushes. Otherwise the base `B` is the merge base of `L` and
   `R`. Where hand-run merges left several, `B` is the one with the newest
   committer time, and on a tie the smallest object ID, so every host picks
   the same; that base can be a worse one, which only hand-run Git causes.
3. Each path that changed between `B` and either head is settled once, net.
   A path only one side changed, or both changed alike, takes that blob as it
   is. A path both changed differently takes `merge(kind, { base: B, ours: L,
   theirs: R })`, with this device as the writer acting. A delete beats an
   edit it never saw. A path one side deleted and the same side created
   elsewhere, holding the deleted path's blob at `B`, the only such pair, is a
   rename: the new path takes the merge of `P` at `B`, that side's version,
   and the other side's version of `P`. A file against a directory at one
   path keeps the directory and the file beside it as `<path>~<side>`, or
   `<path>~<side>-2` and on where that name is taken, to repair.
4. The tree becomes a commit `M` with the parents `[L, R]`, written as
   objects only, with nothing local moved. Its message holds one trailer per
   unit that lost, fixed fields first and the path last, quoted:
   `Overrode: <losing-oid> field="title" "todos/buy milk.md"`,
   `Overrode: <losing-oid> lines=body:12+3 "<path>"`, or
   `Overrode: <losing-oid> file "<path>"`. Every version a merge overrode
   stays reachable as a parent.
5. It checks that nothing of this folder's own stands where `M` writes
   (step 6), then pushes `M` with an ordinary push, which lands only while
   the remote is still `R`. A push that lost the race leaves nothing local changed: Sync
   fetches and merges again from `L` against the new `R`, never merging its
   own merge, a bounded number of times, then `KeptChanging`. A reply that is
   lost is settled by the next fetch. A push that failed for another reason,
   such as no network or a remote that refuses this device, still publishes
   `M` here, so the device keeps receiving, and answers that it saved without
   syncing.
6. Publishing a tree `T` over the files, for a merge or a fast-forward,
   checks and writes each file holding the folder's save lock (`lock`), one
   file at a time, so no cooperating save lands between that file's check
   and its write, and a save waits for one file, never for the whole
   publish. Each path in the difference of `L` and `T` is
   written once, by the one write: `write(path, from: L, to: T)` with the
   live file as the writer acting, so a live file still at `L` takes `T`
   exactly, and text typed after the checkpoint, which no commit holds,
   keeps the units it changed. Removals go first, in one hold of the lock:
   each is checked against `L`'s bytes, then all are made, with the
   directories they empty after them, so a file can take a directory's
   place and the reverse. Before writing anything it stops at
   a file of this folder's own where `T` needs a directory, files where `T`
   needs a file, and an ignored file where `T` adds different bytes, which
   Sync never merges into history. And when a file `T` removes holds an
   edit no commit has, a file `T` changes was moved or removed since the
   checkpoint, or the person made a file where `T` adds one, it stops
   before any change,
   records the files again as `K`, and merges `K` with what it pushed: a
   delete wins, and the edit it never saw stays in history as a parent,
   named by a trailer; a move carries the incoming edit to the new name;
   and two files made at one path merge as an addition on both sides. Names
   compare as APFS folds them, so a name held under another spelling stops
   it too, and a tree this device would send is checked as an incoming one
   is: a merge whose two sides each add one spelling of a name is not sent. Then the branch moves from `L` to `T` by
   compare-and-swap, and the index is set to `T`; an index another program
   holds is left for the next commit to refresh. Every write lands whole, so a publish cut off
   partway leaves each file at its old bytes or its new ones. Before its
   first file change it points `refs/epicenter/publishing` at a commit
   whose parents are `L` and `T`, and it deletes that ref once the branch
   moves. A commit, Sync's checkpoint or a version a person saves, first
   finishes a publish the ref still names while the branch is at `L`: the
   same writes run again, so a file already at `T` stays, one still at `L`
   takes `T`, and one edited since keeps its edit; a file `T` removes that
   was edited after the cut stays, as this device's, and a file the person
   made where `T` adds one joins `T`'s as an addition on both sides, the
   live file winning, unless it is ignored, which stops the commit. Only then does it
   record the files, so bytes that arrived are never recorded as this
   device's edits, which a later merge would let win over another device's
   newer ones. A branch that moved since drops the ref. No record of
   individual files is kept.

Sync stops only for what it cannot represent or must not decide: a
repository in the middle of a merge or a rebase, or with a detached head; a
file Git cannot hold as an ordinary one, or two paths only their case tells
apart; histories with no common commit; a file that kept changing; a file of
the folder's own where the remote needs the path; and a branch another
program moved while it wrote. It never stops because units compete.

"The writer acting" in Sync is the device syncing now, even with an edit a
week old: the last device to sync wins every unit both changed. Paths the
opened definition declares local never enter a commit (ADR-0577), and a
publish neither reads nor writes one.

`epicenter.json` merges as one whole file, the writer's, never by line, but
for `local`: it lists every pattern either side lists, sorted, so a path one
device keeps local is never committed because another device's declaration
won (ADR-0577). Sync, the one write, and the merge driver take the same
rule, from `merge`. An open folder reads `local` from the file for each
commit and Sync, joined with its definition's, so a pattern Sync brings in
applies before the folder reopens, and a handle's publication of its
definition keeps every pattern the file lists. A side that changed nothing in any file leaves the
other's bytes exactly as they are. When a row version
does not read and merges as text, insertions at one place inside its
frontmatter compete instead of joining, so no key is written twice; its body
lines still join.

**Plain Git keeps its conflicts.** The merge driver that `git merge`, `git
pull`, `git rebase`, `git cherry-pick`, and `git stash pop` run uses the same
`merge`: units only one side changed merge by field or line, and insertions
at one place are a union. Where both sides replaced one unit differently, it
writes Git's conflict markers and exits non-zero, so Git stops. In a rebase
or a stash pop, Git's `ours` is not the local work, so "the writer acting
wins" would silently drop replayed commits or stashed edits. Only Epicenter's
Sync, which runs no Git merge, applies the writer acting. A file with markers
shows as one to repair. The driver has one mode.

**`createBodyEditor` holds `from`, `typed`, and one write.** The first change
takes the row as the cache holds it as `from`. A save that lands with nothing
typed since clears both. A save that lands while typing continued makes `from`
the text it sent. A failed save keeps both. A save that finds the row deleted
writes nothing and keeps what is typed, which the control offers until the
person copies or discards it (`gone`). Saves of one file run one at a
time (`inTurn`). It has no revision counter, no re-merge, and no `onSaved`.

**Settings are a declared `settings` table.** Its fields are all optional, and
its stems are named by concern, such as `settings/display.md` and
`settings/transcription.md`; by convention no stem is named `app`. Where a
definition is written, `defineFolder` refuses a required setting; a published
declaration that requires one is read as written.

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
- batch `apply`, `FileChange`, `applyOne`, and the `Partial` result
- the desktop's imitation of the origin private file system
  (`directory-handle.ts`), and the browser's lazy root handle
- Sync's journal, `.git/epicenter/sync-journal.json`, and its recovery
- `folder.kv`, `kv.json`, `kv.ts`, `kv-merge.ts`, `KV_ROOT`, `InvalidKv`, and
  the `kv` section of `epicenter.json` and `defineFolder`. An `epicenter.json`
  an earlier build published still holds `"kv": {}`; it is admitted and not
  read, and the next publication drops it.

## Consequences

- One write and one error type replace five verbs and five error unions, and
  every app's controls write the same way.
- Sync finishes whenever units compete; it stops only for the states named
  above. What it overrode is in its commit message and in history, so
  nothing is lost that a version held. Text saved after the checkpoint
  into a file another device deleted is recorded before the delete wins,
  so it stays in history too.
- A Sync interrupted partway leaves files of both versions, which the next
  commit finishes publishing before it records anything. The next Sync then
  ends where an uninterrupted one would have, here and on the remote, even
  when another device changed the same units again in between. Until then
  a commit that cannot finish the publish, for a file in its way, is
  refused, naming the file.
- A save waits only while Sync checks and writes one file: the merge is
  pushed before any file is written, and each file takes the lock on its
  own.
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
- A setting is a field of its concern's row, so a value that does not read
  makes that whole row one to repair, and every setting in it falls back to
  the app's default until then; `kv.json` read each key alone. And `set`
  changes a row that is there: the first setting of a concern is a `create`.
- `kv.json` becomes an ordinary file. Each app moves its settings into
  `settings/<concern>.md` rows; Whispering keeps reading an earlier build's
  endpoint as a file.

## Considered alternatives

- **Replaying this device's commits onto the remote** (as `git pull
  --rebase`). It revives intermediate states a person reverted, can leave a
  saved version referenced by nothing when the remote deleted its file, and
  replays the same commits again after a lost push reply. A merge commit
  keeps `L` as a parent and fast-forwards the next time.
- **A journal of each publish's files** (`.git/epicenter/sync-journal.json`),
  finished before the next commit. Recovery then has to tell Sync's own
  partial writes from a file another writer made since, which bytes cannot
  say: an empty file a cut-off create left looks like a file a tab made
  empty on purpose. A branch another program moved strands the journal and
  stops every commit. Whole writes make that question unnecessary: the
  publishing ref names only `L` and `T`, and finishing is the same publish,
  which a file already written, or edited since, passes through unchanged.
- **No record of an unfinished publish at all.** The next checkpoint
  records the files a cut publish wrote as this device's edits over `L`. If
  the remote moved on before that Sync, the merge base is `L`, and those
  stale values win over the other device's newer ones, here and on the
  remote.
- **Desktop Sync as Git's own merge** (`git add`, `git merge` with the
  driver, a resolver, `git push`, run by the CLI). It would be a second Sync
  beside the browser's, which every app also deploys to. Git calls a driver
  only for files both sides changed, so modify against delete, renames, and
  a file against a directory stop the merge with a conflicted index for a
  resolver to settle. It writes the working tree directly, and overwrites
  an ignored file at a path the remote adds with no word and no copy.
- **Git's history merge** (`git merge-tree`, isomorphic-git's `merge`).
  isomorphic-git refuses a history with several merge bases and stops on a
  modify against a delete without calling a driver, so the two hosts could
  not share one rule.
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
