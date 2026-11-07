# Todos

Todos keeps each todo as a Markdown note at `todos/<id>.md`: its `title` and
`done` in front matter, its notes in the body. That layout is Todos'
contract, `src/lib/contract.ts`, published unchanged as `static/contract.json`
(`bun run contract` rewrites it after a change), the file
`epicenter check <dir> --contract <url>/contract.json` checks a folder against. Any
program that writes the layout is a valid writer.

Todos has two variants, one store each and nothing moving between them
(decisions 77 to 79): the online web app over the folder attached to Todos
on the server, and a desktop app over a folder of todos it keeps on the
computer (below). A folder of todos on a computer, the desktop app's or a
clone of that folder (`epicenter clone`), is synced by `epicenter sync`,
never by Todos.

## The web app

Todos in a browser is its online variant only: the folder attached to Todos
on the server (its history is the repository at `/folders/<id>`). Signed out
it asks for a sign-in;
signed in, every create, edit, completion and delete is a commit there, and
nothing is kept in the browser. It needs the network; there is no browser
copy to fall back on
([ADR-0700](../../docs/adr/0700-apps-share-data-through-a-file-contract-recorded-in-git.md)).

- Changes made elsewhere (another tab, or a desktop's `epicenter sync`) show
  without a reload.
- A note at a todo's path that does not read as a todo is listed under
  "Needs repair" with its text. Saving text there writes it as typed: text
  that fits repairs the note, and text that still does not fit stays listed
  with what is wrong.

The title, notes and Done of the open todo are one editor of its note
(`todos.edit({ id })`): they save as you type or click, one save at a time.
Done in the list saves at once (`todos.set`). A save never fails: while the
repository cannot be reached, the folder keeps the changes in order and
sends them when it can, and the page says so (`<WhenOpen>`).

The app signs in as `so.epicenter.todos` (`connectAccount()` in
`src/lib/app.ts`) for the repository alone, the one need `home` declares
when it is handed the account
([ADR-0792](../../docs/adr/0792-an-account-asks-for-what-the-capabilities-that-take-it-need.md)).
The server is `VITE_EPICENTER_SERVER` at build time, else Epicenter's. The
hosted API does not serve web writes yet, so signing in works against a
local or self-hosted API.

### Run it

From the repository root:

```sh
bun dev:todos:ui                       # Vite dev server on http://localhost:5186
bun run --cwd apps/todos build         # static files in apps/todos/build/
bun run --cwd apps/todos demo          # the whole stack, to try it by hand
```

The build is static: any host that answers unknown paths with `index.html`
(for `/auth/callback`) serves it, at an origin the API registers.

`demo` boots a disposable Postgres, the local API with temporary Git and LFS
stores, the built app on `http://localhost:5186`, a demo person, and a
desktop sandbox for the `epicenter` CLI, then prints a sign-in helper URL and
the `epicenter clone`, `check` and `sync` commands for the person's `todos`
repository. It needs `initdb`, `pg_ctl`, `git` and `git-lfs` on `PATH`, and
port 5186 free. Ctrl-C deletes everything.

## The desktop app

```sh
bun dev:todos:desktop     # from the repository root; needs a Rust toolchain
bun build:todos:desktop   # a local, unsigned macOS app bundle
```

Its Tauri shell derives the data folder from the app's site and names it
the Data root, which the page opens by name. The page opens `~/Epicenter/todos` (`~/Epicenter Dev/todos`
in development), making it when missing for now. A failed open shows the
shared recovery screen with Retry. The files remain when the app is removed.

The page is the web's own build (`build/`, the dev server in
development), over the folder (`openFolder(todos, home({ site, account }))`,
whose `home` in a Tauri window is the Data root). It asks for no sign-in: a
desktop app never syncs, and Epicenter, once installed, syncs the folder
(ADR-0822). Its header says whether Epicenter syncs the folder (from the
record Epicenter keeps of it), says where to get Epicenter until it does,
and shows the shell's folder path in the status details. Closing the window or quitting does not wait.

One build serves both
([ADR-0781](../../docs/adr/0781-apps-branch-on-what-a-capability-offers-and-one-build-serves-every-surface.md)):
`home` and `connectAccount` decide where the page runs, and the header
branches on `folder.reveal`, showing `FolderChrome` (whether Epicenter
syncs the folder) where the folder can be revealed and
`RepositoryChrome` (the repository's status and the account) otherwise.

## The native CLI

```sh
bun apps/todos/scripts/native.ts /tmp/todos list
bun apps/todos/scripts/native.ts /tmp/todos create "Buy milk"
bun apps/todos/scripts/native.ts /tmp/todos complete <id>
```

It opens Todos' folder at the directory (`openFolder(todos, directory(path))`,
`directory` from `@epicenter/folder/node`), keeps front matter keys and
notes Todos does not name, and never commits or contacts a server.
`complete` lists the todos first and changes only one that is there, since
`set` would make a note where none is.

## How it is wired

```text
src/lib/app.ts                 the page's values, each read through reactive:
                               account = reactive(connectAccount(...)) and
                               folder = reactive(openFolder(todos, home({ site, account })));
                               editing it, or what it imports, reloads the page
routes/+layout.svelte          every page: the chrome
routes/(app)/+layout.svelte    over the repository and signed out: SignIn; otherwise
                               <WhenOpen app="Todos" {folder}> (spinner, Recovery,
                               pages, and the leave guard while folder.saving())
routes/(app)/+page.svelte      TodosApp
  TodosApp.svelte              the header, the list, the open todo
    AppHeader.svelte           FolderChrome where folder.reveal is there, else RepositoryChrome
routes/auth/callback           finishes sign-in, outside (app), then returns to /
```

Every component imports what it reads from `$lib/app.js` (`folder.todos`),
never a client of its own; only `app.ts` opens the store
([ADR-0766](../../docs/adr/0766-an-apps-capabilities-are-module-values-opened-synchronously.md)).
On the web the folder is the account's copy: it opens once the account is
signed in, and a new account is a new page (sign-in returns through
`/auth/callback`, which reloads).

| Path | Role |
| --- | --- |
| `src/lib/app.ts` | The account and the folder, opened once for the page. |
| `src/lib/contract.ts` | The contract. |
| `src/lib/todos.ts` | A todo's file, label and order (open first, then done, each oldest first). |
| `src/lib/components/SignIn.svelte`, `RepositoryChrome.svelte` | The web app's signed-out page; the header's status and account. |
| `src/lib/components/FolderChrome.svelte` | The header's account of the folder: whether Epicenter syncs it, and its path (`folder.displayPath`). |
| `src/lib/components/TodosApp.svelte` | The header, the list, and the open todo, over `folder.todos`. |

## Tests

```sh
bun run --cwd apps/todos test        # contract, order, the list over a memory folder, the native CLI
bun run --cwd apps/todos typecheck   # app, scripts, end to end
bun x playwright test -c apps/todos/playwright.config.ts                    # both engines
bun x playwright test -c apps/todos/playwright.config.ts --project=webkit   # one
bun run --cwd apps/todos build && cargo test -p todos -p epicenter-standalone
```

`bun run test` passes `--conditions=test`, so `$lib/app.js` opens a folder
in memory and a signed-out account: a component test seeds the folder
through its ordinary methods (`folder.todos.set`) and mocks no module.

The desktop shell's tests compile against `build/` (`frontendDist`), so
they need `build` first. They check its identity, its name (so its
default folder), and that its capability grants only plugin permissions and
names no folder.

The Playwright suite (`e2e/todos.spec.ts`) starts the same environment as
`demo`, built into a scratch directory (never `build/`), and walks one person
through five steps per engine: Todos asks for a sign-in, and signed in,
todos are created, edited, completed and deleted in the repository, never in
the browser's files, and survive a reload; `epicenter clone` holds them as
written and `epicenter check` passes; a desktop title edit shows with no
reload, and notes edited in the browser reach the desktop; a note the
desktop wrote that does not read as a todo shows with its text and is
repaired; and signing out asks for a sign-in again.
