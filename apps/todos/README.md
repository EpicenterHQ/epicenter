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
| Desktop, inside Epicenter | An ordinary directory on this computer, which the Epicenter host locks and grants to the page. | The system `git` in that directory's `.git`. Syncs with Epicenter's private repository for the account Home signed in to, or any Git remote with your own Git credentials. |
| Browser | A folder in this browser's origin private file system (OPFS), `so.epicenter.todos`. | Git in the folder's `.git`, in OPFS beside the files. Syncs with Epicenter's private repository for your account, any Git server whose Git routes allow this origin, or in development a loopback demo remote. |

Both builds open their folder at once, and opening writes nothing: the first
todo creates the folder. Both builds use an account only to sync with
Epicenter; editing and saving versions need none. Todos is built on
`@epicenter/folder` and TanStack Query, and does not depend on
`@epicenter/app`. A folder that cannot be opened is shown as that refusal.
The desktop build never falls back to browser storage.

A todo is its Markdown file and nothing else. A file that shares a todo's stem,
such as `todos/milk.png` or `todos/milk.webm` beside `todos/milk.md`, is an
ordinary file: deleting the todo leaves it where it is. Todos does not
rename files; rename a todo's file, or any other file, with another program
or with Git.

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
- A new folder has no Git remote. Connect sets one, or add one named
  `origin` with your own Git in the directory (`git remote add origin <url>`):
  every Sync reads the remote from Git's configuration again, with the same
  review as a browser. Todos reads the author (`user.name`, `user.email`) from
  Git's configuration when the folder opens. Fetch and push are Git's own, so a
  remote that is not Epicenter's
  works with whatever your Git already uses: a credential helper such as the
  macOS keychain or `gh auth`, or SSH. Git cannot ask you for a password
  here; set credentials up with your own Git first.

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
- A delete of a todo changes one file, its Markdown file. It carries the
  version the editor showed when you asked. It runs after the
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
- History is recorded with the system `git`, in the directory's own `.git`
  and never in a repository in a parent directory. Your own Git, editors,
  `git gc`, and Todos share the repository the way Git programs do: through
  Git's lock files, with the branch moved only from the commit Todos read.
  A Save version while another Git program holds the index lands, says the
  index could not be refreshed, and the next Save version refreshes it.
- Git hooks and fsmonitor never run for Todos' Git commands. The page
  changes only `todos/*.md`, `epicenter.json`, and `kv.json`, which the
  shell declares for it, and its own staging files in `.git`: the shell
  makes every change and refuses any other path, or one with a link on the
  way. Git stores every object itself.

### Closing, quitting, and unsaved typing

Edits are written as you make them. Writes and other actions still running
are waited for. The title of a new todo you have not added lives in the box
alone: it stays while the window is open, and quitting or reloading drops it.

- Closing the Todos window hides it. The page stays loaded, so a typed title
  is still there when you open Todos again.
- Quitting Epicenter, or restarting it for an account change, asks this page
  first, over the host's departure wire (`@epicenter/epicenter/departure`),
  through the shared page client (`@epicenter/epicenter/departure/page`).
  From that moment the page takes no input and starts no edit or action. It
  waits until every write and action already running has finished, then
  tells Epicenter it is ready. It never asks: Todos has no prompt to show.
  Once that work is done, nothing in it is lost.
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
  runs asks first with the browser's leave warning. Opening another todo changes only the address's
  `?todo=` and never asks.
- On quit, the page drains its own writes and Git work through the departure
  round above; Epicenter then releases the directory lock.
- A page reload ends that page's work. A write is published whole or not at
  all (its bytes are renamed into place), but a Save version or Sync the
  page was running stops where it was. An incoming update that stops
  partway leaves the files it wrote as changes, and the next Sync records
  and merges them; the browser's recovery button does not appear on the
  desktop. Other Todos windows keep working.
- Git hashing and network traffic do not block writes.

### How it is wired

The Rust shell registers the Todos folder under the ID the page opens,
`so.epicenter.todos`, with its directory and the window labels allowed to
open it, with the page's own engine. Opening Todos calls
`openFolder` from `@epicenter/folder/tauri`, which asks the shell to grant
the folder (`grant_directory`). The first grant creates the directory if it
is missing, refuses a linked `.git`, and takes the cross-process lock. The
Todos window then reads and changes that directory alone, through the folder
plugin's commands.

```text
Todos window (WebView)
        | @epicenter/folder directory folder: the browser's file storage
        |   over the folder plugin's commands, and the native Git backend
        |   (`run_git`: the shell runs `git` in the granted directory only)
        v
~/Epicenter/so.epicenter.todos          (locked and granted by the Rust shell)
```

The page reads and writes files through an OPFS-shaped directory handle
(`directory-handle.ts` in `@epicenter/folder`); a write's bytes are staged
under `.git/epicenter/scratch` and renamed into place. History is the native
Git backend a Bun directory folder uses, with its `git` run by the shell:
only the operations the folder engine needs, with no hook, fsmonitor, or
terminal prompt. Several Todos windows share the folder through Web Locks
and a `BroadcastChannel`, as browser tabs do. Nothing watches the directory
for other programs' edits; Todos reads again at the moments listed
[above](#where-the-files-are).

The `epicenter-host` build condition selects the desktop leaf of
`#platform/folder`, and `vite.config.ts` resolves the bare `@epicenter/folder`
specifier to `@epicenter/folder/tauri` for that build. That build carries the
directory folder and the folder plugin's commands, and none of the browser
folder's storage address, download, or private Git, and no Node or Bun
module. The browser build selects the browser leaf and resolves the same
specifier to `@epicenter/folder/browser`, so it carries no desktop adapter.
Both run the same UI, file storage, history rules, and merge review.

## In a browser

Todos opens this browser's folder, `so.epicenter.todos` in the origin private
file system, at once. Nothing is written until you write: the first todo
creates the folder, its Git history, and `epicenter.json`. The folder has no
remote until you connect one, and works without one. Versions are committed as
`Todos <todos@epicenter.so>`. Another tab of the same origin edits the same
folder; each tab reads again when you return to it.

### Connect

**Connect** (the header's remote button, or Sync's place while there is no
remote) chooses where the todos sync. The choice is a URL the folder keeps in
its own Git configuration; connecting then syncs once.

- **Sync with Epicenter**, signed in: Todos asks the server this build signs in
  to (`POST /api/git/connect { folder: "so.epicenter.todos" }`, ADR-0521) for
  the account's repository, which it creates on first use, and a write token
  for that repository alone. The remote is
  `<server>/git/so.epicenter.todos.<account tag>.git`. Signed out, **Sign in to
  Epicenter** leaves for sign-in and comes back with Connect open. On the
  desktop the window uses the account Home signed in to.
- **Another Git server**: its URL, and a token (and a username, if the server
  asks for one) kept on this device for exactly that URL. With no token the
  desktop's `git` signs in as the person's own Git does; a browser sends none.
  A URL that carries a password is refused, since the folder's Git settings
  would keep it; the desktop sends a token only to an `https` remote. A browser
  reaches only servers whose Git routes allow its origin (ADR-0521).

Either way:

- a folder with todos and an empty repository: the todos are sent;
- an empty folder: it takes the repository's todos, so a second device signs
  in, connects, and has the list;
- a repository with todos of its own when this folder has a history of its
  own: Connect says so, changes nothing, and **Combine them** keeps both; where
  the same todo differs, the review asks.

Connect again to change the remote. In development, **Use the demo remote on
this computer** connects to the loopback remote `bun dev:todos` starts instead.

Credentials stay out of the folder (`src/lib/git-access.ts`). The folder asks
for one right before each push and fetch, with the URL it is about to reach.
Epicenter's token lives in memory, is renewed when less than five minutes
remain by the server's clock, is forgotten when the account signs out or
changes (it stays valid at the server until it expires), and is given only to
the exact remote the server named; a transfer to it while signed out is
refused with a request to sign in. Any other remote gets its pasted token or
nothing. A refusal reaches Sync's message in words a person can act on.

A folder an earlier version kept under `Epicenter/local/` or
`Epicenter/accounts/` is not opened, moved, or deleted; connect to the
repository it synced with to get its todos back.

### Developing

From the repository root:

```sh
bun dev:todos
```

This starts the loopback Git backend on `127.0.0.1:5187`, the UI on
`http://127.0.0.1:5186`, and the local API, and prints the session: the bare
repository, the native checkout, and the remote URL. The UI reaches the
backend same-origin through the Vite proxy at `/git/todos.git`. `bun
dev:todos:ui` starts the UI alone; connecting to the demo remote then fails
and says so, while writes and Save version keep working. Set
`TODOS_DEMO_ROOT` to a directory printed by an earlier run to reopen it.
Syncing with Epicenter needs a server with a repository store: the hosted
Worker has one; a local API (`bun dev:api`) answers Connect with "does not keep
todos".

## Controls

Both builds share these, and run the same engine. Every folder offers Save
version, and Sync once it has a remote; until then Connect takes Sync's place. The todo
list and its editor fill the window. The header holds the rest:

| Control | What it does |
| --- | --- |
| Folder path (desktop) | The directory the todos are in. Click to copy it. |
| Remote | Where the todos sync: **Epicenter**, a GitHub repository's `owner/name` (desktop), the URL, or **Not connected**. Click it to connect, or to change the remote. Connect offers Epicenter or another Git server's URL. |
| Status button | Shows the most important current fact, shortened on narrow screens. Open it for where the folder is, whether every edit is written, the changes since the last version, the last version, and the remote, with the times they were observed, plus "Check again", which reads everything again. |
| Save version | Records the written files as a version in history (`folder.git.commit()`). Writes still running land first. Nothing is sent. |
| Sync | Waits for writes still running, records a version, fetches, merges, and pushes (`folder.sync`, ADR-0514). Edits to different fields, or to different lines of the notes, merge on their own; a merged todo is rewritten in the standard form. When both sides changed the same title, done, notes, or a whole todo (one side deleted it, or a version is not a valid todo), the review replaces the workspace and nothing is written until you apply your choices. The review is modal: the workspace and the Git buttons wait until you apply or cancel, and Cancel forgets the attempt and your choices. A choice the folder refuses shows beside its row and keeps the review. Afterwards the list and Git status are read again. |
| Connect | Shown instead of Sync while the folder has no remote; opens Connect. |
| Recover incoming update | Shown only while an incoming update has not finished; see below. Sync and Save version are off until then, and say why. |

The open todo is part of the address, `?todo=<stem>`, so a reload or a
change of window width keeps it open. On narrow screens the list and the
editor take turns: opening a todo adds a history entry, so the browser's Back
returns to the list, and the editor has its own Back button. Deleting the
open todo replaces the entry, so Back never lands on a name that is gone.

The list opens a todo's title, done, and notes. A file in `todos/` whose text
is not a valid todo shows under "Needs repair" and opens as its text,
read-only, with what to fix. Fix it in a text editor; once it reads as a
todo, the editor shows its fields. A file that cannot be read as text at
all shows under "Could not read" with **Try again**. One todo shows at a
time, and switching never waits or asks.

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
- Delete runs after the file's writes. It carries the version shown when
  the confirmation opened, or one Todos wrote from it since, so a delete you
  confirmed while your last edit was still being written removes that
  edit's file. A file changed elsewhere since is refused, and so is a todo
  Todos no longer lists. Typing into that file waits while it runs.
- The first write of a file written by hand rewrites it in Todos' standard
  form: plain YAML frontmatter, declared keys first, unknown keys kept.
  Comments and custom quoting in the frontmatter are not kept.

### When an incoming update stops partway

This section is the browser's. On the desktop, an update that stops partway
leaves its written files as changes, and the next Sync finishes it.

A sync in the browser writes the incoming files one at a time. If it stops
partway (the tab closed, or a file could not be written), the folder keeps a
record of the update. Todos reports it under the header as "Incoming update
not finished" (or "never started", or "record unreadable"), and as the first
line of the status details. It never resumes the update on its own: opening
the folder, "Check again", and returning to the window only read the record.

- Sync and Save version wait while the update is pending; their buttons are
  off and say why. Editing, writing, and deleting keep working.
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
present. On the desktop they work the same over the real directory once it
has an `origin`.

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
3. Delete a todo from the bar under its notes, which shows its file's path.
   Deleting changes that one Markdown file: a file with the same stem, such
   as an image or a recording, stays where it is. Delete always asks
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
the list, with its path and why. It is not in the list itself. **Show**
opens its complete text, read-only, with each problem and its line. Fix it
in a text editor and return to the window. A todo that parses but has a bad
field, such as `done: soon`, is named the same way. Once the text reads as
a todo, the editor shows its fields. A todo that stops reading as a todo
while it is shown, because another program changed it, shows its text when
the editor next reads it.

Any file name works for a todo, including a leading dot, a trailing space,
punctuation, and `todos/.md` itself. Only `.md` in lowercase makes a file a
todo; `todos/a.MD` is an ordinary file.

## Layout

| Path | Role |
| --- | --- |
| `src/lib/definition.ts` | The inert `defineFolder` declaration, written with the shared `defineTable` and `field` vocabulary. It names no folder. |
| `src/routes/+layout.svelte` | The tooltip provider and toasts; no app state. |
| `src/routes/+page.svelte` | Opens the folder and creates its store (`createTodos`), then mounts `TodosView` with it. Inside Epicenter it starts the shared departure client (`@epicenter/epicenter/departure/page`) and opens the folder only once a status is known, attaching `todos.departure` the moment it exists (`openForDeparture`); in a browser it opens at once. It turns a failed write into a toast with **Copy your text**. |
| `src/routes/auth/callback/+page.svelte` | Where Epicenter's sign-in returns. |
| `src/lib/platform/` | The `#platform/departure` seam: the host leaf is the shared Tauri window port (`@epicenter/epicenter/departure/window`); the browser leaf has no port. The `#platform/folder` seam: `types.ts` is the contract and holds `TODOS_FOLDER_ID`, `folder.browser.ts` opens this browser's folder through `@epicenter/folder/browser`, and `folder.epicenter-host.ts` opens the host's directory through `@epicenter/folder/tauri`. Each returns the folder or the refusal. The `#platform/auth` seam: redirect sign-in for the browser, Home's account through the host for the desktop. Importing any of them opens nothing. |
| `src/lib/todo-listing.ts` | The todo listing as the list shows it (`todosOf`, `repairsOf`), and a todo's file and stem (`todoPath`, `todoStem`). |
| `src/lib/todos.svelte.ts` | The store over one folder (ADR-0528): its own TanStack `QueryClient` with every rule (never stale, no retry, the quit fence), leaving, and closing. It composes the namespaces below over one `Session`. |
| `src/lib/session.ts` | What the namespaces share: the cache keys (`todosKeys`), `TodosError` and `DEPARTING`, the `WriteFailure` type, and the `Session` type. |
| `src/lib/rows.ts` | `todos.rows`: the listing's views (`todos`, `repairs`, `entry(stem)`), `edit`, the scoped `write(stem)` each view creates its mutation from, `create`, and `remove`. Views ask TanStack's `useIsMutating` whether a write or delete runs. |
| `src/lib/git.ts` | `todos.git`: the history `snapshot`, `status`, Save version, and incoming recovery. |
| `src/lib/sync.ts` | `todos.sync`: `run`, which connects first when given a URL, and the review's `apply`. |
| `src/lib/status.ts` | Plain-language status lines and the header summary. |
| `src/routes/components/` | Header, list (`TodoList`, one `TodoRow` per todo), the open todo (`TodoDetail`, with its file name bar and delete confirmation, which also shows a file that does not read as a todo, read-only), the sync review, and Connect (`ConnectDialog`). `TodosView` sets the store and its query client as context for them, lays them out, and reads which todo is open from the URL's `?todo=`. |
| `server/git-server.ts` | `git http-backend` over a bare repository, plus the native checkout. |
| `apps/todos/scripts/dev.ts` | Starts the backend and Vite together. |
| `apps/todos/scripts/native.ts` | JSON CLI over the native checkout. |
| `apps/todos/scripts/remote-edit.ts` | Demo fixture: a hand edit with undeclared frontmatter, committed and pushed from the native checkout with ordinary Git. |
| `apps/todos/scripts/module-graph.ts` | Lists the modules a build of one entry pulls in, resolved with the conditions and aliases `vite.config.ts` declares and with Svelte compiled, for the seam test. |

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
(`mutationKey: ['todos', 'write', path]`, `scope: { id: path }`) only when
`edit` says one is needed: fewer than two are running or waiting for that
file. The write reads the cache when it runs and calls guarded
`table.replace`. Its `onSuccess` moves the cached hash forward and keeps the
newest row; TanStack awaits it before the next write in the scope runs. Its
`onError` reads the listing again, which rolls the cache back, and reports
what was lost. Reads are never held back: one may land while a write runs,
and the last write to settle reads everything again. Nothing goes stale on
its own. Writes never wait for the page to be visible. Todos does not
write a file that does not read as a todo; another editor repairs it, and
the next read shows the result. Todos does not rename files. Delete joins
the same queue and carries the version the person confirmed:
`todos.rows.shown(stem)` waits for that todo's queued writes to land, then
reads it, so nothing the app does changes the file while the person decides
(`remove(stem, shown)`). When it runs, the cached hash must still be that
version; otherwise it refuses with `NotStarted`, and the folder's guard
still refuses a change Todos has not read. The store holds whether
Epicenter is asking to leave; the URL holds which todo is open; the new todo's title lives in the
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

This version opens its folder lazily, keeps its remote in the folder's Git
configuration, and connects with **Connect** (ADR-0532). It dropped:

- The browser's start page, the Local demo as a separate place, and
  **Change**. There is one folder per browser.
- The account's pairing: a browser's copy is no longer kept apart per
  account, Download is gone (connecting an empty folder takes the remote's
  todos), and a remote change no longer needs the server's agreement.

Before that, this version edits through the query cache (ADR-0528) and records versions
only on request or sync (ADR-0529). It dropped several promises of the
version before it:

- The desktop folder is no longer opened by a Rust owner shared by every
  window. The page opens it with `@epicenter/folder`'s own file storage and
  history rules, over the real directory the shell locks and grants, with
  the system `git`. Desktop Todos gains Sync and the merge review, with your
  own Git credentials. It loses three things the owner gave: a Save version
  or Sync a reloading page was running no longer finishes on its own; edits
  other programs make are no longer watched for, only read at the usual
  moments; and an incoming update that stops partway is finished by the
  next Sync instead of a recovery button.
- A write that meets a change made elsewhere is no longer merged with your
  edit and reviewed. The write changes nothing, the editor shows the file as
  it is now, and you can copy the text that was not written. You lose at
  most what was in flight.
- There is no draft kept through a failed write, no save bar, no **Try
  again**, and no "Discard unsaved changes?" when you open another item.
- Saves no longer commit. A version is recorded by **Save version** or by
  Sync, and the status details no longer warn about uncommitted changes.
- Fetch, Pull, Merge incoming changes, and Commit and push are gone, with
  their status lines. Sync and Save version replace them, on the desktop
  too.
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
- Todos no longer repairs a file that does not read as a todo. It shows the
  file's text and what to fix, read-only; fix it in a text editor.
- Quitting or restarting no longer asks about anything. It waits for every
  write and action, then the window is ready; a new todo's title typed and not
  added is dropped.
