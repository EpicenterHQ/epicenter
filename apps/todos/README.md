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

Todos installs into Epicenter as an app, from this folder of the Epicenter
repository (ADR-0552); Epicenter compiles no app in. `epicenter.app.json`
names the id `so.epicenter.todos` and the title; Epicenter runs
`bun run build:installed`, which writes `dist`. The Folders
window Epicenter opens to offers "Install Todos" while no app is installed:
it clones the repository into `~/Epicenter/Apps/so.epicenter.todos/`, and
approving it runs `bun install` at the repository's root and the build here.
Then open Todos from the Folders window's Apps list, or with "Open in Todos"
beside a folder whose declaration contains its shape. Opened from the Apps
list, it opens its own folder, `so.epicenter.todos`. Opened with "Open in
Todos", it opens that folder and reads its todos through its shape
(ADR-0538): it never rewrites that folder's `epicenter.json`, and a folder
whose declaration lacks the shape is refused with a message naming the
folder. Such a folder offers no [Connect](#connect): Epicenter's server keeps
one repository per app id today, so Connect would give it Todos's own
repository. Sync still works with a remote the folder already has, other
than one on Epicenter's server.

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
that is already present. The shell chooses the directory and the folder each
window is handed; nothing in the window can point Todos at another one.

Edit the files with any program. The desktop shell watches the directory,
and Todos reads again exactly what a reported change names, so an edit made
in another program, another window, or by an agent shows while you work
(ADR-0548). Returning to the window reads nothing by itself.

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

- Every Epicenter process, a second build or the `epicenter` CLI, takes turns
  with Todos under the folder's save lock,
  `.so.epicenter.todos.epicenter-save-lock`, across each check and change
  (ADR-0562, ADR-0568). The operating system releases it when a process
  exits, including after a crash or a forced kill. It is not reliable on
  network filesystems.
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

Edits are written as you make them. The title of a new todo you have not
added lives in the box alone: it stays while the window is open, and quitting
or reloading drops it.

- Closing the Todos window destroys it, as Epicenter does any installed app's
  window, so a typed title not added is dropped.
- Quitting Epicenter, or restarting it for an account change, is immediate
  and asks this page nothing
  ([ADR-0542](../../docs/adr/0542-quitting-is-immediate-because-unfinished-work-already-lives-in-its-folder.md)).
  A write still running when the process ends is lost; every write is a
  rename, so the file holds the old version or the new one. Written files are
  on disk and reopen as they were.
- The browser demo asks first with the browser's leave warning when leaving
  the tab while a write or action runs (`todos.holdsUnsaved`). Opening another
  todo changes only the address's `?todo=` and never asks.
- A page reload ends that page's work. A write is published whole or not at
  all (its bytes are renamed into place), but a Save version or Sync the
  page was running stops where it was. An incoming update that stops
  partway leaves the files it wrote as changes, and the next Sync records
  and merges them, in the browser and on the desktop. Other Todos windows
  keep working.
- Git hashing and network traffic do not block writes.

### How it is wired

The Rust shell registers the Todos folder under the ID the page opens,
`so.epicenter.todos`, the first time installed Todos is opened without a
folder or the Folders window lists it, and permits the Todos window into it
(an installed app's own folder, ADR-0552). The shell hands each Todos window
its folder's scope as `?folder=` in the window's URL (`open_installed_app`):
`so.epicenter.todos`, or the scope the Folders window listed for another
folder. For its own folder, or when handed none, Todos calls `openFolder`
from `@epicenter/folder/tauri` with its definition; for any other folder it
calls `openDataFolder` with its definition as the lens, which never writes
that folder's declaration and refuses one without Todos's shape. Either asks
the shell to grant the folder (`grant_directory`). The first grant creates the directory if it
is missing, refuses a linked `.git`, and takes the cross-process lock. The
Todos window then reads and changes that directory alone, through the folder
plugin's commands.

```text
Todos window (WebView)
        | @epicenter/folder directory folder: the browser's file storage
        |   over the folder plugin's commands; history through the shell's
        |   history commands, each one `epicenter` child over the granted
        |   directory (ADR-0559)
        v
~/Epicenter/so.epicenter.todos          (locked and granted by the Rust shell)
```

The page reads and writes files through an OPFS-shaped directory handle
(`directory-handle.ts` in `@epicenter/folder`); a write's bytes are staged
under `.git/epicenter/scratch` and renamed into place. History is the native
Git backend a Bun directory folder uses, with its `git` run by the shell:
only the operations the folder engine needs, with no hook, fsmonitor, or
terminal prompt. Several Todos windows share the folder without waiting on
each other (ADR-0541): the shell checks each save where it lands, a commit
whose branch another window moved retries once, and a save another window
overtook merges with it (`table.save`, ADR-0548). Todos follows
`folder.onFilesChanged`, which the shell's watcher feeds
([above](#where-the-files-are)).

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
folder; each tab tells the others which files it wrote, and they read those
again at once.

### Connect

**Connect** (the header's remote button, or Sync's place while there is no
remote) chooses where the todos sync. The choice is a URL the folder keeps in
its own Git configuration; connecting then syncs once. Only Todos's own
folder, `so.epicenter.todos`, offers Connect; the platform leaf says whether
the folder it opened is that one (`OpenedTodosFolder.own`).

- **Sync with Epicenter**, signed in: Todos proposes a repository name from the
  folder's directory (`so.epicenter.todos`; the person may change it), asks the
  server for the account's personal namespace (`GET /api/repos`), and connects
  to `<git origin>/<namespace>/<name>.git` (ADR-0546). The first sync's push
  creates the repository; until then the server answers the name as an empty
  repository. The desktop window runs `epicenter sync` with the desktop grant,
  which signs `git` in; the browser pushes with its own access token. Signed
  out, **Sign in to Epicenter** leaves for
  sign-in and comes back with Connect open. On the desktop the window uses the
  account Home signed in to.
- **Another Git server**: its URL. The desktop's `git` signs in as the
  person's own Git does; a browser sends no credential. The page holds no token
  for it. A URL that carries a password is refused, since the folder's Git
  settings would keep it. A browser reaches only servers whose Git routes allow
  its origin.

Either way:

- a folder with todos and an empty repository: the todos are sent;
- an empty folder: it takes the repository's todos, so a second device signs
  in, connects, and has the list;
- a repository with todos of its own when this folder has a history of its
  own: Connect says so, changes nothing, and **Combine them** keeps both; where
  the same todo differs, the review asks.

Connect again to change the remote. In development, **Use the demo remote on
this computer** connects to the loopback remote `bun dev:todos` starts instead.

Credentials stay out of the folder and out of the page's storage
(`src/lib/remote.ts`). The browser folder's Git transport (`httpFetch`) sends
the build's own access token, for the Git audience, only to Epicenter's Git
origin through the account, and everything else through plain `fetch`. The
desktop page holds no token: `epicenter sync` mints one from the desktop grant
for each run. A refusal reaches Sync's message in words a person can act on.

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
  disagree about the file. What you type shows in the editor at once and in
  the list once it is saved.
- The checkbox writes at once. A title or notes are written a second after
  you stop typing, and at once when you leave the field or open another
  todo; what you typed stays on screen until it is written, whatever is
  read meanwhile. Quitting loses at most the last second of typing.
- A title or done is a change to the todo as its file is now (ADR-0554):
  what another writer changed in another field stays, and where you both
  changed the title, yours wins. The notes keep the version they started
  from and merge by line with whatever changed since: lines only the other
  writer changed stay, and where you both changed the same lines, yours win,
  with no message (ADR-0575).
- A save that fails, or whose reply is lost, keeps what you typed in the
  editor, which says it is not saved and offers **Try again**; a message
  about notes offers **Copy your text**. A checkbox that did not save shows
  the file; click it again.
- Inputs hold only values a todo can hold. A title or notes with a lone
  surrogate is written with U+FFFD in its place, as shown. The folder still
  refuses a value it cannot hold, which is reported the same way.
- Delete runs after the file's writes. It carries the version shown when
  the confirmation opened, or one Todos wrote from it since, so a delete you
  confirmed while your last edit was still being written removes that
  edit's file. A file changed elsewhere since is refused, and so is a todo
  Todos no longer lists. Typing into that file waits while it runs.
- The first write of a file written by hand rewrites it in Todos' standard
  form: plain YAML frontmatter, declared keys first, unknown keys kept.
  Comments and custom quoting in the frontmatter are not kept.

### When an incoming update stops partway

A sync writes the incoming files one at a time. If it stops partway (the tab
closed, or a file could not be written), the files it wrote show as changes
since the last version, and nothing is pending (ADR-0545). Editing, Save
version, and Sync keep working. The next Sync records those changes and
merges with the remote, which finishes the update. It can add one version of
the half-written state before its merge.

## What to try

These steps are written for the browser demo, where a remote is always
present. On the desktop they work the same over the real directory once it
has an `origin`.

1. Add a todo. The file is written immediately, and nothing is committed or
   pushed. The status details report whether every edit is written, the
   changes since the last version, the last version, and the remote
   separately. They say "Changes need checking" or "Check failed" instead of
   claiming a clean folder when the last observation is out of date or
   failed; "Check again" reads again. Press **Save version** to
   record one.
2. Edit the title or notes. Each edit is written in the todo's standard form
   at once. Change the file in another tab or program, and the editor shows
   that version without your returning. Change it elsewhere while you are
   typing here: your save merges with their change, and where you both
   changed the same part, yours wins and a message names theirs.
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
in a text editor, and the list shows the result. A todo that parses but has a bad
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
| `src/routes/+page.svelte` | Opens the folder and creates its store (`createTodos`), then mounts `TodosView` with it. It turns a failed write into a toast with **Copy your text**. |
| `src/routes/auth/callback/+page.svelte` | Where Epicenter's sign-in returns. |
| `src/lib/platform/` | The `#platform/folder` seam: `types.ts` is the contract and holds `TODOS_FOLDER_ID`, `folder.browser.ts` opens this browser's folder through `@epicenter/folder/browser`, and `folder.epicenter-host.ts` opens the folder the host handed the window (`?folder=`, its own when none) through `@epicenter/folder/tauri`. Each returns the folder or the refusal. The `#platform/auth` seam: redirect sign-in for the browser, Home's account through the host for the desktop. Importing any of them opens nothing. |
| `src/lib/todo-listing.ts` | The todo listing as the list shows it (`todosOf`, `repairsOf`), and a todo's file and stem (`todoPath`, `todoStem`). |
| `src/lib/todos.svelte.ts` | The store over one folder (ADR-0528, ADR-0548): its own TanStack `QueryClient` with every rule (never stale, no retry, no focus refetch), the one line that wires `folder.onFilesChanged` to the cache, the browser leave check, and closing. It composes the namespaces below over one `Session`. |
| `src/lib/session.ts` | What the namespaces share: the delete's mutation key (`todosKeys`), `TodosError`, the `WriteFailure` type, and the `Session` type, which carries the folder's options (`folder$`). |
| `src/lib/rows.ts` | `todos.rows`: the listing's views (`todos`, `repairs`, `entry(stem)`), the `update` options each field sends with, the `saveNotes` options the notes draft saves with, `create`, `shown`, and `remove`. Views ask TanStack's `useIsMutating` whether a save or delete runs. |
| `src/lib/git.ts` | `todos.git`: the history `snapshot`, `status`, and Save version. |
| `src/lib/sync.ts` | `todos.sync`: `run`, which connects first when given a URL, and the review's `apply`. |
| `src/lib/status.ts` | Plain-language status lines and the header summary. |
| `src/routes/components/` | Header, list (`TodoList`, one `TodoRow` per todo), the open todo (`TodoDetail`, with its file name bar and delete confirmation, which also shows a file that does not read as a todo, read-only), the sync review, and Connect (`ConnectDialog`). `TodosView` sets the store and its query client as context for them, lays them out, and reads which todo is open from the URL's `?todo=`. |
| `server/git-server.ts` | `git http-backend` over a bare repository, plus the native checkout. |
| `apps/todos/scripts/dev.ts` | Starts the backend and Vite together. |
| `apps/todos/scripts/native.ts` | JSON CLI over the native checkout. |
| `apps/todos/scripts/remote-edit.ts` | Demo fixture: a hand edit with undeclared frontmatter, committed and pushed from the native checkout with ordinary Git. |
| `epicenter.app.json` | The manifest Epicenter installs Todos from: its id, which `src/lib/platform/types.ts` imports, and its title. |
| `apps/todos/scripts/module-graph.ts` | Lists the modules a build of one entry pulls in, resolved with the conditions and aliases `vite.config.ts` declares and with Svelte compiled, for the seam test. |

Reads and saves come from the folder's options (`folderOptions` in
`@epicenter/folder/query`). A view passes them to `createQuery` or
`createMutation`, adding `select` where it narrows a query. Git status,
Save version, Sync, create, and delete are wellcrafted definitions: code and
tests call a mutation, or `.fetch()` a query, and get a `Result`.

The query cache holds what the files held when they were read; files are the
truth. The store wires the folder's one channel of outside change to the
cache in one line, `folder$.invalidateOnChange(queryClient)`, so another
window's save, an agent's edit, or Sync landing a change marks exactly the
queries it names stale. TanStack's focus refetch is off, and no view has
refresh logic of its own. The todo listing is one query
(`folder$.todos.list`); a row that does not read as a todo is an
`Err(InvalidRow)` entry in it. The store defines its views over that one
cache entry, each with `select`: the list reads `todos.rows.todos` and
`todos.rows.repairs`, and `TodoDetail` reads `todos.rows.entry(stem)`, so
they cannot disagree.

A field edit is an update of the file as it is now (`todos.rows.update`,
`table.update` underneath, ADR-0554). `TodoDetail` holds the typed title in
its own state and sends it a second after the last keystroke, on blur, and
when it goes away; each `TodoRow` checkbox, and the detail's, sends at once.
The notes are the body, opened with `createBodyEditor` from
`@epicenter/folder/svelte` (ADR-0575): it keeps the version it started from
and saves with `todos.rows.saveNotes` on the same pause, merged by line by
`table.save`. Bodies read and write with `\n` line endings (ADR-0572), so
the textarea's value is sent as it is. The page keys `TodoDetail` by the todo, and the view keeps the
stem it was created with, so a save sent as it goes away lands on the todo
it was typed into. Writes to one file run one at a time in the order made,
and each puts the row it wrote in the cache; a read that lands meanwhile
never replaces typed text. A failed save keeps the typed text. The folder
does not report a page's own saves to it, so the last save to settle reads
Git status again. Saves never wait for the page to be visible. Todos does
not write a file that does not read as a todo; another editor repairs it,
and the folder's report shows the result. Todos does not rename files.
Delete carries the version the person confirmed: `TodoDetail` sends what is
typed, and `todos.rows.shown(stem)` waits for running saves to land, then
reads it, so nothing the app does changes the file while the person decides
(`remove(stem, shown)`). When it runs, the cached hash
must still be that version; otherwise it refuses with `NotStarted`, and the
folder's guard still refuses a change Todos has not read. The URL holds which todo is open; the new todo's title lives in the
list. Components find the store with `getTodos()` and never touch its query
client.

Checks: `bun run --cwd apps/todos typecheck` (both seam leaves and the Bun
side), `bun run --cwd apps/todos test` (it builds the Folder's file exchange
addon that the native harness needs, runs the tests on Svelte's server
runtime, then `test:mounted`: the real views mounted in jsdom under
`--conditions=browser`), `bun run --cwd apps/todos build` for the browser
demo, and `bun run --cwd apps/todos build:installed` for the build Epicenter
installs. The installed build writes `dist/` here and prerenders each page
with relative asset paths, so it runs below whatever path the host serves it
at; the browser build writes `build/` and serves a fallback page. The builds
share SvelteKit's output directory, so run them one after the other.

## Changed promises

This version sends a field as a change to the file as it is now
(ADR-0554). A title is written a second after you stop typing or when you
leave the field, not on every keystroke, and the editor no longer says
"Changed elsewhere": a title or done never undoes another writer's other
fields, and only the notes keep a starting version.

Before that, this version follows the folder's change reports and edits through drafts
(ADR-0548). Another window's or program's change shows while you work, and
returning to the window reads nothing by itself. A save over a file changed
elsewhere merges with it, and a failed save keeps your edit with **Try
again**. What you type shows in the list once it is saved, not as you type.

Before that, this version opens its folder lazily, keeps its remote in the
folder's Git configuration, and connects with **Connect** (ADR-0532). It
dropped:

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
