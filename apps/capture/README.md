# Capture

Capture keeps dated captures, newest first. Each capture is one Markdown file:
its text, then its thoughts as a bullet list under `## Thoughts`. The files
are the saved data, and Git records their history. There is no account and no
sign-in on this path. The file format and its rules are in
[`packages/capture`](../../packages/capture/README.md).

There are two builds of the same UI, and the build decides where the folder is:

| Build | Folder | History |
| --- | --- | --- |
| Desktop, inside Epicenter | An ordinary directory the Epicenter desktop shell grants to the Capture window. | Real Git in that directory's `.git`, through the system `git`, which the shell runs for the page. Nothing is fetched or pushed. |
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
  saved version. It waits for writes already sent and deletes the file this
  window wrote last. If the file changed elsewhere since, nothing is deleted
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

- Each change is written to the file at once. One write per file runs at a
  time, and at most one waits; the waiting write saves whatever is on screen
  when it runs, so fast typing writes your latest text, not every keystroke.
- The capture view edits text and thoughts; each change is checked to read
  back as written before it is written. A change Markdown would not keep
  (text that opens a code fence and would absorb the Thoughts section, say)
  is not applied, the reason is shown, and the text returns to what is in
  the file. Edit as text to write unfinished Markdown.
- Every write names the version of the file this window last wrote or read.
  When the file changed elsewhere since, or was deleted, the write is
  refused: the capture shows the file as it is now, and a notice says your
  change was not saved and offers **Copy your text**. Nothing is merged. The
  next change writes on top of what is there now.
- A write that fails for another reason is handled the same way: the capture
  shows the file as it is, and the notice names the failure and offers your
  text to copy. A write whose reply was lost is one of these failures: the
  notice says the change may or may not have happened, and the capture shows
  what the file holds now.
- Text you type is kept well formed, so a lone surrogate becomes U+FFFD as
  you type and what is written is what you see.
- The first write of a file written by hand rewrites its frontmatter in the
  standard form: plain YAML, `capturedAt` first, keys Capture does not
  declare kept. Comments and custom quoting in the frontmatter are not kept.
  The body is written exactly.
- Edit as text writes exactly what is typed, valid or not, and keeps the
  file's line endings. Issues are read live from the text, each with its
  line.
- Thought commands name the list they were shown. A thought edit names the
  thought it started from. If that changed before you save (a newer version
  read on return, say), nothing is applied and the edit's text stays in the
  form to copy.
- Capture reads the folder when a view opens, after each of your own
  actions, and when you return to the window. It reads nothing while a write
  runs; the last write to finish reads everything again.
- Opening and listing captures write nothing.
- **Git is separate.** Writing a file never commits. A version is recorded
  only when you press Save version, and the notice after it says what
  happened, with Git's own message when it fails. Save version waits for
  writes still running, and is refused, like every other action, while
  Capture closes or Epicenter quits or restarts.

## Text not added yet

Text you typed and did not add lives only in the open window: the New
capture text, a thought typed in Add a thought, and a thought being edited.
Any typed character counts, spaces included, until you add it or clear it.

- Each capture keeps its own Add a thought text and thought edit while you
  open other captures. Leaving a capture never asks anything.
- The New capture text stays in its form while you open and leave captures.
- Reloading, closing the tab, or leaving the app asks first while any of it
  exists or a write is still running. The reload shortcut is refused with a
  message.
- On the desktop, closing the Capture window hides it; the page and its text
  stay loaded. Quitting or restarting Epicenter asks nothing, and text not
  added is lost, as it is when any app quits.
- If Epicenter's background service stops, the window is created again once
  the service is back, and text not added is lost.

Nothing persists text not added across a reload or a quit you confirm.

## Captures from before this version

Earlier versions kept captures in your Epicenter account, not in files. The
timeline's "Bring in captures from before this version…" link opens a screen
that copies an export of them in. Nothing on it runs unless you press a
button.

1. **Choose an export.** An export file (JSON) saved from that screen in an
   earlier version.
2. **Import.** Each old capture becomes one Markdown file with its thoughts
   in order and its original date. Earlier entries become their own files.
   Thoughts whose capture is missing are kept in a recovery file that says so.
   Anything that could not be read is listed in a report in `recovery/`.

Importing the same export twice adds nothing twice, and nothing is
overwritten. The exact rules, including what happens after you delete an
imported capture, are in the
[package README](../../packages/capture/README.md#importing-the-old-store).

`fixtures/legacy-bundle.json` is an export file for trying this without
signing in.

## Desktop, inside Epicenter

The captures are files in `so.epicenter.capture/captures` under Epicenter's
working-copy directory (`~/Epicenter/so.epicenter.capture` in production).
The timeline shows the directory. Edit the files with any program: Capture
reads the folder again when the window regains focus. An open capture shows
another program's edit then. A write from Capture that meets an edit it has
not read yet is refused, and the capture shows the other program's version.

The page opens that directory with the same folder engine the browser
build runs, over a directory the Epicenter desktop shell grants it
([ADR-0531](../../docs/adr/0531-the-page-runs-the-folder-engine-and-the-shell-grants-the-directory.md)).
The shell's side is the shared folder plugin in
[`packages/tauri-plugin-epicenter-folder`](../../packages/tauri-plugin-epicenter-folder/README.md),
whose README states what a grant allows. What that means for Capture:

- One Epicenter holds the directory at a time, through a lock file beside
  it, `.so.epicenter.capture.epicenter-lock`, which the shell takes at the
  first grant and keeps until it shuts down. A second Epicenter is refused
  with a message naming the directory.
- Other programs are not asked to take the lock. Every write, delete, and
  import names the version of the file this window last wrote or read, and
  the folder refuses it if the file is no longer that version, so another
  program's edit is a conflict, not overwritten. A new capture and an
  imported file are created only where no file is. An edit in the instant
  between the folder's last check and its change can still be overwritten:
  none of these is an operating-system compare-and-swap.
- Nothing watches the directory. Capture reads the folder again when the
  window regains focus and after its own actions.
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
   openFolder({ id, definition })  from @epicenter/folder/tauri
   the folder engine, in the page
        |  plugin:epicenter-folder|grant_directory   -> { root, branch, author }
        |  plugin:epicenter-folder|read_folder_directory, stat_folder_path,
        |    read_folder_file                        -> reads under <root>
        |  plugin:epicenter-folder|write_folder_file, rename_folder_path,
        |    remove_folder_path, make_folder_directory -> changes, path-checked
        |  plugin:epicenter-folder|run_git           -> the system `git` in <root>
        v
Epicenter shell (Rust)  ->  tauri-plugin-epicenter-folder  ->  <directory>
```

The page names the folder by its ID, `so.epicenter.capture`
(`CAPTURE_FOLDER_ID` in `src/lib/platform/types.ts`), and nothing else. The
shell registered that ID with its directory, a fallback author, and the one
window that may use it (`capture`), so a page cannot ask for an arbitrary
directory. There is no HTTP route and no Bun process between the window and
its files.

`src/lib/platform/folder.epicenter-host.ts` is the whole desktop leaf. It
calls `openFolder` from `@epicenter/folder/tauri`, which asks the shell for
the directory and opens it, or returns why it cannot, and hands the folder
to the same store the
browser build uses. The browser leaf calls `openFolder`
from `@epicenter/folder/browser` and states its own history policy: a local
author and no remote. Each entry refuses in the
other environment. `vite.config.ts` points the bare `@epicenter/folder`
specifier, which `@epicenter/capture` imports, at the same entry, so a build
emits one adapter.

Capture uses the folder's captures table (`list`, `get`, `create`,
`replace`, and `delete`, each write guarded by the version it replaces), its
files for editing a capture as text and for the legacy import (`read`,
`create`, and `replace`), and the Git snapshot, `status`, and `commit`. That
surface is
the `CaptureFolder` type in `src/lib/platform/types.ts`. A grant lets the
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
| The page is destroyed or reloaded | `captures.close()` refuses input and waits until no write or action is running before `host.close()` closes the page's folder. Teardown writes no unadded text. Work still running when a page is torn down without closing stops; the files and Git stay as it left them, and the next open cleans the engine's scratch files. |
| The Capture window is closed | The shell hides it. The page, its open capture, and its text stay loaded. |
| Epicenter's Bun service stops | The shell destroys the window and creates it again once the service is back; the page reopens its folder. Text typed and not added is lost. |

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
| `src/lib/platform/` | The `#platform/folder` seam: `types.ts` is its contract, `folder.browser.ts` opens the OPFS folder, `folder.epicenter-host.ts` opens the directory the shell grants. `auth.*.ts` is used only by the old-data export. |
| `src/lib/captures.svelte.ts` | The store, over a TanStack Query cache: the capture listing and a capture's text as queries, `edit` and `editText` that change the cache and queue a write per file, each action (create, delete, Save version, import) as a mutation, which capture is open, and close. |
| `src/lib/capture-form.svelte.ts` | One capture's input not added yet (a new thought, a thought edit) and the commands that turn a change of text or thoughts into a new body for `edit`. |
| `src/lib/item-actions.ts` | Deleting a capture with its confirmation. |
| `src/lib/components/` | `CaptureApp.svelte` shows the timeline, the recovery screen, or the open capture, and the header's Save version; `CaptureDetail.svelte` and `TextDetail.svelte` are the open capture as text and thoughts or as Markdown, each reading the cache. Each is keyed by the open capture. |

The package exports nothing. No host imports a part of this app.

## Checks

```sh
bun test packages/capture
bun run --cwd apps/capture test             # unit tests, then the mounted components
bun run --cwd packages/capture typecheck
bun run --cwd apps/capture typecheck        # both seam leaves and the scripts
bun run --cwd apps/capture build            # browser
bun run --cwd apps/capture build:epicenter  # the build Epicenter serves
bun scripts/check-ui-boundary.ts
```

The two builds share SvelteKit's output directory, so run them one after the
other. The mounted tests run with `--conditions=browser --conditions=svelte`
(`test:mounted`), so Svelte and the UI kit resolve as a page build resolves
them.

| Test | What it checks |
| --- | --- |
| `src/lib/captures.test.ts` | The store and its query cache over a real browser folder: creating and listing, an edit written at once keeping undeclared metadata, rapid edits with one write running and one waiting, no read while a write runs (on focus or when a view mounts), a conflicting or failed write rolled back with its lost text reported, a deleted file, changes the body or the folder cannot hold, repair as text, thought text kept per capture, stale thought commands, guarded delete after the writes land, Save version and no commit on its own, close, and import. |
| `src/lib/platform/folder.epicenter-host.test.ts` | The desktop leaf over the real `@epicenter/folder/tauri` page engine and the real store, on a temporary directory with the system `git`; the shell's `invoke` is scripted to grant that directory and carry out its commands there (`granted-directory.test-support.ts`). Refused grants fail the open, a write saves the row, an outside edit is a conflict that is not overwritten, closing waits for a save already sent, Save version commits and rewrites nothing, and an import whose export reply was lost is finished by a retry. It does not run the shell's path or Git checks. |
| `src/lib/platform-selection.test.ts` | Which leaf each build bundles: the desktop bundle has the desktop adapter, nothing of the host package, and no browser adapter, browser storage, Git implementation, or Node module; the browser bundle has the browser adapter and no desktop adapter or generated bindings. |
| `src/lib/components/capture-detail.mounted.test.ts`, `timeline.mounted.test.ts` | The real views mounted in jsdom inside the query client over the real store: text and thoughts written, a conflicting write rolled back in the text box, a change elsewhere shown on return, a thought not added kept to copy, repair as text with live issues and Open as capture, input refused while quitting, the New capture text box and Add capture, and the repair list's Edit as text. jsdom has no layout, focus, selection, or IME. |

The granted opener and the directory engine are tested in
`packages/folder/src/tauri-directory.test.ts` and
`packages/folder/src/directory-folder.test.ts`; the grant, the lock, the path
checks, and the Git checks in `packages/tauri-plugin-epicenter-folder`. The
desktop window itself is checked by hand in the Epicenter shell.

| Script | What it checks |
| --- | --- |
| `bun run --cwd apps/capture smoke:browser` | The browser build in Chromium, with two pages sharing one folder: exact saved Markdown, thought edits, keyboard submit, Edit as text, a conflicting write rolled back across pages, Save version, leave warnings, deletion, and an import. Needs a free local port and `bun x playwright install chromium`. |
| `bun apps/capture/scripts/recovery-harness.ts [dir] [bundle.json]` | A standalone tool, not the desktop backend: imports a bundle into a real directory twice, through `@epicenter/folder/bun` with an explicit author and no remote, and prints both reports. Exits nonzero if the retry creates anything. `bun run harness:recovery` runs it from here. |

## Changed promises

This version edits the files through a query cache (ADR-0528) and records
versions only on request (ADR-0529). It dropped several promises of the
version before it:

- A write that meets a change made elsewhere is no longer merged, and there
  is no review with Your edit and Saved elsewhere. The write is refused, the
  capture shows the file as it is, and a notice offers the text that was
  lost to copy. The same holds for a file deleted elsewhere: a write never
  creates it again.
- A failed write no longer keeps your text in the capture with Try again or
  Save again. The capture shows the file, and the notice offers your text.
- Leaving a capture never asks to discard anything. A thought typed and not
  added, and a thought edit, stay with their capture until you add or clear
  them.
- Writes no longer commit. History was recorded after every save; now it is
  recorded only by Save version, so a folder whose person never saves a
  version has no history. The "History was not recorded" notice is gone.
- Returning to the window shows a newer version of the open capture, even
  when a thought is typed there and not added.
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
- Change reports from the folder no longer reread the timeline, and the
  30-second relisting is gone.
- The first write of a hand-written file rewrites its frontmatter as plain
  YAML. Comments in the frontmatter are lost. The previous standard form was
  JSON-style quoted keys.
- Imported captures are written in the same plain YAML form, and a retry
  counts a file an earlier import wrote in another form as the same capture.
- Import reports can no longer be viewed in the app. The recovery screen
  prints the paths of the report, the saved export, and the receipt under
  `recovery/`; on the desktop they are files in the folder, and in the
  browser build nothing shows them.
- A commit is refused while Capture closes or Epicenter quits or restarts,
  and says so, as every other action does.
