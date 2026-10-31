# Todos

Todos keeps each todo as a Markdown note at `todos/<id>.md`: its `title` and
`done` in front matter, its notes in the body. That layout is Todos'
contract, `src/lib/contract.ts`, published unchanged as `static/contract.json`
(`bun run contract` rewrites it after a change), the file
`epicenter check <url>/contract.json <dir>` checks a folder against. Any
program that writes the layout is a valid writer.

Todos has two variants, one store each and nothing moving between them
(decisions 77 to 79): the online web app over the signed-in person's
repository, and a desktop app over a folder of todos it keeps on the
computer (below). A folder of todos on a computer, the desktop app's or a
clone of the person's repository (`epicenter clone`), is synced by Epicenter
(`epicenter sync`), never by Todos.

## The web app

Todos in a browser is its online variant only: the person's own repository,
`<handle>/todos`, through Epicenter. Signed out it asks for a sign-in;
signed in, every create, edit, completion and delete is a commit there, and
nothing is kept in the browser. It needs the network; there is no browser
copy to fall back on
([ADR-0700](../../docs/adr/0700-apps-share-data-through-a-file-contract-recorded-in-git.md)).

- Changes made elsewhere (another tab, or a desktop's `epicenter sync`) show
  without a reload.
- A note at a todo's path that does not read as a todo is listed under
  "Needs repair" with its text. Saving fixed text there replaces the note,
  written in house style; text that still does not fit is refused.

The title and notes save as you type; a save that fails stays in its editor
with Save again, Discard and Copy.

The app signs in as `so.epicenter.todos` for the server's Git audience only
(`src/lib/auth.ts`, made on first use, and only by the web build). The
server is `VITE_EPICENTER_SERVER` at build time, else Epicenter's. The
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

Its Tauri shell (`src-tauri/`, on the shared
[`epicenter-standalone`](../../packages/tauri-epicenter-standalone/README.md)
crate) starts the window on Todos' AppData root, whose `settings.md`
(`todosSettings` in `src/lib/folder.tauri.ts`, machine-local, never synced)
names a data folder only when the person chose one. There is no first-run
question: the page opens `~/Epicenter/Todos` (`~/Epicenter/Todos Dev` under
`tauri.dev.conf.json`, whose `productName` is `Todos Dev`), made when
missing, or the chosen folder (`openAppData(todosSettings)`, then
`openDataFolder`). Tauri decides which folders the window may open: the
shell allows the default at startup, the native picker allows a folder the
person picks, and persisted-scope keeps that across launches. A `folder`
written into `settings.md` by hand opens as not allowed until the person
picks it. A folder that is missing, not allowed, or refused shows a recovery
screen (Allow access, Retry, Choose folder…, Use the default folder, as the
case needs), never another folder silently. "Choose data folder…" in the
status details picks another folder, opens it with its files where they
are, and remembers it. The todos stay when the app is removed.

The page is the same UI as the web, built as the desktop variant
(`bun run build:native`, into `build-desktop/`), over the folder
(`openDataFolder(todos, { appData })`) with no sign-in: Todos makes no
inference calls, and Epicenter syncs the folder. Its header says whether
Epicenter syncs the folder, offers **Sync with Epicenter** until it does
(`syncWithEpicenter({ path, contract })`, the contract at `APPS.TODOS.url`'s
`contract.json`), and holds **Choose data folder…** in the status details.
Closing the window or quitting waits for saves (the leave guard), and so
does Choose data folder….

The variant is chosen at build time through the `#platform/root` seam, as
[the shared pattern](../../packages/tauri-epicenter-standalone/README.md#making-a-web-apps-desktop-variant)
describes: `desktopVariant()` in `vite.config.ts`, `tsconfig.tauri.json`, and
`src/lib/platform.test.ts`, which names a seam whose desktop leaf went
missing.

| Seam | Web leaf | Desktop leaf |
| --- | --- | --- |
| `#platform/root` | `root.ts`: `Startup` (the repository behind sign-in), `store()`, and the account | `root.tauri.ts`: `Startup` (the two roots or the recovery screen), `store()`, and its sync |

## The native CLI

```sh
bun apps/todos/scripts/native.ts /tmp/todos list
bun apps/todos/scripts/native.ts /tmp/todos create "Buy milk"
bun apps/todos/scripts/native.ts /tmp/todos complete <id>
```

It opens the directory as the contract's client (`openDevice` from
`@epicenter/folder/node`), keeps front matter keys and notes Todos does not
name, and never commits or contacts a server.

## How it is wired

```text
routes/+layout.svelte          every page: the chrome and the leave guard
routes/(app)/+layout.svelte    the root that decides the store: <svelte:boundary> (spinner)
                               around Startup from #platform/root
  OnlineRoot.svelte            web: signed out, a sign-in; signed in,
    Online.svelte              {#key account}: setRepo(fromClient(openRemote(todos, { account })))
  Startup.svelte               desktop: await openAppData(todosSettings), openDataFolder(); Recovery
    DesktopRoot.svelte         setAppData/setDevice(fromClient(...)), setFolderSync
routes/(app)/+page.svelte      TodosApp over store().todos (#platform/root)
  TodosApp.svelte              header (Chrome from #platform/root), the list, the open todo
routes/auth/callback           finishes sign-in, outside (app), then returns to /
```

Components read and write only through the todos they are given
(`TodosApp` sets them, `getTodos` in `src/lib/todos.ts` reads them), never a
client of their own; only the variant's root chooses the store.

| Path | Role |
| --- | --- |
| `src/lib/contract.ts` | The contract. |
| `src/lib/todos.ts` | A todo's file, label and order (open first, then done, each oldest first), and the list's context. |
| `src/lib/components/OnlineRoot.svelte`, `Online.svelte`, `OnlineChrome.svelte` | The web app: asks for a sign-in or opens the repository per account (`setRepo`); the header's status and account. |
| `src/lib/components/Startup.svelte`, `DesktopRoot.svelte`, `DesktopChrome.svelte` | The desktop app: its two roots opened in order, or the recovery screen (`@epicenter/svelte/recovery`); the roots set for every page (`setAppData`, `setDevice`); the header's sync status, Sync with Epicenter, and Choose data folder…. |
| `src/lib/folder.tauri.ts` | The desktop window's settings contract, typed contexts (`getAppData`, `getDevice`), and where the contract is published. |
| `src/lib/components/TodosApp.svelte` | The header, the list, and the open todo, over the todos it is given. |

## Tests

```sh
bun run --cwd apps/todos test        # contract, order, both builds' seams, the native CLI
bun run --cwd apps/todos typecheck   # app (web and desktop leaves), scripts, end to end
bun x playwright test -c apps/todos/playwright.config.ts                    # both engines
bun x playwright test -c apps/todos/playwright.config.ts --project=webkit   # one
bun run --cwd apps/todos build:native && cargo test -p todos -p epicenter-standalone
```

The desktop shell's tests compile against `build-desktop/` (`frontendDist`),
so they need `build:native` first. They check its identity, its name (so its
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
