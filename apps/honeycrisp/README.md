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
description. Creating default `kv.json` and publishing the definition request
history asynchronously; an early note edit can join that work. Saved notes and
settings stay intact. Identical reopening adds no commit once history settles.
The definition file supports discovery and does not configure Honeycrisp.

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
Recently Deleted, restore, rename a folder) on a note that is open goes into
its draft and saves with it. On a note or folder that is not open it saves the
row in the same form, only over the version the list read: a file changed
elsewhere since is refused, and the list reads the folder again.

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
only after the notes moved and the list was read again. This is not one
atomic step: a note already moved out stays moved out if the delete stops,
and another program can still put a note in the folder after the last read.
A note whose folder is gone shows under All Notes.

## Editing

A note has two views of its body, **Rich text** and **Source**, beside its
title, folder, and pin. Switching between them saves nothing and discards
nothing. **Edit as file** opens the note's whole text instead; its edits save
first. Every edit saves as you make it; typing while a save runs saves next,
and only the latest text waits. A save never changes what is on screen, so the
rich-text view keeps its cursor and undo history across saves.

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

One item is open at a time: a note, or a file's text. Every save is guarded
by the bytes this item last saved or read, so nothing another program wrote
is overwritten without your say.

| What happened | What Honeycrisp does |
| --- | --- |
| Another program changed the file | Nothing happens until your next save. That save merges your edits with their version first: changes to different fields, or to different lines, combine and save with no question. When both changed the same field or lines, it stops with **This changed elsewhere** and shows only those parts; **Apply** saves your choices. **Cancel** leaves **Reload theirs**, which shows their version in place of your edits, and **Keep mine**, which keeps your edits where both changed and their changes everywhere else. If their version no longer reads the way the item opened (a note whose text is not a valid note, or a file that is no longer text), Reload theirs opens it again as what it is now. Nothing is written until you choose. Returning to the window, or running a terminal command, reads the lists again; an open note that holds nothing unsaved takes the newer file, and its undo history starts over. |
| Another program deleted the file | Your next save stops with **This was deleted elsewhere**: **Discard** closes the note, and **Keep mine** creates the file again from your edits. |
| You typed while a save was running | The newer typing saves next. |
| A value is not valid for a note | It is not written; the bar names what to fix, and the next valid edit saves. |
| A save failed | Your text stays, with **Try again**. |
| A save got no reply | It is shown as not confirmed, with **Save again**. If it did land, that save returns the conflict prompt with your own version as theirs. |
| You rename or delete the open item | Its saves finish first, and the rename or delete acts on what it saved last. Typing is paused while a rename, Keep mine, or Reload theirs runs. Edits made while the delete confirmation is open are saved first, then the file is deleted. A file changed elsewhere since is refused, and the open item shows it again as it is now. |
| You open another item while a save failed or conflicted | Honeycrisp asks **Discard unsaved changes?** Discarding lets that draft go; cancelling keeps the item open. Opening the item already open does nothing and does not ask. |

Unsaved text exists only in the open window. Closing the window, quitting the
app (including Cmd+Q), and reloading the page are held back while the open
item's save is running, failed, or conflicted: Honeycrisp waits for running
saves and actions, and asks before discarding the rest. A failed save is not
tried again for you. Unsaved text does not survive the app being killed or
crashing.

While the desktop app answers a close it takes no input: typing, buttons,
menus, and the terminal do nothing until you choose **Keep editing** or the
app closes. The editors stay as they are, with their undo history. A browser
tab has no such step; its leave prompt is the browser's.

Every native close asks the page. The shell cannot infer permission from an
earlier observation of the drafts: once the notes are open, only the page's
answer to that one request lets a close through. A page that does not answer
is asked again on the next attempt, and the window stays.

## Header controls

| Control | What it does |
| --- | --- |
| Status | The most important current fact. Open it for three separate lines: **Drafts** (the open item's save), **Saved files** (files not yet committed), and **Git history** (the last commit attempt), plus recent commits, **Check again**, and **Commit saved files**. |
| Files (Ctrl+B) | The file browser for the same directory: open, create, rename, and delete any file. **Reveal folder** opens the directory in the system file manager. |
| Terminal (Ctrl+`) | A shell in the same directory. Its output, history, typed command, and working directory stay while it is hidden. |

On the desktop the terminal runs each command in `/bin/sh` with the real
`git`, so it is exactly an outside program editing the same files. It is a
command runner, not a terminal emulator: a command gets no keyboard input, and
its output appears when it ends. `cd` carries to the next command; environment
changes do not. A command is stopped after two minutes, along with anything it
started, and output past 1 MB is cut off. In the browser build the terminal is
an emulated shell over the browser folder with a subset of Git commands.

## Git

History is ordinary Git in `<root>/.git`. A successful content save from an
editor or the file browser is committed, and the save does not wait for the
commit. A commit that fails is reported under **Git history** and leaves the
saved file saved; it is never shown as a save error. The browser terminal
follows the same automatic history policy. Desktop terminal commands and other
programs edit disk directly; their changes enter the next commit, automatic or
explicit. In the browser terminal, automatic history refuses `git add` and
`git commit`; staged authoring requires a folder opened with
`commitOnEdit: false`.

Each note has a **History** button listing its commits. Choosing a version
puts it in the open note, which saves it like any edit. A version that
is not text, or is larger than 16 MB, is refused instead of shown.

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
                                 commands. Frontmatter and drafts stay in the
                                 page.
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

The open item is an edit session from `@epicenter/svelte/edit-session`: a
note is a row session over `folder.tables.notes.autosave`, and any file's text
is a text session over `folder.files.autosave`. The page owns the draft;
each edit requests a save, one write runs at a time with only the latest
waiting, and each write is guarded by the bytes the previous one saved. A
field change to a row that is not open is `tables.<name>.replace` on the row
the list read. A new note or folder is `tables.<name>.create`. Every other
change names a capture: `files.create` for a file that must not exist, and
`files.move` and `files.remove` on the capture the session saved last or a
fresh read. Nothing follows `folder.onFilesChanged`: the page reads the
folder when it opens, after its own actions, and when you return to it.

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
confirmed it is absent, on the condition that it still is. The owner requests
history asynchronously after that save; an early note edit can join the same
commit. Existing settings are kept. Folder acquisition separately publishes
`epicenter.json` through the same save and automatic-history policy. A
directory another Epicenter holds is reported as in use and gains no file.

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

The terminal is an outside writer, exactly as another program is. It requests
no commit. The folder plugin notices its changes, and the page rereads after
each command.

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
   loading, or whose folder failed to open, holds no draft.
3. After that every close is held and the page receives a `close-requested`
   event naming a request. The page stops taking input, then saves what it
   can. With nothing left unsaved it approves; otherwise it asks, and **Keep
   editing** declines and takes input again. Input stays stopped while an
   approval is on its way. It is taken again only when the gate answers that
   the approval was not taken because the page was replaced or the request
   was already answered. Any other failure leaves input stopped, and the
   next close is asked again.
4. Only an approval naming the current page and the current request lets the
   close through. A declined request, a request from before a reload, and a
   second answer are refused.

A page that never answers is asked the same request again on the next attempt.
Nothing in the shell approves on its behalf, so if the page's process dies
after the notes opened, the window can only be force-quit, which loses any
unsaved draft. Until then a logout or restart stays cancelled.

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
| A save that fails: your text stays editable, with **Try again** | `chmod a-w notes`, then edit a note | `chmod u+w notes`, then **Try again** |
| A commit that fails while the file stays saved | `touch .git/refs/heads/main.lock`, then edit a note | `rm .git/refs/heads/main.lock`, then **Commit saved files** |
| An outside edit reaches an idle note | With a note open and saved, edit `notes/<id>.md` in the terminal | The note shows the new text |
| A change made elsewhere: merged, or asked about | Open the folder in two windows, type in a note's title in one, and change the same note in the other before the first window regains focus | A different field merges with no question; the same title shows the review, then **Apply**, or **Cancel** for **Reload theirs** or **Keep mine** |
| A note file deleted under you: nothing writes it back until you choose | With a note open, `rm notes/<id>.md`, then type in it | **Keep mine**, or **Discard** |

What cannot be produced by hand in the running app is a save held open or
slowed on purpose, so that typing lands while it runs, or a reply lost after
the write landed. Those orders are fixed in tests instead, with faults in the
browser folder's storage stand-in: `src/lib/notes.test.ts` holds a save and
types during it, fails writes, and changes or deletes a file under an open
note. `src/routes/components/NoteDetail.dom.test.ts` mounts the note view and
delivers events to it.

## Layout

| Path | Role |
| --- | --- |
| `src/lib/data.ts` | The inert declaration: the `notes` and `folders` tables. |
| `src/lib/editor/schema.ts` | The bounded ProseMirror schema. |
| `src/lib/editor/markdown.ts` | Markdown to document and back, the equivalence it is held to, the check that gates opening and editing, and `bodyCodec`, which decodes and encodes a note's whole body. |
| `src/lib/editor/rich-text.ts` | ProseMirror commands, plugins, the rule that puts each transaction's Markdown in the draft, and semantic state replacement. `EditorView.state` owns live editing state. |
| `src/lib/note-source.ts` | The body replacement Rich and Source share (`withBody`), and list previews. |
| `src/lib/notes.svelte.ts` | Listings, the one open item (in `@epicenter/svelte/open-item`) and its edit session, conflict choices, note and folder actions (counted by `@epicenter/svelte/admissions`), and the input fence. |
| `src/lib/platform/` | The `#platform/notes-host` seam, its two leaves, and `shell.tauri.ts`, the page side of the shell's commands. |
| `src/routes/components/` | Header, folder list, note list, the note view and its save bar, files, terminal. |
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
- `@epicenter/folder` for the folder, its note and folder listings, and guarded autosave; `@epicenter/svelte/edit-session` for the open item's draft; and `@epicenter/definition` for the declaration
- [Tauri](https://tauri.app) for the desktop shell, with the `tauri-plugin-epicenter-folder` crate owning the directory and its Git history
- `@epicenter/ui` and [Tailwind CSS](https://tailwindcss.com)

## Changed promises

This version is built on `@epicenter/folder`'s guarded autosave and the shared
edit sessions, and dropped several promises of the version before it:

- An open note no longer saves last-writer-wins over changes made elsewhere,
  and there is no **Reload file** button. Every save is guarded; a change
  made elsewhere is a conflict, and Reload theirs lives in the conflict
  prompt. Returning to the window still never replaces an open note's text.
- A note deleted elsewhere is no longer kept with **Save as a note** at a new
  name when its path is taken. **Keep mine** creates it again at its own
  path, and **Discard** closes it.
- One item is open at a time. Switching no longer keeps each file's editor
  and text; leaving an item whose save failed asks to discard it.
- Change reports from the folder no longer reread the lists while you work.
  The lists read again on open, after your actions, and when you return.
- List actions on a note that is not open no longer patch one field keeping
  every other byte; they write the note's standard form, guarded by the
  version the list read.
- Text a file cannot hold (a lone surrogate) is no longer refused with a
  notice; it becomes U+FFFD as you type.
- A note with a bad field no longer keeps the list actions whose fields read.
  It is listed under **Needs repair** and opens as text. **Set the missing
  fields to their defaults** is gone.
- **Edit as file** is a separate open of the note's text, after its saves
  land, not a second view of one editor.
- **Not confirmed** records are gone. A change to a file that is not open
  whose reply was lost is reported once; nothing tracks it afterwards, and it
  does not hold a close. The **Compare and choose** view of a text file's
  draft against the file is gone, with the per-file rename and delete
  tracking that went with it.
- The first save of a hand-written note rewrites its frontmatter as plain
  YAML; comments and custom quoting are not kept.
- Reload theirs on a file that is no longer text, or on a note whose text no
  longer reads as a note, no longer keeps your draft with a notice. It takes
  their version and opens the file again as what it is now (its text for
  repair, or why it cannot be opened), so Keep mine is no longer offered
  afterwards.
- Returning to the window, or a terminal command, now takes a newer file into an open note that holds nothing unsaved, so a pull in the terminal is not met as a conflict. Its rich-text undo history starts over when that happens.
