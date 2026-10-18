# 0551. Every write to a folder file is one save that merges by the file's kind, and Sync settles with the same merge

- **Status:** Accepted
- **Date:** 2026-10-15
- **Amends:** ADR-0514, since deleted: [ADR-0576](0576-a-folder-has-one-write-a-merge-by-unit-where-the-writer-acting-wins.md) replaced Sync's choices with a merge the device syncing wins. This amended it so that taking a side of a text unit no longer took the captured version exactly.
- **Built:** `mergeFile` and `fileKindOf` (`merge-file.ts`), the one-pass line merge (`git/merge-lines.ts`), `saveFile`, `Replaced`, and `restoreTheirs` (`save-file.ts`); content-carrying captures (`files.read`, `files.create`, `files.save`, and `StoredRow.text`); `files.save` with `files.replace` and `files.overwrite` deleted; `table.save` and `kv.set` over `saveFile`; Sync's held paths and binary paths over `mergeFile`; `publishDefinition` over create and `{ merge: false }`; drafts that carry changes made during a merged save onto the version it wrote, for rows and, in `createTextDraft`, for text; `ReplacedNotice` in `@epicenter/svelte`; and every caller listed below. The storage boundary keeps its `overwrite` change kind, which no folder verb sends.

## Context

[ADR-0548](0548-a-view-is-a-cache-of-files-with-one-write-path-one-read-path-and-one-channel-of-change.md)
made `table.save` the one write path for rows and moved the merge into the
engine. The other writes did not follow:

| Write | Version check | When the file moved on |
| --- | --- | --- |
| `table.save(file, row)` | compare-and-swap on `file.sha256` | merges by field and body line; the edit wins an overlap; at most three rounds |
| `kv.set(key, value)` | none from the caller; swaps on what it just read | re-applies the key on a fresh read, three times, in its own loop |
| `files.replace(file, content)` | compare-and-swap | refuses with `Conflict` |
| `files.overwrite(path, content)` | none | the last write wins |

Sync merges every kind in `git/sync.ts` (`holdFile`, `heldRow`,
`heldSettings`, `heldFile`): a second copy of the row merge and a third way of
merging settings. The copies disagree, and each disagreement loses edits:

- `table.save` writes the row as given whenever the base hash is still
  current, and ignores the base row. `createSaveBases` pairs the merged
  version's hash with the unmerged row that was sent, so a draft that kept
  typing after a merged save undid the other writer's change on its next
  save.
- When a person takes a side of a body or a text file in Sync, `settle`
  takes that side's whole text (`heldFile.settle`, and the body branch of
  `heldRow.settle`), so "take incoming" drops our edits to lines that did not
  compete. ADR-0548 says only same-line edits compete. The tests miss it
  because each fixture has exactly one competing region.
- Whispering's `fill` must write a transcript only into an empty body, but it
  saves through `table.save`, which merges, so a body another writer just
  wrote is replaced.
- A text file saved from Vocab, Honeycrisp, Whispering, or the Git lab is
  refused when another writer moved it, and each app reloads or keeps its own
  overwrite.

Sync cannot hold a binary path: one makes the whole run `Unreviewable`, whose
message says to repair with Git outside the folder, which does not exist for a
browser folder.

## Decision

**One merge, by kind.** `mergeFile(kind, { base, ours, theirs })` is pure. It
returns the units both sides changed differently and a `settle(pick)` that
builds the merged file and validates it.

| Kind | Merges by | A competing unit |
| --- | --- | --- |
| `kv.json` | key, through `reconcileKv`, written by `formatKvMembers` | one setting |
| a table row, `<table>/<stem>.md` | field, and the body by line | one field; the body |
| other UTF-8 text | line | the file's text |
| binary, or a side absent | none | the whole file |

`fileKindOf(definition, path)` decides the kind for save and Sync alike. A row
or `kv.json` version that does not read as its kind merges as text, by
[ADR-0503](0503-file-authoritative-workflows-preserve-information-and-tolerate-repairable-states.md):
the result is a file a person can repair, not a refusal.

**Each side of a text unit is a line merge with that side winning every
competing region.** `ours` and `theirs` on a body or text unit are those two
merges, never a captured version. Picking a side keeps the other side's lines
that did not compete. This amends ADR-0514: nobody can take a whole raw side
of a text unit any more, as `git checkout --theirs` would; a person who wants
that replaces the unit's text.

**One save loop.** `saveFile(kind, base, edit, { merge })` is the engine's only
write to an existing file:

1. Check that the base's content hashes to `base.sha256`, then swap on that
   hash.
2. On `Conflict`, read the current file. A missing file is `NotFound`: a save
   never recreates a deleted file.
3. Merge the base content and the edit against the current file, and settle
   every competing unit with `ours`.
4. Validate the result against the handle's prepared definition, then swap on
   the current hash. Repeat from 2 at most three times, then `KeptChanging`.
   On `Unconfirmed`, read back once: our bytes mean done.

Every round merges from the edit's own base, never from the previous attempt.

**A base is identified by its content.** Every capture the engine returns
(`files.read`, `files.create`, `files.save`, and a row's `StoredRow`) carries
the file's exact bytes or text, and `saveFile` accepts a base only when that
content hashes to the base's own `sha256`. A base without content, or whose
content does not match, is refused with `Unknown base`, so a save never
silently becomes "the saver wins". An editor keeps its base and its edited
text apart; an app that edits the text inside its capture, as Vocab does
today, is refused. Because the check needs no registry, a base survives what
object identity does not: a draft persisted across a reload or a host
restart, and a capture passed between windows by structured clone. The cost
is one SHA-256 of the base per save. `table.ts`'s `issuedText` map,
`createSaveBases`, and the `draft.ts` workaround go. After a save, a draft's
base is the version it wrote; when that save merged, changes made while it
ran are merged onto that version, so the next save does not undo what the
merge took.

**`{ merge: false }` is the same loop stopping at step 1.** It answers
`Conflict` instead of merging. Two callers need it:

- Whispering's `fill`, which writes only into an empty body: on `Conflict` it
  reads again and writes only if the body is still empty.
- `publishDefinition`: `epicenter.json` is never line-merged. It reads; if
  absent, creates, reading once more on `Exists`; if present, saves with
  `{ merge: false }` and retries once.

**Every verb is a thin call.**

```ts
table.save(file, row, options?)       // saveFile, kind 'row'
kv.set(key, value)                    // saveFile over the file as read at the set
files.save(base, content, options?)   // saveFile, fileKindOf(path)
files.create(path, content)           // unchanged: the file must be absent
```

`files.replace` and `files.overwrite` are deleted. `folderOptions`' verbs stay
`save`, `set`, and `write`; `write`'s `over` becomes `base`. Tests that seeded
files with `overwrite` use a test-support `put`.

**A save names what it replaced, with the content.** "Restore theirs" must work
when the other side's version exists nowhere else: an uncommitted version has
no Git object.

```ts
type Replaced =
  | { kind: 'field'; field: string; kept: unknown; theirs: unknown }
  | { kind: 'setting'; key: string; kept: unknown; theirs: unknown }
  | { kind: 'text'; part: 'body' | 'file'; kept: string; theirs: string; regions: readonly SettledRegion[] }
  | { kind: 'whole'; theirs: CapturedFile | null };
```

`theirs` on a text unit is the same value as Sync's incoming side: the text
with theirs winning every competing region. Restoring it is putting it back,
with no splicing by line. `regions` name each competing span for the notice.
A row with competing fields and a competing body reports one entry per field
and one body entry. `restoreTheirs(saved)` lives next to `Replaced` in
`@epicenter/folder` and builds the one save over `saved.stored`: the base and
the row or content, which the caller sends through the save it already uses,
so its cache sees the result. A file saved at a row path or `kv.json` is
restored by field or key, which needs the folder's definition.

**Every caller that saves a file renders `replaced`.** One shared notice in
`@epicenter/svelte` names what a save replaced and offers "Restore theirs".

| Caller | Base | Renders `replaced` |
| --- | --- | --- |
| Folders window rows | draft over a stored row | its notice list |
| Todos, Vocab, Capture, Honeycrisp, Whispering rows | draft over a stored row | the shared notice |
| Vocab, Honeycrisp, Whispering, Capture text files | file capture with content | the shared notice |
| Git lab working copy | file capture with content | the shared notice |
| `folderOptions.kv.set` | the file as read at the set | not needed: a set is one key's intent |
| Whispering `fill`, `publishDefinition` | capture with content | `{ merge: false }` |

**Sync settles with the person's picks, binary included.** Its merge path maps
each competing unit to the `SyncConflict` kind the review already shows
(`setting`, `field`, `body`, `file`) and passes the picks to the same
`settle`. A binary path is a `file` conflict that allows take and remove
only; its settled value is bytes. The review already shows bytes as
"Not text (N bytes)".

## Consequences

- Deleted:
  - in `table.ts`, `editWins`, `relocate`, and the save loop;
  - in `kv.ts`, `apply`'s retry loop;
  - in `files.ts`, `replace` and `overwrite`, and `overwrite` in the contract;
  - in `git/sync.ts`, `holdFile`, `heldRow`, `heldSettings`, `heldFile`, and the `Held` type;
  - binary `Unreviewable` in Sync;
  - the public `mergeRow`, `mergeLinesPreferring`, and their types;
  - `createSaveBases` and the `draft.ts` workaround;
  - the Folders window's line splice in `restoreTheirs`;
  - in the Git lab, `keepMyText` and its overwrite;
  - each app's reload on a text file's `Conflict`.
- Save and Sync cannot disagree about what merges.
- A text file another writer moved now merges instead of being refused, and the
  person sees what their save replaced.
- A row that had to merge is written in canonical form, so a hand edit loses
  its frontmatter spelling and comments only when another writer raced it.
- A saved text file merges by line even when it is JSON, YAML, or CSV. The
  result may not parse, and an entry the other side appended in the same place
  is replaced and named. A caller that needs the structure kept merges it
  itself under `{ merge: false }`.
- `kv.set` losing every round reports `KeptChanging`, not `Conflict`.
- A binary `Replaced` holds the other writer's bytes until the notice is
  dismissed. Every binary write today is a `create`, so this is reached only
  when a later caller saves bytes over bytes.
- The review labels and notes in `sync-review.svelte`, `git/sync.ts`'s module
  comments, ADR-0514, and the folder README say a take is the captured
  version; they change with the code.

## Considered alternatives

- **Each verb keeps its own merge, and Sync keeps its copy.** The copies
  already disagree in two places, and both lose edits.
- **Save always merges, with no strict option.** Whispering's `fill` overwrites a
  transcript another writer just wrote, and `epicenter.json` is line-merged.
- **A save with no known base content lets the saver win.** Every text editor
  would flip from a refusal to silently overwriting the other writer.
- **Taking a side takes the captured version, as ADR-0514 said.** It drops the
  other side's lines that did not compete.
- **Binary stays `Unreviewable` in Sync.** One binary path strands the whole
  run, and blobs ([ADR-0544](0544-a-blob-is-a-file-in-its-folder-and-git-decides-how-it-travels.md))
  will conflict on first connect.
- **Merge structured text (JSON, YAML) by its structure.** Right for some files
  and wrong for others, with no declaration that says which; `kv.json` is the
  one structured file the folder declares, and it merges by key.
- **`replaced` names a Git object id instead of carrying content.** An
  uncommitted version has none.
