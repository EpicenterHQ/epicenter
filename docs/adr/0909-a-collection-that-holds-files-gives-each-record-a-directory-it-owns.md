# 0909. A collection that holds files gives each record a directory it owns

- **Status:** Proposed
- **Date:** 2026-11-14
- **Relates:** [ADR-0456](0456-a-markdown-row-owns-at-most-one-same-stem-attachment.md) and [ADR-0480](0480-file-tables-own-only-their-markdown-row-files.md) decided file ownership for the folder sync product's tables, [ADR-0893](0893-a-records-path-is-its-path-in-the-apps-data-repository.md) makes a record's path its path in the app's data repository, without the `data/` prefix the source still uses, and [ADR-0850](0850-an-action-changes-files-and-whoever-knows-the-intent-commits-them.md) commits what a run wrote.
- **Unbuilt:** Still unbuilt are the `owns` key in `defineCollection` itself and the `defineApp` overlap refusal; `defineDirectoryCollection` in `packages/app/src/collection-files.prototype.ts` is the throwaway version, run by `bun packages/cli/examples/collection-files.prototype.ts`.

## Context

A collection today keeps one Markdown file per record:
`defineCollection({ path: 'data/words/{word}.md', fields })`, and `delete`
removes that file and nothing else. `defineCollection` refuses a file marker
anywhere in a field schema, including read-only fields. `field.file()` serves
as an action input. The run host in `packages/cli/src/runs.prototype.ts` keeps an upload in
its private runtime directory, gives the run an `UploadedFile` whose `path()`
is valid only while the run runs, and deletes the bytes when the run ends. A
collection of one file per record cannot keep the host's temporary upload
reference after the run.

A voice memo needs its audio, an optional cover image, and any number of
attachments, kept with the memo, moved with it, and deleted with it.
ADR-0456 gave a row one same-stem sibling (`r123.md` beside `r123.opus`) and
rejected "a directory containing `index.md`" because it adds a directory and a
choice of names for every row. ADR-0480 then withdrew attachment ownership:
a link or a field never authorizes deleting bytes. Both reasons still hold.
Neither names a declared owner: a directory whose contents belong to one
record because the collection says so, not because a filename or a link
suggests it.

An earlier draft spelled that owner `directory: 'data/memos/{slug}'`, with
every Markdown file named `record.md`. A record's address was then a path the
developer never wrote, and every editor tab read `record.md`.

## Decision

**A collection that declares `owns: 'directory'` gives each record its own directory, and its `path` names the record's Markdown file inside it.**

```ts
const memos = defineCollection({
  path: 'data/memos/{slug}/memo.md',
  owns: 'directory',
  fields: {
    title: field.text(),
    audio: field.file({ accept: ['audio/*'] }),
    cover: field.file({ optional: true, accept: ['image/*'] }),
    attachments: Type.Optional(Type.Array(field.file())),
  },
});
```

`path` is the one template every collection has, so a record's address is
the Markdown file's path as the current source spells it,
`data/memos/walk/memo.md`; when ADR-0893 is built it is
`memos/walk/memo.md`, and nothing else here changes. `get`, `holds`, and a
UI's routes take that address. The developer names the
Markdown file (`memo.md`, `recipe.md`): the last segment is a literal `.md`
name, and the segment before it holds a placeholder, so no two records share a
directory. `owns: 'directory'` is what makes the directory the record's.
Nothing is inferred from a template's shape, so an existing
`data/posts/{slug}/index.md` collection still deletes one file.

**Every record of such a collection is a directory, with files or without.**

```txt
data/memos/
  walk/
    memo.md               title: "Morning walk"
                          audio: "walk-3f2a9c1b.m4a"
                          attachments: ["notes-aa11bb22.pdf","notes-cc33dd44.pdf"]
    walk-3f2a9c1b.m4a     the audio now selected
    walk-90be11d4.m4a     the audio before a replacement; the body still links it
    cover-7d1e0a42.jpg    a cover no longer selected; its bytes stay
    notes-aa11bb22.pdf
    notes-cc33dd44.pdf
    scribble.txt          dropped in by hand; no field selects it
  .epicenter.local/       staging/ and trash/ for writes in progress; never a record, never committed
data/notes/               path: 'data/notes/{slug}/note.md'
  idea/
    note.md               only file role: optional attachments list
data/words/
  hello.md                an ordinary collection: one file per record, unchanged
```

A record of the notes collection with no files is a directory holding only `note.md`.
Its first file later lands beside it, and its address does not change.

**A file field is a role: the directory holds the files, and the field selects which one plays the role.** One declaration reads four ways:

| Projection | `audio` | `attachments` |
| --- | --- | --- |
| declared | `field.file({ accept: ['audio/*'] })` | `Type.Array(field.file())` |
| stored in front matter | `"walk-3f2a9c1b.m4a"`, one name inside the record's directory | `["notes-aa11bb22.pdf", ...]`, in the order given |
| given to `add` and `set` | an `UploadedFile`; `set` also accepts an `OwnedFile` of the same record | a list of either, with `OwnedFile` accepted only by `set` |
| returned by a read | `OwnedFile`: `{ folder, record, file, href, type, size }` | `OwnedFile[]` |

A stored name is one path segment with no `/`, `\`, `:`, or leading `.`, and
is never the Markdown file's own name. An `epicenter-file:` reference, a
host's absolute path, and `..` cannot be stored. A hand-edited value that
breaks the rule reads as a `problems` line, as any field that does not fit.

**`add` and `set` keep an incoming `UploadedFile` by copying it to a new name.** The name is the upload's name, a hyphen, and the first 8 hex digits of its SHA-256: two uploads named `notes.pdf` with different bytes become `notes-aa11bb22.pdf` and `notes-cc33dd44.pdf`. The copy streams from `upload.path()`, and the run's input stays for the host to delete. There is no `files: true` or attach step. The collection checks a role's `accept` and `maxBytes` on every incoming file, `maxBytes` against the bytes actually copied; `accept` checks the declared MIME type, not the content.

**Replacing a role selects a new file and keeps the old one; clearing a role removes the selection and keeps the bytes.** `set({ path, audio: newUpload })` leaves `walk-90be11d4.m4a` in place, so a body link to it still plays the original. `set({ path, cover: null })` removes `cover` from front matter, and `cover-7d1e0a42.jpg` stays in the directory. Removing one file is its own file operation, never a side effect of a field.

**An `OwnedFile` names its owner, and a record selects only its own files.** `record` is the owner's address. `folder` is an opaque id of the app folder on this computer: the first 32 hex digits of SHA-256 of `epicenter-owner\0` followed by its real path, never the path itself. Two app folders with the same name refuse each other's files. Moving the app folder changes the id, so older descriptors are refused. Hashing a guessable path lets someone who guesses it confirm the guess. `file` is the raw name; `href` is `file` encoded as a Markdown link target. `set` given an `OwnedFile` of the same record selects that file by name with no new bytes. One from another record or folder is refused, naming the owner; putting it in a second record means copying its bytes.

**`delete` removes the record's whole directory, and `move` renames it.** `delete({ path })` removes every file in `data/memos/walk/`, selected or not. `move` renames the directory with one `rename(2)` and refuses an existing target. Names in front matter and relative links in the body point inside the directory, so they keep working; links into it from elsewhere, and out of it, can break. Nothing else deletes bytes: a missing file, an extra file, or a directory without `memo.md` is reported and never swept. A symlink is listed as a symlink and never followed: it cannot be selected, and `delete` removes the link, not its target. The record's Markdown file is never read through a symlink: `check` reports it, `list` leaves it out, and `delete` removes the link. A second collection whose template could write inside an owned directory is refused when the app is defined.

**A write publishes complete bytes before it publishes a selection, and it is not a transaction.** `add` assembles the directory and its `memo.md` under `data/memos/.epicenter.local/staging/` and renames it into place, refusing any directory already at the target, an empty one included. `set` links each new file into the directory before front matter selects it, and removes those files if the front matter write fails. `delete` renames the directory into `.epicenter.local/trash/` before removing it, so a crash leaves the whole record or a directory under `trash/` that no read treats as a record. `add` publishes the files and front matter; a body linking them is a second write (`edit` with each `href`). If it fails, the record stays complete with its earlier body. The commit after a run (ADR-0850) records what is on disk afterward; it does not make the steps before it atomic.

**Plain `defineCollection` refuses any file marker in a field schema today.** An ordinary collection keeps one file per record and every behavior it has now.

## Consequences

- An app that keeps audio, images, or attachments declares one collection and passes uploads to `add`. A file outlives the run that brought it with no step of its own.
- Each record of an owning collection costs a directory, a record with no files included. An editor shows `memo.md` for every record, and the record's name is its directory's. Renaming the directory by hand renames the record and keeps its files.
- Disk use grows with each replacement: old bytes stay until a person or an action deletes them. There is no blob store, reference count, or garbage collection, and no reference scan decides a deletion (ADR-0480).
- Git records each file's bytes like any other file's. Git LFS changes how history stores and transfers those bytes, below ownership; a full restore needs the LFS objects as well as their pointers.
- A new `UploadedFile` reaches a collection only as a top-level action input, because the run host decodes only those. Uploading into a list role, selecting an `OwnedFile`, and clearing a role work through the methods and an app's own actions, not yet through the run host, the CLI, or MCP. Until then a generated `add` or `set` given an undecoded `epicenter-file:` string refuses it without quoting it and stores nothing.
- `Folder` has no directory operations. The prototype copies and renames with `node:fs` after taking the run's write lock through `folder.update`; the production form adds those operations to `Folder`, so the lock and the read-only guard cover them directly.
- The prototype has an lstat-then-read window; production needs a no-follow read in `Folder`.
- `update` with new files, copying a file between records, and a command that lists and restores what a crash left in `.epicenter.local/` are not decided here.

## Considered alternatives

- `directory: 'data/memos/{slug}'` with a fixed `record.md`: the address becomes a path the developer never wrote, and every editor tab reads `record.md`.
- `data/memos/{slug}/{slug}.md`: tabs read the record's name, but renaming the directory by hand orphans its Markdown file, and the template holds one placeholder twice.
- `data/memos/{slug}.md` with a sibling `data/memos/{slug}/` for files: a record with no files stays one file, but every record with files is two entries that move, copy, and delete separately, and a crash between them leaves half a record.
- A plain file until a record's first upload, then a directory: the record's address changes when it gains a file, which breaks links, a UI's routes, and the continuity of its history.
- Ownership inferred from a `field.file` field alone: removing the last file field would change what `delete` removes without a word in the declaration.
- A same-stem sibling (ADR-0456): one file per record, with no room for a cover and attachments.
- Uploads into a shared blob store referenced by ID: a second identity for bytes that are already files, with a lifetime that needs counting.
- A descriptor in front matter holding name, type, size, and hash: it repeats what the file says about itself, and goes stale when a person replaces the file by hand.
