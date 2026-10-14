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
| `bun run test` | The page: the editor, the notes state over the browser folder, first open over a real directory, bundle contents, then `test:dom`. Needs no Rust. It first prepares the folder package's file exchange addon, which needs a C compiler on macOS and Linux. |
| `bun run test:dom` | The note view, mounted with its UI library over jsdom, in its own process. |
| `bun run test:native` | The shell: its Rust tests, then the page's close handling against the shell's real close gate. Needs Rust. |
| `bun run test:quit` | macOS only, run by hand in a login session: the real app, on a fixture page in a fresh directory, quit through AppKit's `terminate:` twice. The first quit is declined; the second is approved while a save is still being written. See [the quit evidence](evidence/native-quit/README.md). Opens a window. |

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
it changes the note at once, everywhere it shows, and is written the same way.
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

Any file name works, for notes and for folders, including a leading dot, a
trailing space, and `notes/.md` itself. A folder's id is its file stem.

Deleting a folder first moves its notes out, each as a list action above. It
is refused while any note cannot say which folder it is in (a note that needs
repair or is not text): repair or remove those first. The folder's file goes
only after every note was written and the notes were read again with none
left in the folder. This is not one
atomic step: a note already moved out stays moved out if the delete stops,
and another program can still put a note in the folder after the last read.
A note whose folder is gone shows under All Notes.

## Editing

A note has two views of its body, **Rich text** and **Source**, beside its
title, folder, and pin. Switching between them saves nothing and discards
nothing. **Edit as file** opens the note's whole text instead. Every edit is
saved as you make it. One save runs at a time for each file, and while it
runs one more waits, which saves whatever you have typed by the time it
starts. A save never changes what is on screen, so the rich-text view keeps
its cursor and undo history across saves. There is no draft: what you see is
what is saved, or about to be.

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

Honeycrisp reads the folder when it opens, when you return to its window, and
after its own actions and terminal commands. It does not follow other
programs' changes while you work. Every save is guarded by the bytes
Honeycrisp last read or saved, so nothing another program wrote is
overwritten.

| What happened | What Honeycrisp does |
| --- | --- |
| Another program changed a file, and you return to the window | The lists and the open note show the new version. The rich-text view starts over on the new text, so its undo history restarts. Nothing is read while a save is running, so this never replaces what you are typing. |
| Another program changed or deleted the file, and you edit it before returning | The save is refused, and the note goes back to the file as it is now (or leaves the list, if it was deleted). A message says the file changed elsewhere and offers **Copy your text**, which copies the whole note as you had it. |
| You typed while a save was running | The newer typing saves next, on top of the save before it. |
| A save failed, for example on a full disk | The same as a refused save: the note goes back to the file, and the message offers your text to copy. A failed save is not tried again for you. |
| A save got no reply | The note goes back to the file as it reads now, and the message says the save may or may not have happened. |
| A value is not valid for a note | Inputs only change notes to valid values. A value the folder still refuses goes back the same way. |
| You rename or delete the open item | Its saves finish first, and the rename or delete acts on what it saved last. Typing is paused while a rename or delete runs. A file changed elsewhere since is refused. |

What can be lost is what a refused or failed save held, at most the last
moment of typing, and the message offers it to copy. Opening another note
never asks: there is nothing unsaved to discard. Reloading the page and
in-page navigation wait while a save or action is running.

Closing the window or quitting the app (including Cmd+Q) waits for every save
and action to land, then closes. It never asks to discard anything. While the
desktop app answers a close it takes no input: typing, buttons, menus, and the
terminal do nothing until the app closes or the close is refused. The editors
stay as they are, with their undo history. A browser tab has no such step;
its leave prompt is the browser's.

Every native close asks the page. The shell cannot infer permission from an
earlier observation of the page: once the notes are open, only the page's
answer to that one request lets a close through. A page that does not answer
is asked again on the next attempt, and the window stays.

## Header controls

| Control | What it does |
| --- | --- |
| Status | The most important current fact, usually **Saved**. Open it for three separate lines: **Saves** (whether a save is running), **Changes** (files changed since the last version), and **Versions** (the last **Save version** this session), plus recent versions and **Check again**. |
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
        │                        notes directory with the shared folder plugin
        │                        and asks the page before a close or quit.
        ▼
Folder plugin                    owns the directory: conditional file writes,
        │                        the root lock, change detection, Git history.
        │                        It is the Rust crate in
        │                        packages/tauri-plugin-epicenter-folder.
        ▼
Page (build-desktop, bundled)    opens the folder by its ID through
                                 @epicenter/folder and calls the shell's own
                                 commands. It keeps what it read in a TanStack
                                 Query cache and writes each edit at once.
```

The page chooses where its folder lives at build time through
`#platform/notes-host`. The desktop leaf opens the shell's folder with
`openFolder` from `@epicenter/folder/tauri`; the browser leaf opens one OPFS
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

The page edits files through its query cache (ADR-0528). The note and folder
listings are queries over `tables.<name>.list()`, and a file opened as text is
a query over its bytes. An edit is one immutable change to the cached note or
text, and a mutation keyed and scoped by the file's path writes it with
`tables.<name>.replace` or `files.replace`, guarded by the hash the cache last
confirmed. A file has at most one write running and one waiting. A write that
fails reads that file again, which puts the cache back to the file. A new note
or folder is `tables.<name>.create`; a new file is `files.create`; rename and
delete run in the same per-file queue after its writes, on the capture the
last write confirmed. Nothing follows `folder.onFilesChanged`: the page reads
the folder when it opens, after its own actions, and on focus, and it never
reads while a write runs.

### What the shell decides

The page names one thing, the scope `so.epicenter.honeycrisp`. The shell
decides the rest in Rust, before any page exists:

- The root: `HONEYCRISP_ROOT`, else the default directory above. The shell
  makes the directory itself if it is missing and writes nothing inside it.
- The commit author: the owner reads the root's Git identity after taking its
  lock, with `Honeycrisp <honeycrisp@localhost>` as the fallback.
- Where history goes: nowhere but the directory. The folder is registered
  with no remote, and a repository that names an `origin` is still opened
  without one.
- Which window may use the folder and the commands: `main`, through
  `src-tauri/capabilities/main.json`. The window loads the bundled page and
  refuses to navigate anywhere else, including the same host on another port
  or an address carrying credentials.

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
| `close_register`, `close_opened`, `close_approve`, `close_decline` | Close consent, below. |
| `shell_info` | The root, and where the terminal's next command starts. |
| `terminal_run` | One command in `/bin/sh`. The shell keeps the working directory between commands, so hiding the terminal or reloading the page loses nothing. |
| `file_log`, `file_show` | One file's commits, and its text at one of them. The path must be a literal path inside the folder and the commit a hexadecimal id. |
| `reveal_folder` | Open the root in the system file manager. |

The terminal is an outside writer, exactly as another program is. The page
reads the folder again after each command.

### Close consent

Four things can close the app: the window's close button, an exit request
from the run loop, the Quit menu item, and on macOS a quit from the system.
On macOS a custom Quit item routes Cmd+Q through the same path, because the
predefined one bypasses Tauri's preventable exit event. A quit from the Dock,
a logout, or an Apple Event is AppKit's `terminate:`. Tao's application
delegate does not answer `applicationShouldTerminate:`, so AppKit would end
the app without an exit event. During setup, `src-tauri/src/quit.rs` adds
that one method to Tao's existing delegate class. It always cancels the
system quit and asks for an ordinary exit instead, so the gate decides. As a
result, a logout or restart is cancelled every time, even with nothing
unsaved, and it is never resumed. Start it again once Honeycrisp has exited.
If the method cannot be added, the app does not start. Each way out asks
`src-tauri/src/close.rs`:

1. The page registers when it starts, before it opens the folder, and gets a
   generation. A reload registers again; the page before it can no longer
   answer.
2. Until the page says its folder is open, a close goes ahead: a page that is
   loading, or whose folder failed to open, has nothing to save.
3. After that every close is held and the page receives a `close-requested`
   event naming a request. The page stops taking input, waits for every save
   and action to land, then approves. It never declines and never asks: a
   save that failed was already put back and reported. Input stays stopped
   while an approval is on its way. It is taken again only when the gate
   answers that the approval was not taken because the page was replaced or
   the request was already answered. Any other failure leaves input stopped,
   and the next close is asked again.
4. Only an approval naming the current page and the current request lets the
   close through. A declined request, a request from before a reload, and a
   second answer are refused.

A page that never answers is asked the same request again on the next attempt.
Nothing in the shell approves on its behalf, so if the page's process dies
after the notes opened, the window can only be force-quit, which loses a save
still in flight. Until then a logout or restart stays cancelled.

## Testing failures by hand

There is no fault panel. The earlier one lived in the Bun folder host, which
is gone, and the shell does not wrap the folder's writes to bring it back.
Use a disposable directory, never the default one:

```sh
HONEYCRISP_ROOT=/tmp/honeycrisp-test bun dev:honeycrisp
```

Both failures below are real, made from the app's terminal or any other one,
and `src-tauri/src/tests.rs` runs the same two through the folder plugin.

| To see | Do this in the notes directory | Undo |
| --- | --- | --- |
| A save that fails: the note goes back to the file, with **Copy your text** | `chmod a-w notes`, then edit a note | `chmod u+w notes`, then type again |
| A commit that fails while the files stay saved | `touch .git/refs/heads/main.lock`, then **Save version** | `rm .git/refs/heads/main.lock`, then **Save version** |
| An outside edit reaches the open note | With a note open, edit `notes/<id>.md` in the terminal | The note shows the new text |
| A change made elsewhere refuses a save | Open the folder in two windows, change a note in one, then type in the same note in the other before it regains focus | The second window's note goes back to the first window's version, with **Copy your text** |
| A note file deleted under you | With a note open, `rm notes/<id>.md`, then type in it | The note leaves the list; nothing writes it back |

What cannot be produced by hand in the running app is a save held open or
slowed on purpose, so that typing or a return to the window lands while it
runs, or a reply lost after the write landed. Those orders are fixed in tests
instead, with faults in the browser folder's storage stand-in:
`src/lib/notes.test.ts` holds a save and types and returns to the window
during it, fails writes, and changes or deletes a file under an open note.
`src/lib/editor/rich-text.test.ts` shows the rich-text view following those
outcomes, and `src/routes/components/NoteDetail.dom.test.ts` mounts the note
view and delivers events to it.

## Layout

| Path | Role |
| --- | --- |
| `src/lib/data.ts` | The inert declaration: the `notes` and `folders` tables. |
| `src/lib/editor/schema.ts` | The bounded ProseMirror schema. |
| `src/lib/editor/markdown.ts` | Markdown to document and back, the equivalence it is held to, the check that gates opening and editing, and `bodyCodec`, which decodes and encodes a note's whole body. |
| `src/lib/editor/rich-text.ts` | ProseMirror commands, plugins, the rule that puts each transaction's Markdown in the query cache before it is shown, and semantic state replacement when the cached body changes. `EditorView.state` owns the cursor, pending formatting, and undo history. |
| `src/lib/note-source.ts` | The body replacement Rich and Source share (`withBody`), and list previews. |
| `src/lib/notes.svelte.ts` | The query cache: listing and text queries, edits and their per-file write mutations, rollback after a failed write, note, folder, and file actions, Save version, what the detail shows, and the input fence. |
| `src/lib/platform/` | The `#platform/notes-host` seam, its two leaves, and `shell.tauri.ts`, the page side of the shell's commands. |
| `src/routes/components/` | Header, folder list, note list, the note view, files, terminal. |
| `src-tauri/src/lib.rs` | The desktop shell: the folder plugin, the notes scope, the window, close routing. |
| `src-tauri/src/root.rs` | Choosing and resolving the root directory. |
| `src/lib/platform/first-open.ts` | Setting up a folder that has no layout yet, through the attached folder. |
| `src-tauri/src/commands.rs` | The shell's commands, each a thin call into a module below. |
| `src-tauri/src/close.rs` | Whether a close or quit may go ahead. |
| `src-tauri/src/quit.rs` | macOS: a quit from the system becomes an exit request the gate answers. |
| `src-tauri/examples/quit/` | macOS: the real app quit through `terminate:` on a fixture page (`bun run test:quit`). |
| `src-tauri/src/terminal.rs`, `history.rs`, `reveal.rs` | The terminal, per-file history, and reveal. |
| `src-tauri/capabilities/main.json` | What the notes window may call. |
| `native-tests/` | The page's close handling against the shell's real close gate. |

## Tech stack

The [desktop acceptance report](evidence/desktop/README.md) includes native
screenshots, saved Markdown and Git versions, checks, and verified limits. It
was made with the earlier Bun folder host. The
[native migration record](evidence/native-migration/README.md) says what
replaced the host and which native checks are still to be run.

- [SvelteKit](https://kit.svelte.dev) with the static adapter, SSR disabled
- [ProseMirror](https://prosemirror.net) with `prosemirror-history` and `prosemirror-markdown`
- `@epicenter/folder` for the folder, its note and folder listings, and guarded writes; [TanStack Query](https://tanstack.com/query) for the cache the page reads and edits; and `@epicenter/definition` for the declaration
- [Tauri](https://tauri.app) for the desktop shell, with the `tauri-plugin-epicenter-folder` crate owning the directory and its Git history
- `@epicenter/ui` and [Tailwind CSS](https://tailwindcss.com)

## Changed promises

This version edits through the query cache (ADR-0528) and makes versions only
when you ask (ADR-0529). It drops several promises of the version before it:

- There is no draft. An edit is in the note at once and saved at once; there
  is no save bar, no **Try again**, and no **Discard unsaved changes?**
  prompt. A save that is refused or fails puts the note back to the file and
  offers your text to copy, so at most the last moment of typing is lost.
- A change made elsewhere is no longer merged with your edits, and there is
  no review with **Apply**. The save is refused, and the note shows their
  version.
- A note deleted elsewhere is no longer offered back. Your next edit to it is
  refused, and it leaves the list.
- Closing and quitting never ask. They wait for saves to land, then close.
- Saves no longer commit. History grows only through **Save version** and
  your own commits, so each note's history has fewer entries. **Commit saved
  files** is now **Save version**.
- Returning to the window takes a newer file into the open note whenever no
  save is running, and its rich-text undo history starts over when that
  happens.
- Renaming the open note keeps its editor and undo history.
- Every list action reads and writes the same cached note as the note view,
  so a pin or move from the list shows in the open note at once, and the other
  way around.
