# Todos

A file-first todo list. Each todo is a plain Markdown file, `todos/<stem>.md`,
with `title` and `done` in frontmatter and notes in the body. Todos shows one
folder table: the list is the table, the detail is one row, and a field change
writes that row's file. A file in `todos/` that does not read as a todo shows
its text and what to fix. Every other file in the folder is yours to edit with
any program; Todos does not show it.

There are two builds of the same UI, and the build decides where the folder is:

| Build | Folder | History |
| --- | --- | --- |
| Desktop, inside Epicenter | An ordinary directory on this computer, opened by the Epicenter host. | Real Git in that directory's `.git`. No remote unless you add one. |
| Browser demo | A folder in this browser's origin private file system (OPFS). | Git in the folder's `.git`, in OPFS beside the files, with a loopback remote for the demo. |

Todos uses no hosted API, account, or secrets in either build. It is built on
`@epicenter/folder` and TanStack Query, and does not depend on
`@epicenter/app`. A folder that
cannot be opened is shown as that refusal. The desktop build never falls back
to browser storage.

A todo is its Markdown file and nothing else. A file that shares a todo's stem,
such as `todos/milk.png` or `todos/milk.webm` beside `todos/milk.md`, is an
ordinary file: renaming or deleting the todo leaves it where it is, and you
rename or delete it yourself with another program.

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

Edit the files with any program. Todos reads the folder when a screen
opens, when you return to the window, and after its own actions. It does not
follow change reports while you work: the list and the editor show what they
last read until one of those moments.

### Saving and versions

- Each edit is written to its file as you make it. A save never records a
  version (ADR-0529).
- A version is a Git commit. It is recorded only when you press **Save
  version**, or when Sync records one before it runs. Nothing commits on its
  own: not a save, a timer, or closing the app.
- The status details count the changes since the last version as plain
  detail, not as a warning.
- A new folder has no Git remote, and the desktop folder does not sync yet,
  so the desktop app offers Save version and no Sync. To use a remote, add
  one named `origin` with your own Git in the directory.

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
  take it. Every write is guarded by the version Todos last read or wrote: if
  another program changed or deleted the file since, the write changes
  nothing, the editor shows the file as it is now, and a message says so
  with a button that copies the text that was not written. The guard is
  checked immediately before the file is replaced, so an edit that lands in
  that instant is overwritten. It is not an operating-system compare-and-swap,
  and nothing merges on a write.
- A rename or delete of a todo changes one file, its Markdown file. It
  carries the version the editor showed when you asked. It runs after the
  file's writes, and only on that version or one Todos itself wrote from it
  since; a file changed elsewhere is refused, whether or not Todos has read
  the change yet. A failure is reported as it happened: a
  refusal wrote nothing, and a reply that never arrived says the change may
  have landed, with the folder's own detail. Nothing is retried or rolled
  back.
- Todos refuses to open a directory whose `.git` is a symbolic link or a
  `gitdir:` file (a linked worktree or submodule), or whose
  `.git/epicenter/scratch` is linked elsewhere. It checks this when it opens
  the directory; it does not defend against a program that swaps a link in
  while it runs. Symbolic links among the files are not followed.
- Git commands Epicenter runs ignore inherited `GIT_DIR`, `GIT_WORK_TREE`, and
  `GIT_INDEX_FILE`, and never fall through to a repository in a parent
  directory.

### Closing, quitting, and unsaved typing

Edits are written as you make them. Writes and other actions still running
are waited for. The title of a new todo you have not added lives in the box
alone: it stays while the window is open, and quitting or reloading drops it.
Repair text you typed and did not save lives in the page: it stays while you
open other todos and while the window is open, and it counts as unsaved, so
the browser demo's leave warning covers it. Quitting or restarting Epicenter
drops it without asking, as a reload does.

- Closing the Todos window hides it. The page stays loaded, so a typed title
  is still there when you open Todos again.
- Quitting Epicenter, or restarting it for an account change, asks this page
  first, over the host's departure wire (`@epicenter/epicenter/departure`),
  through the shared page client (`@epicenter/epicenter/departure/page`).
  From that moment the page takes no input and starts no edit or action. It
  waits until every write and action already running has finished, then
  tells Epicenter it is ready. It never asks: Todos has no prompt to show.
  Once that work is done, nothing in it is lost; repair text typed and not
  saved is.
- Todos opens its folder only once it is listening for a quit or restart and
  has read from Epicenter whether one is running. If it cannot listen, or
  cannot read that status, it shows "Todos is waiting for Epicenter" with
  Retry, and nothing is open or editable meanwhile; returning to the window,
  or a quit or restart beginning, also reads again.
- If the quit or restart is cancelled, by you or by another window, the
  page takes input again. Until
  Epicenter says the quit is over, the page stays waiting, even if an answer
  to Epicenter was lost.
- A host restart after a crash, a forced kill, or a system shutdown that does
  not ask Epicenter ends the page without asking. A write that had not landed
  is lost. Written files are on disk and reopen as they were.
- The browser demo has none of this: leaving the tab while a write or action
  runs, or while repair text is typed and not saved, asks first with the
  browser's leave warning. Opening another todo changes only the address's
  `?todo=` and never asks.
- On quit, the Rust Folder owner fences new work, drains accepted local
  writes, stops network work, and releases the directory lock.
- A page reload or explicit client close ends that page's access. The shared
  owner remains open for sibling windows and finishes accepted work. The
  client's network wait can end while the native operation continues.
- Git hashing and network traffic do not block writes.

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
interprets Markdown tables against that byte boundary. Events announce changes; the page rereads through invoke. No file
contents or history are mirrored in browser storage on desktop.

Every page attached to the same root shares its owner. File admission orders
managed writes. A separate Git queue hashes a captured
file view after file admission is released, so a large file cannot hold up the
next write. Other programs do not participate in these queues; edits
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
folder; each tab reads again when you return to it.

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
alone; Sync then fails and says so, while writes and Save version keep
working. Set `TODOS_DEMO_ROOT` to a directory printed by an earlier run to
reopen it.

## Controls

Both builds share these. A folder that syncs (the browser demo) offers Sync
beside Save version; one that does not sync yet (the desktop app, whose
folder owner has no sync) offers Save version alone. Todos asks the folder
(`folder.sync.supported`), not the build. The todo list and its editor fill
the window. The header holds the rest:

| Control | What it does |
| --- | --- |
| Folder path (desktop) | The directory the todos are in. Click to copy it. |
| Status button | Shows the most important current fact, shortened on narrow screens. Open it for where the folder is, whether every edit is written, the changes since the last version, the last version, and the remote, with the times they were observed, plus "Check again", which reads everything again. |
| Save version | Records the written files as a version in history (`folder.git.commit()`). Writes still running land first. Nothing is sent. |
| Sync | Waits for writes still running, records a version, fetches, merges, and pushes (`folder.sync`, ADR-0514). Edits to different fields, or to different lines of the notes, merge on their own; a merged todo is rewritten in the standard form. When both sides changed the same title, done, notes, or a whole todo (one side deleted it, or a version is not a valid todo), the review replaces the workspace and nothing is written until you apply your choices. The review is modal: the workspace and the Git buttons wait until you apply or cancel, and Cancel forgets the attempt and your choices. A choice the folder refuses shows beside its row and keeps the review. Afterwards the list and Git status are read again. Off when the folder has no remote. |
| Recover incoming update | Shown only while an incoming update has not finished; see below. Sync and Save version are off until then, and say why. |

The open todo is part of the address, `?todo=<stem>`, so a reload or a
change of window width keeps it open. On narrow screens the list and the
editor take turns: opening a todo adds a history entry, so the browser's Back
returns to the list, and the editor has its own Back button. Renaming or
deleting the open todo replaces the entry, so Back never lands on a name
that is gone.

The list opens a todo's title, done, and notes. A file in `todos/` whose text
is not a valid todo shows under "Needs repair" and opens as its text, with
what to fix, **Save**, and **Discard**; once it reads as a todo, the editor
shows its fields. A file that cannot be read as text at all shows under
"Could not read" with **Try again**; Todos cannot repair it. One todo shows
at a time, and switching never waits or asks. Repair text you typed and did
not save stays with its file while you switch, until you save or discard it,
or the file reads as a todo or leaves the folder.

### Editing and writes

- The list and the editor read the same cached listing, so they never
  disagree: a title you type shows in the list as you type it.
- Each edit is written at once. Writes to one file run one at a time, with
  at most one more waiting, and the waiting one writes whatever you typed
  by the time it runs, so fast typing writes your latest text, not every
  keystroke. Writes to different files run side by side.
- Each write is guarded by the version Todos last read or wrote. When the
  file changed elsewhere since, the write changes nothing, the editor and
  the list show the file as it is now, and a message says so with **Copy
  your text**, which copies the text that was not written. You lose at most
  what was in flight: one click, or the last moment of typing. Nothing
  merges on a write; Sync is where histories merge.
- A write that fails for another reason, or whose reply is lost, is reported
  the same way, and the file is read again.
- Inputs hold only values a todo can hold. A title or notes with a lone
  surrogate is written with U+FFFD in its place, as shown. The folder still
  refuses a value it cannot hold, and the editor then shows the file again.
- Rename and delete carry the version the editor showed when you asked:
  for delete, when the confirmation opened. They run after the file's
  writes, and only on that version or one Todos wrote from it since, so a
  delete you confirmed while your last edit was still being written removes
  that edit's file. A file changed elsewhere since is refused, and so is a
  todo Todos no longer lists. Typing into that file waits while they run.
- The first write of a file written by hand rewrites it in Todos' standard
  form: plain YAML frontmatter, declared keys first, unknown keys kept.
  Comments and custom quoting in the frontmatter are not kept.
- A repair writes the text you typed when you press **Save**, guarded by the
  version you started typing over: Todos records it at your first
  keystroke. Text that still does not read as a todo is written as typed and
  stays under "Needs repair". When the file changed elsewhere since your
  first keystroke, even if Todos has read the change, nothing is written,
  the text stays in the field, the editor says the file changed, and a
  message offers to copy your text. **Discard** drops your text and shows
  the file as it is now.

### When an incoming update stops partway

A sync in the browser writes the incoming files one at a time. If it stops
partway (the tab closed, or a file could not be written), the folder keeps a
record of the update. Todos reports it under the header as "Incoming update
not finished" (or "never started", or "record unreadable"), and as the first
line of the status details. It never resumes the update on its own: opening
the folder, "Check again", and returning to the window only read the record.

- Sync and Save version wait while the update is pending; their buttons are
  off and say why. Editing, writing, renaming, and deleting keep working.
- **Recover incoming update** runs only when you press it. Writes still
  running land first. Afterward the list is read again and shows what the
  update wrote.
- Recovery finishes the update from the files as they are: each file still at
  its version from before the update gets the incoming version, and each file
  already at the incoming version is left alone. A file that holds neither,
  such as one you edited after the update stopped, is named with the reason,
  nothing is written, and the update stays pending with its record. Make each
  named file hold one of its two versions (for example with `git show` in
  your own terminal), then press the button again.
- Nothing is discarded, rolled back, or retried for you.

## What to try

These steps are written for the browser demo, where a remote is always
present. On the desktop, steps 1 to 3 work the same over the real directory,
without Sync.

1. Add a todo. The file is written immediately, and nothing is committed or
   pushed. The status details report whether every edit is written, the
   changes since the last version, the last version, and the remote
   separately. They say "Changes need checking" or "Check failed" instead of
   claiming a clean folder when the last observation is out of date or
   failed; focus and "Check again" read again. Press **Save version** to
   record one.
2. Edit the title or notes. Each edit is written in the todo's standard form
   at once. Change the file in another tab or program, return, and the
   editor shows that version. Change it elsewhere without returning, then
   edit here: the write changes nothing, the editor shows their version, and
   a message offers to copy your text.
3. Rename a todo's file or delete it from the bar under its notes. Renaming
   or deleting changes that one Markdown file: a file with the same stem,
   such as an image or a recording, stays where it is. Delete always asks
   first, naming what it removes and whether its latest changes are in no
   saved version. A file changed elsewhere after the confirmation opened is
   refused.
4. In the native checkout printed at startup:

   ```sh
   git pull --ff-only
   $EDITOR todos/<stem>.md
   git commit -am "Edit natively" && git push
   ```

   Then press **Sync** in the browser. It records a version of what you
   wrote, brings in the native commit, and pushes. Edit the same todo's
   title in both places first to see the review; an incoming file that would
   overwrite an ignored or untracked one is reported and nothing is written.
5. To see a hand edit from another computer, run the demo fixture against the
   same checkout:

   ```sh
   bun apps/todos/scripts/remote-edit.ts <checkout> <stem> "Buy oat milk"
   ```

   It pulls, rewrites `todos/<stem>.md` with a YAML comment, a new title,
   `done: true`, and the keys `owner` and `labels`, which Todos does not
   declare, then commits and pushes with ordinary Git. Press **Sync** in the
   browser: the list and the editor show the new title, and the file keeps
   the comment and keys byte for byte until Todos writes it. Any write from
   Todos, a checkbox included, writes the standard form: `owner` and
   `labels` stay, the comment does not.
6. `bun apps/todos/scripts/native.ts <checkout> status` prints the native
   folder's JSON status through `openFolder` from `@epicenter/folder/bun`.
   `create "<title>"`, `complete <stem>`, `commit-and-push`, `fetch`, and
   `pull` are also available there, for the native checkout only. A checkout
   that cannot be opened prints the refusal and exits 1.

Write a file whose text does not parse (for example `printf -- '---\ntitle: *missing\n---\n' > todos/bad.md`,
or Markdown with no `---` lines at all) to see it under "Needs repair" below
the list, with its path and why. It is not in the list itself. **Repair**
opens its complete text with each problem and its line; fix it there and
press **Save**. Text that still does not parse is written as typed and stays
under "Needs repair". A todo that parses but has a bad field, such as
`done: soon`, is named the same way. Once the text reads as a todo, the
editor shows its fields. A todo that stops reading as a todo while it is
shown, because another program changed it, shows its text for repair when
the editor next reads it.

Any file name works for a todo, including a leading dot, a trailing space,
punctuation, and `todos/.md` itself. Only `.md` in lowercase makes a file a
todo; `todos/a.MD` is an ordinary file.

## Layout

| Path | Role |
| --- | --- |
| `src/lib/definition.ts` | The inert `defineFolder` declaration, written with the shared `defineTable` and `field` vocabulary. It names no folder. |
| `src/routes/+layout.svelte` | The tooltip provider and toasts; no app state. |
| `src/routes/+page.svelte` | Opens the folder and creates its store (`createTodos`), then shows the views inside its `FolderScope`. Inside Epicenter it starts the shared departure client (`@epicenter/epicenter/departure/page`) and opens the folder only once a status is known, attaching `todos.departure` the moment it exists (`openForDeparture`). It turns a failed write into a toast with **Copy your text**. |
| `src/lib/platform/` | The `#platform/departure` seam: the host leaf is the shared Tauri window port (`@epicenter/epicenter/departure/window`); the browser leaf has no port. And the `#platform/folder` seam: `types.ts` is its contract and holds `TODOS_FOLDER_ID`, `folder.browser.ts` opens the OPFS folder through `@epicenter/folder/browser`, and `folder.epicenter-host.ts` opens the host's directory through `@epicenter/folder/tauri`. Each returns the folder or the refusal. The mounted page calls it; importing it opens nothing. |
| `src/routes/components/FolderScope.svelte` | One opened folder's views: sets its store for `getTodos()` and provides the store's query client. |
| `src/lib/todo-listing.ts` | The todo listing as the list shows it (`todosOf`, `repairsOf`), and a todo's file and stem (`todoPath`, `todoStem`). |
| `src/lib/todos.svelte.ts` | The store over one folder (ADR-0528): its own TanStack `QueryClient` with every rule (never stale, no retry, the quit fence), leaving, and closing. It composes the namespaces below over one `Session`. |
| `src/lib/session.ts` | What the namespaces share: the cache keys (`todosKeys`), `TodosError` and `DEPARTING`, the `WriteFailure` type, and the `Session` type. |
| `src/lib/rows.ts` | `todos.rows`: the listing's views (`todos`, `repairs`, `entry(stem)`), `edit`, the scoped `write(stem)` and `repair(stem)` each view creates its mutation from, repair drafts (`draft`, `setDraft`, `discardDraft`, `drafted`), `create`, `rename`, and `remove`. Views ask TanStack's `useIsMutating` whether a write, rename, or delete runs. |
| `src/lib/git.ts` | `todos.git`: the history `snapshot`, `status`, Save version, and incoming recovery. |
| `src/lib/sync.ts` | `todos.sync`: `run` and the review's `apply`. |
| `src/lib/status.ts` | Plain-language status lines and the header summary. |
| `src/routes/components/` | Header, list (`TodoList`, one `TodoRow` per todo), the open todo (`TodoDetail`, with its file name bar and delete confirmation, which also repairs a file that does not read as a todo), and the sync review. `TodosView` lays them out and reads which todo is open from the URL's `?todo=`. |
| `server/git-server.ts` | `git http-backend` over a bare repository, plus the native checkout. |
| `apps/todos/scripts/dev.ts` | Starts the backend and Vite together. |
| `apps/todos/scripts/native.ts` | JSON CLI over the native checkout. |
| `apps/todos/scripts/remote-edit.ts` | Demo fixture: a hand edit with undeclared frontmatter, committed and pushed from the native checkout with ordinary Git. |
| `apps/todos/scripts/module-graph.ts` | Lists the modules a build of one entry pulls in, resolved with the conditions and aliases `vite.config.ts` declares, for the seam test. |

Every query and mutation is a wellcrafted definition. A view passes
`.options` to `createQuery` or `createMutation`, adding `select` where it
narrows a query; code and tests call a mutation, or `.fetch()` a query, and get
a `Result`.

The query cache holds the files, and an edit goes straight into it. Every
write carries the hash of the version the person acted on, taken when they
acted. The todo listing is one query (`['todos', 'rows']`) built from
`folder.tables.todos.list()`; a row that does not read as a todo is an
`Err(InvalidRow)` entry in it. The store defines its views over that one
cache entry, each with `select`: the list reads `todos.rows.todos` and
`todos.rows.repairs`, and `TodoDetail` reads `todos.rows.entry(stem)`, so
they cannot disagree. A view that edits a file calls `todos.rows.edit(stem, change)`, one
immutable `map` over the listing, and queues its own write mutation
(`mutationKey: ['todos', 'write', 'row', path]`, `scope: { id: path }`) only when
`edit` says one is needed: fewer than two are running or waiting for that
file. The write reads the cache when it runs and calls guarded
`table.replace`. Its `onSuccess` moves the cached hash forward and keeps the
newest row; TanStack awaits it before the next write in the scope runs. Its
`onError` reads the file again, which rolls the cache back, and reports
what was lost. Reads are never held back: one may land while a write runs,
and the last write to settle reads everything again. Nothing goes stale on
its own. Writes never wait for the page to be visible. A repair
(`todos.rows.repair(stem)`, `mutationKey: ['todos', 'write', 'repair', path]`)
is a write too: it joins the file's queue and writes `{ text, base }` with
guarded `folder.files.replace(base, text)`. `base` is the draft's: the
`InvalidRow`'s path, hash, and text at the first keystroke
(`todos.rows.setDraft`). A success reads that one file again, whatever else
is writing, and drops the draft; a `Conflict` keeps it. The store keeps the
drafts, counts them in `todos.departure.holdsUnsaved`, and drops one once its
file reads as a todo or leaves the listing. Rename and delete join the same
queue and carry the version the person confirmed: `todos.rows.shown(stem)`
waits for that todo's queued writes to land, then reads it, so nothing the
app does changes the file while the person decides (`rename(stem, next,
shown)`, `remove(stem, shown)`). When they run, the cached hash must still be
that version; otherwise they refuse with `NotStarted`, and the folder's
guard still refuses a change Todos has not read. The store holds whether
Epicenter is asking to leave and the repair
drafts; the URL holds which todo is open; the new todo's title lives in the
list. Components find the store with `getTodos()` and never touch its query
client.

Checks: `bun run --cwd apps/todos typecheck` (both seam leaves and the Bun
side), `bun run --cwd apps/todos test` (it builds the Folder's file exchange
addon that the native harness needs, runs the tests on Svelte's server
runtime, then `test:mounted`: the real views mounted in jsdom under
`--conditions=browser`), `bun run --cwd apps/todos build` for the browser
demo, and `bun run --cwd apps/todos build:epicenter` for the build Epicenter
serves. The two builds share SvelteKit's output directory, so run them one
after the other.

## Changed promises

This version edits through the query cache (ADR-0528) and records versions
only on request or sync (ADR-0529). It dropped several promises of the
version before it:

- A write that meets a change made elsewhere is no longer merged with your
  edit and reviewed. The write changes nothing, the editor shows the file as
  it is now, and you can copy the text that was not written. You lose at
  most what was in flight.
- There is no draft kept through a failed write, no save bar, no **Try
  again**, and no "Discard unsaved changes?" when you open another item.
- Saves no longer commit. A version is recorded by **Save version** or by
  Sync, and the status details no longer warn about uncommitted changes.
- Fetch, Pull, Merge incoming changes, and Commit and push are gone, with
  their status lines. Sync and Save version replace them. The desktop app,
  whose folder owner does not sync yet, offers Save version alone.
- Delete no longer says that committed versions stay in Git history; it says
  when the file has changes in no saved version.
- Change reports from the folder still do not reread anything while you
  work. Screens read when they open, when you return to the window, and
  after the app's own actions.
- Todos no longer browses or edits arbitrary files. The file browser, the
  file view, **Open in Files**, **Open as todo**, and New file and New folder
  are gone. Todos shows the `todos/` table alone; edit any other file, or a
  todo's raw text, with another program.
- Todos has no terminal. Use your own terminal in the folder; the desktop
  folder is an ordinary directory with ordinary Git.
- A file that does not read as a todo is repaired by typing its text and
  pressing **Save**, not by text that saves as you type.
- Quitting or restarting no longer asks about anything. It waits for every
  write and action, then the window is ready; a new todo's title typed and not
  added, and repair text typed and not saved, are dropped. In the browser, a
  reload with repair text not saved asks first.
