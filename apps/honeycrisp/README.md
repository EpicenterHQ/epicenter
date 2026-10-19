# Honeycrisp

Honeycrisp is a Markdown notes app with a rich-text editor. Every note is one
Markdown file in a folder, and that folder's files are the saved data. There
is no account, no sync, and no database behind it.

The browser build keeps notes in this origin's local folder; the installed
build opens the directory Epicenter grants its window. Part of the
[Epicenter](https://github.com/EpicenterHQ/epicenter) monorepo. Licensed under
AGPL-3.0-or-later.

## Run it

From the repository root:

| Command | What it does |
| --- | --- |
| `bun dev:honeycrisp` | Starts the browser build on port 5175. Notes live in this browser's local folder (IndexedDB), not in a directory on disk. `bun dev:honeycrisp:ui` is the same. |
| `bun build:honeycrisp:ui` | Builds the browser page into `apps/honeycrisp/build`. |

The installed build (`bun run build:installed`, which Epicenter runs when it
installs Honeycrisp from `epicenter.app.json`) uses the same rows and edits
over the shell's granted directory. A missing grant is shown as a refusal.

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

A note's title, folder, pin, and text are saved as you change them: a second
after you stop typing, when you leave the title or Source, and at once for a
folder, a pin, or a list action (pin, move to a folder, move to Recently
Deleted, restore, rename a folder). Each save merges with whatever another tab
saved meanwhile: a field you did not change keeps their value, text merges by
line, and where you both changed the same field or lines, yours win, with no
message. What you type always stays on screen; a read never replaces it.

A note has two views of its body, **Rich text** and **Source**. Switching
between them saves nothing and discards nothing. **Edit as file** opens the
note's whole text instead; while it is open that way, its text is what saves,
and list actions on it are refused.

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

Deleting a folder first moves its notes out, each as a list action. It is
refused while any note cannot say which folder it is in: repair or remove
those first. The folder's file goes only after the notes were read again with
none left in the folder. This is not one atomic step.

## When something changes underneath you

Honeycrisp reads the notes when it opens. After that, a save from another tab
reaches it through the folder's change channel, and only what it names is read
again. Returning to the tab reads nothing.

| What happened | What Honeycrisp does |
| --- | --- |
| Another tab changed a note | The lists and the open note show it. If you were not typing, the rich-text view starts over on the new text, so its undo history restarts. |
| Another tab changed a note while you were typing | What you typed stays on screen. Its save merges with their change, as above. |
| Another tab deleted a note you are typing in | The note leaves the list, and what you typed is offered to copy. Its next save, after a pause or **Save it again**, puts the note back with your typing; **Discard it** lets it go. |
| A save failed, for example because storage is full | What you typed stays on screen, the note shows **Not saved** with the reason, and the header says so. It saves again with your next change, or with **Save again**. |
| You delete a note or file | What you typed in it is saved first, and a delete refuses while it did not save. A file another tab changed at that moment is kept. |

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
| `src/lib/notes.svelte.ts` | The notes over the folder `getFolder()` answers: the file queries, note and folder edits over the edit layer, file text drafts, creates and deletes, and what the detail shows. |
| `src/lib/status.ts` | The header's save line and the words for a failure. |
| `src/routes/+page.svelte` | `<FolderApp>` over `honeycrispTables`, with `NotesView` inside it. |
| `src/routes/components/` | Header, folder list, note list, the note view, files. |

## Tech stack

The [desktop acceptance report](evidence/desktop/README.md) records an
earlier, directory-based Honeycrisp; none of its desktop, Git, or history
features exist in this version.

- [SvelteKit](https://kit.svelte.dev) with the static adapter, SSR disabled
- [ProseMirror](https://prosemirror.net) with `prosemirror-history` and `prosemirror-markdown`
- `@epicenter/folder` for the local folder, its rows and files, merging saves, and change reports; `@epicenter/svelte` for `<FolderApp>`, its query cache, and its edit layer; [TanStack Query](https://tanstack.com/query) for the cache the page reads; and [TypeBox](https://github.com/sinclairzx81/typebox) for the row schemas
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
- A delete keeps a file another tab changed at that moment, instead of
  deleting it anyway.
- Typing in a note another tab deleted is saved, which puts the note back,
  instead of being refused.
- While a note is open as its file, its repair reasons are checked after
  each save, not as you type.
- A note file named `notes/.md` is not listed: the local folder needs a
  non-empty name.
