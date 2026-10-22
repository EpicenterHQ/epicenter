# Honeycrisp

Honeycrisp is a Markdown notes app with a rich-text editor. Every note is one
Markdown file in a folder, and that folder's files are the saved data. There
is no account, no sync, and no database behind it.

The browser build keeps notes in this origin's local folder; the host build
Epicenter bundles opens the directory Epicenter grants its window. Part of the
[Epicenter](https://github.com/EpicenterHQ/epicenter) monorepo. Licensed under
AGPL-3.0-or-later.

## Run it

From the repository root:

| Command | What it does |
| --- | --- |
| `bun dev:honeycrisp` | Starts the browser build on port 5175. Notes live in this browser's local folder (IndexedDB), not in a directory on disk. `bun dev:honeycrisp:ui` is the same. |
| `bun build:honeycrisp:ui` | Builds the browser page into `apps/honeycrisp/build`. |

The host build (`bun run build:host`, which Epicenter's `build:bundled` runs
from this folder) uses the same rows and edits over the shell's granted
directory. A missing grant is shown as a refusal.

Checks, from `apps/honeycrisp`:

| Command | What it checks |
| --- | --- |
| `bun run typecheck` | The page and the tests. |
| `bun run test` | The editor, the notes state over the local folder on an in-memory IndexedDB, bundle contents, then `test:dom`. |
| `bun run test:dom` | The note view and the whole page, mounted with their UI library over jsdom. |

## Where notes live

```text
notes/
└── <note-id>.md
folders/
└── <folder-id>.md
```

These are the folder's files: Honeycrisp opens
`openFolder({ tables: honeycrispTables })`, this browser's one local folder,
with `notes` and `folders` read as Markdown rows. Opening needs no account or
network and writes nothing. A table's directory appears with its first file.

A browser that ran an earlier Honeycrisp keeps that version's notes in its
origin private file system. This version does not read, copy, or delete them.
It refuses to open while that earlier folder is present, so it never shows an
empty workspace in place of existing notes. A fresh profile or origin opens
the new local folder.

A note's file stem is its identity. Its frontmatter holds `title`, `folderId`,
`pinned`, `createdAt`, and `deletedAt`; its body is the note. The note list
shows the newest notes first, by `createdAt`, grouped under labels such as
"Today" and "Yesterday". Honeycrisp keeps no last-edited time (ADR-0573).
Folders are logical: a note belongs to one through `folderId`, so moving a note
between folders changes one field and never moves its file.

The tables only interpret. Every save keeps the keys Honeycrisp does not
name, and a file that does not read as a note is still listed, with its text
and why. To change a key Honeycrisp does not show, use **Edit as file**: it
saves exactly what you type.

## Editing

A note's title and text autosave a second after you stop typing. Folder
changes, pinning, and list actions save at once (move to a folder, move to Recently
Deleted, restore, rename a folder). The Folder owns accepted input, so
background reads preserve it. Every save publishes complete current text;
the last whole-file publication wins, without merging outside changes.

A note has two views of its body, **Rich text** and **Source**. **Edit as file**
shows its whole text, including frontmatter. These presentations share one
detail view for the selected file. Inspecting source, or changing only the
header in the whole-file editor, keeps rich-text Undo. Changing the body in
either source editor restarts the rich-text history on that body.

Blurring a title or source input, changing presentation, and selecting another
file leave autosave with the Folder owner. These transitions neither discard input nor
request an early save, and they never wait for a save or a refresh. The shared
page lifecycle calls best-effort `flush()` when hidden. Close releases synchronously
without submitting input. Confirmed departure accepts losing unfinished work.

The detail view has one save status and one set of retry and discard controls
across all presentations. A failed save keeps the current content and its
error. Acquired text remains editable after a failed refresh, deletion, or
binary replacement, even after closing and reopening the view. **Restore text**
can recreate a deleted file. Read failures offer **Try again**, which only
refreshes the file. Discard abandons pending local input; it does not
cancel a publication already admitted or restore an earlier saved version.

Structured and whole-file editing use one folder-owned source per path.
`folder.tables.notes.edit(id)` interprets it as a note;
`folder.files.edit(path)` exposes full text. `getSnapshot()` is a pure cached
read of `content`, `loadError`, `isDirty`, `isSaving`, and `saveError`.
`content` holds exact `text` with interpreted `fields`, `body`, and `issues`.
`issues === null` means the structured interpretation is valid.
`change({ fields?, body? })` patches the known source; `replaceText(text)`
replaces it completely. Svelte uses the memoized `createFileEdit(handle)`
adapter's tracked getters, including `.content`. Observation starts the first
read; no editor query or mirrored component content is needed. Folder-wide
save indicators read aggregate status without opening files.

The rich-text view sends transactions through the neutral editor. Its own
state owns selection, undo, formatting, and unspellable empty paragraphs.
Reconciliation keeps this state when the body is unchanged, so changing a
title or inspecting source retains Undo. Switching views requires no save or
refresh.

The body is edited with line feeds (ADR-0572): a note whose file has CRLF line
endings shows normally, and its first edit saves it with line feeds.

The rich-text view edits paragraphs, headings, bold, italic, strikethrough,
inline code, links, bullet, numbered, and task lists, quotes, code blocks,
dividers, and line breaks. There is no underline and there are no images.

- **Source the editor cannot hold stays in Source.** A note containing HTML,
  an image, or a table opens in Source only, with the reason shown.
- **An edit Markdown cannot spell is refused before it appears.** Two are
  known: bold, italic, or strikethrough that starts or ends with punctuation
  directly against a letter (`a**(b)**`), and a line break inside a heading.
- **Three things are not kept as content,** because Markdown has no spelling
  for them: an empty paragraph, a line break with nothing after it in its
  block, and bold, italic, or strikethrough on a space by itself.
- **Text a file cannot hold is saved as the replacement character.** Half of
  an emoji (a lone surrogate) typed or pasted anywhere becomes U+FFFD.
- Spaces at the start or end of a line are kept. In Source they appear as
  `&#32;` (and a tab as `&#9;`).
- Changing the text in Source to say something different starts the
  rich-text view over: its cursor goes to the start and Undo begins again.

A file in `notes/` whose text does not read as a note, including plain
Markdown with no `---` lines or a note with a bad field such as
`pinned: maybe`, is listed under **Needs repair** with the reasons. It opens as
its text, which saves as you type; the reasons are checked again after each
save. Once it reads as a note, **Open as note** shows its fields again. A file
in `notes/` that is not text, and a file in `folders/` that does not read as a
folder, are listed apart and open nothing here; Files can still delete them.

Deleting a logical folder first lists its notes and includes held pending
notes, including a note moved into it by unsaved input. It refuses when a
note cannot identify its folder. Each current member is published with
`folderId: null`, preserving its other current content; the folder file is
removed only after another read finds no remaining members. This is not
atomic: a note already moved stays moved if a later write fails, and another
writer can move a note in after the final read.

New notes and folders use `table.write`: the submitted fields and body form a
complete document, and a failed creation leaves no deferred edit. Existing
notes and folders use the shared working document. A list action refreshes clean source before editing, preserving pending local
input; `table.set` then accepts the patch and publishes
a snapshot. Typing during that publication builds on the accepted patch. A
failed publication returns its error and keeps the change available for retry.
Lists and raw reads remain independent of editable text acquisition.

Direct file and table publications join the same per-path lane as editor saves. Apps refuse new actions once closing starts. Folder releases synchronously without waiting for submitted writes. Callers
needing durable bytes await their write or save before closing.
Internal view changes retain the opened Folder.

## When something changes underneath you

Honeycrisp reads the notes when it opens. After that, a save from another tab
reaches it through the folder's change channel, and only what it names is read
again. Returning to the tab reads nothing.

| What happened | What Honeycrisp does |
| --- | --- |
| Another tab changed a note | The lists and the open note show it. If you were not typing, the rich-text view starts over on the new text, so its undo history restarts. |
| Another tab changed a note while you were typing | Current input stays on screen. Its next save publishes that complete source over the outside file. |
| Another tab deleted a note you are typing in | The note leaves the list, while acquired text stays editable and copyable. New input or **Restore text** can recreate it. |
| A save failed, for example because storage is full | What you typed stays on screen, the note shows **Not saved** with the reason, and the header says so. It saves again with your next change, or with **Save again**. |
| You delete a note or file | Deletion enters the same ordered publication lane without saving pending input first. Newer input may recreate the file. |

Closing the tab or reloading while something is not saved yet is held back,
and the browser asks first. Closing the page sends what is typed.

## Header controls

| Control | What it does |
| --- | --- |
| Status | Whether everything typed is saved in this browser, and where notes are kept. |
| Files (Ctrl+B) | The folder's files: open any file as text, create a file, and delete a file. |

## Layout

| Path | Role |
| --- | --- |
| `src/lib/data.ts` | The tables: `notes` and `folders`, with each row's schema. |
| `src/lib/editor/schema.ts` | The bounded ProseMirror schema. |
| `src/lib/editor/markdown.ts` | Markdown to document and back, the equivalence it is held to, the check that gates opening and editing, and `bodyCodec`. |
| `src/lib/editor/rich-text.ts` | ProseMirror commands, plugins, the rule that puts each transaction's Markdown in the note's draft before it is shown, and semantic state replacement when the note's body changes. |
| `src/lib/note-source.ts` | A note's list preview and the name a person sees. |
| `src/lib/notes.svelte.ts` | The notes over the folder `getFolder()` answers: the file queries, note and folder edits over the edit layer, whole-file edits through the shared edit layer, creates and deletes, and what the detail shows. |
| `src/lib/status.ts` | The header's save line and the words for a failure. |
| `src/routes/+page.svelte` | `<FolderApp>` over `honeycrispTables`, with `HoneycrispApp` inside it. |
| `src/routes/components/` | Header, folder list, note list, the note view, files. |

## Tech stack

The [desktop acceptance report](evidence/desktop/README.md) records an
earlier, directory-based Honeycrisp; none of its desktop, Git, or history
features exist in this version.

- [SvelteKit](https://kit.svelte.dev) with the static adapter, SSR disabled
- [ProseMirror](https://prosemirror.net) with `prosemirror-history` and `prosemirror-markdown`
- `@epicenter/folder` for the local folder, its rows and files, retained editable content, and change reports; `@epicenter/svelte` for `<FolderApp>`, its query cache, and its edit layer; [TanStack Query](https://tanstack.com/query) for the cache the page reads; and [TypeBox](https://github.com/sinclairzx81/typebox) for the row schemas
- `@epicenter/ui` and [Tailwind CSS](https://tailwindcss.com)

## Changed promises

This version moves Honeycrisp to the local folder, `openFolder({ tables })`.
It drops these promises of the version before it:

- Notes saved by the earlier browser build are not shown. They stay where
  they were, unread and undeleted.
- There is no **Save version**, no Git history, no Changes or Versions status,
  and no warning that a deleted file's changes are in no version. A delete
  cannot be undone.
- The desktop build uses the new native Folder over its granted directory.
- Files cannot be renamed, and the file browser cannot create or delete an
  empty folder: the local folder has no rename, move, or directory of its
  own. A directory exists while a file is in it.
- Typing in a note another tab deleted remains available to copy or discard.
  New input or **Restore text** can restore the file.
- While a note is open as its file, its repair reasons include unsaved text.
- A note file named `notes/.md` is not listed: the local folder needs a
  non-empty name.
