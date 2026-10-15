# Honeycrisp

Honeycrisp is a Markdown notes app with a rich-text editor. Every note is one
Markdown file in a folder you own, and that folder's files are the saved data.
There is no account, no sync, and no database behind it.

Part of the [Epicenter](https://github.com/EpicenterHQ/epicenter) monorepo.
Licensed under AGPL-3.0-or-later.

## Run it

From the repository root:

| Command | What it does |
| --- | --- |
| `bun dev:honeycrisp` | Builds the desktop page, then starts the desktop app (`tauri dev`). |
| `bun build:honeycrisp` | Builds the desktop app bundle (`tauri build`). |
| `bun dev:honeycrisp:ui` | Starts the browser build on port 5175. Notes live in this browser's origin private file system (OPFS), not in a directory on disk. |
| `bun build:honeycrisp:ui` | Builds the browser page into `apps/honeycrisp/build`. |

Development and builds need Bun, Rust, Git, and the Tauri prerequisites for your
platform. The packaged app is one program and needs Git available on the
machine. It starts signed out and stays that way; it does not need the
Epicenter desktop app or the hosted API.

Checks, from `apps/honeycrisp`:

| Command | What it checks |
| --- | --- |
| `bun run typecheck` | Both page builds and the scripts. |
| `bun run test` | The page: the editor, the notes state over the browser folder, first open over a real directory, bundle contents, then `test:dom`. Needs no Rust or C compiler. |
| `bun run test:dom` | The note view, mounted with its UI library over jsdom, in its own process. |
| `bun run test:native` | The shell: builds the desktop page, then runs its Rust tests. Needs Rust. |

## Where notes live

```text
~/Epicenter/local/so.epicenter.honeycrisp/
├── epicenter.json
├── kv.json
├── notes/
│   └── <note-id>.md
├── folders/
│   └── <folder-id>.md
└── .git/
```

Set `HONEYCRISP_ROOT` to use another directory, for example a disposable one
for testing:

```sh
HONEYCRISP_ROOT=/tmp/honeycrisp-test bun dev:honeycrisp
```

A missing directory gets this layout and a Git repository. Opening publishes
`epicenter.json` from Honeycrisp's declaration, replacing any previous
description, and creates a default `kv.json` when there is none. Saved notes
and settings stay intact, and opening records no commit. The definition file
supports discovery and does not configure Honeycrisp.

A note's file stem is its identity. Its frontmatter holds `title`, `folderId`,
`pinned`, `createdAt`, `updatedAt`, and `deletedAt`; its body is the note.
Folders are logical: a note belongs to one through `folderId`, so moving a note
between folders changes one field and never moves or renames its file.

Saving a note writes its frontmatter as plain YAML: its declared fields
first, then any keys Honeycrisp does not know, which are kept. Comments and
custom quoting in the frontmatter are not kept, so the first save of a file
written by hand rewrites its frontmatter. The body is kept exactly. Opening or
listing a note writes nothing. To change a key Honeycrisp does not show, use
**Edit as file**: it saves exactly what you type.

An action from the note list or the folder list (pin, move to a folder, move to
Recently Deleted, restore, rename a folder) is an edit like typing in the note:
the open note shows it at once, the lists show it once it is saved, and it is
saved the same way.
While a note is open as its file (**Edit as file**), its text is what saves, so
list actions on it are refused until it is open as a note again.

A file in `notes/` whose text does not read as a note, including plain
Markdown with no `---` lines or a note with a bad field such as
`pinned: maybe`, is listed under **Needs repair** with the reasons. It opens as
its text, which saves as you type, with the problems named from the text on
screen. Once it reads as a note, **Open as note** shows its fields again. A
file in `notes/` that is not text at all, and a file in `folders/` that does
not read as a folder, are listed apart and open nothing here; Files, rename,
delete, and the terminal still work on them.

A file name may start with a dot: `notes/.hidden.md` and `notes/.md` itself
are notes like any other, and `.gitignore` is an ordinary file. A folder's id
is its file stem. A name that some disk would read as another file is
refused, on every platform, so a folder copied to Windows still means the same
files: a name ending in a dot or a space (`draft.`, `old `), one holding
`< > : " | ? *`, a Windows device name (`con`, `nul.md`, `com1.txt`), a
Windows short name (`NOTES~1`, `PROGRA~1.TXT`; `Notes ~2.md` is fine), and
`HEAD` or `.git` in any case. Creating
or renaming to such a name in **Files** writes nothing and shows why, for
example "A name cannot end with a dot or a space." A note's own stem may still
end in a space, since its file name ends in `.md`. A file another program
gave such a name cannot be changed from Honeycrisp; rename it from the
terminal.

Deleting a folder first moves its notes out, each as a list action above. It
is refused while any note cannot say which folder it is in (a note that needs
repair or is not text): repair or remove those first. The folder's file goes
only after every note was saved and the notes were read again with none
left in the folder. This is not one
atomic step: a note already moved out stays moved out if the delete stops,
and another program can still put a note in the folder after the last read.
A note whose folder is gone shows under All Notes.

## Editing

A note has two views of its body, **Rich text** and **Source**, beside its
title, folder, and pin. Switching between them saves nothing and discards
nothing. **Edit as file** opens the note's whole text instead. Every edit is
saved as you make it. An edit remembers the version of the file it started
from, so the save merges with anything that changed the file since. One save
runs at a time for each note; what you type while it runs is saved next, from
the version that save wrote. A save that lands never changes what is on
screen, so the rich-text view keeps its cursor and undo history across saves.

Opening a note does not change its file. A rich-text edit rewrites the body as
Markdown and may respell it (`_a_` becomes `*a*`), without changing what it
says.

The rich-text view edits paragraphs, headings, bold, italic, strikethrough,
inline code, links, bullet, numbered, and task lists, quotes, code blocks,
dividers, and line breaks. There is no underline and there are no images.

- **Source the editor cannot hold stays in Source.** A note containing HTML,
  an image, or a table opens in Source only, with the reason shown. The
  rich-text view is refused for it rather than risk changing it.
- **An edit Markdown cannot spell is refused before it appears.** Two are
  known: bold, italic, or strikethrough that starts or ends with punctuation
  directly against a letter (`a**(b)**`), and a line break inside a heading.
  The editor says so; add a space, or make the change in Source.
- **Three things are not kept as content,** because Markdown has no spelling
  for them: an empty paragraph, a line break with nothing after it in its
  block, and bold, italic, or strikethrough on a space by itself. An empty
  paragraph from Enter shows at once and saves nothing until you type in it.
- **Text a file cannot hold is saved as the replacement character.** Half of
  an emoji (a lone surrogate) typed in the title, rich text, Source, or a
  file's text becomes U+FFFD as you type, so what saves is what you see.
- Spaces at the start or end of a line are kept. In Source they appear as
  `&#32;` (and a tab as `&#9;`), since Markdown would drop them otherwise.
- Inline code is literal: it can be a link, but not bold, italic, or struck.
- Text typed to look like a table stays text. A line that would start a
  table's divider row (`|---|`, `:--`) is written with a backslash, so the
  note still opens as rich text.
- Changing the text in Source to say something different starts the
  rich-text view over: its cursor goes to the start and Undo begins again.
  Respelling the same content in Source, or switching views, keeps both.

## When the file changes underneath you

Honeycrisp reads the folder when it opens. After that, a change made outside
the window reaches it through the folder's change reports
(`folder.onFilesChanged`): on the desktop, the shell watches the directory and
reports each changed file, whoever wrote it (another window, another program,
`git`, or the terminal); in a browser, each tab reports its writes to the
other tabs of the same folder. Only what a report names is read again.
Returning to the window reads nothing. Honeycrisp's own saves update what it
shows directly.

| What happened | What Honeycrisp does |
| --- | --- |
| Another program or window changed a file | The lists and the open note show the new version. If you were not typing, the rich-text view starts over on the new text, so its undo history restarts. |
| Another program changed the file while you were typing | What you typed stays on screen: the edit holds the version it started from, and a read never replaces it. The save merges with their change (ADR-0548): what only they changed stays, and where you both changed the same field or lines, your edit wins. A message says what of theirs your edit replaced. |
| Another program deleted the file, and you edit it | The save is refused, and the note leaves the list. A message offers **Copy your text**, which copies the whole note as you had it. |
| You typed while a save was running | The newer typing saves next, on top of the save before it. |
| A save failed, for example on a full disk | Your edit stays on screen, the note shows **Not saved**, and the message offers your text to copy. It saves again with your next change, or with **Save again**. |
| A save got no reply | The same as a failed save: the message says the save may or may not have happened, and the next save merges with whatever the file holds. |
| A value is not valid for a note | Inputs only change notes to valid values. A value the folder still refuses is reported the same way. |
| You typed in a file open as text, and it changed elsewhere | Text is written whole, without a merge, so the write is refused. The view shows the file as it is now, and the message offers your text to copy. |
| You rename or delete the open item | Its saves finish first, and the rename or delete acts on what it saved last. Typing is paused while a rename or delete runs. A file changed elsewhere since is refused. |

What a failed save held stays on screen until it saves; what a refused text
write held is offered to copy. Opening another note never asks. Reloading the
page and in-page navigation wait while a save or action is running.

Closing the desktop window or quitting the app (including Cmd+Q) quits at
once. Nothing asks the page, nothing waits, and no dialog appears
([ADR-0542](../../docs/adr/0542-quitting-is-immediate-because-unfinished-work-already-lives-in-its-folder.md)).
Each save writes its new text beside the file and renames it into place, so a
quit in the middle of a save leaves the file's old text or its new text, never
part of either. What is lost is what a save still running held: at most the
last moment of typing. In a browser tab, the leave prompt is the browser's.

## Header controls

| Control | What it does |
| --- | --- |
| Status | The most important current fact, usually **Saved**. Open it for three separate lines: **Saves** (whether a save is running, or an edit is not saved), **Changes** (files changed since the last version), and **Versions** (the last **Save version** this session), plus recent versions. |
| Save version | Records every saved file as one version in Git history. Nothing else does: saves never make a version. |
| Files (Ctrl+B) | The file browser for the same directory: open, create, rename, and delete any file. **Reveal folder** opens the directory in the system file manager. |
| Terminal (Ctrl+`) | Desktop only. A shell in the same directory. Its output, history, typed command, and working directory stay while it is hidden. |

On the desktop the terminal runs each command in `/bin/sh` with the real
`git`, so it is exactly an outside program editing the same files. It is a
command runner, not a terminal emulator: a command gets no keyboard input, and
its output appears when it ends. `cd` carries to the next command; environment
changes do not. A command is stopped after two minutes, along with anything it
started, and output past 1 MB is cut off. The browser build has no terminal.

## Git

History is ordinary Git in `<root>/.git`. A version is a commit, and
Honeycrisp makes one only when you choose **Save version** (ADR-0529). Saves
never commit, and nothing commits on its own, so files changed since the last
version are normal; the status shows how many, without warning. A commit that
fails is reported under **Versions** and leaves the saved files saved; it is
never shown as a save error. Terminal commands, including `git add` and
`git commit`, and other programs edit disk directly; their changes are in the
next version.

A version's author is the repository's Git identity: `user.name` and
`user.email` from its own configuration or your global one, as for any Git
program. Whichever of the two is not configured is `Honeycrisp` or
`honeycrisp@localhost`. Honeycrisp reads an `origin` the repository already
names, but it has no Sync: it never pushes or fetches, and history goes
nowhere but the directory unless you push it yourself from the terminal.

Deleting a file says whether its latest changes are in no saved version, so
you can save one first.

Each note has a **History** button listing the versions that include it.
Since only **Save version** and your own commits make versions, a note's
history has an entry for each of those, not one per save. Choosing a version
replaces the note's text with it and saves at once, like any edit. A version
that is not text, or is larger than 16 MB, is refused instead of shown.

## How the desktop app is built

```text
Tauri shell (src-tauri)          one program and one window. It registers the
        │                        notes directory with the shared folder plugin.
        │                        Closing the window quits at once.
        ▼
Folder plugin                    grants the window the directory and holds its
        │                        lock. The page reads, makes every change, and
        │                        runs the folder's `git` through it, and it
        │                        checks each path. The Rust crate is in
        │                        packages/tauri-plugin-epicenter-folder.
        ▼
Page (build-desktop, bundled)    runs @epicenter/folder's own engine over the
                                 granted directory and calls the shell's own
                                 commands. It keeps what it read in a TanStack
                                 Query cache and saves each edit at once.
```

The page chooses where its folder lives at build time through
`#platform/notes-host`. The desktop leaf opens the shell's folder with
`openFolder` from `@epicenter/folder/tauri`, which asks the shell for the
directory and runs the engine over it; the browser leaf opens one OPFS
directory, `Epicenter/local/so.epicenter.honeycrisp`, holding the notes and
their `.git`, with `openFolder` from `@epicenter/folder/browser`. A browser
folder an earlier version kept in IndexedDB is not read, copied, or deleted;
the browser opens the OPFS directory alone. Shared code
imports the folder contract from the bare `@epicenter/folder`, which
`vite.config.ts` aliases to the build's one entry. A desktop folder that
cannot be opened is an error on screen, never a fallback to browser storage.
`src/lib/platform-selection.test.ts` checks that the desktop bundle holds no
browser store and no Git implementation, that neither bundle holds a Yjs or
Node module, and that the browser bundle holds no desktop adapter.

The page reads files through its query cache with `folderOptions(folder)`
from `@epicenter/folder/query` (ADR-0548). The note and folder listings, the
file listing, and Git status are its queries; a file opened as text is a query
over its bytes, cached under the folder's read of that file. `createNotes`
wires the folder's change reports to the cache in one line, so a report makes
exactly the queries it names stale; the query client's focus refetch is off.

An edit of a note or folder is a draft (`createDraftState` from
`@epicenter/folder/svelte`), one per row, shared by the open note and the
lists. The draft captures the cached row and its version at the first change
and keeps the edited row outside the cache. Each change saves with
`tables.<name>.save`, which merges with whatever changed since; one save runs
at a time per row, and its result goes into the cache. A text edit is a text
draft written whole with `files.replace`, guarded by its version. A new note
or folder is `tables.<name>.create`; a new file is `files.create`; rename and
delete wait for the file's saves and act on the version the last one wrote.
After its own actions the page makes what they changed stale, and after its
saves it reads Git status again, since the folder does not report a page's
own writes to it.

### What the shell decides

The page names one thing, the scope `so.epicenter.honeycrisp`. The shell
decides the rest in Rust, before any page exists:

- The root: `HONEYCRISP_ROOT`, else the default directory above. The shell
  makes the directory itself if it is missing and writes nothing inside it.
- That the one window `main` opens it, with the page's own engine. On the
  page's first `grant_directory` the folder plugin takes the
  directory's cross-process lock and refuses a linked `.git`. The window
  then reads the directory and everything in it, `.git` and dot files
  included, through the folder plugin's read commands, never through a link.
- What the page may change: any path in the directory that the folder's path
  rule allows (see the file names above), plus the engine's own staging files
  in `.git`. The folder plugin checks each path on disk and makes the change;
  the page never writes a file itself. `git` runs in Rust as the exact
  operations the engine uses.
- The fallback commit author, `Honeycrisp <honeycrisp@localhost>`. The
  engine reads the identity and any `origin` from Git's configuration
  (see Git, above).
- Which window may use the folder and the commands: `main`, through
  `src-tauri/capabilities/main.json`. The window loads the bundled page and
  refuses to navigate anywhere else, including the same host on another port
  or an address carrying credentials. Tauri treats the bundled page as local
  (`tauri://localhost`, or `http://tauri.localhost` on Windows), so the
  capability lists no remote origin.

The layout is set up by the page, through the folder, after the folder plugin
holds the directory's lock (`src/lib/platform/first-open.ts`). It looks first:
a missing table directory is made, and `kv.json` is written only when a read
confirmed it is absent, on the condition that it still is. Existing settings
are kept. Folder acquisition separately publishes `epicenter.json`. Neither
records a commit. A directory another Epicenter holds is reported as in use
and gains no file.

### Shell commands

Besides the folder plugin's commands, the page calls these. None takes a root
or a working directory.

| Command | Purpose |
| --- | --- |
| `shell_info` | The root, and where the terminal's next command starts. |
| `terminal_run` | One command in `/bin/sh`. The shell keeps the working directory between commands, so hiding the terminal or reloading the page loses nothing. |
| `file_log`, `file_show` | One file's commits, and its text at one of them. The path must be a literal path inside the folder and the commit a hexadecimal id. |
| `reveal_folder` | Open the root in the system file manager. |

The terminal is an outside writer, exactly as another program is. The shell's
watcher reports what each command changed, and the page reads only that.

### Closing and quitting

Closing the window, Cmd+Q, and a quit from the Dock, a logout, or an Apple
Event all quit at once. The shell holds nothing back and asks the page
nothing; on macOS the Quit item is Tauri's standard one. The operating system
releases the folder's lock when the process ends. A save cut off by the quit
leaves the old file or the new one, and a Git command cut off by it leaves at
most a ref lock that Git names, which a person or an agent deletes.

## Testing failures by hand

There is no fault panel. The earlier one lived in the Bun folder host, which
is gone, and the shell does not wrap the folder's writes to bring it back.
Use a disposable directory, never the default one:

```sh
HONEYCRISP_ROOT=/tmp/honeycrisp-test bun dev:honeycrisp
```

The failures below are real, made from the app's terminal or any other one.
`src-tauri/src/tests.rs` runs the first through the folder plugin; the
folder engine's own tests cover a commit that fails.

| To see | Do this in the notes directory | Undo |
| --- | --- | --- |
| A save that fails: the edit stays on screen as **Not saved**, with **Copy your text** | `chmod a-w notes`, then edit a note | `chmod u+w notes`, then **Save again** |
| A commit that fails while the files stay saved | `touch .git/refs/heads/main.lock`, then **Save version** | `rm .git/refs/heads/main.lock`, then **Save version** |
| An outside edit reaches the open note | With a note open, edit `notes/<id>.md` in the terminal | The note shows the new text |
| A change made elsewhere merges with a save | With a note open, run `sleep 5; echo changed >> notes/<id>.md` in a terminal outside the app, and keep typing in the note until it lands | The file keeps the added line and your typing |
| A note file deleted under you | With a note open, `rm notes/<id>.md`, then type in it | The note leaves the list; nothing writes it back |

What cannot be produced by hand in the running app is a save held open or
slowed on purpose, so that typing or a reported change lands while it runs,
or a reply lost after the write landed. Those orders are fixed in tests
instead, with faults in the browser folder's storage stand-in:
`src/lib/notes.test.ts` holds a save and types and reads during it, fails
writes, saves from another tab, and changes or deletes a file under an open
note.
`src/lib/editor/rich-text.test.ts` shows the rich-text view following those
outcomes, and `src/routes/components/NoteDetail.dom.test.ts` mounts the note
view and delivers events to it.

## Layout

| Path | Role |
| --- | --- |
| `src/lib/data.ts` | The inert declaration: the `notes` and `folders` tables. |
| `src/lib/editor/schema.ts` | The bounded ProseMirror schema. |
| `src/lib/editor/markdown.ts` | Markdown to document and back, the equivalence it is held to, the check that gates opening and editing, and `bodyCodec`, which decodes and encodes a note's whole body. |
| `src/lib/editor/rich-text.ts` | ProseMirror commands, plugins, the rule that puts each transaction's Markdown in the note's draft before it is shown, and semantic state replacement when the note's body changes. `EditorView.state` owns the cursor, pending formatting, and undo history. |
| `src/lib/note-source.ts` | The body replacement Rich and Source share (`withBody`), and list previews. |
| `src/lib/notes.svelte.ts` | The query cache and its change wiring, the drafts each edit is held in and saved from, note, folder, and file actions, Save version, what the detail shows, and the fence that stops input once the notes close. |
| `src/lib/platform/` | The `#platform/notes-host` seam, its two leaves, and `shell.tauri.ts`, the page side of the shell's commands. |
| `src/routes/components/` | Header, folder list, note list, the note view, files, terminal. |
| `src-tauri/src/lib.rs` | The desktop shell: the folder plugin, the notes scope, and the window. |
| `src-tauri/src/root.rs` | Choosing and resolving the root directory. |
| `src/lib/platform/first-open.ts` | Setting up a folder that has no layout yet, through the granted folder. |
| `src-tauri/src/commands.rs` | The shell's commands, each a thin call into a module below. |
| `src-tauri/src/terminal.rs`, `history.rs`, `reveal.rs` | The terminal, per-file history, and reveal. |
| `src-tauri/capabilities/main.json` | What the notes window may call. |

## Tech stack

The [desktop acceptance report](evidence/desktop/README.md) includes native
screenshots, saved Markdown and Git versions, checks, and verified limits. It
was made with the earlier Bun folder host. The
[native migration record](evidence/native-migration/README.md) says what
replaced the host and which native checks are still to be run.

- [SvelteKit](https://kit.svelte.dev) with the static adapter, SSR disabled
- [ProseMirror](https://prosemirror.net) with `prosemirror-history` and `prosemirror-markdown`
- `@epicenter/folder` for the folder, its note and folder listings, merging saves, change reports, query options, and drafts; [TanStack Query](https://tanstack.com/query) for the cache the page reads; and `@epicenter/definition` for the declaration
- [Tauri](https://tauri.app) for the desktop shell, with the `tauri-plugin-epicenter-folder` crate granting the directory, reading it, making changes, and running `git`
- `@epicenter/ui` and [Tailwind CSS](https://tailwindcss.com)

## Changed promises

This version reads through the query cache, follows the folder's change
reports, and holds each edit in a draft that merges on save (ADR-0548). It
makes versions only when you ask (ADR-0529). It drops several promises of the
versions before it:

- An edit is saved at once; there is no save bar and no **Discard unsaved
  changes?** prompt. A save that fails keeps the edit on screen as **Not
  saved** until it saves again, instead of putting the note back to the file.
- There is no review with **Apply**. A save that meets a change made
  elsewhere merges with it, and your edit wins where you both changed the
  same field or lines; a message names what of theirs it replaced.
- A note deleted elsewhere is no longer offered back. Your next edit to it is
  refused, and it leaves the list.
- Closing and quitting never ask and never wait. They quit at once; a save
  still running when they do leaves the old file or the new one.
- Saves no longer commit. History grows only through **Save version** and
  your own commits, so each note's history has fewer entries. **Commit saved
  files** is now **Save version**.
- A change made outside the window shows as it happens, from the folder's
  change reports, instead of when you return to the window. **Check again**
  is gone. When a change replaces the open note's text while you are not
  typing, its rich-text undo history starts over.
- Renaming the open note keeps its editor and undo history.
- A list action and the open note share one edit, so a pin or move from the
  list shows in the open note at once, and an edit in the note shows in the
  list once it is saved.

Since the desktop app moved to the page's own engine:

- A file name that some disk would read as another file is refused (see
  [Where notes live](#where-notes-live)). Leading dots still work.
- An `origin` the repository names is read instead of ignored. Honeycrisp
  still never pushes or fetches.
