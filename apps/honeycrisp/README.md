# Honeycrisp

Honeycrisp is a Markdown notes app with a rich-text editor. Every note is one
Markdown file in a folder you own, and that folder's files are the saved data.
There is no account, no sync, and no database behind it.

On the desktop, Honeycrisp is an app you install in Epicenter
([ADR-0552](../../docs/adr/0552-every-app-is-installed-from-a-folder-in-any-git-repository.md));
it also runs in a browser tab. Part of the
[Epicenter](https://github.com/EpicenterHQ/epicenter) monorepo. Licensed under
AGPL-3.0-or-later.

## Run it

From the repository root:

| Command | What it does |
| --- | --- |
| `bun dev:honeycrisp` | Starts the browser build on port 5175. Notes live in this browser's origin private file system (OPFS), not in a directory on disk. `bun dev:honeycrisp:ui` is the same. |
| `bun build:honeycrisp:ui` | Builds the browser page into `apps/honeycrisp/build`. |

On the desktop, run Epicenter (`bun dev:epicenter`) and install Honeycrisp
from its Folders window: **Install from a repository…**, this repository, and
the app in `apps/honeycrisp`. Epicenter reads `epicenter.app.json`, runs
`bun run build:installed` here, which writes the prerendered page with relative
paths into `dist/`, and serves it at `/apps/so.epicenter.honeycrisp/`. The
browser build needs Bun only; the installed one needs Epicenter and Git. Neither
needs an account or the hosted API.

`shape.json` is the shape Honeycrisp opens (ADR-0538), which Epicenter matches
folders against. Run `bun run shape` after changing `src/lib/data.ts`;
`apps/honeycrisp/scripts/shape.test.ts` fails until then.

Checks, from `apps/honeycrisp`:

| Command | What it checks |
| --- | --- |
| `bun run typecheck` | Both page builds and the scripts. |
| `bun run test` | The page: the editor, the notes state over the browser folder, first open over a real directory, which folder the installed build opens, bundle contents, `shape.json`, then `test:dom`. Needs no Rust or C compiler. |
| `bun run test:dom` | The note view, mounted with its UI library over jsdom, in its own process. |

Epicenter's ignored test `installs_honeycrisp_from_its_folder_in_the_monorepo`
installs and builds Honeycrisp from a clone of this repository named by
`EPICENTER_MONOREPO`.

## Where notes live

```text
~/Epicenter/so.epicenter.honeycrisp/
├── epicenter.json
├── kv.json
├── notes/
│   └── <note-id>.md
├── folders/
│   └── <folder-id>.md
└── .git/
```

This is Honeycrisp's own folder in Epicenter's folder root: `~/Epicenter` in
production, `~/Epicenter Dev` in development, or `EPICENTER_FOLDER_DIR`. Set
that to use another root, for example a disposable one for testing:

```sh
EPICENTER_FOLDER_DIR=/tmp/epicenter-test bun dev:epicenter
```

Opened from the Folders window's Apps list, Honeycrisp gets its own folder.
Opened beside another folder whose `epicenter.json` declares Honeycrisp's
`notes` and `folders` tables, possibly with more fields or tables, it opens
that folder instead: it reads and writes its notes, never writes its
`epicenter.json`, and sets nothing up in it. A folder that does not declare
them is refused with what it lacks.

A missing own folder gets this layout and a Git repository. Opening publishes
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
Recently Deleted, restore, rename a folder), and a folder or pin chosen in the
open note, is saved at once as a change to the file as it is now (ADR-0554): it
sets that field and keeps whatever another writer changed in the others. A
title is saved a second after you stop typing, when you leave it, and when you
open something else. The note's text, in rich text or Source, is saved the
same way, and quitting loses at most that last second of typing.
While a note is open as its file (**Edit as file**), its text is what saves, so
list actions on it are refused until it is open as a note again.

A file in `notes/` whose text does not read as a note, including plain
Markdown with no `---` lines or a note with a bad field such as
`pinned: maybe`, is listed under **Needs repair** with the reasons. It opens as
its text, which saves as you type, with the problems named from the text on
screen. Once it reads as a note, **Open as note** shows its fields again. A
file in `notes/` that is not text at all, and a file in `folders/` that does
not read as a folder, are listed apart and open nothing here; Files, rename,
and delete still work on them.

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
gave such a name cannot be changed from Honeycrisp; rename it with another
program.

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
(`folder.onFilesChanged`): in Epicenter, the shell watches the directory and
reports each changed file, whoever wrote it (another window, another program,
or `git`); in a browser, each tab reports its writes to the
other tabs of the same folder. Only what a report names is read again.
Returning to the window reads nothing. Honeycrisp's own saves update what it
shows directly.

| What happened | What Honeycrisp does |
| --- | --- |
| Another program or window changed a file | The lists and the open note show the new version. If you were not typing, the rich-text view starts over on the new text, so its undo history restarts. |
| Another program changed the file while you were typing | What you typed stays on screen, and a read never replaces it. A title or other field you set wins that field and keeps every field they changed. The note's text holds the version it started from, and its save merges with their change by line (ADR-0548): what only they changed stays, and where you both changed the same lines, yours win. A message says what of theirs your text replaced, with **Restore theirs**. |
| Another program deleted the file, and you edit it | The save is refused, and the note leaves the list. A message offers **Copy your text**, which copies the note's text as you had it. |
| You typed while a save was running | The newer typing saves next, on top of the save before it. |
| A save failed, for example on a full disk | What you typed stays on screen, the note shows **Not saved**, and the message offers the note's text to copy. It saves again with your next change, or with **Save again**. |
| A save got no reply | The same as a failed save: the message says the save may or may not have happened, and the next save merges with whatever the file holds. |
| A value is not valid for a note | Inputs only change notes to valid values. A value the folder still refuses is reported the same way. |
| You typed in a file open as text, and it changed elsewhere | The save merges by line (ADR-0551): what only they changed stays, and where you both changed the same lines, yours win. A message says what of theirs your edit replaced, with **Restore theirs**. |
| You rename or delete the open item | Its saves finish first, and the rename or delete acts on what it saved last. Typing is paused while a rename or delete runs. A file changed elsewhere since is refused. |

What a failed save held stays on screen until it saves; what a failed text
save held is offered to copy. Opening another note never asks. Reloading the
page and in-page navigation wait while a save or action is running.

Closing Honeycrisp's window, or quitting Epicenter (including Cmd+Q), happens
at once. Nothing asks the page, nothing waits, and no dialog appears
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
| Files (Ctrl+B) | The file browser for the same directory: open, create, rename, and delete any file. |

Neither build has a terminal or **Reveal folder**; see [Changed promises](#changed-promises).

## Git

History is ordinary Git in `<root>/.git`. A version is a commit, and
Honeycrisp makes one only when you choose **Save version** (ADR-0529). Saves
never commit, and nothing commits on its own, so files changed since the last
version are normal; the status shows how many, without warning. A commit that
fails is reported under **Versions** and leaves the saved files saved; it is
never shown as a save error. Other programs, including `git add` and
`git commit` in your own terminal, edit disk directly; their changes are in
the next version.

A version's author is the repository's Git identity: `user.name` and
`user.email` from its own configuration or your global one, as for any Git
program. Whichever of the two is not configured is `Epicenter` or
`epicenter@localhost` in Epicenter, and `Honeycrisp` or `honeycrisp@localhost`
in a browser. Honeycrisp reads an `origin` the repository already
names, but it has no Sync: it never pushes or fetches, and history goes
nowhere but the directory unless you push it yourself from a terminal.

Deleting a file says whether its latest changes are in no saved version, so
you can save one first.

A note has no **History** button in either build: listing one file's
versions was a command of the standalone desktop app, which is gone. Use
`git log -- notes/<id>.md` in a terminal.

## How the installed app is built

```text
Epicenter's shell                registers Honeycrisp's own folder, or a folder
        │                        the Folders window lists, with the shared
        │                        folder plugin, and opens the app's window on
        │                        it. Quitting Epicenter quits at once.
        ▼
Folder plugin                    grants the window the directory and holds its
        │                        lock. The page reads, makes every change, and
        │                        runs the folder's `git` through it, and it
        │                        checks each path. The Rust crate is in
        │                        packages/tauri-plugin-epicenter-folder.
        ▼
Page (dist, served by Epicenter) runs @epicenter/folder's own engine over the
                                 granted directory. It keeps what it read in a
                                 TanStack Query cache and saves each edit.
```

The page chooses where its folder lives at build time through
`#platform/notes-host`. The Epicenter host leaf
(`notes-host.epicenter-host.ts`) opens the folder Epicenter handed the window
as `?folder=<scope>`, or Honeycrisp's own, `so.epicenter.honeycrisp`, when
none was handed. Its own folder opens with `openFolder` from
`@epicenter/folder/tauri`, which publishes Honeycrisp's declaration; any other
opens with `openDataFolder` and that declaration as the lens (ADR-0538). The
browser leaf opens one OPFS directory, `Epicenter/local/so.epicenter.honeycrisp`,
holding the notes and their `.git`, with `openFolder` from
`@epicenter/folder/browser`. A browser folder an earlier version kept in
IndexedDB is not read, copied, or deleted; the browser opens the OPFS
directory alone. Shared code imports the folder contract from the bare
`@epicenter/folder`, which `vite.config.ts` aliases to the build's one entry.
A folder Epicenter hands that cannot be opened is an error on screen, never a
fallback to browser storage. `src/lib/platform-selection.test.ts` checks that
the installed bundle holds no browser store and no Git implementation, that
neither bundle holds a Yjs or Node module, and that the browser bundle holds
no desktop adapter.

The page reads files through its query cache with `folderOptions(folder)`
from `@epicenter/folder/query` (ADR-0548). The note and folder listings, the
file listing, and Git status are its queries; a file opened as text is a query
over its bytes, cached under the folder's read of that file. `createNotes`
wires the folder's change reports to the cache in one line, so a report makes
exactly the queries it names stale; the query client's focus refetch is off.

A field edit of a note or folder is `tables.<name>.update`, which sets the
fields on the file as it is now (ADR-0554); `NoteDetail` holds a typed title in
its own state until it is sent. A note's body is a body draft
(`createBodyDraftState` from `@epicenter/folder/svelte`), one per note in the
store, shared by rich text and Source: it captures the cached row and its
version at the first change, keeps the body outside the cache, and saves with
`tables.notes.save` a second after the last change or when the view leaves
it, merging with whatever changed since. A text edit is a text draft
(`createTextDraftState`) saved the same way with `files.save`. Writes to one
file run one at a time, and each puts its result in the cache. A new note
or folder is `tables.<name>.create`; a new file is `files.create`; rename and
delete wait for the file's saves and act on the version the last one wrote.
After its own actions the page makes what they changed stale, and after its
saves it reads Git status again, since the folder does not report a page's
own writes to it.

### What Epicenter decides

The page names one thing, the folder's scope. Epicenter's shell decides the
rest in Rust (`apps/epicenter/src-tauri`):

- The root: Honeycrisp's own folder, `<folder root>/so.epicenter.honeycrisp`,
  or the folder the Folders window opened Honeycrisp beside. The first grant
  of its own folder creates the directory; nothing else is written inside it.
- That the app's windows open it, each with the page's own engine. On the
  page's first `grant_directory` the folder plugin takes the directory's
  cross-process lock and refuses a linked `.git`. The window then reads the
  directory and everything in it, `.git` and dot files included, through the
  folder plugin's read commands, never through a link.
- What the page may change: any path in the directory that the folder's path
  rule allows (see the file names above), plus the engine's own staging files
  in `.git`. The folder plugin checks each path on disk and makes the change;
  the page never writes a file itself. `git` runs in Rust as the exact
  operations the engine uses.
- The fallback commit author, `Epicenter <epicenter@localhost>`. The engine
  reads the identity and any `origin` from Git's configuration (see Git,
  above).

The layout of Honeycrisp's own folder is set up by the page, through the
folder, after the folder plugin holds the directory's lock
(`src/lib/platform/first-open.ts`). It looks first: a missing table directory
is made, and `kv.json` is written only when a read confirmed it is absent, on
the condition that it still is. Existing settings are kept. Folder acquisition
separately publishes `epicenter.json`. Neither records a commit. Another
folder is not set up. A directory another Epicenter holds is reported as in
use and gains no file.

Quitting Epicenter, with Cmd+Q, the Dock, a logout, or an Apple Event, quits
at once and asks this window nothing. The operating system releases the
folder's lock when the process ends. A save cut off by the quit leaves the
old file or the new one, and a Git command cut off by it leaves at most a ref
lock that Git names, which a person or an agent deletes.

## Testing failures by hand

There is no fault panel. The earlier one lived in the Bun folder host, which
is gone, and the shell does not wrap the folder's writes to bring it back.
Use a disposable folder root, never the default one:

```sh
EPICENTER_FOLDER_DIR=/tmp/epicenter-test bun dev:epicenter
```

The failures below are real, made from a terminal in
`/tmp/epicenter-test/so.epicenter.honeycrisp`. The folder engine's own tests
cover a commit that fails.

| To see | Do this in the notes directory | Undo |
| --- | --- | --- |
| A save that fails: the edit stays on screen as **Not saved**, with **Copy your text** | `chmod a-w notes`, then edit a note | `chmod u+w notes`, then **Save again** |
| A commit that fails while the files stay saved | `touch .git/refs/heads/main.lock`, then **Save version** | `rm .git/refs/heads/main.lock`, then **Save version** |
| An outside edit reaches the open note | With a note open, edit `notes/<id>.md` in a terminal | The note shows the new text |
| A change made elsewhere merges with a save | With a note open, run `sleep 5; echo changed >> notes/<id>.md` in a terminal, and keep typing in the note until it lands | The file keeps the added line and your typing |
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
| `src/lib/editor/rich-text.ts` | ProseMirror commands, plugins, the rule that puts each transaction's Markdown in the note's body draft before it is shown, and semantic state replacement when the note's body changes. `EditorView.state` owns the cursor, pending formatting, and undo history. |
| `src/lib/note-source.ts` | The body replacement Rich and Source share (`withBody`), and list previews. |
| `src/lib/notes.svelte.ts` | The query cache and its change wiring, the updates fields are set with, the body and text drafts and their saves, note, folder, and file actions, Save version, what the detail shows, and the fence that stops input once the notes close. |
| `src/lib/platform/` | The `#platform/notes-host` seam and its two leaves: `notes-host.epicenter-host.ts`, the folder Epicenter hands the window, and `notes-host.browser.ts`, the OPFS folder. |
| `src/lib/platform/first-open.ts` | Setting up Honeycrisp's own folder when it has no layout yet, through the granted folder. |
| `src/routes/components/` | Header, folder list, note list, the note view, files. |
| `epicenter.app.json` | What Epicenter installs: the app id, `shape.json`, the build, and its output, `dist`. |
| `shape.json`, `apps/honeycrisp/scripts/shape.ts` | The declaration Epicenter matches folders against, and the script that writes it. |

## Tech stack

The [desktop acceptance report](evidence/desktop/README.md) includes native
screenshots, saved Markdown and Git versions, checks, and verified limits. It
was made with the earlier Bun folder host and the standalone desktop app, both
since deleted; its terminal, reveal, and per-note history no longer exist.

- [SvelteKit](https://kit.svelte.dev) with the static adapter, SSR disabled
- [ProseMirror](https://prosemirror.net) with `prosemirror-history` and `prosemirror-markdown`
- `@epicenter/folder` for the folder, its note and folder listings, updates, merging saves, change reports, query options, and text drafts; [TanStack Query](https://tanstack.com/query) for the cache the page reads; and `@epicenter/definition` for the declaration
- Epicenter's [Tauri](https://tauri.app) shell on the desktop, with the `tauri-plugin-epicenter-folder` crate granting the directory, reading it, making changes, and running `git`
- `@epicenter/ui` and [Tailwind CSS](https://tailwindcss.com)

## Changed promises

Honeycrisp is now an app installed in Epicenter (ADR-0552), and its
standalone desktop app is deleted. It drops these promises of the standalone
app:

- There is no Honeycrisp program, Dock icon, or `bun build:honeycrisp`
  bundle. Honeycrisp's window is one of Epicenter's.
- Notes live in `~/Epicenter/so.epicenter.honeycrisp`, not
  `~/Epicenter/local/so.epicenter.honeycrisp`, which is not read. Move that
  directory to keep its notes and history. `HONEYCRISP_ROOT` is gone;
  `EPICENTER_FOLDER_DIR` sets the folder root.
- There is no terminal. Run commands in your own terminal in the notes
  directory; Epicenter's proposed **Open in Terminal** opens one there
  ([ADR-0555](../../docs/adr/0555-apps-reach-native-code-through-official-tauri-plugins-first-granted-by-app-id.md)).
- There is no **Reveal folder**. ADR-0555 proposes **Reveal in Finder** as an
  action on every folder.
- A note has no **History** button. Use `git log` in a terminal.
- The fallback commit author is `Epicenter <epicenter@localhost>`.
- Honeycrisp also opens a folder it is handed whose declaration contains its
  shape, without writing that folder's declaration.

This version saves a field as a change to the file as it is now
(ADR-0554). A title and the note's text are saved a second after you stop
typing, not at every keystroke; a field never names another writer's value
it replaced, since it sets only what you changed; and a list action no longer
shows in the open note before it is saved.

Before that, this version reads through the query cache, follows the folder's change
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
