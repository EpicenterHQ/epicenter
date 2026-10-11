# Todos

A file-first todo list. Each todo is a plain Markdown file, `todos/<stem>.md`,
with `title` and `done` in frontmatter and notes in the body. A file browser
shows every file in the folder, and a terminal edits the same files and runs
Git commands against the folder's history.

There are two builds of the same UI, and the build decides where the folder is:

| Build | Folder | History |
| --- | --- | --- |
| Desktop, inside Epicenter | An ordinary directory on this computer, opened by the Epicenter host. | Real Git in that directory's `.git`. No remote unless you add one. |
| Browser demo | A folder in this browser's origin private file system (OPFS). | Git in the folder's `.git`, in OPFS beside the files, with a loopback remote for the demo. |

Todos uses no hosted API, account, or secrets in either build. It is built on
`@epicenter/folder` and does not depend on `@epicenter/app`. A folder that
cannot be opened is shown as that refusal. The desktop build never falls back
to browser storage.

A todo is its Markdown file and nothing else. A file that shares a todo's stem,
such as `todos/milk.png` or `todos/milk.webm` beside `todos/milk.md`, is an
ordinary file: renaming or deleting the todo leaves it where it is, and you
rename or delete it yourself from the file browser.

## Desktop, inside Epicenter

Todos is one of Epicenter's compiled applications. Open it from Epicenter Home,
or through the `epicenter://app/todos` link. There is no separate Todos app to
install or run.

### Where the files are

The todos are files in `so.epicenter.todos` under Epicenter's working-copy
directory:

| Build of Epicenter | Directory |
| --- | --- |
| Production | `~/Epicenter/so.epicenter.todos` |
| Development (`bun dev:epicenter`) | `~/Epicenter Dev/so.epicenter.todos` |
| `EPICENTER_FOLDER_DIR` set to `/some/dir` | `/some/dir/so.epicenter.todos` |

The header shows the directory's real path, and the status details have a
"Copy path" button. Epicenter creates the directory and its `todos/` folder the
first time Todos opens, and initializes Git there. It never overwrites a file
that is already present. Native startup chooses the directory; nothing in the
window can point Todos at another one.

Edit the files with any program. Todos reads the folder again when it opens,
after each of its own actions and terminal commands, and when you return to the
window. It does not follow change reports while you work: the list and file
browser show what they last read until one of those moments. An open todo or
file that holds nothing unsaved takes the newer version when you return. One
that holds unsaved edits keeps them, and its next save stops with the conflict
prompt described under "Editing and conflicts".

### Saving and committing

- Saving a todo writes its file, then Epicenter commits the folder. The save
  does not wait for the commit, and a commit that fails is shown in the status
  details, never as a failed save.
- Saving any other file in the plain editor, and content writes in the embedded
  terminal, follow the same automatic history policy.
- A new folder has no Git remote, and the window says so: Pull and Fetch are
  off, and the commit button reads "Commit". To use a remote, add one named
  `origin` with your own Git in the directory, then reopen Epicenter. Todos
  records automatic commits locally and offers Commit and push and Pull. It follows `main`
  only.
- The terminal is the same restricted shell as the browser demo, over the real
  directory. It is not `/bin/sh`: it has the listed file commands and
  `git status`, `diff`, `log`, `push`, `fetch`, and
  `pull --ff-only`, and it cannot reach outside the folder. For anything else,
  use your own terminal in the directory. Automatic history refuses staged
  authoring through `git add` and `git commit`; those commands require a folder
  opened with `commitOnEdit: false`.

### What is and is not protected

- One Epicenter owns the directory at a time. A second one pointed at the same
  directory (a development and a production build sharing
  `EPICENTER_FOLDER_DIR`) is refused when Todos opens, with a message naming
  the directory. The lock is a file beside the directory,
  `.so.epicenter.todos.epicenter-lock`. The operating system releases it when
  Epicenter exits, including after a crash or a forced kill, so there is
  nothing to clean up and the file is never deleted. It is not reliable on
  network filesystems. A symbolic link or anything but a regular file at that
  path is refused when Todos opens; a link swapped in while it runs is not
  defended against.
- The lock is between Epicenter processes. Other programs are not asked to
  take it. Every save is guarded by the version the open item last saved or
  read: if another program changed or deleted the file since, the save writes
  nothing and the conflict prompt asks you to choose. The guard is checked
  immediately before the file is replaced, so an edit that lands in that
  instant is overwritten. It is not an operating-system compare-and-swap, and
  nothing merges.
- A rename or delete of a todo changes one file, its Markdown file. A failure
  is reported as it happened: a refusal wrote nothing, and a reply that never
  arrived says the change may have landed, with the folder's own detail.
  Nothing is retried or rolled back.
- Todos refuses to open a directory whose `.git` is a symbolic link or a
  `gitdir:` file (a linked worktree or submodule), or whose
  `.git/epicenter/scratch` is linked elsewhere. It checks this when it opens
  the directory; it does not defend against a program that swaps a link in
  while it runs. Symbolic links among the files are not followed.
- Git commands Epicenter runs ignore inherited `GIT_DIR`, `GIT_WORK_TREE`, and
  `GIT_INDEX_FILE`, and never fall through to a repository in a parent
  directory.

### Closing, quitting, and unsaved typing

Unsaved typing lives only in the open window. Each edit saves as you make it,
so the cases below are about input that could not be saved: a conflict, a
failed save, or a save still running.

- Closing the Todos window hides it. The page stays loaded, so unsaved input
  and the terminal's output are still there when you open Todos again.
- Quitting Epicenter, or restarting it for an account change, asks this page
  first, over the host's departure wire (`@epicenter/epicenter/departure`),
  through the shared page client (`@epicenter/epicenter/departure/page`).
  From that moment the page takes no typing and starts no action, Git
  command, or terminal command. A page holding nothing unsaved answers at
  once. Otherwise it shows its window, saves what typing would have saved,
  and waits for those saves to finish. If something still cannot be saved (a
  failed, unconfirmed, or conflicted save, or the title of a new todo you have
  not added), the window lists it, names
  whether Epicenter is quitting or restarting, and offers "Keep working" or
  "Quit anyway" ("Restart anyway"). Nothing is added, retried, or discarded
  for you; leaving anyway only tells Epicenter this window is ready. A choice
  counts only for the quit or restart it was shown for.
- A Git command or terminal command already running when Epicenter asks is
  waited for. A pull or merge whose fetch finishes after the request applies
  nothing and says so. The terminal keeps its typed command, history, and
  output meanwhile, and Enter runs nothing; its typed command is not counted
  as unsaved.
- Todos opens its folder only once it is listening for a quit or restart and
  has read from Epicenter whether one is running. If it cannot listen, or
  cannot read that status, it shows "Todos is waiting for Epicenter" with
  Retry, and nothing is open or editable meanwhile; returning to the window,
  or a quit or restart beginning, also reads again.
- If the quit or restart is cancelled, by you or by another window, the
  page takes typing again with all unsaved input, failed saves, and typed
  titles as they were. Quitting again during the same quit asks the page again, without a
  second prompt. Until Epicenter says the quit is over, the page stays
  waiting, even if an answer to Epicenter was lost.
- A host restart after a crash, a forced kill, or a system shutdown that does
  not ask Epicenter ends the page without asking. Input that was not saved
  is lost. Nothing persists them. Saved files are on disk and reopen as they
  were.
- The browser demo has none of this: leaving the tab keeps its own leave
  warning.
- On quit, the Rust Folder owner fences new work, drains accepted local saves
  and commits, stops network work, and releases the directory lock. A forced
  kill can leave saved files uncommitted; the next commit includes them.
- A page reload or explicit client close ends that page's access. The shared
  owner remains open for sibling windows and finishes accepted work. The
  client's network wait can end while the native operation continues.
- A terminal command holds nothing between its steps. Other pages can save
  while it runs. A rewrite of a file the command read checks that captured
  version. Terminal writes make the same immediate automatic commit attempt
  as other saves. Git hashing and network traffic do not block saves.

### How it is wired

The Rust shell installs `tauri-plugin-epicenter-folder` once and registers the
Todos folder under the ID the page opens, `so.epicenter.todos`, with its
directory, author, remote, history policy, and allowed window label. Importing
the page's adapter acquires nothing; opening Todos calls `openFolder` from
`@epicenter/folder/tauri`, which attaches this page to that folder and sends
none of those settings.

```text
Todos window (WebView)
        | generated, typed Tauri invoke commands and change events
        v
shared Rust Folder plugin
        | canonical-root owner, file admission, Git queue, OS lock
        v
~/Epicenter/so.epicenter.todos
```

Rust reads and publishes bytes and owns Git history. Shared TypeScript code
interprets Markdown tables and runs the restricted terminal against that byte
boundary. Events announce changes; the page rereads through invoke. No file
contents or history are mirrored in browser storage on desktop.

Every page attached to the same root shares its owner. File admission orders
managed saves and terminal operations. A separate Git queue hashes a captured
file view after file admission is released, so a large file cannot hold up the
next save. Other programs do not participate in these queues; edits
made in place while capture is underway remain best effort.

The `epicenter-host` build condition selects the desktop leaf of
`#platform/folder`, and `vite.config.ts` resolves the bare `@epicenter/folder`
specifier to `@epicenter/folder/tauri` for that build, so it carries no
browser storage and no Git implementation. The browser build selects the
browser leaf and resolves the same specifier to `@epicenter/folder/browser`,
so it carries no desktop adapter. Both use the same UI and file interpretation.

## Browser demo

This build is for developing `@epicenter/folder` and the UI without the
desktop host. The folder and its Git history live in one directory of this
browser's origin private file system, `Epicenter/local/so.epicenter.todos`,
and a loopback Git server lets the browser push to a bare repository that an
ordinary native checkout pulls from and pushes to. The browser commits as
`Todos <todos@localhost>`. Another tab of the same origin edits the same
folder, and each tab rereads when the other saves.

A folder an earlier version of the demo kept in IndexedDB is not read, copied,
or deleted; this version starts from the OPFS directory alone.

From the repository root:

```sh
bun dev:todos
```

This starts the Git backend on `127.0.0.1:5187` and the UI on
`http://127.0.0.1:5186`, and prints the session: the bare repository, the
native checkout, and the remote URL. The UI reaches the backend same-origin
through the Vite proxy at `/git/todos.git`. `bun dev:todos:ui` starts the UI
alone; pushes and fetches then fail and say so, while saves and local commits
keep working. Set `TODOS_DEMO_ROOT` to a directory printed by an earlier run to
reopen it.

## Controls

Both builds share these, except the Git actions: a folder that syncs (the
browser demo) offers Sync, and one that does not sync yet (the desktop app,
whose folder owner has no sync) offers Pull, Merge incoming changes, and
Commit and push instead. Todos asks the folder (`folder.sync.supported`),
not the build. The todo list and its editor fill the window. The header
holds the rest:

| Control | What it does |
| --- | --- |
| Files button (Ctrl+B) | Shows or hides the file browser: a pane on wide screens, a drawer on narrow ones. |
| Folder path (desktop) | The directory the todos are in. Click to copy it. |
| Status button | Shows the most important current fact, shortened on narrow screens. Open it for where the folder is, saved files, uncommitted changes, the last commit, the remote, and the last pull as separate lines with the times they were observed, plus "Check again" and "Fetch". When the last remote check saw commits on both sides, it says the histories diverged; Todos only fast-forwards, so local commits are kept until the histories are resolved. |
| Sync | Waits for the open todo's saves, commits the saved files, fetches, merges, and pushes (`folder.sync`, ADR-0514). Edits to different fields, or to different lines of the notes, merge on their own; a merged todo is rewritten in the standard form. When both sides changed the same title, done, notes, or a whole todo (one side deleted it, or a version is not a valid todo), the review replaces the workspace and nothing is written until you apply your choices. The review is modal: the open todo and the Git buttons take no input until you apply or cancel, and Cancel forgets the attempt and your choices. Afterwards the lists and the open todo are read again: a todo with nothing unsaved shows the result, and one holding a draft it could not save keeps it; its next save merges with the result. Off when the folder has no remote. |
| Pull (desktop) | Fetches, then applies the remote only as a clean fast-forward. A refusal is shown as "Pull stopped" with the reason, and in the status details. Off when the folder has no remote. |
| Merge incoming changes (desktop) | Shown when the last check saw commits on both sides. Merges the fetched remote into the committed folder in one commit; a conflict refuses and writes nothing. Nothing is pushed. |
| Commit and push (desktop) | Commits the saved files and pushes. Unsaved typing is not included. Reads "Commit" when the folder has no remote. |
| Recover incoming update | Shown only while an incoming update has not finished; see below. Sync, or Pull, Merge incoming changes, and Commit and push, are off until then, and say why. |
| Terminal button (Ctrl+\`) | Shows or hides the terminal. It is hidden at first; its output, history, typed command, and working directory stay when it is hidden. |

On narrow screens the list, the editor, and the terminal take turns; the
editor has a Back button, and the file browser opens as a drawer.

Where you open a file decides how you edit it. The file browser opens any
file's complete text, a todo's frontmatter included. The todo list opens a
todo's title, done, and notes; a todo whose text is not a valid todo opens as
text with what to fix, and **Open as todo** returns once it reads as one. One
item is open at a time. Opening the item already shown does nothing. Opening
another waits for the open one's saves. If a save failed or conflicted, Todos
asks "Discard unsaved changes?" first: Discard lets the edits go, Cancel
keeps you on the item.

### Editing and conflicts

- Each edit saves at once. One save runs at a time and only the latest edit
  waits, so fast typing writes your latest text, not every keystroke. A save
  never changes what is on screen.
- When the file changed elsewhere since this item last saved or read it,
  the save merges your edits with that version first. Changes to different
  fields, or to different lines, combine and save with no question, and the
  editor shows the result.
- When both changed the same field or lines, the save bar shows a review of
  only those parts: **Your edit**, **Saved elsewhere**, and a result. Pick
  **Use this** on either side for each part, or **Use all from** one side
  when there are several, and **Apply** saves every answer at once over that
  version. Your other edits and their other changes are kept either way.
  When the file was deleted elsewhere, or is no longer a valid todo or no
  longer text, the review shows the whole file: your edit saves it again
  from your version, and their side leaves it as it is now. A deleted file
  then closes; a todo that no longer reads as one opens as its text. Nothing
  is written until you apply, and typing waits until then.
- The review has no Cancel. To drop your edits instead, open another item:
  Todos asks "Discard unsaved changes?" as for any edit it could not save.
- A save that fails for another reason keeps your edits and offers **Try
  again**. When a save's reply is lost, the folder reads the file once: if it
  holds what was sent, the save counts as saved. Otherwise the bar says it may
  or may not be in the file and offers **Save again**.
- A value the file cannot hold, such as a title with a lone surrogate, is
  never written; the bar names it, and the next valid edit saves. Text in
  the plain editor is kept well formed, so a lone surrogate becomes U+FFFD as
  you type and what saves is what you see.
- Rename and delete wait for the open item's saves and act on what it saved
  last. Typing is paused while a rename or an applied review runs.
  Renaming an item whose save failed moves what was saved and saves your
  edits at the new name. Edits made while the delete confirmation is open are
  saved first, then the file is deleted.
- The first save of a file written by hand rewrites it in Todos' standard
  form: plain YAML frontmatter, declared keys first, unknown keys kept.
  Comments and custom quoting in the frontmatter are not kept.

### When an incoming update stops partway

A sync in the browser writes the incoming files one at a time. If it
stops partway (the tab closed, or a file could not be written), the folder
keeps a record of the update. Todos reports it under the header as "Incoming
update not finished" (or "never started", or "record unreadable"), and as the
first line of the status details. It never resumes the update on its own:
opening the folder, "Check again", and returning to the window only read the
record.

- Commits, syncs, pulls, and merges wait while the update is pending; their
  buttons are off and say why. Editing, saving, renaming, deleting, and Fetch keep
  working.
- **Recover incoming update** runs only when you press it. The open item's
  saves land first; if its save failed or conflicted, nothing runs and the
  result names that file. While the update runs the open item takes no
  typing, and afterward it shows what the update wrote.
- Recovery finishes the update from the files as they are: each file still at
  its version from before the update gets the incoming version, and each file
  already at the incoming version is left alone. A file that holds neither,
  such as one you edited after the update stopped, is named with the reason,
  nothing is written, and the update stays pending with its record. Make each
  named file hold one of its two versions (for example by editing its text
  in the file browser, or with `git show` in the terminal), then press the
  button again.
- Nothing is discarded, rolled back, or retried for you.

Unsaved input lives only in this open page. In the browser, while the open
item has a save in progress, a failed save, or a conflict, reloading or
closing the tab asks first with the browser's leave warning. Leaving anyway
discards that input; files already saved stay as saved. The desktop window is
covered under "Closing, quitting, and unsaved typing" above.

## What to try

These steps are written for the browser demo, where a remote is always
present. On the desktop, steps 1 to 4 work the same over the real directory,
without the push.

1. Add a todo. The file saves immediately; a local commit follows in the
   background, and nothing is pushed until you press Sync. The
   status details report saved files, uncommitted changes,
   the last commit, and the remote separately. They say "Changes need
   checking" or "Check failed" instead of claiming a clean folder when the last
   observation is out of date or failed; focus and "Check again" check again.
2. Edit the title or notes. Each edit saves the todo's standard form at once.
   Change the file in another tab or program, then edit again: edits to
   other fields merge with no question, and a field you both changed shows
   in a review with **Apply**. See "Editing and conflicts".
3. Open the file browser. Folders expand and collapse; every text file, a
   todo's Markdown included, opens as its text and saves as you type, with
   the same review. A file that is not UTF-8 text, or is over 1 MB,
   shows its type and size and is never saved as text. Right-click a row, or
   use its "…" button, for Open, Rename, Copy path, and Delete; on a folder,
   New file and New folder. With a row focused, arrow keys move and expand,
   F2 renames, Delete asks to delete, and Shift+F10 opens the menu.
   - Renaming or deleting a todo file changes that one Markdown file. A file
     with the same stem, such as an image or a recording, stays where it is.
     A closed file is renamed or deleted only if it still has the version
     read when you asked.
   - The list's checkbox on the open todo is an edit to it. On a closed todo
     it replaces the todo as the list read it; if the file changed since, it
     writes nothing, says so, and the list reads it again.
   - Delete always asks first, naming what it removes. Only empty folders can
     be deleted from the browser. Renaming does not update references to the
     old name in other files.
4. In the terminal: `ls todos`, `cat todos/<stem>.md`, `echo '...' > note.md`,
   `git status`, `git log --oneline`, `git diff`, `git push`. Content writes
   request automatic history; staged authoring is refused in automatic mode.
   Files matched by `.gitignore` stay out of status and automatic commits; a
   tracked file stays tracked. A later automatic commit or Sync resets
   staged-only changes to the committed state.
5. In the native checkout printed at startup:

   ```sh
   git pull --ff-only
   $EDITOR todos/<stem>.md
   git commit -am "Edit natively" && git push
   ```

   Then press **Sync** in the browser. It commits what you saved, brings in the
   native commit, and pushes. Edit the same todo's title in both places
   first to see the review; an incoming file that would overwrite an ignored
   or untracked one is reported and nothing is written.
6. To see a hand edit from another computer, run the demo fixture against the
   same checkout:

   ```sh
   bun apps/todos/scripts/remote-edit.ts <checkout> <stem> "Buy oat milk"
   ```

   It pulls, rewrites `todos/<stem>.md` with a YAML comment, a new title,
   `done: true`, and the keys `owner` and `labels`, which Todos does not
   declare, then commits and pushes with ordinary Git. Press **Sync** in the
   browser: the list shows the new title, an open todo with nothing unsaved
   shows it, and the file keeps the comment and keys byte for byte until
   Todos saves it or merges it with a change of its own. Any save from Todos, a checkbox included, writes the
   standard form: `owner` and `labels` stay, the comment does not.
7. `bun apps/todos/scripts/native.ts <checkout> status` prints the native
   folder's JSON status through `openFolder` from `@epicenter/folder/bun`.
   `create "<title>"`, `complete <stem>`, `commit-and-push`, `fetch`, and
   `pull` are also available. A checkout that cannot be opened prints the
   refusal and exits 1.

Write a file whose text does not parse (for example `printf -- '---\ntitle: *missing\n---\n' > todos/bad.md`,
or Markdown with no `---` lines at all) to see it under "Needs repair" below
the list, with its path and why. It is not in the list itself. **Repair**
opens its complete text with each problem and its line; fix it there. Text
that still does not parse saves as typed and stays under "Needs repair". A
todo that parses but has a bad field, such as `done: soon`, is named the same
way. Once the text reads as a todo, **Open as todo** opens its fields. A todo
whose text stops reading as a todo while it is open stays as you left it;
its next save shows a review of the whole file, where using the version
saved elsewhere opens its text instead. When the file is no longer UTF-8
text, using your edit saves your version over it, and using the version saved
elsewhere opens it as it is now: file details from Files, or why it cannot
open from the todo list.

Any file name works for a todo, including a leading dot, a trailing space,
punctuation, and `todos/.md` itself. Only `.md` in lowercase makes a file a
todo; `todos/a.MD` is an ordinary file.

## Layout

| Path | Role |
| --- | --- |
| `src/lib/definition.ts` | The inert `defineFolder` declaration, written with the shared `defineTable` and `field` vocabulary. It names no folder. |
| `src/routes/+page.svelte` | Opens the Todos owner. Inside Epicenter it starts the shared departure client (`@epicenter/epicenter/departure/page`) and opens the folder only once a status is known, attaching `todos.departure` the moment it exists (`openForDeparture`). |
| `src/lib/platform/` | The `#platform/departure` seam: the host leaf is the shared Tauri window port (`@epicenter/epicenter/departure/window`); the browser leaf has no port. And the `#platform/folder` seam: `types.ts` is its contract and holds `TODOS_FOLDER_ID`, `folder.browser.ts` opens the OPFS folder through `@epicenter/folder/browser`, and `folder.epicenter-host.ts` opens the host's directory through `@epicenter/folder/tauri`. Each returns the folder or the refusal. The mounted page calls it; importing it opens nothing. |
| `src/lib/files.ts` | File browser rows, and which files open as editable text. |
| `src/lib/todos.svelte.ts` | Todo and folder listings, the rows named for repair, the one open item (`@epicenter/svelte/open-item`) and its edit session (`@epicenter/svelte/edit-session`), review answers (`todos.resolve`), and file actions, each counted by `@epicenter/svelte/admissions` so close and departure wait for it. |
| `src/lib/terminal.svelte.ts` | The terminal session that outlives the terminal pane, over the folder's own `folder.terminal()`. |
| `src/lib/status.ts` | Plain-language status lines and the header summary. |
| `src/routes/components/` | Header, file browser, list, the detail pane (`Detail`: `TodoDetail` or `FileView`, each with the shared `SaveBar` from `@epicenter/svelte/save-bar`), and terminal. |
| `server/git-server.ts` | `git http-backend` over a bare repository, plus the native checkout. |
| `apps/todos/scripts/dev.ts` | Starts the backend and Vite together. |
| `apps/todos/scripts/native.ts` | JSON CLI over the native checkout. |
| `apps/todos/scripts/remote-edit.ts` | Demo fixture: a hand edit with undeclared frontmatter, committed and pushed from the native checkout with ordinary Git. |
| `apps/todos/scripts/module-graph.ts` | Lists the modules a build of one entry pulls in, resolved with the conditions and aliases `vite.config.ts` declares, for the seam test. |

The owner holds one open item (`todos.opened`), kept by the shared open-item
slot: a row session for a todo, a text session for a file or a todo whose
text is not valid, or what could not be opened. The slot shows each item
under the key it has now (`keyOf`): its session's path, which follows a
rename, and how it is edited, where a todo shown as text for repair has its
own key, so **Open as todo** opens the row. `todos.open` answers `unsaved`
with the session it means, and the view's "Discard unsaved changes?"
discards that session. `todos.reload` reads the shown item again, for **Try
again** on a failed load. `Detail` keys each view by the item, so another item mounts
a new view. A view edits through its session (`session.edit`, `session.input`),
reads `session.draft` and `session.state`, and disables its inputs while
`session.locked`. Leaving an item releases its session, so a control left
over from it changes nothing.

Checks: `bun run --cwd apps/todos typecheck` (both seam leaves and the Bun
side), `bun run --cwd apps/todos test` (it builds the Folder's file exchange
addon that the native harness needs, runs the tests on Svelte's server
runtime, then `test:mounted`: the real detail pane mounted in jsdom under
`--conditions=browser`), `bun run --cwd apps/todos build` for
the browser demo, and `bun run --cwd apps/todos build:epicenter` for the build
Epicenter serves. The two builds share SvelteKit's output directory, so run
them one after the other.

## Changed promises

This version is built on `@epicenter/folder`'s guarded autosave and dropped
several promises of the version before it:

- An open todo no longer saves last-writer-wins over changes made elsewhere,
  and there is no **Reload** button. Every save is guarded, a change made
  elsewhere merges with your edits, and what both changed shows in a review.
- One item is open at a time. Switching no longer keeps each file's unsaved
  input in its own editor, and there is no handoff between the todo list
  and Files: leaving an item whose save failed asks to discard it.
- Change reports from the folder no longer reread the list while you work.
  The list reads again on open, after your actions, and when you return.
- The list's checkbox no longer patches `done` into a file's text keeping
  every other byte; it writes the todo's standard form. While the todo is
  open as text in Files, the checkbox is refused.
- Rename and delete no longer refuse while a save failed; a conflict still
  refuses them through the version guard.
- Typing during a rename is paused instead of saved at the new name.
- Using the version saved elsewhere for a file that is no longer text opens
  it again as it is now, which ends its session, instead of keeping the
  session open with a message. Your edit is offered beside it in the review.
- The browser demo no longer has Pull, Merge incoming changes, or Commit and
  push. Sync replaces them: it merges diverged history that Pull refused,
  merges a todo both sides changed by field and notes, and asks before
  writing a conflict. A todo it merges is rewritten in the standard form.
  The desktop app keeps the three actions until its folder owner syncs.
- Unconfirmed-delete states are gone: a delete whose reply was lost is
  reported once, and the list reads the folder again.
