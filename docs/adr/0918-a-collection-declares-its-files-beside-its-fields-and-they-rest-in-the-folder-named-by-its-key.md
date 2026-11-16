# 0918. A collection declares its files beside its fields, and they rest in the folder named by its key

- **Status:** Proposed
- **Date:** 2026-11-15
- **Unbuilt:** all of it. `defineCollection` takes no `files`, `Folder` in `packages/app/src/context.ts` has no `move`, and a collection has no `dirOf`.

## Context

A collection keeps one Markdown file per record. `defineCollection` refuses a
`field.file()` in its fields, because that field is an upload the host deletes
when the run ends
([ADR-0915](0915-serve-owns-a-pages-runs-and-a-file-input-is-a-temporary-upload.md),
which leaves "persistent attachments" undecided). An app that keeps a voice
memo's audio, a page's narration, or a figure has no declared place for the
bytes and builds the path by hand.

A file is also not a field. Every other field is a JSON value that fits on a
front matter line. Bytes do not, so they rest as a file of their own, and the
question this record answers is which file.

## Decision

**`defineCollection({ files })` names the files a record may have beside its Markdown file.**

```ts
const memos = defineCollection({
  path: 'data/memos/{memo}/memo.md',
  fields: { title: field.text({ optional: true }) },
  files: { audio: { accept: ['audio/*'] }, cover: { optional: true } },
});
```

Each entry of `files` is a slot: `{ accept?, maxBytes?, optional? }`. `accept`
lists MIME types or `type/*`, `maxBytes` defaults to `MAX_FILE_BYTES`, and a
slot is required unless it says `optional: true`. A slot may not share a name
with a field or a placeholder.

**A slot's bytes rest as one file named after the slot, in the record's folder. Front matter says nothing about it.**

The file is `<slot>` plus the extension of the incoming file's name:
`audio.m4a`. The record's folder is the record's path up to its last
placeholder, without the extension:

| `path` | The record's folder | Shape |
| --- | --- | --- |
| `data/memos/{memo}/memo.md` | `data/memos/<memo>/` | the Markdown file is inside |
| `data/journal/{entry}.md` | `data/journal/<entry>/` | the folder is beside the file |
| `data/pages/{page}/script.md` | `data/pages/<page>/` | shares the page's folder |
| `data/settings.md` | `data/settings/` | beside the file |

```txt
data/memos/walk/
  memo.md        title: "Morning walk"
  audio.m4a
```

`collection.dirOf(keys)` is that folder's path, as `pathOf(keys)` is the record's.

**`add` and `set` take a file for a slot, and a read finds it by name.**

A slot accepts an `UploadedFile`, or `{ name, bytes }` from code. `add`
refuses before writing anything when the Markdown file exists; it then writes
each slot's file and the Markdown file last. `set(keys, { audio: file })`
replaces whatever file holds the slot, and `set(keys, { audio: null })`
deletes an optional slot's file. A slot refuses an incoming file whose extension is `.md`: a
Markdown file in a record's folder is another collection's record.

A read gives each slot as `{ name, path }`, or leaves it out when no file is
there. A required slot with no file adds `audio is missing` to `problems`, and
two files for one slot add `audio: two files (audio.m4a, audio.mp3)`.

**`delete` removes the record's Markdown file and the files of its declared slots, and nothing else.**

A file no slot declares, such as a figure the text links to, stays. The
folder is removed only when it is then empty. So a record deleted and added
again under the same key does not inherit the old audio.

**`folder.move(from, to)` renames a file or a folder under `data/`.** It takes
the write lock, obeys a read-only run, and refuses a target that exists.
Renaming a record whose Markdown file is inside its folder is
`folder.move(memos.dirOf({ memo: 'walk' }), memos.dirOf({ memo: 'stroll' }))`.

## Consequences

- An app that keeps one audio file or one cover per record declares a slot and
  passes the file to the verbs `actions()` gives. It writes no action of its
  own.
- The incoming file's own name is not kept. `Voice 003.m4a` becomes
  `audio.m4a`.
- Setting a slot to a file or to `null` destroys the bytes it replaces. Git holds the earlier bytes only where the file is tracked
  ([ADR-0858](0858-where-a-file-lives-decides-whether-it-travels-survives-or-dies-with-its-program.md),
  [ADR-0856](0856-binary-files-go-through-git-lfs.md)).
- A write of a slot and the front matter is two steps. A failure between them
  leaves the file written and the front matter as it was.
- The path decides the shape. A collection whose records will gain files puts
  the Markdown file inside the folder, so a rename is one `folder.move`. A
  collection whose records rarely do keeps single files, and a rename there
  is two moves.
- Until [ADR-0921](0921-a-file-reaches-an-action-as-its-own-input-beside-input-on-any-call.md)
  is built, an `UploadedFile` exists only inside a run started with
  `runs.start`, so a page reaches a slot only that way.
- This record gives a record no list of files and no file under the
  uploader's own name.

## Considered alternatives

- **A front matter line naming the file (`audio: "walk.m4a"`).** A second
  statement about the folder that goes stale when a person renames or deletes
  the file by hand.
- **`owns: 'directory'`, with digest-suffixed names, a staging folder, and
  `delete` removing the whole directory.** A drafted record proposed this. The
  names cannot be predicted, the staging folder is hidden, and `delete` would
  remove files a person dropped in by hand.
- **`field.file()` inside `fields`.** Then `field.list(field.file())` and a
  file nested in an object can be written and must be refused, and spreading
  one collection's fields into an action's `input` could carry an upload into
  an action the command line cannot call.
- **One folder of blobs, referenced by id or path.** A second identity for
  bytes that are already files, and a reference to keep true.
- **A setting that picks inside or beside.** The path already says which.
