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
  Deleting asks first, waits for saves already sent, and deletes the file
  this window saved last. If the file changed elsewhere since, nothing is
  deleted and the capture opens again as it is now.

One capture is open at a time. Moving a thought to another capture has no
control: cut it from one capture and paste it into the other.

The timeline lists only files that read as captures. A file that does not
(frontmatter that does not parse, a `capturedAt` that is not a date and
time, or an ambiguous layout: two "Thoughts" headings, text between the
heading and the list, two lists) is named below the timeline with its path
and why, and opens as text. Nothing is rewritten to make it fit. Files that
are not UTF-8 text are listed apart and not opened.

## Editing and conflicts

- Each change saves at once. One save runs at a time and only the latest
  change waits, so fast typing writes your latest text, not every keystroke.
  A save never changes what is on screen.
- The capture view edits text and thoughts; each change is checked to read
  back as written before it is saved. A change Markdown would not keep (text
  that opens a code fence and would absorb the Thoughts section, say) is not
  applied, the reason is shown, and the text returns to what is saved. Edit
  as text to write unfinished Markdown.
- A save stops with a prompt when the file changed elsewhere since this
  window last saved or read it: **Reload theirs** shows their version in
  place of your text; **Keep mine** saves your text over it. When the file
  was deleted elsewhere, the choices are **Discard**, which closes the
  capture, and **Keep mine**, which creates the file again from your text.
  Nothing is written until you choose.
- A save that fails for another reason keeps your text, names the failure,
  and offers **Try again**. A save whose reply was lost is checked with one read: if your
  text is there, it is saved. Otherwise the window says it may or may not be
  in the file and offers **Save again**.
- A value the file cannot hold is never written; the bar names it, and the
  next valid change saves. Text you type is kept well formed, so a lone
  surrogate becomes U+FFFD as you type and what saves is what you see.
- Typing is paused while Keep mine or Reload theirs runs.
- The first save of a file written by hand rewrites its frontmatter in the
  standard form: plain YAML, `capturedAt` first, keys Capture does not
  declare kept. Comments and custom quoting in the frontmatter are not kept.
  The body is written exactly.
- Edit as text saves exactly what is typed, valid or not, and keeps the
  file's line endings. Issues are read live from the text, each with its
  line.
- A thought edit names the thought it started from. If that thought changed
  before you save (Reload theirs, or a newer version taken on return), the
  edit is not applied and its text stays in the form to copy.
- The timeline reads the folder when the page opens, after each of your own
  actions, and when you return to the window. Returning also takes a newer
  version of the open capture when it holds nothing unsaved and no thought
  typed and not added; otherwise the next save reports the change as a
  conflict.
- Opening and listing captures write nothing.
- **Git is separate.** A file that saved is saved. If the commit that records
  it fails, a "History was not recorded" notice says so and offers the commit
  again, with Git's own message under "Show technical details". It never
  undoes a save. Committing is refused, like every other action, while
  Capture closes.

## Unsaved text is protected

Unsaved text lives only in the open window: a save still being sent, one
that failed or conflicted, text in the New capture form, text in Add a
thought, and a thought being edited. Any typed character counts, spaces
included, until you add it or clear it.

- Leaving a capture whose save failed or conflicted, or that holds a thought
  typed and not added, asks once: **Discard unsaved changes?** Discard lets
  that capture's text go; Cancel keeps it open. Nothing else is kept when you
  leave. Opening the capture already shown does nothing and asks nothing.
- The New capture text stays in its form while you open and leave captures.
- Reloading, closing the tab, or leaving the app asks first while any of it
  exists. The reload shortcut is refused with a message.
- On the desktop, closing the Capture window ends the page and never asks.
  It waits for the saves the page has in flight, with no timeout (see
  [Closing and quitting](#closing-and-quitting)), then the window goes.
  Quitting Epicenter, or restarting it for an account change, closes the
  window the same way. A failed save is not sent again, and text not added
  yet, such as a new thought, is not added: both are lost. The save bar
  already said the save failed.
- If Epicenter closes the folder, the window says saving cannot be
  confirmed. Your text stays so you can copy or download it.
- If Epicenter's background service stops, the window says so. Saving does
  not depend on that service and carries on; reloading the window may not
  work until Epicenter restarts.

Nothing persists unsaved text across a reload you confirm or a quit.

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
reads the folder again when the window regains focus or becomes visible. An
open capture takes another program's edit then if it holds nothing unsaved;
otherwise its next save asks Reload theirs or Keep mine.

The Epicenter desktop shell owns that directory, through the shared folder
plugin in
[`packages/tauri-plugin-epicenter-folder`](../../packages/tauri-plugin-epicenter-folder/README.md).
Its README states what the owner promises and what it does not. What that
means for Capture:

- One Epicenter owns the directory at a time, through a lock file beside it,
  `.so.epicenter.capture.epicenter-lock`. A second one is refused with a
  message naming the directory.
- Other programs are not asked to take the lock. Every save, delete, and
  import names the version of the file this window last saved or read, and
  the owner refuses it if the file is no longer that version, so another
  program's edit is a conflict, not overwritten. A new capture and an
  imported file are created only where no file is. An edit in the instant
  between the owner's last check and its change can still be overwritten:
  none of these is an operating-system compare-and-swap.
- The owner watches the directory and announces changes. Capture does not
  follow those announcements; it reads the folder when the window regains
  focus or becomes visible.
- Complete saves request automatic local history from the owner, whether or
  not a Capture window is still open. While Git is busy, requests coalesce
  and wait for protection. A failed checkpoint stays visible and needs a
  newer save or an explicit commit. The window schedules no commits.
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
author, a commit after each save, and no remote. Each entry refuses in the
other environment. `vite.config.ts` points the bare `@epicenter/folder`
specifier, which `@epicenter/capture` imports, at the same entry, so a build
emits one adapter.

Capture uses the folder's captures table (`list`, `get`, `create`, `delete`,
and `autosave`, each write guarded by the version it replaces), its files for
editing a capture as text and for the legacy import (`read`, `create`,
`replace`, and `autosave`), and the Git snapshot and commit. That surface is
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
| The page is destroyed or reloaded | `captures.close()` refuses input and waits for the page's running actions and the open capture's saves, then detaches this page's session (`host.close()`). Teardown does not send a failed save again, and writes no unadded text. The folder stays open in the shell for its other windows. |
| The Capture window is closed | The page's close handler awaits `captures.close()`, then the window goes. |
| The shell closes the folder | The folder's Git snapshot arrives with `closed`. The window says saving cannot be confirmed and keeps the text on screen. |
| Epicenter's Bun service stops (`host-stopped`, sent to this window) | A notice. The folder is the shell's, so saving carries on. The service served this page, so a reload may fail until Epicenter restarts. |
| A reply to a save is lost | One read checks whether the text landed. If it did, it is saved; if not, the capture keeps its text and offers Save again. |

### Closing and quitting

Closing never asks. The page registers Tauri's `onCloseRequested` for its
window before the captures can be edited (`#platform/window`), and the
handler awaits `captures.close()` (`createClosing` from
`@epicenter/svelte/closing`). Tauri destroys the window when the handler
returns. Epicenter's Quit and an account-change restart close the window the
same way, and leave once every window is gone.

- `captures.close()` waits for every action the page admitted (a create, an
  import, Keep mine, Reload theirs, a delete) and for the open capture's
  saves, including the latest snapshot waiting behind a running write.
- There is no timeout. After about 1,200 ms the page shows "Still saving…"
  with **Close anyway**, which stops waiting and lets the window go.
- A close while the folder is still opening, or after it failed to open,
  goes ahead at once.
- A failed save, a conflict, and unadded text are not held back. They are
  lost on close.
- Quitting from the Dock, logging out, or shutting down reaches Epicenter as
  AppKit's own quit, which closes no window first. Saves the folder owner
  already accepted still land.
- In a browser there is no close handler: one `beforeNavigate` rule raises
  the browser's own "Leave site?" when a reload or a closed tab would unload
  the page while a save runs or has failed.

| Host to page | Page to host |
| --- | --- |
| Event `host-stopped`, sent to this window (`@epicenter/epicenter/host-stopped`) | None. The page shows the notice above. |

## Layout

| Path | Role |
| --- | --- |
| `src/lib/platform/` | The `#platform/folder` seam: `types.ts` is its contract, `folder.browser.ts` opens the OPFS folder, `folder.epicenter-host.ts` attaches to the shell's directory and exports the host-stopped signal for this window. The `#platform/window` seam hears the window asked to close. `auth.*.ts` is used only by the old-data export. |
| `src/lib/captures.svelte.ts` | The store: the timeline and its repair list, how a capture loads, the one open capture in the shared open-item slot (`@epicenter/svelte/open-item`) with its edit session, refusals, the conflict commands, create, delete, import, and commit counted by the shared admissions (`@epicenter/svelte/admissions`), and close. |
| `src/lib/capture-form.svelte.ts` | The capture view's form over an open capture's row session: the body read as text and thoughts, each change encoded over the body and saved, and the new thought and thought edit not saved yet. |
| `src/lib/item-actions.ts` | Opening, leaving, and deleting with the confirmation each may need. A discard names the session the store answered `unsaved` with. |
| `src/lib/recovery/` | Opens the old account store for an export. Loaded only from the recovery screen. |
| `src/lib/components/` | `CaptureApp.svelte` shows the timeline, the recovery screen, or the open capture; `CaptureDetail.svelte` and `TextDetail.svelte` are the open capture as text and thoughts or as Markdown, each with the shared save bar (`@epicenter/svelte/save-bar`) and its conflict prompt. Each is keyed by the open item. |

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
| `src/lib/captures.test.ts` | The store over a real browser folder: creating and listing, whole-row saves that keep undeclared metadata, rapid typing writing only the latest draft, a draft that is not a valid capture never written, a change the body cannot hold refused, the conflict prompt (Reload theirs, Keep mine) and deleted elsewhere (Keep mine recreates, Discard closes), repair as text and reopening as a capture, leaving with a failed save or an unadded thought, guarded delete after the saves land, adopting on return, a stale thought edit, close (a delete waiting on a save, the held snapshot, a failed save), and import. |
| `src/lib/platform/folder.epicenter-host.test.ts` | The desktop leaf over the real folder adapter and the real store, with the shell's `invoke` and events scripted: refusals fail the open, the host's stop is heard on this window only, closing detaches once and waits for saves, a save is one guarded replacement, an outside edit is a conflict, a lost reply is checked by a read, a failed commit and a closed folder are reported, and an interrupted import is finished by a retry. It does not run the Rust owner. |
| `src/lib/platform-selection.test.ts` | Which leaf each build bundles: the desktop bundle has the desktop adapter and the Tauri window leaf, of the host package only its host-stopped page side, and no browser adapter, browser storage, Git implementation, or Node module; the browser bundle has the browser adapter and no desktop adapter, generated bindings, or host signals. |
| `src/lib/components/capture-detail.mounted.test.ts`, `timeline.mounted.test.ts` | The real views mounted in jsdom over the real store: text and thoughts save, the conflict prompt's buttons, Discard and Keep mine after a delete elsewhere, repair as text with live issues and Open as capture, the New capture text box, and the repair list's Edit as text. jsdom has no layout, focus, selection, or IME. |

The Rust owner, its watcher, its lock, and its history are tested in
`packages/tauri-plugin-epicenter-folder` and in
`packages/folder/src/tauri-native.test.ts`. The desktop window itself is
checked by hand in the Epicenter shell.

| Script | What it checks |
| --- | --- |
| `bun run --cwd apps/capture smoke:browser` | The browser build in Chromium, with two pages sharing one folder: exact saved Markdown, thought edits, keyboard submit, Edit as text, the conflict prompt across pages, leave warnings, deletion, and an import. Needs a free local port and `bun x playwright install chromium`. |
| `bun apps/capture/scripts/recovery-harness.ts [dir] [bundle.json]` | A standalone tool, not the desktop backend: imports a bundle into a real directory twice, through `@epicenter/folder/bun` with an explicit author and no remote, and prints both reports. Exits nonzero if the retry creates anything. Run `bun run --filter @epicenter/folder build:addon` first, or use `bun run harness:recovery` here, which does. |

## Changed promises

This version is built on `@epicenter/folder`'s guarded autosave and the
shared edit sessions, and dropped several promises of the version before it:

- The Files workspace is gone. There is one timeline. A capture's
  Markdown is edited with Edit as text, and a file that is not a valid
  capture opens that way from the timeline's repair list.
- Saves no longer win over changes made elsewhere, and there is no
  Reload from file. Every save, and every delete, is guarded by the version
  this window last saved or read; a change made elsewhere is a conflict, and
  Reload theirs lives in the conflict prompt.
- One capture is open at a time. Moving between captures no longer keeps
  each capture's unsaved text, unadded thought, or failed save. Leaving one
  that holds any of it asks to discard it. Only the New capture text is kept
  across captures.
- A capture has no address of its own. The page no longer puts the open
  capture in the URL; reloading returns to the timeline.
- Save as a copy is gone, from every failure. So are Put the file back,
  Let it go, Discard my changes, and Check again for a removed file: a file
  deleted elsewhere offers Keep mine, which creates it again, or Discard.
- Deleting no longer shows the file for review. It asks a plain
  confirmation and deletes what this window saved last; a file changed
  elsewhere is not deleted, and the capture opens again as it is now.
- Unconfirmed-delete choices are gone. A delete whose reply was lost is
  reported once, and the timeline reads the folder again.
- Change reports from the folder no longer reread the timeline, and the
  30-second relisting is gone. The timeline reads the folder on open, after
  your actions, and when the window regains focus or becomes visible.
  Returning also takes a newer version of an open capture that holds nothing
  unsaved.
- The first save of a hand-written file rewrites its frontmatter as plain
  YAML. Comments in the frontmatter are lost. The previous standard form was
  JSON-style quoted keys.
- Imported captures are written in the same plain YAML form, and a retry
  counts a file an earlier import wrote in another form as the same capture.
- A thought typed and not added on a capture that stops reading as one
  (after Reload theirs brings a layout the view cannot show) can no longer be
  added when the file is repaired. It stays on screen, read-only, to copy,
  and leaving or Edit as text asks before discarding it. The same holds for a
  thought edit not saved.
- Import reports can no longer be viewed in the app. The recovery screen
  prints the paths of the report, the saved export, and the receipt under
  `recovery/`; on the desktop they are files in the folder, and in the
  browser build nothing shows them.
- A failed save's text is no longer kept for a removed file on the
  timeline. A capture whose file is gone is not listed once you leave it.
- Reload theirs of a file that can no longer be shown the way it is open (a
  capture file that is now binary, say) no longer keeps your text with Keep
  mine offered. It lets your text go and opens the file again as it reads
  now, as a capture, as text, or as could not be opened.
- The save bar uses the wording every Epicenter app shares: "This changed
  elsewhere" rather than "This capture changed elsewhere", and a failed save
  names the failure in the bar instead of under "Show technical details".
- A commit is refused while Capture closes, and says so, as every other
  action does.
