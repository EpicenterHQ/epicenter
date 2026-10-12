# Capture

Capture keeps dated captures, newest first. Each capture is one Markdown file:
its text, then its thoughts as a bullet list under `## Thoughts`. The files
are the saved data, and Git records their history. There is no account and no
sign-in on this path. The file format and its rules are in
[`packages/capture`](../../packages/capture/README.md).

There are two builds of the same UI, and the build decides where the folder is:

| Build | Folder | History |
| --- | --- | --- |
| Desktop, inside Epicenter | An ordinary directory, owned by the Epicenter desktop shell. | Real Git in that directory's `.git`, recorded by the shell. No remote. |
| Browser | One directory in this browser's origin private file system (OPFS), `Epicenter/local/so.epicenter.capture`. | Git in that directory's `.git`, in OPFS beside the files. No remote. |

The browser opens the OPFS directory alone. It does not read, copy, or delete
a folder an earlier version kept in IndexedDB.

Run the browser build with `bun dev:capture` (or `bun dev:capture:ui`) from
the repository root. It starts the app and nothing else. Start `bun dev:api`
yourself only to export old captures from a hosted account, described below.

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
  text to copy. A write whose reply was lost is checked by the folder; if it
  landed, it is saved.
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
  stay loaded. When Epicenter quits or restarts, it asks the window first.
  The window stops taking input at once and waits for writes and actions
  already running. If no text is left unadded, it says so. Otherwise it
  offers **Keep working** or **Discard and quit** (or **Discard and
  restart**). Text not added is never added on its own because Epicenter is
  quitting. Neither choice changes your text: if another window keeps
  Epicenter open, everything is as it was.
- If Epicenter closes the folder, the window says saving cannot be
  confirmed. Your text stays so you can copy or download it.
- If Epicenter's background service stops, the window says so. Saving does
  not depend on that service and carries on; reloading the window may not
  work until Epicenter restarts.

Nothing persists text not added across a reload or a quit you confirm.

## Captures from before this version

Earlier versions kept captures in your Epicenter account, not in files. The
timeline's "Bring in captures from before this version…" link opens a screen
that copies them in. Nothing on it runs unless you press a button, and the
old data is only read.

1. **Get an export.** Either choose an export file (JSON) saved earlier, or
   use your account: sign in, then export. The export holds what this device
   has for your account. A device that has not finished syncing has less than
   the account; export again later to pick up the rest.
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

The Epicenter desktop shell owns that directory, through the shared folder
plugin in
[`packages/tauri-plugin-epicenter-folder`](../../packages/tauri-plugin-epicenter-folder/README.md).
Its README states what the owner promises and what it does not. What that
means for Capture:

- One Epicenter owns the directory at a time, through a lock file beside it,
  `.so.epicenter.capture.epicenter-lock`. A second one is refused with a
  message naming the directory.
- Other programs are not asked to take the lock. Every write, delete, and
  import names the version of the file this window last wrote or read, and
  the owner refuses it if the file is no longer that version, so another
  program's edit is a conflict, not overwritten. A new capture and an
  imported file are created only where no file is. An edit in the instant
  between the owner's last check and its change can still be overwritten:
  none of these is an operating-system compare-and-swap.
- The owner watches the directory and announces changes. Capture does not
  follow those announcements; it reads the folder when the window regains
  focus.
- Writes never request history. The owner commits only when the window
  asks with Save version.
- History is local-only. The shell registers the Capture folder to take the
  commit author from the directory's Git config when one is set there
  (otherwise `Capture <capture@localhost>`), to ignore that config's
  `origin`, and with no remote. So nothing is fetched or pushed, whatever
  remote the directory names. Capture has no control that fetches, pulls, or
  pushes. The policy in effect is on the folder's Git snapshot.
- The owner refuses a directory whose `.git` is a symbolic link or a
  `gitdir:` file (a linked worktree or submodule).

### How it is wired

```text
Capture window (WebView)
   openFolder({ id, definition })  from @epicenter/folder/tauri
        |  Tauri invoke: plugin:epicenter-folder|attach, read, apply, commit, ...
        |  Tauri events: folder-files-changed, folder-snapshot-changed
        v
Epicenter shell (Rust)  ->  tauri-plugin-epicenter-folder  ->  <directory>
```

The page names the folder by its ID, `so.epicenter.capture`
(`CAPTURE_FOLDER_ID` in `src/lib/platform/types.ts`), and nothing else. The
shell registered that ID with its directory, its history policy, and
the windows that may use it, so a page cannot ask for an arbitrary path or
choose an author or a remote. There is no HTTP route and no Bun process
between the window and its files.

`src/lib/platform/folder.epicenter-host.ts` is the whole desktop leaf. It
calls `openFolder` from `@epicenter/folder/tauri`, which opens the shell's
folder or returns why it cannot, and hands the folder to the same store the
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
the `CaptureFolder` type in `src/lib/platform/types.ts`. The plugin
grants an authorized Capture window the whole Capture directory and nothing
outside it; there is no per-call allowlist.

Capture opens no terminal. A folder loads its terminal with a dynamic
import, so each build emits that chunk, and the page never requests or runs
it.

The build Epicenter serves is selected by the `epicenter-host` condition on
`#platform/folder`. That leaf opens no browser folder, so it cannot fall back
to browser storage. Outside the shell, in a window the folder does not allow, with no
folder registered, or with no plugin installed, opening fails and the page
shows the reason.

### What closing and stopping mean

| Event | What happens |
| --- | --- |
| The page is destroyed or reloaded | `captures.close()` refuses input and waits until no write or action is running before `host.close()` detaches this page's session. Teardown writes no unadded text. The folder stays open in the shell for its other windows. |
| The Capture window is closed | The shell hides it. The page, its open capture, and its text stay loaded. |
| The shell closes the folder | The folder's Git snapshot arrives with `closed`. The window says saving cannot be confirmed and keeps the text on screen. |
| Epicenter's Bun service stops (`host-stopped`, sent to this window) | A notice. The folder is the shell's, so saving carries on. The service served this page, so a reload may fail until Epicenter restarts. |
| A reply to a write is lost | The folder checks whether it landed. If it did, it is saved; if not, the capture shows the file as it is and the notice offers your text to copy. |

### Quitting and restarting

Epicenter asks its windows before it quits, or restarts for an account
change, over the departure wire that `@epicenter/epicenter/departure`
publishes (`apps/epicenter/src/departure-wire.ts`). That module states the
wire and its page rules. The page answers through the shared client
`@epicenter/epicenter/departure/page`, bound to this window by
`@epicenter/epicenter/departure/window`, and attaches the store's
`captures.departure` to it. The host runs one round for every window it
serves and decides; this page answers only for its own text not added.

| Host to page | Page to host |
| --- | --- |
| Event `departure-changed`, sent to this window: read the status again | `invoke('departure_status')`, which returns the status |
| | `invoke('departure_answer', { generation, round, answer })`: `asking`, then `ready` or `cancel` |
| Event `host-stopped`, sent to this window | None. The page shows the notice above. |

What the shared client does for this page:

- It registers its listener on this window, then reads the status. The folder
  opens only once a status is known; if registration or that read fails, the
  page says so and offers Try again.
- A round it has not handled fences every input and action before anything
  is awaited. With nothing unsaved, it answers `ready`. Otherwise it answers
  `asking`, then settles: every write and action already running finishes.
  With no text left unadded, it answers `ready`.
  Otherwise the person chooses Keep working (`cancel`) or Discard and quit,
  or restart (`ready`). Neither choice closes, discards, or changes what the
  page holds.
- A round that arrives while the folder opens fences the store as it
  attaches; a page whose folder did not open answers `ready`, and its Try
  again stays disabled until the round ends.
- The same round with no vote means Quit was pressed again: a page still
  deciding sends `asking` again, and never asks the person a second time. A
  newer round is taken up while the page stays fenced.
- Once the page has answered `ready` or `cancel` for a round, any read of that
  round that does not show its answer (lost, or reset by Quit pressed again)
  sends the same answer again, with no new question and nothing changed.
- Only an `idle` status newer than the round gives the page back. `granted`,
  `leaving`, and a `discarded` vote keep it fenced and close the question. A
  lost or refused answer never gives it back; a nudge, Check again, or focus
  while fenced reads the status again. Older statuses are ignored.
- Settling waits until the page's query client has no mutation running: a
  write, a create, a delete, an import, or Save version. Closing the page
  waits for the same.

Which quit paths the host routes through a round, and what it does for a
window that stays silent, are the host's; see `apps/epicenter`.

## Layout

| Path | Role |
| --- | --- |
| `src/lib/platform/` | The `#platform/folder` seam: `types.ts` is its contract, `folder.browser.ts` opens the OPFS folder, `folder.epicenter-host.ts` attaches to the shell's directory and opens the shared departure client over this window's port. `auth.*.ts` is used only by the old-data export. |
| `src/lib/captures.svelte.ts` | The store, over a TanStack Query cache: the capture listing and a capture's text as queries, `edit` and `editText` that change the cache and queue a write per file, each action (create, delete, Save version, import) as a mutation, which capture is open, departure, and close. |
| `src/lib/capture-form.svelte.ts` | One capture's input not added yet (a new thought, a thought edit) and the commands that turn a change of text or thoughts into a new body for `edit`. |
| `src/lib/item-actions.ts` | Deleting a capture with its confirmation. |
| `src/lib/recovery/` | Opens the old account store for an export. Loaded only from the recovery screen. |
| `src/lib/components/` | `CaptureApp.svelte` shows the timeline, the recovery screen, or the open capture, and the header's Save version; `CaptureDetail.svelte` and `TextDetail.svelte` are the open capture as text and thoughts or as Markdown, each reading the cache. Each is keyed by the open capture. |

The package exports nothing. No host imports a part of this app.

## Checks

```sh
bun run --cwd packages/folder build:addon   # once: the exchange a directory folder replaces files with
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
| `src/lib/captures.test.ts` | The store and its query cache over a real browser folder: creating and listing, an edit written at once keeping undeclared metadata, rapid edits with one write running and one waiting, no read while a write runs (on focus or when a view mounts), a conflicting or failed write rolled back with its lost text reported, a deleted file, changes the body or the folder cannot hold, repair as text, thought text kept per capture, stale thought commands, guarded delete after the writes land, Save version and no commit on its own, departure, close, and import. |
| `src/lib/platform/folder.epicenter-host.test.ts` | The desktop leaf over the real folder adapter and the real store, with the shell's `invoke` and events scripted: refusals fail the open, departure is heard on this window only, closing detaches once and waits for writes, a write is one guarded replacement, an outside edit is a conflict that is not overwritten, a lost reply is confirmed when it landed and reported when it did not, Save version commits and rewrites nothing, a closed folder is reported, and an interrupted import is finished by a retry. It does not run the Rust owner. |
| `src/lib/platform/departure.test.ts` | The real store behind the shared departure client: a ready vote changes nothing it holds, its open capture comes back unchanged after another page cancels, and settling waits for a held write. The client's own rules are tested in `apps/epicenter/src/departure-page.test.ts`. |
| `src/lib/platform-selection.test.ts` | Which leaf each build bundles: the desktop bundle has the desktop adapter, of the host package only its departure wire, page client, and window port, and no browser adapter, browser storage, Git implementation, or Node module; the browser bundle has the browser adapter and no desktop adapter, generated bindings, or departure gate. |
| `src/lib/components/capture-detail.mounted.test.ts`, `timeline.mounted.test.ts` | The real views mounted in jsdom inside the query client over the real store: text and thoughts written, a conflicting write rolled back in the text box, a change elsewhere shown on return, a thought not added kept to copy, repair as text with live issues and Open as capture, input refused while quitting, the New capture text box and Add capture, and the repair list's Edit as text. jsdom has no layout, focus, selection, or IME. |

The Rust owner, its watcher, its lock, and its history are tested in
`packages/tauri-plugin-epicenter-folder` and in
`packages/folder/src/tauri-native.test.ts`. The desktop window itself is
checked by hand in the Epicenter shell.

| Script | What it checks |
| --- | --- |
| `bun run --cwd apps/capture smoke:browser` | The browser build in Chromium, with two pages sharing one folder: exact saved Markdown, thought edits, keyboard submit, Edit as text, a conflicting write rolled back across pages, Save version, leave warnings, deletion, and an import. Needs a free local port and `bun x playwright install chromium`. |
| `bun apps/capture/scripts/recovery-harness.ts [dir] [bundle.json]` | A standalone tool, not the desktop backend: imports a bundle into a real directory twice, through `@epicenter/folder/bun` with an explicit author and no remote, and prints both reports. Exits nonzero if the retry creates anything. Run `bun run --filter @epicenter/folder build:addon` first, or use `bun run harness:recovery` here, which does. |

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
