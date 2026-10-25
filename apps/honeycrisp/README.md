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

A note's title and body save through the folder mirror. Text inputs keep what
was typed in a local draft while each save is in flight; the mirror shows only
what landed. Folder changes, pinning, and list actions await their saved result.
A failed write returns the editor to the disk value and shows a toast with
**Copy your text**. The header says **Saving…** while writes are pending and
**Saved** when they finish.

A note has **Rich text** and **Source** views of its body. They share one body
draft in `NoteDetail`, so a save landing does not reset rich-text Undo. Editing
only the title also keeps Undo. **Edit as file** shows the whole text, including
frontmatter, through its own draft. Switching between the two editors of the
same file checkpoints and waits for the previous save. A different body shown
in either source view starts a new rich-text history.

`<OpenFolder>` opens the mirror, checkpoints it on focus, visibility, online,
and pagehide, and closes it on unmount. A browser unload asks only while a
save is in flight. The desktop window waits for those writes on close.

The mirror keeps text files and interprets Markdown rows. `row(id)` is absent
when a file is gone; an invalid row has issues. `FileDetail` checks repair
text with `readRow` as it is typed. A row patch sets only named fields or body
over the file at save time. It writes frontmatter in schema key order, then
other keys sorted, so comments and original key order are not preserved by a
structured edit. **Edit as file** writes the exact text instead.

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
its text, which saves as you type; the reasons update before each save.
Once it reads as a note, **Open as note** shows its fields again. A file
in `notes/` that is not text, and a file in `folders/` that does not read as a
folder, are listed apart and open nothing here; Files can still delete them.

Deleting a logical folder checks every note's relation, moves current
members out with `folderId: null`, then removes the folder file if no member
remains. It refuses when a note cannot identify its folder. This is not
atomic: an earlier move remains if a later write fails, and another tab can
move a note between the check and deletion.

New notes use `folder.tables.notes.create`; folders use
`folder.tables.folders.create`. A created file opens only after its write
answers. Direct file and table writes share the mirror's per-path save lane.

## When something changes underneath you

Another tab's saved change appears in the mirror. An editor with pending typed
text keeps showing that draft until its save answers. A failed save follows
the disk again; the toast offers Copy for the attempted text. A clean editor
follows the changed file. Deleted files leave the list, and a selected deleted
file shows that it is no longer in the folder. Read failures offer **Try
again**, which checkpoints the folder.

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
| `src/lib/notes.svelte.ts` | The notes over the folder `getFolder()` answers: note and folder actions over mirror rows, creates and deletes, and what the detail shows. |
| `src/lib/status.ts` | The header's save line and the words for a failure. |
| `src/routes/+page.svelte` | `<OpenFolder>` over `honeycrispTables`, with `HoneycrispApp` inside it. |
| `src/routes/components/` | Header, folder list, note list, the note view, files. |

## Tech stack

The [desktop acceptance report](evidence/desktop/README.md) records an
earlier, directory-based Honeycrisp; none of its desktop, Git, or history
features exist in this version.

- [SvelteKit](https://kit.svelte.dev) with the static adapter, SSR disabled
- [ProseMirror](https://prosemirror.net) with `prosemirror-history` and `prosemirror-markdown`
- `@epicenter/folder/next` for the folder mirror and rows; `@epicenter/svelte` for `<OpenFolder>` and text drafts; [TypeBox](https://github.com/sinclairzx81/typebox) for row schemas
- `@epicenter/ui` and [Tailwind CSS](https://tailwindcss.com)

## Changed promises

This version moves Honeycrisp to the local folder, `openFolder({ tables })`.
It drops these promises of the version before it:

- Notes saved by the earlier browser build are not shown. They stay where
  they were, unread and undeleted.
- There is no **Save version**, no Git history, no Changes or Versions status,
  and no warning that a deleted file's changes are in no version. A delete
  cannot be undone.
- The desktop build uses the mirror over its granted directory.
- Files cannot be renamed, and the file browser cannot create or delete an
  empty folder: the local folder has no rename, move, or directory of its
  own. A directory exists while a file is in it.
- A failed write offers the attempted text to copy in its toast.
- While a note is open as its file, its repair reasons include unsaved text.
- A note file named `notes/.md` is not listed: the local folder needs a
  non-empty name.
