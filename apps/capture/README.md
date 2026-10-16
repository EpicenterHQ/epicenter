# Capture

Capture keeps dated captures, newest first. Each capture is one Markdown file:
its text, then its thoughts as a bullet list under `## Thoughts`. The files
are the saved data, and Git records their history. There is no account and no
sign-in on this path. The file format and its rules are in
[`packages/capture`](../../packages/capture/README.md).

There are two builds of the same UI, and the build decides where the folder is:

| Build | Folder | History |
| --- | --- | --- |
| Desktop, inside Epicenter | An ordinary directory the Epicenter desktop shell grants to the Capture window. | Real Git in that directory's `.git`, through the system `git`, which the `epicenter` CLI runs for the page, one child per operation. Nothing is fetched or pushed. |
| Browser | One directory in this browser's origin private file system (OPFS), `Epicenter/local/so.epicenter.capture`. | Git in that directory's `.git`, in OPFS beside the files. No remote. |

The browser opens the OPFS directory alone. It does not read, copy, or delete
a folder an earlier version kept in IndexedDB.

Run the browser build with `bun dev:capture` (or `bun dev:capture:ui`) from
the repository root. It starts the app and nothing else.

## What you can do

- **New capture** saves the text exactly as written, with an empty Thoughts
  section. The file is named for the time, `captures/20261001-023000-ab12c.md`.
  Ctrl or ⌘ + Enter adds it, and the new capture opens with the cursor in
  Add a thought. Closing the form keeps its text.
- Open a capture from the timeline to edit its text, and to add, edit,
  reorder, copy, and delete thoughts. A thought can span lines and hold
  nested Markdown. Add a thought sits after the last thought, which is where
  a new one goes; Ctrl or ⌘ + Enter adds it. Each thought's Actions menu
  holds Edit, Move up, Move down, Copy text, and Delete.
- **Edit as text** opens the capture's file, frontmatter included, as
  Markdown to edit directly. Anything Markdown allows can go there. **Open as
  capture** goes back once the text reads as a capture.
- **More** holds Copy capture text, Download file, and **Delete capture**.
  Deleting asks first, and says when the capture has changes that are in no
  saved version. It waits for your edit to be saved and deletes the file
  this window wrote last. If the file changed elsewhere since, nothing is deleted
  and the timeline shows the file as it is now.
- **Save version** in the header records every saved capture in the folder's
  Git history. Nothing else records a version.

One capture is open at a time. Moving a thought to another capture has no
control: cut it from one capture and paste it into the other.

The timeline lists only files that read as captures. A file that does not
(frontmatter that does not parse, a `capturedAt` that is not a date and
time, or an ambiguous layout: two "Thoughts" headings, text between the
heading and the list, two lists) is named below the timeline with its path
and why, and opens as text. Nothing is rewritten to make it fit. Files that
are not UTF-8 text are listed apart and not opened.

## Editing

- A capture's text and thoughts are its document, so an edit holds the
  version of the file it started from, taken at your first change, and the
  body you typed (ADR-0548, ADR-0554). What the window reads from the
  folder never replaces it. A thought you add, edit, delete, or move is
  saved at once. The capture text, and a file edited as text, is saved a
  second after you stop typing, when you leave the text box, and when you
  open something else; quitting loses at most that last second. Saves run
  one at a time, and what you typed while one ran goes in the next.
- The capture view edits text and thoughts; each change is checked to read
  back as written before it is saved. A change Markdown would not keep
  (text that opens a code fence and would absorb the Thoughts section, say)
  is not applied, the reason is shown, and the text returns to what it was.
  Edit as text to write unfinished Markdown.
- When the file changed elsewhere since the edit started, the save merges
  with it: what only the other writer changed stays, and where you both
  changed the same field or line, your edit wins and a notice names what of
  theirs it replaced, with **Restore theirs**. Text edited as text merges
  the same way, by line. When the file was deleted, the save is refused: the
  capture leaves the list, and a notice says your change was not saved and
  offers **Copy your text**.
- A save that fails for another reason keeps your edit on screen, the
  capture says Not saved, and the notice names the failure and offers your
  text to copy. Your next change saves it again. A save whose reply was lost
  is one of these failures: the notice says the change may or may not have
  happened.
- Text you type is kept well formed, so a lone surrogate becomes U+FFFD as
  you type and what is written is what you see.
- The first write of a file written by hand rewrites its frontmatter in the
  standard form: plain YAML, `capturedAt` first, keys Capture does not
  declare kept. Comments and custom quoting in the frontmatter are not kept.
  The body is written exactly.
- Edit as text writes exactly what is typed, valid or not, and keeps the
  file's line endings. Issues are read live from the text, each with its
  line. It writes the whole file over the version you started typing on,
  and does not merge: when the file changed elsewhere since, nothing is
  written, the view shows the file as it is now, and a notice offers your
  text to copy.
- Thought commands name the list they were shown. A thought edit names the
  thought it started from. If that changed before you save (a newer version
  another program wrote, say), nothing is applied and the edit's text stays
  in the form to copy.
- Capture reads a capture's file when a view first needs it, and keeps it
  until the folder reports that the file changed: on the desktop, the
  shell's watcher of the directory; in the browser, another tab of Capture
  writing the same folder. Returning to the window reads nothing. Your own
  saves update what the window shows from their result.
- Opening and listing captures write nothing.
- **Git is separate.** Writing a file never commits. A version is recorded
  only when you press Save version, and the notice after it says what
  happened, with Git's own message when it fails. Save version waits for
  edits still being saved, and is refused, like every other action, while
  Capture closes or Epicenter quits or restarts.

## Text not added yet

Text you typed and did not add lives only in the open window: the New
capture text, a thought typed in Add a thought, and a thought being edited.
Any typed character counts, spaces included, until you add it or clear it.

- Each capture keeps its own Add a thought text and thought edit while you
  open other captures. Leaving a capture never asks anything.
- The New capture text stays in its form while you open and leave captures.
- Reloading, closing the tab, or leaving the app asks first while any of it
  exists, a save is still running, or an edit could not be saved. The
  reload shortcut is refused with a message.
- On the desktop, closing the Capture window destroys it, as Epicenter does
  any installed app's window. Quitting or restarting Epicenter asks nothing,
  and text not added is lost, as it is when any app quits.
- If Epicenter's background service stops, the window is closed, and text not
  added is lost; open Capture again from the Folders window.

Nothing persists text not added across a reload or a quit you confirm.

## Desktop, inside Epicenter

Capture installs into Epicenter as an app, from this folder of the Epicenter
repository (ADR-0552); Epicenter compiles no app in. `epicenter.app.json`
names the id `so.epicenter.capture` and the title; Epicenter runs
`bun run build:installed`, which writes `dist`. In the Folders
window, "Install from a repository…" with Epicenter's repository lists Capture
with its folder, `apps/capture`; installing clones the repository into
`~/Epicenter/Apps/so.epicenter.capture/`, and approving it runs `bun install`
at the repository's root and the build here. Opened from the Folders window's
Apps list, Capture opens its own folder, `so.epicenter.capture`. Opened with
"Open in Capture" beside another folder whose declaration contains its shape,
it opens that folder and reads its captures through its shape (ADR-0538): it
never rewrites that folder's `epicenter.json`, and a folder whose declaration
lacks the shape is refused with a message naming the folder.

The captures are files in `so.epicenter.capture/captures` under Epicenter's
working-copy directory (`~/Epicenter/so.epicenter.capture` in production).
The timeline shows the directory. Edit the files with any program: the
shell watches the directory, and an open capture shows another program's
edit as soon as it lands. A save from Capture that meets an edit it has not
read yet merges with it.

The page opens that directory with the same folder engine the browser
build runs, over a directory the Epicenter desktop shell grants it
([ADR-0531](../../docs/adr/0531-the-page-runs-the-folder-engine-and-the-shell-grants-the-directory.md)).
The shell's side is the shared folder plugin in
[`packages/tauri-plugin-epicenter-folder`](../../packages/tauri-plugin-epicenter-folder/README.md),
whose README states what a grant allows. What that means for Capture:

- Every Epicenter process, a second build or the `epicenter` CLI, takes turns
  with this window under the folder's save lock,
  `.so.epicenter.capture.epicenter-save-lock`, across each check and change
  (ADR-0562, ADR-0568).
- Other programs are not asked to take the lock. Every write and delete
  names the version of the file this window last wrote or read. A row write
  merges with another program's edit, keeping what only they changed; a text
  write is refused if the file is no longer that version. A new capture is
  created only where no file is. An edit in the instant
  between the folder's last check and its change can still be overwritten:
  none of these is an operating-system compare-and-swap.
- The shell watches the directory and tells the window which paths
  changed; the page marks exactly those reads stale
  (`folder.onFilesChanged`, wired once in `src/routes/+page.svelte`).
  Nothing is read again on focus.
- Writes never request history. The folder commits only when the window
  asks with Save version.
- History is local. Git's own configuration, global included, names the
  commit author (otherwise `Capture <capture@localhost>`, which the shell
  registers) and any `origin`. Capture has no control that fetches, pulls, or
  pushes, so nothing is fetched or pushed, whatever remote the directory
  names.
- The shell refuses a directory whose `.git` is a symbolic link or a
  `gitdir:` file (a linked worktree or submodule).

### How it is wired

```text
Capture window (WebView)
   openFolder({ id, definition })     its own folder, from @epicenter/folder/tauri
   openDataFolder({ id, lens })       any other folder it is handed
   the folder engine, in the page
        |  plugin:epicenter-folder|grant_directory   -> { root, branch, author }
        |  plugin:epicenter-folder|read_folder_directory, stat_folder_path,
        |    read_folder_file                        -> reads under <root>
        |  plugin:epicenter-folder|write_folder_file, rename_folder_path,
        |    remove_folder_path, make_folder_directory -> changes, path-checked
        |  status, history, save_version             -> one `epicenter` child over <root>
        v
Epicenter shell (Rust)  ->  tauri-plugin-epicenter-folder  ->  <directory>
```

The page names the folder by its scope and nothing else. The shell hands the
window that scope as `?folder=` in its URL (`open_installed_app`): Capture's
own, `so.epicenter.capture` (`CAPTURE_FOLDER_ID` in
`src/lib/platform/types.ts`), or the scope the Folders window listed for
another folder. A window handed none opens Capture's own. The shell registers
Capture's own scope with its directory and a fallback author as an installed
app's own folder, and permits the Capture window into the folder it hands it
(ADR-0552), so a page cannot ask for an arbitrary directory. There is no HTTP route and no Bun process between the window and
its files.

`src/lib/platform/folder.epicenter-host.ts` is the whole desktop leaf. For
Capture's own folder it calls `openFolder` from `@epicenter/folder/tauri`
with `captureDefinition`; for any other folder it calls `openDataFolder` with
`captureDefinition` as the lens, which never writes that folder's declaration
and refuses one without Capture's shape. Either asks the shell for the
directory and opens it, or returns why it cannot, and the leaf hands the
folder to the same store the
browser build uses. The browser leaf calls `openFolder`
from `@epicenter/folder/browser` and states its own history policy: a local
author and no remote. Each entry refuses in the
other environment. `installedAppViteConfig` (from `@epicenter/vite-config`)
points the bare `@epicenter/folder` specifier, which `@epicenter/capture`
imports, at the same entry, so a build emits one adapter.

Capture uses the folder's captures table (`list`, `create`, `save`, and
`delete`, each write guarded by the version it replaces, `save` merging
with a newer one), its files for editing a capture as text (`read`
and `write`), the Git snapshot, `status`,
and `commit`, and `onFilesChanged`. Reads and saves go through the folder's
query options (`folderOptions` from `@epicenter/folder/query`), so every
read is keyed under the folder. The folder is the `CaptureFolder` type in
`src/lib/platform/types.ts`. A grant lets the
Capture window read the Capture directory and nothing outside it; the shell
checks the whole path of every change on disk before making it, and runs
only the Git operations the folder engine uses.

Capture opens no terminal. A folder loads its terminal with a dynamic
import, so each build emits that chunk, and the page never requests or runs
it.

The build Epicenter serves is selected by the `epicenter-host` condition on
`#platform/folder`. That leaf opens no browser folder, so it cannot fall back
to browser storage. Outside the shell, in a window the folder does not allow,
with no folder registered, with the directory held by another Epicenter, or
with no plugin installed, opening fails and the page shows the reason.

### What closing and stopping mean

| Event | What happens |
| --- | --- |
| The page is destroyed or reloaded | The page stops hearing the folder's changes, and `captures.close()` refuses input and waits until every edit held is saved and no write or action is running before `folder.close()` closes the page's folder. Teardown writes no unadded text. Work still running when a page is torn down without closing stops; the files and Git stay as it left them, and the next open cleans the engine's scratch files. |
| The Capture window is closed | The shell destroys it, as it does any installed app's window. Text typed and not added is lost. |
| Epicenter's Bun service stops | The shell destroys the window; open Capture again from the Folders window. Text typed and not added is lost. |

### Quitting and restarting

Quitting Epicenter, or restarting it for an account change, is immediate and
asks this page nothing
([ADR-0542](../../docs/adr/0542-quitting-is-immediate-because-unfinished-work-already-lives-in-its-folder.md)).
Every save is a rename into the folder, so a write cut off at exit leaves the
old file or the new one. The New capture text, a thought typed and not added,
and a thought edit not saved live only in the page, and a quit drops them, as
people expect. In the browser, `captures.unsettled` holds back a reload, a
tab close, or a navigation out of the app while any of them is there or a
write runs.

## Layout

| Path | Role |
| --- | --- |
| `src/lib/platform/` | The `#platform/folder` seam: `types.ts` is its contract, `folder.browser.ts` opens the OPFS folder, `folder.epicenter-host.ts` opens the directory the shell grants. |
| `src/lib/captures.svelte.ts` | The store, over a TanStack Query cache keyed by `folderOptions`: the capture listing and a capture's text as queries, each capture's form (`formOf`), `editText` holding a file's typed text over its version and writing it, each action (create, delete, Save version) as a mutation, which capture is open, and close. |
| `src/lib/capture-form.svelte.ts` | One capture's edit, a body draft (`createBodyDraftState` from `@epicenter/folder/svelte`) saved one save at a time, its input not added yet (a new thought, a thought edit), and the commands that turn a change of text or thoughts into a new body. |
| `src/lib/item-actions.ts` | Deleting a capture with its confirmation. |
| `src/lib/components/` | `CaptureApp.svelte` shows the timeline or the open capture, and the header's Save version; `CaptureDetail.svelte` and `TextDetail.svelte` are the open capture as text and thoughts or as Markdown, each showing the edit not saved yet over the cache. Each is keyed by the open capture. |

The package exports nothing. No host imports a part of this app.

## Checks

```sh
bun test packages/capture
bun run --cwd apps/capture test             # unit tests, then the mounted components
bun run --cwd packages/capture typecheck
bun run --cwd apps/capture typecheck        # both seam leaves and the scripts
bun run --cwd apps/capture build            # browser
bun run --cwd apps/capture build:installed  # the build Epicenter installs
bun scripts/check-ui-boundary.ts
```

The browser build writes `build/` and serves a fallback page. The installed
build writes `dist/` here and prerenders each page with relative asset paths,
so it runs below whatever path the host serves it at. The two builds share
SvelteKit's output directory, so run them one after the other. The mounted tests run with `--conditions=browser --conditions=svelte`
(`test:mounted`), so Svelte and the UI kit resolve as a page build resolves
them.

| Test | What it checks |
| --- | --- |
| `src/lib/captures.test.ts` | The store and its query cache over a real browser folder: creating and listing, an edit saved keeping undeclared metadata, saves one at a time with text typed meanwhile in one more, a reported change read again without replacing an edit not saved, a save merged with a change made elsewhere and what it replaced, a failed save kept and sent again, a deleted file, a change the body cannot hold, repair as text, a text write merged with a change made elsewhere and one to a deleted file, thought text kept per capture, stale thought commands, delete after the edit is saved, Save version and no commit on its own, and close. |
| `src/lib/platform/folder.epicenter-host.test.ts` | The desktop leaf over the real `@epicenter/folder/tauri` page engine and the real store, on a temporary directory with the system `git`; the shell's `invoke` is scripted to grant that directory and carry out its commands there (`granted-directory.test-support.ts`). Refused grants fail the open, a window handed no folder opens Capture's own, a window handed another folder opens it through Capture's shape and keeps its declaration, one without the shape is refused by name, a write saves the row, an outside edit merges with the window's, closing waits for a save already sent, and Save version commits and rewrites nothing. It does not run the shell's path or Git checks. |
| `src/lib/platform-selection.test.ts` | Which leaf each build bundles: the desktop bundle has the desktop adapter, nothing of the host package, and no browser adapter, browser storage, Git implementation, or Node module; the browser bundle has the browser adapter and no desktop adapter or generated bindings. |
| `src/lib/components/capture-detail.mounted.test.ts`, `timeline.mounted.test.ts` | The real views mounted in jsdom inside the query client over the real store: text and thoughts written, a save merged with a change made elsewhere, a reported change shown, a thought not added kept to copy, repair as text with live issues and Open as capture, input refused while quitting, the New capture text box and Add capture, and the repair list's Edit as text. jsdom has no layout, focus, selection, or IME. |

The granted opener and the directory engine are tested in
`packages/folder/src/tauri-directory.test.ts` and
`packages/folder/src/directory-folder.test.ts`; the grant, the lock, the path
checks, and the Git checks in `packages/tauri-plugin-epicenter-folder`. The
desktop window itself is checked by hand in the Epicenter shell.

| Script | What it checks |
| --- | --- |
| `bun run --cwd apps/capture smoke:browser` | The browser build in Chromium, with two pages sharing one folder: exact saved Markdown, thought edits, keyboard submit, Edit as text, a write merged with another page's change, Save version, leave warnings, and deletion. Needs a free local port and `bun x playwright install chromium`. |

## Changed promises

This version reads the files through a query cache that the folder's
change channel keeps current (ADR-0528, ADR-0548), and records versions
only on request (ADR-0529). It dropped several promises of the version
before it:

- There is no review with Your edit and Saved elsewhere. A write that meets
  a change made elsewhere merges with it, and your edit wins where you both
  changed the same lines. A write to a file deleted elsewhere is refused and
  never creates it again; a notice offers the text that was lost to copy.
- A failed save keeps your edit on screen without Try again or Save again
  buttons: your next change saves it again, and the notice offers your
  text. A failed write in Edit as text shows the file, and the notice
  offers your text.
- Leaving a capture never asks to discard anything. A thought typed and not
  added, and a thought edit, stay with their capture until you add or clear
  them.
- Writes no longer commit. History was recorded after every save; now it is
  recorded only by Save version, so a folder whose person never saves a
  version has no history. The "History was not recorded" notice is gone.
- A newer version of the open capture is shown when the folder reports it,
  even when a thought is typed there and not added. Returning to the window
  reads nothing.
- The save bar is gone. The header says Saving… or Saved, and the capture
  says where it is saved.

The version before that one dropped these:

- The Files workspace is gone. There is one timeline. A capture's
  Markdown is edited with Edit as text, and a file that is not a valid
  capture opens that way from the timeline's repair list.
- One capture is open at a time.
- A capture has no address of its own. The page no longer puts the open
  capture in the URL; reloading returns to the timeline.
- Save as a copy, Put the file back, Let it go, Discard my changes, and
  Check again for a removed file are gone.
- Unconfirmed-delete choices are gone. A delete whose reply was lost is
  reported once, and the timeline reads the folder again.
- The 30-second relisting is gone.
- The first write of a hand-written file rewrites its frontmatter as plain
  YAML. Comments in the frontmatter are lost. The previous standard form was
  JSON-style quoted keys.
- Captures from before the file version can no longer be imported. The
  recovery screen and the export format it read are gone.
- A commit is refused while Capture closes or Epicenter quits or restarts,
  and says so, as every other action does.
